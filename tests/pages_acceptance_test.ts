import { CDPClient } from "../server/cdp.ts";

const ROOT = new URL("../", import.meta.url);
const DOCS = new URL("../docs/", import.meta.url);
const PROJECT_PATH = "/audio-only-browser/";
const DEBUG_PORT = 18_932;
const UPDATE_EVIDENCE = Deno.env.get("UPDATE_PAGES_EVIDENCE") === "1";
const PAGES_EVIDENCE = new URL("../evidence/08-pages-subpath.png", import.meta.url);

const publishedFiles = [
  "index.html",
  "assets/site.css",
  "sample/index.html",
  "sample/article.html",
  "sample/about.html",
  "sample/subscribed.html",
  "evidence/01-dom-before.png",
  "evidence/02-dom-after.png",
  "evidence/03-navigation-after.png",
  "evidence/04-form-before.png",
  "evidence/05-form-after.png",
  "evidence/06-voice-before.png",
  "evidence/07-voice-after.png",
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function contentType(pathname: string) {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function startPagesServer() {
  const notFoundRequests: string[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(PROJECT_PATH)) {
        notFoundRequests.push(url.pathname);
        return new Response("Not found", { status: 404 });
      }

      const relativePath = url.pathname.slice(PROJECT_PATH.length) || "index.html";
      const fileUrl = new URL(relativePath, DOCS);
      if (!fileUrl.href.startsWith(DOCS.href)) {
        notFoundRequests.push(url.pathname);
        return new Response("Not found", { status: 404 });
      }

      try {
        return new Response(await Deno.readFile(fileUrl), {
          headers: { "Content-Type": contentType(relativePath) },
        });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        notFoundRequests.push(url.pathname);
        return new Response("Not found", { status: 404 });
      }
    },
  );
  const address = server.addr as Deno.NetAddr;
  return {
    server,
    notFoundRequests,
    origin: `http://${address.hostname}:${address.port}`,
  };
}

async function connectToChrome(debugPort: number) {
  let websocketUrl = "";
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      ).json();
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
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Network.enable"),
    cdp.send("Log.enable"),
  ]);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1_200,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return cdp;
}

async function evaluate<T = unknown>(cdp: CDPClient, expression: string): Promise<T> {
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
      response.exceptionDetails.exception?.description || "Browser evaluation failed",
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
      // The previous document may be navigating away.
    }
    await delay(100);
  }
  throw new Error(`Browser condition timed out: ${expression}`);
}

