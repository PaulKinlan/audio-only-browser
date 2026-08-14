const startBtn = document.getElementById('start-session');
const targetUrlInput = document.getElementById('target-url');
const micBtn = document.getElementById('mic-btn');
const narrationDisplay = document.getElementById('narration-display');
const transcriptDisplay = document.getElementById('transcript-display');
const interfaceDiv = document.querySelector('.interface');
const sessionSetup = document.querySelector('.session-setup');

const SERVER_URL = 'http://localhost:9090';

// Initialize Web Speech API
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = new SpeechRecognition();
recognition.continuous = false;
recognition.interimResults = false;

/* 
 * ======================================================================
 * WebRTC Seam Documentation
 * ======================================================================
 * In a production version, instead of using the local Web Speech API 
 * (recognition & speechSynthesis), this client would establish a WebRTC 
 * peer connection to a media server / voice model endpoint.
 * 
 * Flow for WebRTC Integration:
 * 1. Request microphone access via `navigator.mediaDevices.getUserMedia({ audio: true })`.
 * 2. Create an `RTCPeerConnection` and add the audio track to it.
 * 3. Receive a remote audio track (the voice model's response) and play it via an `<audio>` element.
 * 4. The server receives the raw audio, uses an STT/LLM pipeline to resolve intents, 
 *    drives the CDP browser, and streams TTS back down the WebRTC connection.
 * 5. This frontend would purely act as a media gateway rather than doing STT/TTS locally.
 * ======================================================================
 */

function speak(text) {
    narrationDisplay.innerText = text;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);
}

startBtn.addEventListener('click', async () => {
    const targetUrl = targetUrlInput.value;
    if (!targetUrl) return;

    startBtn.disabled = true;
    startBtn.innerText = "Starting...";

    try {
        const res = await fetch(`${SERVER_URL}/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUrl })
        });
        const data = await res.json();
        
        sessionSetup.style.display = 'none';
        interfaceDiv.style.display = 'block';
        
        speak(data.narration);
        startPollingUpdates();
    } catch (e) {
        alert("Failed to connect to server. Is it running?");
        startBtn.disabled = false;
        startBtn.innerText = "Start Session";
    }
});

micBtn.addEventListener('mousedown', () => {
    transcriptDisplay.innerText = "Listening...";
    micBtn.classList.add('listening');
    window.speechSynthesis.cancel();
    recognition.start();
});

recognition.addEventListener('result', async (e) => {
    const transcript = e.results[0][0].transcript;
    transcriptDisplay.innerText = transcript;
    
    // Send intent to server
    try {
        const res = await fetch(`${SERVER_URL}/intent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: transcript })
        });
        const data = await res.json();
        speak(data.narration);
    } catch (err) {
        console.error(err);
        speak("Sorry, I could not reach the server.");
    }
});

recognition.addEventListener('end', () => {
    micBtn.classList.remove('listening');
});

// Polling for DOM updates
async function startPollingUpdates() {
    setInterval(async () => {
        try {
            const res = await fetch(`${SERVER_URL}/updates`);
            const data = await res.json();
            if (data.updates && data.updates.length > 0) {
                // Synthesize the first update (simplified)
                speak(`Update: ${data.updates[0]}`);
            }
        } catch (e) {
            // ignore network errors on poll
        }
    }, 2000);
}
