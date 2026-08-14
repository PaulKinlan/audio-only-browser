import { CDPClient } from "../server/cdp.ts";
import { AudioBrowser, createHandler } from "../server/main.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SAMPLE_PORT = 18_901;
const FRONTEND_PORT = 18_900;
const API_PORT = 18_909;
const BACKEND_DEBUG_PORT = 18_922;
const UI_DEBUG_PORT = 18_923;

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

function staticServer(directory: string, port: number) {
  return new Deno.Command("python3", {
    args: ["-m", "http.server", String(port), "--bind", "127.0.0.1"],
    cwd: directory,
    stdout: "null",
    stderr: "null",
  }).spawn();
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
  let websocketUrl = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const targets = await (await fetch(
        `http://127.0.0.1:${UI_DEBUG_PORT}/json/list`,
      )).json();
      websocketUrl = targets.find((target: { type: string }) =>
        target.type === "page"
      )
        ?.webSocketDebuggerUrl || "";
      if (websocketUrl) break;
    } catch {
      // Chrome is still starting.
    }
    await delay(100);
  }
  assert(websocketUrl, "UI Chrome did not expose a page target");
  const cdp = new CDPClient();
  await cdp.connect(websocketUrl);
  await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable")]);
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
    const sampleServer = staticServer(`${ROOT}sample-site`, SAMPLE_PORT);
    const frontendServer = staticServer(`${ROOT}frontend`, FRONTEND_PORT);
    const previousDebugPort = Deno.env.get("CHROME_DEBUG_PORT");
    Deno.env.set("CHROME_DEBUG_PORT", String(BACKEND_DEBUG_PORT));
    const browser = new AudioBrowser();
    let apiServer: Deno.HttpServer | undefined;
    let uiChrome: Awaited<ReturnType<typeof launchUiChrome>> | undefined;

    try {
      await Promise.all([
        waitForUrl(`http://127.0.0.1:${SAMPLE_PORT}/index.html`),
        waitForUrl(`http://127.0.0.1:${FRONTEND_PORT}/index.html`),
      ]);
      await browser.launch();
      apiServer = Deno.serve({
        hostname: "127.0.0.1",
        port: API_PORT,
        onListen: () => {},
      }, createHandler(browser));

      const session = await api("/session", {
        targetUrl: `http://127.0.0.1:${SAMPLE_PORT}/index.html`,
      });
      assert(
        session.snapshot.headings[0].text === "Welcome to the Audio Trailhead",
        "semantic snapshot should include the main heading",
      );
      assert(
        session.snapshot.landmarks.some((item: { role: string }) =>
          item.role === "nav"
        ),
        "semantic snapshot should include landmarks",
      );
      assert(
        session.snapshot.controls.some((item: { role: string; name: string }) =>
          item.role === "link" && item.name.includes("web development")
        ),
        "semantic snapshot should include named links",
      );
      assertIncludes(session.narration, "Next steps", "session narration");

      const button = await api("/intent", {
        action: "please load the comments",
      });
      assert(
        button.resolution.kind === "button",
        "natural-language button intent should activate a button",
      );
      assertIncludes(button.result, "Load comments", "button effect");
      assertIncludes(
        button.nextStep,
        "Next steps",
        "post-button next-step narration",
      );
      await delay(650);
      const updates = await api("/updates");
      assert(
        updates.updates.some((update: string) =>
          update.includes("Jamie: Voice navigation")
        ),
        `expected concise added-content update, got ${
          JSON.stringify(updates.updates)
        }`,
      );

      const article = await api("/intent", {
        action: "I would like to read the article about web development",
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
        article.snapshot.title === "Intent-driven Browsing",
        "link click should navigate the real browser",
      );
      assertIncludes(
        article.nextStep,
        "Meet the Audio Trailhead team",
        "article next steps",
      );

      const about = await api("/intent", {
        action: "meet the audio trailhead team",
      });
      assertIncludes(about.snapshot.url, "/about.html", "about navigation URL");
      assert(
        about.snapshot.forms[0].controls.some((name: string) =>
          name.includes("Email address")
        ),
        "semantic snapshot should describe form controls",
      );

      const submitted = await api("/intent", {
        action:
          "enter listener@example.com in the email field and sign up for updates",
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
        submitted.snapshot.title === "Journey updates confirmed",
        "form submission should navigate to confirmation",
      );
      assertIncludes(
        submitted.nextStep,
        "Start the sample journey again",
        "confirmation next steps",
      );

      uiChrome = await launchUiChrome();
      await uiChrome.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
          globalThis.__voiceCalls = { recognition: [], synthesis: [] };
          class MockRecognition {
            constructor() { this.listeners = {}; }
            addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
            start() { globalThis.__voiceCalls.recognition.push("start"); }
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
      const frontendUrl =
        `http://127.0.0.1:${FRONTEND_PORT}/index.html?server=${
          encodeURIComponent(`http://127.0.0.1:${API_PORT}`)
        }`;
      await uiChrome.cdp.send("Page.navigate", { url: frontendUrl });
      await waitForBrowser(
        uiChrome.cdp,
        "document.readyState === 'complete' && window.audioBrowserApp",
      );
      await evaluate(
        uiChrome.cdp,
        `
        document.querySelector('#target-url').value = ${
          JSON.stringify(`http://127.0.0.1:${SAMPLE_PORT}/index.html`)
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

      await evaluate(
        uiChrome.cdp,
        "document.querySelector('#mic-btn').click()",
      );
      await waitForBrowser(
        uiChrome.cdp,
        "globalThis.__voiceCalls.recognition.includes('start')",
      );
      await evaluate(
        uiChrome.cdp,
        `
        document.querySelector('#text-intent').value = 'read the article about web development';
        document.querySelector('#intent-form').requestSubmit();
      `,
      );
      await waitForBrowser(
        uiChrome.cdp,
        "document.querySelector('#narration-display').textContent.includes('Intent-driven Browsing')",
      );
      const voiceEvidence = await evaluate<{
        calls: { recognition: string[]; synthesis: string[] };
        transcript: string;
        narration: string;
      }>(
        uiChrome.cdp,
        `({
        calls: globalThis.__voiceCalls,
        transcript: document.querySelector('#transcript-display').textContent,
        narration: document.querySelector('#narration-display').textContent
      })`,
      );
      assertIncludes(
        voiceEvidence.transcript,
        "read the article",
        "typed fallback transcript",
      );
      assert(
        voiceEvidence.calls.recognition.includes("start"),
        "microphone control should call the recognition seam",
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
    } finally {
      uiChrome?.cdp.close();
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
      try {
        sampleServer.kill("SIGTERM");
      } catch { /* already stopped */ }
      try {
        frontendServer.kill("SIGTERM");
      } catch { /* already stopped */ }
      await Promise.all([sampleServer.status, frontendServer.status]);
      if (previousDebugPort === undefined) Deno.env.delete("CHROME_DEBUG_PORT");
      else Deno.env.set("CHROME_DEBUG_PORT", previousDebugPort);
    }
  },
});