async function click(cdp: CDPClient, selector: string) {
  await evaluate(
    cdp,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error("Missing click target: " + ${
      JSON.stringify(selector)
    });
      element.click();
    })()`,
  );
}

async function capturePagesEvidence(cdp: CDPClient) {
  const screenshot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  const binary = atob(screenshot.data);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  assert(bytes.length > 10_000, "Pages screenshot should be a meaningful PNG");
  assert(
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
      bytes[3] === 0x47,
    "Pages screenshot should have a PNG signature",
  );
  if (UPDATE_EVIDENCE) {
    await Deno.writeFile(PAGES_EVIDENCE, bytes);
  } else {
    const committed = await Deno.readFile(PAGES_EVIDENCE);
    assert(
      committed.length > 10_000 && committed[0] === 0x89 &&
        committed[1] === 0x50 && committed[2] === 0x4e &&
        committed[3] === 0x47,
      "Committed Pages acceptance screenshot should be a meaningful PNG",
    );
  }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

Deno.test({
  name: "GitHub Pages subpath drives the landing and complete static sample journey",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { server, notFoundRequests, origin } = startPagesServer();
    const profile = await Deno.makeTempDir({ prefix: "audio-browser-pages-test-" });
    const process = new Deno.Command(
      Deno.env.get("CHROME_BIN") || "google-chrome-stable",
      {
        args: [
          "--headless=new",
          `--remote-debugging-port=${DEBUG_PORT}`,
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
    let cdp: CDPClient | undefined;
    const browserErrors: string[] = [];
    const failedResponses: string[] = [];

    try {
      for (const file of publishedFiles) {
        const response = await fetch(`${origin}${PROJECT_PATH}${file}`);
        assert(response.ok, `${file} should be published without a 404`);
      }

      cdp = await connectToChrome(DEBUG_PORT);
      cdp.on<{ exceptionDetails?: { exception?: { description?: string } } }>(
        "Runtime.exceptionThrown",
        ({ exceptionDetails }) => {
          browserErrors.push(
            exceptionDetails?.exception?.description || "Uncaught browser exception",
          );
        },
      );
      cdp.on<{ entry: { level: string; text: string } }>(
        "Log.entryAdded",
        ({ entry }) => {
          if (entry.level === "error") browserErrors.push(entry.text);
        },
      );
      cdp.on<{ response: { status: number; url: string } }>(
        "Network.responseReceived",
        ({ response }) => {
          if (response.status >= 400) {
            failedResponses.push(`${response.status} ${response.url}`);
          }
        },
      );
      cdp.on<{ errorText: string; type: string }>(
        "Network.loadingFailed",
        ({ errorText, type }) => failedResponses.push(`${type}: ${errorText}`),
      );

      const landingUrl = `${origin}${PROJECT_PATH}`;
      await cdp.send("Page.navigate", { url: landingUrl });
      await waitForBrowser(
        cdp,
        "document.readyState === 'complete' && document.querySelector('#try-static-sample')",
      );
      const landing = await evaluate<{
        title: string;
        heading: string;
        boundary: string;
        sampleHref: string;
        externalSources: string[];
      }>(
        cdp,
        `({
          title: document.title,
          heading: document.querySelector('h1').textContent.trim(),
          boundary: document.querySelector('#boundary').textContent.trim(),
          sampleHref: document.querySelector('#try-static-sample').href,
          externalSources: [...document.querySelectorAll('.source-grid a')].map(link => link.href)
        })`,
      );
      assert(
        landing.title.includes("Audio-Only Browser"),
        "landing title should identify the project",
      );
      assert(
        landing.heading.includes("Keep control local"),
        "landing should state the local boundary",
      );
      assert(
        landing.boundary.includes("does not run the browser"),
        "landing should honestly describe Pages",
      );
      assert(
        landing.sampleHref === `${origin}${PROJECT_PATH}sample/index.html`,
        "sample URL should remain under the project subpath",
      );
      assert(
        landing.externalSources.includes("https://aifoc.us/") &&
          landing.externalSources.includes("https://paul.kinlan.me/"),
        "landing should link to the live curated sources",
      );
      await capturePagesEvidence(cdp);

      await click(cdp, "#view-evidence");
      await waitForBrowser(cdp, "location.hash === '#evidence'");
      assert(
        await evaluate(cdp, "document.querySelectorAll('#evidence img').length") === 7,
        "landing should publish exactly the seven reviewed controller images",
      );
      await evaluate(
        cdp,
        "document.querySelectorAll('#evidence img').forEach(image => image.loading = 'eager')",
      );
      await waitForBrowser(
        cdp,
        "[...document.querySelectorAll('#evidence img')].every(image => image.complete && image.naturalWidth > 0)",
      );

      await cdp.send("Page.navigate", { url: landingUrl });
      await waitForBrowser(cdp, "document.readyState === 'complete'");
      await click(cdp, "#try-static-sample");
      await waitForBrowser(
        cdp,
        "location.pathname.endsWith('/sample/index.html') && document.querySelector('h1')?.textContent === 'AI Focus'",
      );

      await click(cdp, "#reveal-context");
      await waitForBrowser(
        cdp,
        "document.querySelector('#snapshot-context')?.textContent.includes('18 minute reading time')",
      );
      assert(
        await evaluate(cdp, "document.querySelector('#reveal-context').disabled") ===
          true,
        "demo reveal should visibly update control state",
      );

      await click(cdp, 'a[href="article.html"]');
      await waitForBrowser(
        cdp,
        "location.pathname.endsWith('/sample/article.html') && document.title.startsWith('How might a modern Lighthouse')",
      );
      await click(cdp, 'a[href="about.html"]');
      await waitForBrowser(
        cdp,
        "location.pathname.endsWith('/sample/about.html') && document.querySelector('#demo-email')",
      );

      await evaluate(
        cdp,
        `document.querySelector('#demo-email').value = 'pages-test@example.invalid'`,
      );
      await click(cdp, 'button[type="submit"]');
      await waitForBrowser(
        cdp,
        "location.pathname.endsWith('/sample/subscribed.html') && document.querySelector('h1')?.textContent === 'Local form demo complete'",
      );
      const confirmation = await evaluate<{ body: string; url: string }>(
        cdp,
        `({ body: document.body.textContent, url: location.href })`,
      );
      assert(
        confirmation.body.includes("No subscription was created") &&
          confirmation.url.includes("email=pages-test%40example.invalid"),
        "demo form should navigate to its visible no-subscription confirmation",
      );

      await click(cdp, 'a[href="index.html"]');
      await waitForBrowser(cdp, "location.pathname.endsWith('/sample/index.html')");
      await delay(250);
      assert(
        browserErrors.length === 0,
        `browser errors: ${browserErrors.join(" | ")}`,
      );
      assert(
        failedResponses.length === 0,
        `failed browser requests: ${failedResponses.join(" | ")}`,
      );
      assert(
        notFoundRequests.length === 0,
        `Pages server received 404s: ${notFoundRequests.join(" | ")}`,
      );

      console.log("PAGES EVIDENCE landing:", landingUrl);
      console.log("PAGES EVIDENCE reveal: featured details visible");
      console.log("PAGES EVIDENCE form:", confirmation.url);
      console.log("PAGES EVIDENCE screenshot: evidence/08-pages-subpath.png");
    } finally {
      cdp?.close();
      try {
        process.kill("SIGTERM");
      } catch {
        // Chrome already stopped.
      }
      await process.status;
      await Deno.remove(profile, { recursive: true }).catch(() => {});
      await server.shutdown();
    }
  },
});

// Keep the module rooted in the repository so permission failures are obvious.
await Deno.stat(ROOT);
