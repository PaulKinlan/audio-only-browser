import { CDPClient } from "../server/cdp.ts";
import { AudioBrowser, createHandler } from "../server/main.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SAMPLE_PORT = 18_901;
const API_PORT = 18_909;
const BACKEND_DEBUG_PORT = 18_922;
const UI_DEBUG_PORT = 18_923;
const CONTROLLER_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const UPDATE_EVIDENCE = Deno.env.get("UPDATE_EVIDENCE") === "1";
const EVIDENCE_FILES = [
  "01-dom-before.png",
  "02-dom-after.png",
  "03-navigation-after.png",
  "04-form-before.png",
  "05-form-after.png",
  "06-voice-before.png",
  "07-voice-after.png",
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertIncludes(value: string, expected: string, label: string) {
  assert(
    value.toLowerCase().includes(expected.toLowerCase()),
    `${label}: expected ${JSON.stringify(value)} to include ${
      JSON.stringify(expected)
    }`,
  );
}

const TEST_NAVIGATION_START = `<!doctype html>
  <title>Navigation readiness fixture</title>
  <h1>Navigation readiness fixture</h1>
  <a href="/delayed-destination.html">Open delayed destination</a>`;

const TEST_DELAYED_DESTINATION = `<!doctype html>
  <title>Delayed destination ready</title>
  <h1>Delayed destination ready</h1>`;

function startSampleServer() {
  return Deno.serve({
    hostname: "127.0.0.1",
    port: SAMPLE_PORT,
    onListen: () => {},
  }, async (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/navigation-readiness.html") {
      return new Response(TEST_NAVIGATION_START, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (pathname === "/delayed-destination.html") {
      await delay(650);
      return new Response(TEST_DELAYED_DESTINATION, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    const name = pathname === "/" ? "index.html" : pathname.slice(1);
    if (
      !["index.html", "article.html", "about.html", "subscribed.html"].includes(
        name,
      )
    ) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(
      await Deno.readFile(`${ROOT}sample-site/${name}`),
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  });
}

async function waitForUrl(url: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function api(path: string, body?: unknown) {
  const response = await fetch(
    `http://127.0.0.1:${API_PORT}${path}`,
    body
      ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
      : undefined,
  );
  const data = await response.json();
  assert(
    response.ok,
    `${path} failed (${response.status}): ${JSON.stringify(data)}`,
  );
  return data;
}

async function connectToChrome(debugPort: number) {
  let websocketUrl = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const targets = await (await fetch(
        `http://127.0.0.1:${debugPort}/json/list`,
      )).json();
      websocketUrl = targets.find((target: { type: string }) =>
        target.type === "page"
      )?.webSocketDebuggerUrl || "";
      if (websocketUrl) break;
    } catch {
      // Chrome is still starting.
    }
    await delay(100);
  }
  assert(websocketUrl, "Chrome did not expose a page target");
  const cdp = new CDPClient();
  await cdp.connect(websocketUrl);
  await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable")]);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1_000,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return cdp;
}

async function captureEvidence(cdp: CDPClient, name: string) {
  assert(
    EVIDENCE_FILES.includes(name),
    `Unexpected evidence filename: ${name}`,
  );
  const metrics = await cdp.send<{
    cssContentSize: { width: number; height: number };
  }>("Page.getLayoutMetrics");
  const width = Math.ceil(metrics.cssContentSize.width);
  const height = Math.ceil(metrics.cssContentSize.height);
  const screenshot = await cdp.send<{ data: string }>(
    "Page.captureScreenshot",
    {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    },
  );
  const binary = atob(screenshot.data);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  assert(bytes.length > 1_000, `${name} should contain a meaningful PNG`);
  assert(
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
      bytes[3] === 0x47,
    `${name} should have a PNG signature`,
  );
  if (UPDATE_EVIDENCE) {
    await Deno.mkdir(`${ROOT}evidence`, { recursive: true });
    await Deno.writeFile(`${ROOT}evidence/${name}`, bytes);
  } else {
    const committed = await Deno.readFile(`${ROOT}evidence/${name}`);
    assert(
      committed.length > 1_000 && committed[0] === 0x89 &&
        committed[1] === 0x50 && committed[2] === 0x4e &&
        committed[3] === 0x47,
      `Committed evidence/${name} should be a meaningful PNG`,
    );
  }
}

async function launchUiChrome() {
  const profile = await Deno.makeTempDir({ prefix: "audio-browser-ui-test-" });
  const process = new Deno.Command(
    Deno.env.get("CHROME_BIN") || "google-chrome-stable",
    {
      args: [
        "--headless=new",
        `--remote-debugging-port=${UI_DEBUG_PORT}`,
        `--user-data-dir=${profile}`,
        "--no-sandbox",
        "--disable-gpu",
        "--disable-background-networking",
        "about:blank",
      ],
      stdout: "null",
      stderr: "null",
    },
  ).spawn();
  const cdp = await connectToChrome(UI_DEBUG_PORT);
  return { cdp, process, profile };
}

async function evaluate<T = unknown>(
  cdp: CDPClient,
  expression: string,
): Promise<T> {
  const response = await cdp.send<{
    result?: { value?: unknown };
    exceptionDetails?: { exception?: { description?: string } };
  }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        "Browser evaluation failed",
    );
  }
  return response.result?.value as T;
}

async function waitForBrowser(
  cdp: CDPClient,
  expression: string,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, `Boolean(${expression})`)) return;
    } catch {
      // The page may be navigating.
    }
    await delay(100);
  }
  throw new Error(`Browser condition timed out: ${expression}`);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

