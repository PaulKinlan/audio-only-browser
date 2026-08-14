import { CDPClient } from "./cdp.ts";

type SemanticControl = {
  id: string;
  kind: string;
  role: string;
  name: string;
  href?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  disabled: boolean;
};

type SemanticSnapshot = {
  title: string;
  url: string;
  language: string;
  headings: Array<{ level: number; text: string }>;
  landmarks: Array<{ role: string; label: string }>;
  controls: SemanticControl[];
  forms: Array<{ name: string; controls: string[] }>;
  contentSummary: string;
};

type RuntimeEvaluation<T> = {
  result?: { value?: T };
  exceptionDetails?: unknown;
};

type IntentResolution = {
  status: "acted" | "unresolved";
  effects: string[];
  target?: string;
  kind?: string;
  mayNavigate?: boolean;
  message?: string;
};

type ChromeTarget = {
  type: string;
  webSocketDebuggerUrl?: string;
};

type DocumentState = {
  frameId: string;
  loaderId: string;
  url: string;
};

type FrameTreeResponse = {
  frameTree: {
    frame: {
      id: string;
      loaderId: string;
      url: string;
    };
  };
};

type PageNavigateResult = {
  errorText?: string;
  frameId: string;
  loaderId?: string;
};

type AudioBrowserOptions = {
  allowedTargetOrigins?: string[];
};

type HandlerOptions = {
  controllerPort: number;
};

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function normalizeAllowedOrigin(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid allowed target origin: ${value}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Allowed target origins must use HTTP(S): ${value}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `Allowed target origins cannot contain credentials: ${value}`,
    );
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`Configure an origin without a path: ${value}`);
  }
  return parsed.origin;
}

