// src/main.js — CI ise bundle karke www/app.js banata hai
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { BackgroundMode } from '@anuradev/capacitor-background-mode';
import { AppLauncher } from '@capacitor/app-launcher';
import { Contacts } from '@capacitor-community/contacts';

const WORKER_URL = 'https://jarvis-api.sachinsainimbd4339.workers.dev';
const LANG = 'hi-IN';

const orb = document.getElementById('orb');
const statusText = document.getElementById('statusText');
const transcriptDiv = document.getElementById('transcript');
const errorBox = document.getElementById('errorBox');
const core = document.getElementById('core');

let history = [];
let activeLoop = false;
let isSpeaking = false;
let isThinking = false;
let pendingCallName = null;
let contactCache = null;
let ttsLang = 'hi-IN';
let ttsVoice = null;
let ttsReady = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setOrb = (c) => { orb.className = c; };
const setStatus = (t) => { statusText.innerText = t; };

/* ---------------- Devanagari → Latin ---------------- */
const DEV = {
  'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'n','च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'n',
  'ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n','त':'t','थ':'th','द':'d','ध':'dh','न':'n',
  'प':'p','फ':'ph','ब':'b','भ':'bh','म':'m','य':'y','र':'r','ल':'l','व':'v','श':'sh',
  'ष':'sh','स':'s','ह':'h','ळ':'l','क़':'q','ख़':'kh','ग़':'g','ज़':'z','ड़':'r','ढ़':'rh','फ़':'f',
  'अ':'a','आ':'aa','इ':'i','ई':'ee','उ':'u','ऊ':'oo','ऋ':'ri','ए':'e','ऐ':'ai','ओ':'o','औ':'au',
  'ा':'a','ि':'i','ी':'ee','ु':'u','ू':'oo','ृ':'ri','े':'e','ै':'ai','ो':'o','ौ':'au','ॉ':'o','ॅ':'e',
  'ं':'n','ँ':'n','ः':'h','्':'','़':'','।':' ',
  '०':'0','१':'1','२':'2','३':'3','४':'4','५':'5','६':'6','७':'7','८':'8','९':'9'
};
const CONS = new Set('क ख ग घ ङ च छ ज झ ञ ट ठ ड ढ ण त थ द ध न प फ ब भ म य र ल व श ष स ह क़ ख़ ग़ ज़ ड़ ढ़ फ़'.split(' '));
const MATRA = new Set('ा ि ी ु ू ृ े ै ो ौ ॉ ॅ ं ँ ः ्'.split(' '));

function devaToLatin(input) {
  const ch = Array.from(String(input || ''));
  let out = '';
  for (let i = 0; i < ch.length; i++) {
    const c = ch[i];
    const next = ch[i + 1];
    const m = DEV[c];
    if (m === undefined) { out += c; continue; }
    out += m;
    if (CONS.has(c) && next !== '्' && !(next && MATRA.has(next))) out += 'a';
  }
  return out;
}

const norm = (s) => devaToLatin(s).toLowerCase().replace(/[^a-z0-9\u0900-\u097F]/g, '');

/* ---------------- digit words ---------------- */
const DIGIT_WORDS = {
  zero:'0', oh:'0', one:'1', two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8', nine:'9',
  'double':'d', 'triple':'t', 'डबल':'d',
  'शून्य':'0','ज़ीरो':'0','जीरो':'0','एक':'1','दो':'2','तीन':'3','चार':'4','पांच':'5','पाँच':'5',
  'छह':'6','छे':'6','सात':'7','आठ':'8','नौ':'9'
};

function extractNumber(raw) {
  const lower = String(raw || '').toLowerCase();
  const plain = lower.replace(/[^\d]/g, '');
  if (plain.length >= 6) return plain;
  let out = '';
  for (const tk of lower.split(/[^a-z0-9\u0900-\u097F]+/)) {
    const v = DIGIT_WORDS[tk];
    if (!v) continue;
    if (v === 'd') out += (out.slice(-1) || '');
    else if (v === 't') { const l = out.slice(-1) || ''; out += l + l; }
    else out += v;
  }
  return out.length >= 6 ? out : '';
}