Deno.test({
  name:
    "real CDP browser resolves intents, narrates updates, and drives voice UI seams",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const sampleServer = startSampleServer();
    const previousDebugPort = Deno.env.get("CHROME_DEBUG_PORT");
    Deno.env.set("CHROME_DEBUG_PORT", String(BACKEND_DEBUG_PORT));
    const sampleOrigin = `http://127.0.0.1:${SAMPLE_PORT}`;
    const browser = new AudioBrowser({ allowedTargetOrigins: [sampleOrigin] });
    let apiServer: Deno.HttpServer | undefined;
    let backendEvidenceCdp: CDPClient | undefined;
    let uiChrome: Awaited<ReturnType<typeof launchUiChrome>> | undefined;

    try {
      await waitForUrl(`${sampleOrigin}/index.html`);
      await browser.launch();
      backendEvidenceCdp = await connectToChrome(BACKEND_DEBUG_PORT);
      apiServer = Deno.serve({
        hostname: "127.0.0.1",
        port: API_PORT,
        onListen: () => {},
      }, createHandler(browser, { controllerPort: API_PORT }));

      const frontendResponse = await fetch(
        `http://127.0.0.1:${API_PORT}/index.html`,
      );
      assert(frontendResponse.ok, "API server should serve the frontend");
      assertIncludes(
        await frontendResponse.text(),
        "Audio-Only Browser",
        "same-origin frontend",
      );

      const crossOriginResponse = await fetch(
        `${CONTROLLER_ORIGIN}/snapshot`,
        { headers: { Origin: "http://attacker.example" } },
      );
      assert(
        crossOriginResponse.status === 403,
        "cross-origin control requests should be rejected",
      );
      assert(
        !crossOriginResponse.headers.has("Access-Control-Allow-Origin"),
        "API responses should not include wildcard CORS",
      );

      for (
        const protectedPath of ["/session", "/snapshot", "/intent", "/updates"]
      ) {
        const reboundResponse = await fetch(
          `${CONTROLLER_ORIGIN}${protectedPath}`,
          {
            headers: {
              Host: "attacker.example",
              Origin: "http://attacker.example",
            },
          },
        );
        assert(
          reboundResponse.status === 403,
          `a hostile Host with its matching hostile Origin should be rejected for ${protectedPath}`,
        );
      }

      const fixedOriginResponse = await fetch(`${CONTROLLER_ORIGIN}/snapshot`, {
        headers: {
          Host: `127.0.0.1:${API_PORT}`,
          Origin: CONTROLLER_ORIGIN,
        },
      });
      assert(
        fixedOriginResponse.ok,
        "the configured controller Host and Origin should be allowed",
      );

      const disallowedTarget = await fetch(
        `http://127.0.0.1:${API_PORT}/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetUrl: "http://example.com/" }),
        },
      );
      assert(
        disallowedTarget.status === 403,
        "session targets outside the configured origins should be rejected",
      );

      await api("/session", {
        targetUrl: `${sampleOrigin}/navigation-readiness.html`,
      });
      const delayedStart = performance.now();
      const delayedNavigation = await api("/intent", {
        action: "open the delayed destination",
      });
      const delayedElapsed = performance.now() - delayedStart;
      assert(
        delayedElapsed >= 550,
        `CDP intent returned before delayed navigation committed (${delayedElapsed}ms)`,
      );
      assert(
        delayedNavigation.snapshot.title === "Delayed destination ready",
        "CDP readiness should snapshot the new delayed document, not the old page",
      );

      const session = await api("/session", {
        targetUrl: `${sampleOrigin}/index.html`,
      });
      assert(
        session.snapshot.headings[0].text === "AI Focus",
        "semantic snapshot should include the real snapshot heading",
      );
      assert(
        session.snapshot.landmarks.some((item: { role: string }) =>
          item.role === "nav"
        ),
        "semantic snapshot should include landmarks",
      );
      assert(
        session.snapshot.controls.some((item: { role: string; name: string }) =>
          item.role === "link" && item.name.includes("modern Lighthouse")
        ),
        "semantic snapshot should include named links",
      );
      assertIncludes(session.narration, "Next steps", "session narration");
      await captureEvidence(backendEvidenceCdp, "01-dom-before.png");

      const button = await api("/intent", {
        action: "reveal the featured essay details",
      });
      assert(
        button.resolution.kind === "button",
        "natural-language button intent should activate a button",
      );
      assertIncludes(
        button.result,
        "Reveal featured essay details",
        "button effect",
      );
      assertIncludes(
        button.nextStep,
        "Next steps",
        "post-button next-step narration",
      );
      await delay(650);
      const updates = await api("/updates");
      assert(
        updates.updates.some((update: string) =>
          update.includes("featured Paul Kinlan")
        ),
        `expected concise added-content update, got ${JSON.stringify(updates.updates)}`,
      );
      await captureEvidence(backendEvidenceCdp, "02-dom-after.png");

      const article = await api("/intent", {
        action: "read how a modern Lighthouse might work with large language models",
      });
      assert(
        article.resolution.kind === "link",
        "article request should resolve to a link",
      );
      assertIncludes(
        article.snapshot.url,
        "/article.html",
        "article navigation URL",
      );
      assert(
        article.snapshot.title ===
          "How might a modern Lighthouse work with large language models?",
        "link click should navigate the real browser",
      );
      assertIncludes(
        article.nextStep,
        "Read about Paul Kinlan and AI Focus",
        "article next steps",
      );
      await captureEvidence(backendEvidenceCdp, "03-navigation-after.png");

      const about = await api("/intent", {
        action: "read about Paul Kinlan and AI Focus",
      });
      assertIncludes(about.snapshot.url, "/about.html", "about navigation URL");
      assert(
        about.snapshot.forms[0].controls.some((name: string) =>
          name.includes("Demo email address")
        ),
        "semantic snapshot should describe form controls",
      );
      await captureEvidence(backendEvidenceCdp, "04-form-before.png");

      const submitted = await api("/intent", {
        action:
          "enter listener@example.com in the demo email field and submit the form",
      });
      assert(
        submitted.resolution.kind === "form-submit",
        "combined fill-and-submit intent should submit the form",
      );
      assertIncludes(
        submitted.result,
        "listener@example.com",
        "form fill effect",
      );
      assertIncludes(
        submitted.snapshot.url,
        "/subscribed.html?email=listener%40example.com",
        "submitted form URL",
      );
      assert(
        submitted.snapshot.title === "Local form demo complete",
        "form submission should navigate to confirmation",
      );
      assertIncludes(
        submitted.nextStep,
        "Return to the AI Focus snapshot",
        "confirmation next steps",
      );
      await captureEvidence(backendEvidenceCdp, "05-form-after.png");

      uiChrome = await launchUiChrome();
      await uiChrome.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
          globalThis.__voiceCalls = { recognition: [], synthesis: [], intents: [] };
          const nativeFetch = globalThis.fetch.bind(globalThis);
          globalThis.fetch = (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input), location.href);
            if (url.pathname === "/intent" && init?.body) {
              globalThis.__voiceCalls.intents.push(JSON.parse(String(init.body)).action);
            }
            return nativeFetch(input, init);
          };
          class MockRecognition {
            constructor() {
              this.listeners = {};
              globalThis.__mockRecognition = this;
            }
            addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
            start() { globalThis.__voiceCalls.recognition.push("start"); }
            emitResult(transcript) {
              globalThis.__voiceCalls.recognition.push("result:" + transcript);
              const event = { results: [[{ transcript }]] };
              for (const callback of this.listeners.result || []) callback(event);
              for (const callback of this.listeners.end || []) callback({});
            }
          }
          class MockUtterance { constructor(text) { this.text = text; this.lang = ""; } }
          Object.defineProperty(globalThis, "SpeechRecognition", { configurable: true, value: MockRecognition });
          Object.defineProperty(globalThis, "webkitSpeechRecognition", { configurable: true, value: MockRecognition });
          Object.defineProperty(globalThis, "SpeechSynthesisUtterance", { configurable: true, value: MockUtterance });
          Object.defineProperty(globalThis, "speechSynthesis", { configurable: true, value: {
            cancel() { globalThis.__voiceCalls.synthesis.push("cancel"); },
            speak(utterance) { globalThis.__voiceCalls.synthesis.push("speak:" + utterance.text); }
          }});
        `,
      });
      const frontendUrl = `http://127.0.0.1:${API_PORT}/index.html`;
      await uiChrome.cdp.send("Page.navigate", { url: frontendUrl });
      await waitForBrowser(
        uiChrome.cdp,
        "document.readyState === 'complete' && window.audioBrowserApp",
      );
      await evaluate(
        uiChrome.cdp,
        `
        document.querySelector('#target-url').value = ${
          JSON.stringify(`${sampleOrigin}/index.html`)
        };
        document.querySelector('#start-session').click();
      `,
      );
      await waitForBrowser(
        uiChrome.cdp,
        "!document.querySelector('.interface').hidden",
      );
      await waitForBrowser(
        uiChrome.cdp,
        "globalThis.__voiceCalls.synthesis.some(call => call.startsWith('speak:'))",
      );
      await captureEvidence(uiChrome.cdp, "06-voice-before.png");

      await evaluate(
        uiChrome.cdp,
        "document.querySelector('#mic-btn').click()",
      );
      await waitForBrowser(
        uiChrome.cdp,
        "globalThis.__voiceCalls.recognition.includes('start')",
      );
      const voiceIntent =
        "read how a modern Lighthouse might work with large language models";
      await evaluate(
        uiChrome.cdp,
        `globalThis.__mockRecognition.emitResult(${JSON.stringify(voiceIntent)})`,
      );
      await waitForBrowser(
        uiChrome.cdp,
        "document.querySelector('#connection-status').textContent.startsWith('Now browsing How might a modern Lighthouse')",
      );
      await captureEvidence(uiChrome.cdp, "07-voice-after.png");
      const voiceSnapshot = await api("/snapshot");
      assertIncludes(
        voiceSnapshot.snapshot.url,
        "/article.html",
        "voice-driven CDP navigation URL",
      );
      const voiceEvidence = await evaluate<{
        calls: {
          recognition: string[];
          synthesis: string[];
          intents: string[];
        };
        transcript: string;
        narration: string;
        typedValue: string;
      }>(
        uiChrome.cdp,
        `({
        calls: globalThis.__voiceCalls,
        transcript: document.querySelector('#transcript-display').textContent,
        narration: document.querySelector('#narration-display').textContent,
        typedValue: document.querySelector('#text-intent').value
      })`,
      );
      assertIncludes(
        voiceEvidence.transcript,
        "read how a modern Lighthouse",
        "recognition-result transcript",
      );
      assert(
        voiceEvidence.calls.recognition.includes("start") &&
          voiceEvidence.calls.recognition.includes(`result:${voiceIntent}`),
        "microphone control should start recognition and receive its result event",
      );
      assert(
        voiceEvidence.calls.intents.includes(voiceIntent),
        "the recognition transcript should reach submitIntent and its /intent request",
      );
      assert(
        voiceEvidence.typedValue === "",
        "voice attestation should not substitute typed-form submission",
      );
      assertIncludes(
        voiceEvidence.narration,
        "Activated Read how a modern Lighthouse",
        "voice-driven action narration",
      );
      assert(
        voiceEvidence.calls.synthesis.filter((call: string) =>
          call.startsWith("speak:")
        ).length >= 2,
        "session and intent responses should call speech synthesis",
      );

      console.log(
        "EVIDENCE semantic controls:",
        session.snapshot.controls.length,
      );
      console.log("EVIDENCE DOM update:", updates.updates.join(" | "));
      console.log("EVIDENCE navigation:", article.snapshot.url);
      console.log("EVIDENCE form submission:", submitted.snapshot.url);
      console.log("EVIDENCE voice seam:", JSON.stringify(voiceEvidence.calls));
      console.log(
        "EVIDENCE screenshots:",
        EVIDENCE_FILES.map((name) => `evidence/${name}`).join(" | "),
      );
    } finally {
      uiChrome?.cdp.close();
      backendEvidenceCdp?.close();
      try {
        uiChrome?.process.kill("SIGTERM");
      } catch { /* already stopped */ }
      if (uiChrome?.process) await uiChrome.process.status;
      if (uiChrome?.profile) {
        await Deno.remove(uiChrome.profile, { recursive: true }).catch(
          () => {},
        );
      }
      if (apiServer) await apiServer.shutdown();
      await browser.close();
      await sampleServer.shutdown();
      if (previousDebugPort === undefined) Deno.env.delete("CHROME_DEBUG_PORT");
      else Deno.env.set("CHROME_DEBUG_PORT", previousDebugPort);
    }
  },
});
