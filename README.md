# audio-only-browser

An audio-first way to browse the web. This is not a traditional screen reader
and does not recite an ARIA tree. A Deno server drives a real headless Chrome
session over the Chrome DevTools Protocol (CDP), builds a compact semantic page
snapshot, and maps a person's natural-language request to links, buttons and
forms.

## What it does

1. **Semantic snapshots** describe the page title, URL, headings, landmarks,
   controls, forms and a short content excerpt.
2. **Intent-driven actions** let someone say or type requests such as “read the
   article about web development”, “load the comments”, or “enter
   listener@example.com and sign up”. The matching control is operated in the
   real page through CDP.
3. **Next-step narration** says where the browser is and identifies a few useful
   actions after each navigation or interaction.
4. **DOM-update narration** uses a `MutationObserver` inside the browsed page to
   report concise added, removed or changed content.
5. **Voice and text UI** uses the Web Speech recognition and `speechSynthesis`
   APIs when available, with a fully functional text form as a fallback.

The sample site is a playable multi-page journey covering link navigation, a
delayed comments update, an article, a newsletter form and a confirmation page.

## Run locally

Chrome must be available as `google-chrome-stable`. Set `CHROME_BIN` if it has
another path.

```sh
# terminal 1: CDP driver and API on :9090
cd server
deno run -A main.ts

# terminal 2: sample journey on :9001
cd sample-site
python3 -m http.server 9001

# terminal 3: voice UI on :9000
cd frontend
python3 -m http.server 9000
```

Open <http://localhost:9000>. The default target is
<http://localhost:9001/index.html>.

The server also accepts `PORT` and `CHROME_DEBUG_PORT` environment variables.
The UI can target another API endpoint with `?server=http://host:port`.

## API

- `POST /session` with `{ "targetUrl": "https://…" }` starts browsing and
  returns a narration plus semantic snapshot.
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

The integration test starts temporary static servers and isolated Chrome
profiles. It drives the API's real CDP browser through button, link and form
intents, checks mutation narration and next steps, then opens the frontend in a
second real Chrome session to verify recognition and synthesis seam calls plus
typed fallback input.

```sh
deno test -A tests/browser_integration_test.ts
```

Test processes and Chrome profiles use temporary locations; they do not write
runtime response or log artifacts into the repository.

## Deployment note

The frontend is static, but the functional demo requires Deno plus a Chrome
binary. It cannot run as a complete application on GitHub Pages or a Deno Deploy
runtime that does not expose Chrome. Host the CDP driver on a machine with
Chrome and point the frontend at it.
