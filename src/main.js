// src/main.js — CI ise bundle karke www/app.js banata hai
import { AppLauncher } from '@capacitor/app-launcher';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { BackgroundMode } from '@anuradev/capacitor-background-mode';

const WORKER_URL = 'https://jarvis-api.sachinsainimbd4339.workers.dev';
const LANG = 'hi-IN';
const LISTEN_TIMEOUT = 12000;
const MAX_HISTORY = 8; // chhoti history = tez jawab

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

/* ---------- apps jo voice se khulenge ---------- */
const APPS = {
  youtube:   { name: 'YouTube',    urls: ['vnd.youtube://', 'https://www.youtube.com'] },
  whatsapp:  { name: 'WhatsApp',   urls: ['whatsapp://', 'https://wa.me/'] },
  instagram: { name: 'Instagram',  urls: ['instagram://app', 'https://www.instagram.com'] },
  facebook:  { name: 'Facebook',   urls: ['fb://', 'https://www.facebook.com'] },
  telegram:  { name: 'Telegram',   urls: ['tg://', 'https://t.me'] },
  chrome:    { name: 'Chrome',     urls: ['googlechrome://', 'https://www.google.com'] },
  gmail:     { name: 'Gmail',      urls: ['googlegmail://', 'https://mail.google.com'] },
  maps:      { name: 'Maps',       urls: ['geo:0,0?q=', 'https://maps.google.com'] },
  playstore: { name: 'Play Store', urls: ['market://', 'https://play.google.com'] },
  settings:  { name: 'Settings',   urls: ['android.settings.SETTINGS'] },
  phone:     { name: 'Phone',      urls: ['tel:'] },
};

const APP_WORDS = {
  youtube:   ['youtube', 'you tube', 'यूट्यूब'],
  whatsapp:  ['whatsapp', 'whats app', 'watsapp', 'व्हाट्सएप', 'व्हाट्सऐप'],
  instagram: ['instagram', 'insta', 'इंस्टाग्राम'],
  facebook:  ['facebook', 'फेसबुक'],
  telegram:  ['telegram', 'टेलीग्राम'],
  chrome:    ['chrome', 'browser', 'क्रोम'],
  gmail:     ['gmail', 'जीमेल'],
  maps:      ['maps', 'google maps', 'नक्शा'],
  playstore: ['play store', 'playstore'],
  settings:  ['settings', 'सेटिंग'],
  phone:     ['phone', 'dialer'],
};

/* ---------- permissions + background service ---------- */
async function ensurePermissions() {
  const res = await SpeechRecognition.requestPermissions();
  if (res.speechRecognition !== 'granted') {
    throw new Error('Microphone permission nahi mili. App Settings se allow karein.');
  }
  try { await BackgroundMode.requestNotificationsPermission(); } catch (e) {}
}

async function startBackgroundService() {
  await BackgroundMode.enable({
    title: 'JARVIS',
    text: 'Chalu hai',
    color: '#00485c',
    resume: true,
    silent: true,              // beep/awaaz nahi, notification chup
    allowClose: false,
    allowMicrophoneInBackground: true,
    disableWebViewOptimization: true,   // background me bhi JS chalta rahe
  });
}

async function askBatteryExemption() {
  try {
    const s = await BackgroundMode.checkBatteryOptimizations();
    if (s.enabled) await BackgroundMode.requestDisableBatteryOptimizations();
  } catch (e) {}
}

/* ---------- app kholna (sabse tez) ---------- */
async function openApp(key) {
  const app = APPS[key];
  let opened = false;

  for (const url of app.urls) {
    try {
      await AppLauncher.openUrl({ url });
      opened = true;
      break;
    } catch (e) {
      // ye scheme kaam nahi kari, agla try karo
    }
  }

  const line = opened
    ? `${app.name} khol diya sir.`
    : `${app.name} is phone me nahi mila sir.`;

  transcriptDiv.innerText = `JARVIS: ${line}`;
  isThinking = false;
  setStatus('JARVIS BOL RAHA HAI...');

  // app khul gaya, ab awaaz background me bajegi
  try {
    await TextToSpeech.speak({ text: line, lang: LANG, rate: 1.0, pitch: 0.7, volume: 1.0, queueStrategy: 0 });
  } catch (e) {}

  setOrb('center-orb');
  if (activeLoop) startMicSafe();
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
    // recognizer kabhi kabhi error deta hai - loop mat todo
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

  if (/(band karo|so jao|stop jarvis|alvida|ruko)/.test(t)) {
    activeLoop = false;
    speak('Standby par ja raha hoon sir.', shutdown);
    return;
  }

  // "open / khol / kholo / chalu"  -> app kholo
  const wantsOpen = /(khol|kholo|open|chalu|चालू|खोल)/.test(t);
  if (wantsOpen) {
    for (const key of Object.keys(APP_WORDS)) {
      if (APP_WORDS[key].some((w) => t.includes(w))) {
        openApp(key);   // turant, TTS ka wait nahi
        return;
      }
    }
  }

  if (/(time|samay|baje|टाइम|समय)/.test(t)) {
    speak(`Sir, abhi ${new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })} ho rahe hain.`, () => startMicSafe());
    return;
  }
  if (/(date|tarikh|din|तारीख)/.test(t)) {
    speak(`Sir, aaj ${new Date().toLocaleDateString('hi-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} hai.`, () => startMicSafe());
    return;
  }

  askGemini(text);
}

async function askGemini(promptText) {
  showError('');
  history.push({ role: 'user', parts: [{ text: promptText }] });
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
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
    await ensurePermissions();
    await startBackgroundService();
    askBatteryExemption();
  } catch (e) {
    activeLoop = false;
    showError(e.message || String(e));
    setStatus('STANDBY - TAP TO START');
    return;
  }

  speak('Namaste sir. Jarvis taiyaar hai. Kahiye, main kya karoon?', () => startMicSafe());
};