/* ---------------- alias memory ---------------- */
const ALIAS_KEY = 'jarvis_call_aliases';
const getAliases = () => { try { return JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}') || {}; } catch (e) { return {}; } };
const setAliases = (o) => { try { localStorage.setItem(ALIAS_KEY, JSON.stringify(o)); } catch (e) {} };

/* ---------------- app list ---------------- */
const APPS = [
  { label: 'YouTube', key: ['youtube', 'you tube', 'यूट्यूब', 'yt'], urls: ['vnd.youtube://', 'https://www.youtube.com'] },
  { label: 'WhatsApp', key: ['whatsapp', 'whats app', 'व्हाट्सएप', 'वाट्सएप', 'व्हाट्सऐप'], urls: ['whatsapp://send'] },
  { label: 'Instagram', key: ['instagram', 'insta', 'इंस्टाग्राम', 'इन्स्टाग्राम'], urls: ['instagram://app', 'https://www.instagram.com'] },
  { label: 'Facebook', key: ['facebook', 'fb', 'फेसबुक'], urls: ['fb://facewebmodal', 'https://www.facebook.com'] },
  { label: 'Telegram', key: ['telegram', 'टेलीग्राम'], urls: ['tg://', 'https://telegram.org'] },
  { label: 'Snapchat', key: ['snapchat', 'स्नैपचैट'], urls: ['snapchat://', 'https://www.snapchat.com'] },
  { label: 'Spotify', key: ['spotify', 'स्पॉटिफाई'], urls: ['spotify://'] },
  { label: 'Gmail', key: ['gmail', 'जीमेल'], urls: ['googlegmail://'] },
  { label: 'Google', key: ['google', 'गूगल'], urls: ['https://www.google.com'] },
  { label: 'Chrome', key: ['chrome', 'क्रोम', 'browser', 'ब्राउज़र'], urls: ['https://www.google.com'] },
  { label: 'Google Maps', key: ['maps', 'map', 'नक्शा', 'मैप्स'], urls: ['geo:0,0?q='] },
  { label: 'Play Store', key: ['play store', 'playstore', 'प्ले स्टोर'], urls: ['market://search?q='] },
  { label: 'PhonePe', key: ['phonepe', 'फोनपे'], urls: ['phonepe://'] },
  { label: 'Google Pay', key: ['google pay', 'gpay', 'जीपे'], urls: ['tez://'] },
  { label: 'Paytm', key: ['paytm', 'पेटीएम'], urls: ['paytmmp://'] },
  { label: 'Swiggy', key: ['swiggy', 'स्विगी'], urls: ['swiggy://'] },
  { label: 'Zomato', key: ['zomato', 'ज़ोमैटो', 'जोमैटो'], urls: ['zomato://'] },
  { label: 'Uber', key: ['uber', 'उबर'], urls: ['uber://'] },
  { label: 'Netflix', key: ['netflix', 'नेटफ्लिक्स'], urls: ['nflx://'] },
  { label: 'LinkedIn', key: ['linkedin', 'लिंक्डइन'], urls: ['linkedin://', 'https://www.linkedin.com'] }
];

async function openFirst(urls) {
  for (const url of urls) {
    try { await AppLauncher.openUrl({ url }); return true; } catch (e) {}
  }
  return false;
}

/* ---------------- contacts ---------------- */
async function loadContacts() {
  if (contactCache) return contactCache;
  let st = (await Contacts.checkPermissions()).contacts;
  if (st !== 'granted' && st !== 'limited') st = (await Contacts.requestPermissions()).contacts;
  if (st !== 'granted' && st !== 'limited') throw new Error('CONTACT_DENIED');

  const res = await Contacts.getContacts({ projection: { name: true, phones: true } });
  contactCache = (res.contacts || [])
    .map((c) => {
      const names = [c.name && c.name.display, c.name && c.name.given, c.name && c.name.family]
        .filter(Boolean).map(norm);
      const number = (c.phones || []).find((p) => p && p.number);
      return { names, number: number ? number.number : null, display: (c.name && c.name.display) || '' };
    })
    .filter((c) => c.number && c.names.length);
  return contactCache;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.startsWith(b) || b.startsWith(a)) return 0.9;
  if (a.includes(b) || b.includes(a)) return 0.8;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i / Math.max(a.length, b.length);
}

