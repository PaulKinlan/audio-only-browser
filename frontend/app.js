const elements = {
  start: document.getElementById("start-session"),
  target: document.getElementById("target-url"),
  mic: document.getElementById("mic-btn"),
  narration: document.getElementById("narration-display"),
  transcript: document.getElementById("transcript-display"),
  interface: document.querySelector(".interface"),
  setup: document.querySelector(".session-setup"),
  intentForm: document.getElementById("intent-form"),
  textIntent: document.getElementById("text-intent"),
  connectionStatus: document.getElementById("connection-status"),
};

const SERVER_URL = location.origin;
let pollingTimer;

class WebSpeechVoiceIO {
  constructor({ onTranscript, onStatus }) {
    this.onTranscript = onTranscript;
    this.onStatus = onStatus;
    const Recognition = globalThis.SpeechRecognition ||
      globalThis.webkitSpeechRecognition;
    this.recognition = Recognition ? new Recognition() : null;
    if (!this.recognition) return;
    this.recognition.continuous = false;
    this.recognition.interimResults = false;
    this.recognition.lang = document.documentElement.lang || "en-GB";
    this.recognition.addEventListener("result", (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim();
      if (transcript) this.onTranscript(transcript);
    });
    this.recognition.addEventListener("end", () => this.onStatus("idle"));
    this.recognition.addEventListener("error", (event) => {
      this.onStatus(
        "error",
        `Voice input is unavailable (${event.error}). Use the text box instead.`,
      );
    });
  }

  speak(text) {
    elements.narration.textContent = text;
    if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) {
      return false;
    }
    globalThis.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = document.documentElement.lang || "en-GB";
    globalThis.speechSynthesis.speak(utterance);
    return true;
  }

  startListening() {
    if (!this.recognition) {
      this.onStatus(
        "error",
        "Voice recognition is not supported here. Type the action below.",
      );
      elements.textIntent.focus();
      return false;
    }
    try {
      globalThis.speechSynthesis?.cancel();
      this.recognition.start();
      this.onStatus("listening");
      return true;
    } catch {
      this.onStatus(
        "error",
        "The microphone is already active. You can type the action below.",
      );
      return false;
    }
  }
}

/*
 * WebRTC integration seam:
 * Replace WebSpeechVoiceIO with an object exposing speak(text) and
 * startListening(). Send the microphone MediaStream over RTCPeerConnection,
 * call submitIntent() with transcripts from the remote model, and play its
 * returned audio track. The text form remains the non-audio fallback.
 */
const voice = new WebSpeechVoiceIO({
  onTranscript: (transcript) => submitIntent(transcript),
  onStatus: (status, message) => {
    elements.mic.classList.toggle("listening", status === "listening");
    elements.mic.setAttribute("aria-pressed", String(status === "listening"));
    if (status === "listening") elements.transcript.textContent = "Listening…";
    if (message) elements.transcript.textContent = message;
  },
});

async function request(path, options = {}) {
  const response = await fetch(`${SERVER_URL}${path}`, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      data.error || data.result || `Request failed (${response.status})`,
    );
  }
  return data;
}

async function startSession() {
  const targetUrl = elements.target.value.trim();
  if (!targetUrl) return;
  elements.start.disabled = true;
  elements.start.textContent = "Starting…";
  elements.connectionStatus.textContent = "Connecting to the headless browser…";
  try {
    const data = await request("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUrl }),
    });
    elements.setup.hidden = true;
    elements.interface.hidden = false;
    elements.connectionStatus.textContent = `Connected to ${
      data.snapshot.title || data.snapshot.url
    }`;
    voice.speak(data.narration);
    startPollingUpdates();
    elements.textIntent.focus();
  } catch (error) {
    elements.connectionStatus.textContent = error.message;
    elements.start.disabled = false;
    elements.start.textContent = "Start session";
  }
}

async function submitIntent(action) {
  const cleaned = action.trim();
  if (!cleaned) return;
  elements.transcript.textContent = cleaned;
  elements.textIntent.value = "";
  elements.textIntent.disabled = true;
  try {
    const data = await request("/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: cleaned }),
    });
    voice.speak(data.narration);
    elements.connectionStatus.textContent = `Now browsing ${
      data.snapshot.title || data.snapshot.url
    }`;
  } catch (error) {
    voice.speak(`Sorry, ${error.message}`);
  } finally {
    elements.textIntent.disabled = false;
    elements.textIntent.focus();
  }
}

function startPollingUpdates() {
  clearInterval(pollingTimer);
  pollingTimer = setInterval(async () => {
    try {
      const data = await request("/updates");
      if (data.updates?.length) {
        voice.speak(`Page update: ${data.updates.slice(0, 2).join(". ")}`);
      }
    } catch {
      // A later poll can recover without interrupting the user.
    }
  }, 750);
}

elements.start.addEventListener("click", startSession);
elements.mic.addEventListener("click", () => voice.startListening());
elements.intentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitIntent(elements.textIntent.value);
});

globalThis.audioBrowserApp = { startSession, submitIntent, voice };
