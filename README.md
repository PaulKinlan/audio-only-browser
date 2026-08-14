# audio-only-browser

An audio-only way to browse the web. This is not a traditional screen reader (it doesn't recite ARIA trees). Instead, a server runs a real browser (headless Chrome via CDP), and the user interacts by voice. LLMs (or heuristics, in this demo) help navigate the sites by understanding the user's intent.

## The Concept
1. **Reasoning about links**: Summarizes the "next steps" instead of doing a full DOM dump.
2. **Describing actions**: Let the user describe actions ("go to the article about X"), which the server resolves to elements and navigates.
3. **DOM-update narration**: When the DOM changes, the browser narrates what changed concisely.
4. **Voice models via WebRTC**: Currently uses built-in Web Speech API and SpeechSynthesis, with a seam for WebRTC integration.

## WebRTC Seam
In a production version, the Web Speech API would be replaced by a WebRTC connection to a voice model. 
See `frontend/app.js` for the `WebRTCSeam` comment block which explains where to integrate the bidirectional audio stream.

## Running the Project
1. Run the server (Deno):
   `cd server && deno run -A main.ts`
   (Runs on port 9090)
2. Serve the frontend and sample site:
   You can use python or Deno's built-in file server.
   `cd frontend && python3 -m http.server 9000`
   `cd sample-site && python3 -m http.server 9001`
3. Open `http://localhost:9000` in your browser. (The app expects the sample site on `http://localhost:9001/index.html`)

## Deployment note

This demo needs a running Deno server + headless Chrome (it drives a real browser via CDP), so it
does NOT run on GitHub Pages (static-only). Deploy it to Deno Deploy (or run locally):

```sh
cd server && deno run -A main.ts     # CDP driver on :9090
cd sample-site && python3 -m http.server 9001 &
cd frontend && python3 -m http.server 9000 &
```

Note: Deno Deploy does not expose a Chrome binary, so the CDP driver needs a separate machine with
headless Chrome; the frontend can be hosted statically. This is documented, not silently force-fit
to static hosting.