async function dial(number) {
  const clean = String(number || '').replace(/[^\d+]/g, '');
  try { await AppLauncher.openUrl({ url: 'tel:' + clean }); }
  catch (e) { errorBox.innerText = 'Call app nahi khula: ' + e.message; }
}

/* ---------------- TTS setup (Hindi na ho to English fallback) ---------------- */
async function initTts() {
  if (ttsReady) return;
  ttsReady = true;
  try {
    const langs = await TextToSpeech.getSupportedLanguages();
    const list = (langs && langs.languages) || [];
    const hasHi = list.some((l) => String(l).toLowerCase().startsWith('hi'));
    if (!hasHi) {
      try { await TextToSpeech.openInstall(); } catch (e) {}
    }
  } catch (e) {}

  try {
    const res = await TextToSpeech.getSupportedVoices();
    const voices = res && res.voices ? res.voices : [];
    const find = (re) => voices.findIndex((v) => re.test(String((v && v.lang) || '')));
    const idxHi = find(/^hi/i);
    const idxEnIn = find(/^en[-_]in/i);
    const idxEn = find(/^en/i);
    if (idxHi >= 0) { ttsVoice = idxHi; ttsLang = 'hi-IN'; }
    else if (idxEnIn >= 0) { ttsVoice = idxEnIn; ttsLang = 'en-IN'; }
    else if (idxEn >= 0) { ttsVoice = idxEn; ttsLang = 'en-US'; }
  } catch (e) {}
}

function ttsOptions(text) {
  const o = { text, lang: ttsLang, rate: 1.0, pitch: 0.7, volume: 1.0, category: 'ambient' };
  if (typeof ttsVoice === 'number' && ttsVoice >= 0) o.voice = ttsVoice;
  return o;
}

function webSpeak(text, lang) {
  return new Promise((resolve) => {
    try {
      if (!window.speechSynthesis) return resolve();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = 1.0;
      u.pitch = 0.7;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    } catch (e) { resolve(); }
  });
}

/* ---------------- speech out ---------------- */
async function say(rawText) {
  const text = String(rawText);
  transcriptDiv.innerText = 'JARVIS: ' + text;
  isSpeaking = true;
  setOrb('center-orb speaking');
  setStatus('JARVIS BOL RAHA HAI...');
  try { await SpeechRecognition.stop(); } catch (e) {}
  try { await TextToSpeech.stop(); } catch (e) {}
  await initTts();

  const hi = /^hi/i.test(ttsLang);
  const spoken = hi ? text : devaToLatin(text);
  const t0 = Date.now();
  let spoke = false;

  try {
    await TextToSpeech.speak(ttsOptions(spoken));
    spoke = true;
  } catch (e) {
    errorBox.innerText = 'TTS: ' + (e && e.message ? e.message : e);
  }

  if (!spoke) {
    // Hindi voice nahi hai -> English voice se Hinglish
    ttsLang = 'en-US';
    ttsVoice = null;
    try {
      await TextToSpeech.speak(ttsOptions(devaToLatin(text)));
      spoke = true;
    } catch (e2) {
      errorBox.innerText = 'TTS: ' + (e2 && e2.message ? e2.message : e2);
    }
  }

  if (!spoke) await webSpeak(devaToLatin(text), 'en-IN');

  const need = 350 + spoken.length * 85;
  const spent = Date.now() - t0;
  if (spent < need) await sleep(need - spent);

  isSpeaking = false;
  setOrb('center-orb');
}

/* ---------------- Gemini ---------------- */
function nowContext() {
  const d = new Date();
  const date = d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  return 'Aaj ' + date + ' hai, abhi ' + time + ' baje hain.';
}