function configuredTargetOrigins() {
  const sampleOrigin = Deno.env.get("SAMPLE_ORIGIN") ||
    "http://127.0.0.1:9001";
  const additional = (Deno.env.get("ALLOWED_TARGET_ORIGINS") || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return [sampleOrigin, ...additional];
}

export function validateTargetUrl(
  targetUrl: unknown,
  allowedOrigins: Set<string>,
) {
  if (typeof targetUrl !== "string" || !targetUrl.trim()) {
    throw new HttpError("A target URL is required", 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new HttpError("The target URL is invalid", 400);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new HttpError("Only HTTP(S) pages can be browsed", 400);
  }
  if (parsed.username || parsed.password) {
    throw new HttpError("Target URLs cannot contain credentials", 400);
  }
  if (!allowedOrigins.has(parsed.origin)) {
    throw new HttpError(
      `Target origin is not allowed: ${parsed.origin}`,
      403,
    );
  }
  return parsed;
}

const semanticSnapshotExpression = String.raw`(() => {
    const clean = value => String(value || "").replace(/\s+/g, " ").trim();
    const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" &&
            !element.hidden && (rect.width > 0 || rect.height > 0);
    };
    const nameOf = element => clean(
        element.getAttribute("aria-label") ||
        element.getAttribute("alt") ||
        (element.labels && Array.from(element.labels).map(label => label.textContent).join(" ")) ||
        element.innerText || element.textContent ||
        element.getAttribute("placeholder") || element.getAttribute("title") ||
        element.getAttribute("name") || element.id
    );
    const selectorOf = (element, index) => element.id ? "#" + CSS.escape(element.id) :
        element.tagName.toLowerCase() + "[data-audio-index='" + index + "']";
    const candidates = Array.from(document.querySelectorAll(
        "a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link]"
    )).filter(visible);
    const controls = candidates.map((element, index) => {
        element.dataset.audioIndex = String(index);
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute("role") ||
            (tag === "a" ? "link" : tag === "button" ? "button" :
            tag === "input" || tag === "select" || tag === "textarea" ? "input" : tag);
        return {
            id: selectorOf(element, index),
            kind: tag,
            role,
            name: nameOf(element),
            href: tag === "a" ? element.href : undefined,
            type: element.getAttribute("type") || undefined,
            value: "value" in element ? clean(element.value) : undefined,
            placeholder: element.getAttribute("placeholder") || undefined,
            disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true")
        };
    });
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
        .filter(visible).map(heading => ({
            level: Number(heading.tagName.slice(1)), text: clean(heading.textContent)
        })).filter(heading => heading.text);
    const landmarks = Array.from(document.querySelectorAll("main, nav, aside, header, footer, [role]"))
        .filter(visible).slice(0, 20).map(element => ({
            role: element.getAttribute("role") || element.tagName.toLowerCase(),
            label: clean(element.getAttribute("aria-label") || element.querySelector("h1,h2,h3")?.textContent)
        }));
    const forms = Array.from(document.forms).filter(visible).map(form => ({
        name: clean(form.getAttribute("aria-label") || form.querySelector("legend")?.textContent ||
            form.getAttribute("name") || "Form"),
        controls: Array.from(form.elements).map(control => nameOf(control)).filter(Boolean)
    }));
    const contentRoot = document.querySelector("main, article") || document.body;
    return {
        title: clean(document.title), url: location.href, language: document.documentElement.lang || "",
        headings, landmarks, controls, forms,
        contentSummary: clean(contentRoot?.innerText).slice(0, 700)
    };
})()`;

const mutationObserverExpression = String.raw`(() => {
    if (globalThis.__audioBrowserObserverInstalled) return;
    globalThis.__audioBrowserObserverInstalled = true;
    const clean = value => String(value || "").replace(/\s+/g, " ").trim();
    const start = () => {
        if (!document.body || globalThis.__audioBrowserObserver) return;
        let pending = [];
        let timer;
        const flush = () => {
            timer = undefined;
            const unique = [...new Set(pending.filter(Boolean))].slice(0, 3);
            pending = [];
            if (!unique.length || typeof globalThis.audioBrowserMutation !== "function") return;
            globalThis.audioBrowserMutation(JSON.stringify({ summary: unique.join("; ").slice(0, 220) }));
        };
        globalThis.__audioBrowserObserver = new MutationObserver(records => {
            for (const record of records) {
                if (record.type === "childList") {
                    const added = Array.from(record.addedNodes).map(node => clean(node.textContent)).filter(Boolean).join(" ");
                    const removed = Array.from(record.removedNodes).map(node => clean(node.textContent)).filter(Boolean).join(" ");
                    if (added) pending.push("New content: " + added.slice(0, 150));
                    else if (removed) pending.push("Content removed: " + removed.slice(0, 120));
                } else if (record.type === "characterData") {
                    const text = clean(record.target.textContent);
                    if (text) pending.push("Text changed: " + text.slice(0, 150));
                } else if (record.type === "attributes") {
                    const element = record.target;
                    const name = clean(element.getAttribute("aria-label") || element.textContent || element.id || element.tagName);
                    if (record.attributeName === "aria-expanded") {
                        pending.push(name + " is now " + (element.getAttribute("aria-expanded") === "true" ? "expanded" : "collapsed"));
                    }
                }
            }
            if (pending.length && !timer) timer = setTimeout(flush, 80);
        });
        globalThis.__audioBrowserObserver.observe(document.body, {
            subtree: true, childList: true, characterData: true,
            attributes: true, attributeFilter: ["aria-expanded", "aria-pressed", "aria-live"]
        });
    };
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", start, { once: true });
    else start();
})()`;

function intentResolverExpression(action: string, allowedOrigins: string[]) {
  return String.raw`(() => {
        const action = ${JSON.stringify(action)};
        const allowedOrigins = new Set(${JSON.stringify(allowedOrigins)});
        const clean = value => String(value || "").toLowerCase().replace(/[^a-z0-9@._+-]+/g, " ").trim();
        const allowedDestination = value => {
            try { return allowedOrigins.has(new URL(value, location.href).origin); }
            catch { return false; }
        };
        const stop = new Set(["a","an","the","please","could","would","want","to","go","open","click","press","follow","take","me","on","in","for","field"]);
        const words = value => clean(value).split(/\s+/).filter(word => word && !stop.has(word));
        const actionWords = words(action);
        const visible = element => {
            const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && !element.hidden &&
                (rect.width > 0 || rect.height > 0) && !element.disabled;
        };
        const nameOf = element => clean(
            element.getAttribute("aria-label") ||
            (element.labels && Array.from(element.labels).map(label => label.textContent).join(" ")) ||
            element.innerText || element.textContent || element.placeholder || element.name || element.id
        );
        const describe = element => nameOf(element) || element.tagName.toLowerCase();
        const score = element => {
            const href = element.href ? new URL(element.href).pathname.replace(/[/.\-_]+/g, " ") : "";
            const haystack = clean(nameOf(element) + " " + href + " " + (element.type || "") + " " + element.tagName);
            const hayWords = new Set(words(haystack));
            let total = actionWords.reduce((sum, word) => sum + (hayWords.has(word) ? 5 :
                haystack.includes(word) && word.length > 2 ? 2 : 0), 0);
            const label = nameOf(element);
            if (label && clean(action).includes(label)) total += 8;
            if (/\b(home|start)\b/i.test(action) && /index|home/.test(haystack)) total += 5;
            if (/\b(article|read)\b/i.test(action) && element.tagName === "A") total += 2;
            if (/\b(load|show|reveal)\b/i.test(action) && element.tagName === "BUTTON") total += 2;
            return total;
        };
        const effects = [];
        const email = action.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
        const quoted = action.match(/["']([^"']+)["']/)?.[1];
        const inputs = Array.from(document.querySelectorAll("input:not([type=hidden]), textarea, select")).filter(visible);
        let input;
        let value;
        if (email) {
            input = inputs.find(element => element.type === "email") || inputs.sort((a,b) => score(b) - score(a))[0];
            value = email;
        } else if (/\b(type|enter|fill|set|choose|select)\b/i.test(action)) {
            input = inputs.sort((a,b) => score(b) - score(a))[0];
            value = quoted || action.match(/(?:with|to|as)\s+(.+?)(?:\s+(?:and|then)\s+|$)/i)?.[1];
        }
        if (input && value) {
            input.focus();
            if (input.tagName === "SELECT") {
                const option = Array.from(input.options).sort((a,b) => score(b) - score(a))[0];
                if (option) input.value = option.value;
            } else {
                const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
                if (setter) setter.call(input, value); else input.value = value;
            }
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            effects.push("Entered " + value + " in " + describe(input));
        }
        const wantsSubmit = /\b(submit|send|sign\s*up|subscribe|continue|finish)\b/i.test(action);
        if (input && wantsSubmit) {
            const form = input.form;
            if (form && !allowedDestination(form.action || location.href)) {
                return { status: "unresolved", effects: [], message: "That form submits outside the configured browsing origins." };
            }
            const submit = form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
            if (submit && visible(submit)) {
                effects.push("Activated " + describe(submit));
                submit.click();
                return { status: "acted", effects, target: describe(submit), kind: "form-submit", mayNavigate: true };
            }
            if (form) {
                effects.push("Submitted form");
                form.requestSubmit();
                return { status: "acted", effects, target: describe(input), kind: "form-submit", mayNavigate: true };
            }
        }
        if (input && effects.length) {
            return { status: "acted", effects, target: describe(input), kind: "form-input", mayNavigate: false };
        }
        const candidates = Array.from(document.querySelectorAll("a[href], button, [role=link], [role=button], input[type=submit]"))
            .filter(visible)
            .filter(element => element.tagName !== "A" || allowedDestination(element.href));
        const ranked = candidates.map(element => ({ element, score: score(element) })).sort((a,b) => b.score - a.score);
        if (!ranked.length || ranked[0].score <= 0) {
            return { status: "unresolved", effects: [], message: "I could not match that request to an available action." };
        }
        const target = ranked[0].element;
        const label = describe(target);
        target.focus();
        target.click();
        return {
            status: "acted", effects: ["Activated " + label], target: label,
            kind: target.tagName === "A" ? "link" : "button", mayNavigate: target.tagName === "A"
        };
    })()`;
}

export class AudioBrowser {
  private cdp = new CDPClient();
  private chromeProc: Deno.ChildProcess | null = null;
  private updates: string[] = [];
  private chromeProfile = "";
  private allowedTargetOrigins: Set<string>;
  private domContentLoadedLoaders = new Set<string>();

  constructor(options: AudioBrowserOptions = {}) {
    const origins = options.allowedTargetOrigins ?? configuredTargetOrigins();
    this.allowedTargetOrigins = new Set(origins.map(normalizeAllowedOrigin));
    if (!this.allowedTargetOrigins.size) {
      throw new Error("At least one allowed target origin is required");
    }
  }

  async launch() {
    const executable = Deno.env.get("CHROME_BIN") || "google-chrome-stable";
    const debugPort = Number(Deno.env.get("CHROME_DEBUG_PORT") || "9222");
    this.chromeProfile = await Deno.makeTempDir({
      prefix: "audio-browser-chrome-",
    });
    this.chromeProc = new Deno.Command(executable, {
      args: [
        "--headless=new",
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${this.chromeProfile}`,
        "--disable-gpu",
        "--no-sandbox",
        "--disable-background-networking",
        "--no-first-run",
        "about:blank",
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();

    let wsUrl = "";
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const targets = await response.json();
        wsUrl = targets.find((target: ChromeTarget) =>
          target.type === "page"
        )?.webSocketDebuggerUrl || "";
        if (wsUrl) break;
      } catch {
        // Chrome is still starting.
      }
      await delay(100);
    }
    if (!wsUrl) throw new Error("Chrome did not expose a page target");

    await this.cdp.connect(wsUrl);
    await Promise.all([
      this.cdp.send("Page.enable"),
      this.cdp.send("DOM.enable"),
      this.cdp.send("Runtime.enable"),
      this.cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }),
      this.cdp.send("Fetch.enable", {
        patterns: [{ resourceType: "Document", requestStage: "Request" }],
      }),
    ]);
    this.cdp.on<{ loaderId: string; name: string }>(
      "Page.lifecycleEvent",
      (event) => {
        if (event.name === "DOMContentLoaded") {
          this.domContentLoadedLoaders.add(event.loaderId);
        }
      },
    );
    this.cdp.on<{ requestId: string; request: { url: string } }>(
      "Fetch.requestPaused",
      (event) => void this.continueAllowedDocumentRequest(event),
    );
    await this.cdp.send("Runtime.addBinding", { name: "audioBrowserMutation" });
    await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: mutationObserverExpression,
    });
    this.cdp.on<{ name: string; payload: string }>(
      "Runtime.bindingCalled",
      (event) => {
        if (event.name !== "audioBrowserMutation") return;
        try {
          const summary = JSON.parse(event.payload).summary?.trim();
          if (summary && this.updates.at(-1) !== summary) {
            this.updates.push(summary);
            if (this.updates.length > 20) this.updates.shift();
          }
        } catch {
          // Ignore malformed messages from browsed pages.
        }
      },
    );
  }

  async close() {
    this.cdp.close();
    try {
      this.chromeProc?.kill("SIGTERM");
    } catch { /* already stopped */ }
    if (this.chromeProc) {
      try {
        await this.chromeProc.status;
      } catch { /* already reaped */ }
    }
    if (this.chromeProfile) {
      try {
        await Deno.remove(this.chromeProfile, { recursive: true });
      } catch { /* best effort */ }
    }
  }

  async navigate(targetUrl: unknown) {
    const parsed = validateTargetUrl(targetUrl, this.allowedTargetOrigins);
    const previousDocument = await this.currentDocument();
    this.updates = [];
    const result = await this.cdp.send<PageNavigateResult>(
      "Page.navigate",
      { url: parsed.href },
    );
    if (result.errorText) throw new Error(result.errorText);
    await this.waitForNewDocument(previousDocument, 8_000, result.loaderId);
    await this.cdp.send("Runtime.evaluate", {
      expression: mutationObserverExpression,
    });
    this.updates = [];
    return await this.snapshot();
  }

  async snapshot(): Promise<SemanticSnapshot> {
    const response = await this.cdp.send<RuntimeEvaluation<SemanticSnapshot>>(
      "Runtime.evaluate",
      {
        expression: semanticSnapshotExpression,
        returnByValue: true,
        awaitPromise: true,
      },
    );
    if (response.exceptionDetails) {
      throw new Error("Unable to inspect the current page");
    }
    if (!response.result?.value) {
      throw new Error("The page returned no semantic snapshot");
    }
    return response.result.value;
  }

  async resolveIntent(action: string) {
    const previousDocument = await this.currentDocument();
    const response = await this.cdp.send<RuntimeEvaluation<IntentResolution>>(
      "Runtime.evaluate",
      {
        expression: intentResolverExpression(
          action,
          [...this.allowedTargetOrigins],
        ),
        returnByValue: true,
        awaitPromise: true,
      },
    );
    const resolution = response.result?.value;
    if (!resolution || resolution.status === "unresolved") return resolution;
    if (resolution.mayNavigate) {
      await this.waitForNewDocument(previousDocument, 8_000);
    } else {
      await delay(120);
    }
    return resolution;
  }

  takeUpdates() {
    const updates = this.updates.slice();
    this.updates = [];
    return updates;
  }

  private async continueAllowedDocumentRequest(
    event: { requestId: string; request: { url: string } },
  ) {
    try {
      validateTargetUrl(event.request.url, this.allowedTargetOrigins);
      await this.cdp.send("Fetch.continueRequest", {
        requestId: event.requestId,
      });
    } catch {
      await this.cdp.send("Fetch.failRequest", {
        requestId: event.requestId,
        errorReason: "BlockedByClient",
      }).catch(() => {});
    }
  }

  private async currentDocument(): Promise<DocumentState> {
    const response = await this.cdp.send<FrameTreeResponse>(
      "Page.getFrameTree",
    );
    const frame = response.frameTree.frame;
    return {
      frameId: frame.id,
      loaderId: frame.loaderId,
      url: frame.url,
    };
  }

  private async waitForNewDocument(
    previous: DocumentState,
    timeoutMs: number,
    expectedLoaderId?: string,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const document = await this.currentDocument();
        const changed = document.loaderId !== previous.loaderId ||
          document.url !== previous.url;
        const expectedDocument = expectedLoaderId
          ? document.loaderId === expectedLoaderId
          : changed;
        if (changed && expectedDocument) {
          const response = await this.cdp.send<
            RuntimeEvaluation<{ ready: string; url: string }>
          >("Runtime.evaluate", {
            expression: `({ ready: document.readyState, url: location.href })`,
            returnByValue: true,
          }, 1_000);
          const state = response.result?.value;
          const ready = state && state.url === document.url &&
            (state.ready === "interactive" || state.ready === "complete");
          const domContentLoaded = this.domContentLoadedLoaders.has(
            document.loaderId,
          );
          if (ready && domContentLoaded) return;
        }
      } catch {
        // A navigation can temporarily destroy the execution context.
      }
      await delay(50);
    }
    throw new Error("Timed out waiting for a new page document");
  }
}

function nextStepNarration(snapshot: SemanticSnapshot) {
  const location = snapshot.title || snapshot.headings[0]?.text ||
    "an untitled page";
  const topic =
    snapshot.headings[0]?.text && snapshot.headings[0].text !== location
      ? ` The main topic is ${snapshot.headings[0].text}.`
      : "";
  const available = snapshot.controls.filter((control) =>
    !control.disabled && control.name
  ).slice(0, 4);
  if (!available.length) {
    return `You are on ${location}.${topic} There are no obvious actions on this page.`;
  }
  const actions = available.map((control) => {
    if (control.role === "link") return `follow ${control.name}`;
    if (control.type === "email" || control.kind === "input") {
      return `enter ${control.name}`;
    }
    return `activate ${control.name}`;
  });
  return `You are on ${location}.${topic} Next steps: ${actions.join(", ")}.`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const frontendFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

async function frontendResponse(pathname: string) {
  const file = frontendFiles.get(pathname);
  if (!file) return null;
  const [name, contentType] = file;
  const body = await Deno.readFile(
    new URL(`../frontend/${name}`, import.meta.url),
  );
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const protectedControllerPaths = new Set([
  "/session",
  "/snapshot",
  "/intent",
  "/updates",
]);

function controllerOriginForPort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid controller port: ${port}`);
  }
  return new URL(`http://127.0.0.1:${port}`);
}

export function createHandler(
  browser: AudioBrowser,
  options: HandlerOptions,
) {
  const controller = controllerOriginForPort(options.controllerPort);
  return async (request: Request) => {
    const url = new URL(request.url);
    if (protectedControllerPaths.has(url.pathname)) {
      const requestHost = request.headers.get("Host");
      const requestOrigin = request.headers.get("Origin");
      if (
        requestHost !== controller.host ||
        (requestOrigin !== null && requestOrigin !== controller.origin)
      ) {
        return json(
          { error: "Requests must come from the configured controller origin" },
          403,
        );
      }
    }
    try {
      if (request.method === "GET") {
        const frontend = await frontendResponse(url.pathname);
        if (frontend) return frontend;
      }
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true });
      }
      if (url.pathname === "/session" && request.method === "POST") {
        const { targetUrl } = await request.json();
        const snapshot = await browser.navigate(targetUrl);
        return json({ narration: nextStepNarration(snapshot), snapshot });
      }
      if (url.pathname === "/snapshot" && request.method === "GET") {
        const snapshot = await browser.snapshot();
        return json({ snapshot, narration: nextStepNarration(snapshot) });
      }
      if (url.pathname === "/intent" && request.method === "POST") {
        const { action } = await request.json();
        if (typeof action !== "string" || !action.trim()) {
          return json({ error: "An action is required" }, 400);
        }
        const resolution = await browser.resolveIntent(action.trim());
        if (!resolution || resolution.status === "unresolved") {
          return json({
            result: resolution?.message || "I could not resolve that action.",
            resolution,
          }, 422);
        }
        const snapshot = await browser.snapshot();
        const nextStep = nextStepNarration(snapshot);
        return json({
          result: resolution.effects.join(". "),
          resolution,
          snapshot,
          nextStep,
          narration: `${resolution.effects.join(". ")}. ${nextStep}`,
        });
      }
      if (url.pathname === "/updates" && request.method === "GET") {
        return json({ updates: browser.takeUpdates() });
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      return json({
        error: error instanceof Error ? error.message : "Unexpected error",
      }, status);
    }
  };
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (import.meta.main) {
  const browser = new AudioBrowser();
  await browser.launch();
  const port = Number(Deno.env.get("PORT") || "9090");
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port,
    onListen: ({ port }) =>
      console.log(`Audio browser listening on http://127.0.0.1:${port}`),
  }, createHandler(browser, { controllerPort: port }));
  let shuttingDown = false;
  const signals = ["SIGINT", "SIGTERM"] as const;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const signal of signals) Deno.removeSignalListener(signal, shutdown);
    await server.shutdown();
    await browser.close();
  };
  addEventListener("unload", () => {
    void browser.close();
  });
  for (const signal of signals) Deno.addSignalListener(signal, shutdown);
  await server.finished;
}
