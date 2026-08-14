# audio-only-browser

An audio-first way to browse an explicitly allowlisted web origin. This is not a
traditional screen reader and does not recite an ARIA tree. A loopback-only Deno
server drives a real headless Chrome session over the Chrome DevTools Protocol
(CDP), builds a compact semantic page snapshot, and maps a person's
natural-language request to links, buttons and forms.

## What it does

1. **Semantic snapshots** describe the page title, URL, headings, landmarks,
   controls, forms and a short content excerpt.
2. **Intent-driven actions** operate a matching control in the real page.
3. **Navigation readiness** waits for a new document loader or URL and its
   `DOMContentLoaded` lifecycle event before taking the next snapshot.
4. **Next-step and DOM-update narration** keep the listener oriented after
   navigation and dynamic page changes.
5. **Voice and text UI** uses Web Speech APIs when available, with a functional
   text form as fallback.

## Included content snapshot

`sample-site/` is a dated local, curated mapping of real content from Paul
Kinlan's `https://aifoc.us/` and `https://paul.kinlan.me/`, captured on **14
August 2026**. It includes the AI Focus introduction, a shortened mapping of
“how might a modern Lighthouse work with large language models?”, and author
context. Each page identifies its source and snapshot status.

Two minimal interactions are deliberately not copied from the live sites and
are labelled **demo-only** in the pages:

- a button that reveals featured-essay details after a short delay, to exercise
  DOM-update narration;
- a local email form and confirmation page, to exercise form intent handling.
  It creates no subscription and stores or sends no submitted information.

## Run locally

Chrome must be available as `google-chrome-stable`. Set `CHROME_BIN` if it has
another path.

```sh
# terminal 1: curated content snapshot on :9001
cd sample-site
python3 -m http.server 9001 --bind 127.0.0.1

# terminal 2: same-origin frontend, API and CDP driver on :9090
cd server
deno run -A main.ts
```

Open <http://127.0.0.1:9090/>. The API and frontend share that origin; the API
does not provide wildcard CORS and rejects requests carrying a different
`Origin`. The Deno listener and sample command bind only to loopback.

The default browsable origin is `http://127.0.0.1:9001`. Configure a different
sample origin, or additional exact HTTP(S) origins, before starting the server:

```sh
SAMPLE_ORIGIN=http://127.0.0.1:9001 \
ALLOWED_TARGET_ORIGINS=https://aifoc.us,https://paul.kinlan.me \
deno run -A main.ts
```

`SAMPLE_ORIGIN` and each comma-separated `ALLOWED_TARGET_ORIGINS` entry must be
an origin only (scheme, host and optional port; no path or credentials). Session
targets, link destinations, form actions, redirects and top-level document
requests are constrained to that set. The server also accepts `PORT` and
`CHROME_DEBUG_PORT`.

## API

All API calls are same-origin with the served frontend.

- `POST /session` with `{ "targetUrl": "http://allowed-origin/…" }` starts
  browsing and returns a narration plus semantic snapshot.
- `POST /intent` with `{ "action": "natural language request" }` operates the
  matched page control and returns the effect, updated snapshot and next steps.
- `GET /snapshot` returns the current semantic snapshot.
- `GET /updates` drains concise DOM-update messages.
- `GET /health` confirms the API is ready.

## Voice integration seam

`frontend/app.js` keeps voice I/O behind `WebSpeechVoiceIO`. A production WebRTC
implementation can replace its `speak(text)` and `startListening()` methods,
send microphone audio to a remote voice model, pass remote transcripts to
`submitIntent()`, and play the returned audio track. The text action form
remains available regardless of the audio transport.

## Test

The integration test starts an isolated sample server and Chrome profiles. It
covers the curated link/button/form journey, mutation narration, a delayed CDP
navigation regression, target-origin and same-origin request rejection, and the
frontend recognition/synthesis seams.

```sh
deno test -A tests/browser_integration_test.ts
```

Test processes and Chrome profiles use temporary locations; they do not write
runtime response or log artifacts into the repository. Local `*.log` and
`intent.json`, `session.json` and `updates.json` runtime captures under the
frontend, server and sample directories are ignored without being deleted.

## Deployment note

The functional demo requires Deno plus a Chrome binary. It cannot run as a
complete application on GitHub Pages or a Deno Deploy runtime that does not
expose Chrome. Keep the controller loopback-only unless a separate authenticated,
origin-restricted control plane is designed.