async function askGemini(promptText) {
  const payload = '[' + nowContext() + ' Isi ko sach maano, apni purani date use mat karo.] ' + promptText;
  history.push({ role: 'user', parts: [{ text: payload }] });
  if (history.length > 8) history = history.slice(-8);
  while (history.length && history[0].role !== 'user') history.shift();

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history }),
      signal: AbortSignal.timeout(25000)
    });
    const data = await res.json();
    if (!res.ok || !data.reply) {
      history.pop();
      errorBox.innerText = 'Worker: ' + (data.error || res.status);
      return 'Sir, connection me issue hai.';
    }
    history.push({ role: 'model', parts: [{ text: data.reply }] });
    return data.reply;
  } catch (err) {
    history.pop();
    errorBox.innerText = 'Connection error: ' + err.message;
    return 'Sir, internet se connect nahi ho pa raha.';
  }
}

/* ---------------- call by name ---------------- */
function extractCallName(raw) {
  let t = String(raw || '').toLowerCase();
  t = t.replace(/(को|से|ko|se)?\s*(phone|call|dial|fon|फोन|कॉल|काल|मिलाओ|milao)\s*(करो|कर|कर दो|karo|kar do|kar|lagao|लगाओ|lagana|लगाना)?/g, ' ');
  t = t.replace(/\b(please|sir|jarvis|zara|abhi|mere|mera|the)\b/g, ' ');
  t = t.replace(/[?!,.।]/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

async function handleCall(raw) {
  const name = extractCallName(raw);
  if (!name) return false;
  const key = norm(name);

  const aliases = getAliases();
  if (key && aliases[key]) {
    await say(name + ' ko call laga raha hoon sir.');
    await dial(aliases[key]);
    return true;
  }

  let list;
  try { list = await loadContacts(); }
  catch (e) {
    await say('Sir, contacts ki permission nahi mili. Settings se Contacts allow karein.');
    return true;
  }

  let best = null, score = 0;
  for (const c of list) {
    for (const n of c.names) {
      const s = similarity(n, key);
      if (s > score) { score = s; best = c; }
    }
  }

  if (best && score >= 0.6) {
    await say((best.display || name) + ' ko call laga raha hoon sir.');
    await dial(best.number);
    return true;
  }

  pendingCallName = name;
  await say(name + ' naam ka contact nahi mila sir. Number bolo, yaad rakh loonga.');
  return true;
}

/* ---------------- local fast router (internet nahi lagta) ---------------- */
async function routeLocal(raw) {
  const latin = devaToLatin(raw).toLowerCase();
  const probe = latin + ' ' + String(raw).toLowerCase();

  /* stop */
  if (/(band karo|band kar|so jao|stop jarvis|alvida|bye jarvis|बंद करो|सो जाओ)/.test(probe)) {
    await say('Theek hai sir, standby par ja raha hoon.');
    await stopEverything();
    return true;
  }

  /* pending call ka number */
  if (pendingCallName) {
    const num = extractNumber(raw);
    if (num) {
      const aliases = getAliases();
      aliases[norm(pendingCallName)] = num;
      setAliases(aliases);
      await say('Number yaad rakh liya sir. Call laga raha hoon.');
      await dial(num);
      pendingCallName = null;
      return true;
    }
  }

  /* date (Devanagari + nukta dono) */
  if (/(date|tarikh|tareekh|tarik|din|डेट|तारीख़|तारीख|तारिख|दिन|आज)/.test(probe)) {
    if (!/(time|samay|baje|टाइम|समय|बजे)/.test(probe)) {
      const d = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      await say('Sir, aaj ' + d + ' hai.');
      return true;
    }
  }

  /* time */
  if (/(time|samay|baje|टाइम|समय|बजे)/.test(probe)) {
    const now = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    await say('Sir, abhi ' + now + ' ho rahe hain.');
    return true;
  }

  /* battery */
  if (/(battery|बैटरी)/.test(probe)) {
    let pct = null;
    try {
      if (navigator.getBattery) {
        const b = await navigator.getBattery();
        pct = Math.round(b.level * 100);
      }
    } catch (e) {}
    await say(pct !== null ? ('Sir, battery ' + pct + ' percent hai.') : 'Sir, battery ki jaankari nahi mil rahi.');
    return true;
  }

  /* call */
  if (/(call|phone|fon|dial|milao|मिलाओ|कॉल|फोन|काल)/.test(probe)) {
    const done = await handleCall(raw);
    if (done) return true;
  }

  /* app kholna */
  if (/(khol|kholo|open|chalao|chala do|launch|खोल|खोलो|ओपन|चालू)/.test(probe)) {
    for (const app of APPS) {
      if (app.key.some((k) => probe.includes(k))) {
        const ok = await openFirst(app.urls);
        await say(ok ? app.label + ' khol raha hoon sir.' : app.label + ' install nahi hai sir.');
        return true;
      }
    }
    await say('Is app ka seedha shortcut nahi hai sir. Naam saaf bolo.');
    return true;
  }

  pendingCallName = null;
  return false;
}

/* ---------------- mic loop ---------------- */
function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function listenOnce() {
  const res = await SpeechRecognition.start({
    language: LANG,
    maxResults: 1,
    partialResults: false,
    popup: false,
    prompt: ''
  });
  const m = res && res.matches;
  return m && m.length ? String(m[0]).trim() : '';
}

async function loop() {
  while (activeLoop) {
    if (isSpeaking || isThinking) { await sleep(120); continue; }

    let text = '';
    setStatus('JARVIS SUN RAHA HAI...');
    setOrb('center-orb listening-mode');
    try {
      text = await withTimeout(listenOnce(), 14000);
    } catch (e) {
      text = '';
      try { await SpeechRecognition.stop(); } catch (e2) {}
      await sleep(350);
    }
    if (!activeLoop) break;
    setOrb('center-orb');
    if (!text) continue;

    transcriptDiv.innerText = 'Aap: "' + text + '"';
    isThinking = true;
    setOrb('center-orb thinking-mode');
    setStatus('JARVIS SOCH RAHA HAI...');

    try {
      const handled = await routeLocal(text);
      if (!handled) {
        const ans = await askGemini(text);
        if (ans) await say(ans);
      }
    } catch (e) {
      errorBox.innerText = 'Error: ' + e.message;
    }

    isThinking = false;
    await sleep(150);
  }
}

/* ---------------- permissions + background ---------------- */
async function ensurePermissions() {
  const res = await SpeechRecognition.requestPermissions();
  const st = (res && (res.speechRecognition || res.speechRecognitionPermission)) || '';
  if (st && st !== 'granted') throw new Error('Microphone permission nahi mili. App settings se allow karein.');
  try { await BackgroundMode.requestNotificationsPermission(); } catch (e) {}
}

async function startBackgroundService() {
  await BackgroundMode.enable({
    title: 'JARVIS',
    text: 'Assistant sun raha hai...',
    color: '#00485c',
    resume: true,
    silent: false,
    allowClose: false,
    allowMicrophoneInBackground: true,
    disableWebViewOptimization: true
  });
  try {
    const s = await BackgroundMode.checkBatteryOptimizations();
    if (s && s.enabled) await BackgroundMode.requestDisableBatteryOptimizations();
  } catch (e) {}
}

async function stopEverything() {
  activeLoop = false;
  isSpeaking = false;
  isThinking = false;
  try { await SpeechRecognition.stop(); } catch (e) {}
  try { await SpeechRecognition.removeAllListeners(); } catch (e) {}
  try { await TextToSpeech.stop(); } catch (e) {}
  try { speechSynthesis.cancel(); } catch (e) {}
  try { await BackgroundMode.disable(); } catch (e) {}
  setOrb('center-orb');
  setStatus('STANDBY - TAP TO START');
}

async function startAssistant() {
  errorBox.innerText = '';
  activeLoop = true;
  setStatus('START HO RAHA HAI...');
  try {
    await ensurePermissions();
  } catch (e) {
    errorBox.innerText = e.message;
    activeLoop = false;
    setStatus('TAP CORE TO START');
    return;
  }
  try { await startBackgroundService(); }
  catch (e) { errorBox.innerText = 'Background: ' + e.message; }

  await initTts();
  await say('Namaste sir. Jarvis taiyaar hai. Kahiye, main kya karoon?');
  loop();
}

core.onclick = async () => {
  if (!activeLoop) await startAssistant();
  else await stopEverything();
};
