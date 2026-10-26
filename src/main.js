// src/main.js  →  CI me esbuild ise bundle karke www/app.js banata hai
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { BackgroundMode } from '@anuradev/capacitor-background-mode';

const WORKER_URL = 'https://jarvis-api.sachinsainimbd4339.workers.dev';
const LANG = 'hi-IN';
const LISTEN_TIMEOUT = 12000; // Google recognizer itna sunta hai, phir restart

const orb = document.getElementById('orb');
const statusText = document.getElementById('statusText');
const transcriptDiv = document.getElementById('transcript');
const errorBox = document.getElementById('errorBox');
const core = document.getElementById('core');

let history = [];
let isSpeaking = false;
let isThinking = false;
let activeLoop = false;
let micBusy = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setOrb = (cls) => { orb.className = cls; };
const setStatus = (t) => { statusText.innerText = t; };
const showError = (t) => { errorBox.innerText = t; };

/* ---------- permissions + background service ---------- */
async function ensurePermissions() {
  const res = await SpeechRecognition.requestPermissions();
  if (res.speechRecognition !== 'granted') {
    throw new Error('Microphone permission nahi mili. App Settings se allow karein.');
  }
  try { await BackgroundMode.requestNotificationsPermission(); } catch (e) {}
}

async function startBackgroundService() {
  // Android 14+ rule: service foreground me hi start hota hai (isliye tap zaroori)
  await BackgroundMode.enable({
    title: 'JARVIS',
    text: 'Assistant sun raha hai...',
    color: '#00485c',
    resume: true,
    silent: false,
    allowClose: false,
    allowMicrophoneInBackground: true,
    disableWebViewOptimization: true,
  });
}

async function askBatteryExemption() {
  try {
    const s = await BackgroundMode.checkBatteryOptimizations();
    if (s.enabled) await BackgroundMode.requestDisableBatteryOptimizations();
  } catch (e) {}
}

/* ---------- mic loop ---------- */
function stopMicSafe() {
  micBusy = false;
  SpeechRecognition.stop().catch(() => {});
}

async function startMicSafe() {
  if (!activeLoop || isSpeaking || isThinking || micBusy) return;
  micBusy = true;
  setStatus('JARVIS SUN RAHA HAI...');
  setOrb('center-orb listening-mode');

  let text = null;
  let timedOut = false;
  try {
    const p = SpeechRecognition.start({
      language: LANG, maxResults: 1, popup: false, partialResults: false, prompt: 'Boliye',
    });
    const r = await Promise.race([p, sleep(LISTEN_TIMEOUT).then(() => '__timeout__')]);
    if (r === '__timeout__') timedOut = true;
    else if (r && r.matches && r.matches[0]) text = r.matches[0].trim();
  } catch (e) {
    // Google recognizer kabhi kabhi "no match / busy" deta hai - loop mat todo
  }

  if (timedOut) await SpeechRecognition.stop().catch(() => {});
  micBusy = false;
  if (!activeLoop) return;

  if (text) {
    transcriptDiv.innerText = `Aap: "${text}"`;
    setOrb('center-orb thinking-mode');
    setStatus('JARVIS SOCH RAHA HAI...');
    handleCommand(text);
  } else {
    setTimeout(startMicSafe, 500);
  }
}

/* ---------- TTS ---------- */
async function speak(text, onFinish) {
  transcriptDiv.innerText = `JARVIS: ${text}`;
  isThinking = false;
  stopMicSafe();
  isSpeaking = true;
  setOrb('center-orb speaking');
  setStatus('JARVIS BOL RAHA HAI...');

  // mic echo na sun le, isliye kam se kam itna wait karo
  const minWait = 800 + text.length * 75;
  try {
    await Promise.all([
      TextToSpeech.speak({ text, lang: LANG, rate: 1.0, pitch: 0.7, volume: 1.0, queueStrategy: 0 }),
      sleep(minWait),
    ]);
  } catch (e) {
    if (activeLoop) showError('TTS: ' + (e.message || e));
    await sleep(Math.min(minWait, 3000));
  }

  isSpeaking = false;
  setOrb('center-orb');
  if (onFinish) onFinish();
}

async function shutdown() {
  activeLoop = false;
  isSpeaking = false;
  isThinking = false;
  micBusy = false;
  SpeechRecognition.stop().catch(() => {});
  TextToSpeech.stop().catch(() => {});
  BackgroundMode.disable().catch(() => {});
  setOrb('center-orb');
  setStatus('STANDBY - TAP TO START');
  showError('');
}

/* ---------- commands ---------- */
function handleCommand(text) {
  isThinking = true;
  const t = text.toLowerCase();

  if (/(band karo|so jao|stop jarvis|alvida)/.test(t)) {
    activeLoop = false;
    speak('Standby par ja raha hoon sir.', shutdown);
    return;
  }
  if (/(time|samay|baje|टाइम|समय)/.test(t)) {
    speak(`Sir, abhi ${new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })} ho rahe hain.`, () => startMicSafe());
    return;
  }
  if (/(date|tarikh|din|तारीख)/.test(t)) {
    speak(`Sir, aaj ${new Date().toLocaleDateString('hi-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} hai.`, () => startMicSafe());
    return;
  }
  if (/(youtube|यूट्यूब)/.test(t) && /(khol|open)/.test(t)) {
    speak('YouTube khol raha hoon sir.', () => startMicSafe());
    window.location.href = 'vnd.youtube://';
    return;
  }
  if (/(google|गूगल)/.test(t) && /(khol|open)/.test(t)) {
    speak('Google khol raha hoon sir.', () => startMicSafe());
    window.location.href = 'googlechrome://';
    return;
  }
  askGemini(text);
}

async function askGemini(promptText) {
  showError('');
  history.push({ role: 'user', parts: [{ text: promptText }] });
  if (history.length > 14) history = history.slice(-14);
  if (history[0].role !== 'user') history.shift();

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history }),
      signal: AbortSignal.timeout(25000),
    });
    const data = await res.json();

    if (!res.ok || !data.reply) {
      history.pop();
      showError('Worker Error: ' + (data.error || res.status));
      speak('Sir, connection mein issue aaya hai.', () => startMicSafe());
      return;
    }

    history.push({ role: 'model', parts: [{ text: data.reply }] });
    speak(data.reply, () => startMicSafe());
  } catch (err) {
    history.pop();
    showError('Connection error: ' + err.message);
    speak('Sir, internet se connect nahi ho pa raha.', () => startMicSafe());
  }
}

/* ---------- core tap ---------- */
core.onclick = async () => {
  if (activeLoop) { await shutdown(); return; }

  activeLoop = true;
  showError('');
  setStatus('PERMISSIONS MAANG RAHE HAIN...');
  setOrb('center-orb');

  try {
    await ensurePermissions();          // mic + notification
    await startBackgroundService();     // foreground service ON
    askBatteryExemption();              // battery saver popup
  } catch (e) {
    activeLoop = false;
    showError(e.message || String(e));
    setStatus('STANDBY - TAP TO START');
    return;
  }

  speak('Namaste sir. Jarvis taiyaar hai. Kahiye, main kya karoon?', () => startMicSafe());
};
