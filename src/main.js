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
const debugBox = document.getElementById('debugBox');
const testBtn = document.getElementById('testVoice');

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

const DEV = {
  '\u0915':'k','\u0916':'kh','\u0917':'g','\u0918':'gh','\u0919':'n','\u091A':'ch','\u091B':'chh','\u091C':'j','\u091D':'jh','\u091E':'n',
  '\u091F':'t','\u0920':'th','\u0921':'d','\u0922':'dh','\u0923':'n','\u0924':'t','\u0925':'th','\u0926':'d','\u0927':'dh','\u0928':'n',
  '\u092A':'p','\u092B':'ph','\u092C':'b','\u092D':'bh','\u092E':'m','\u092F':'y','\u0930':'r','\u0932':'l','\u0935':'v','\u0936':'sh',
  '\u0937':'sh','\u0938':'s','\u0939':'h','\u0933':'l','\u0915\u093C':'q','\u0916\u093C':'kh','\u0917\u093C':'g','\u091C\u093C':'z','\u0921\u093C':'r','\u0922\u093C':'rh','\u092B\u093C':'f',
  '\u0905':'a','\u0906':'aa','\u0907':'i','\u0908':'ee','\u0909':'u','\u090A':'oo','\u090B':'ri','\u090F':'e','\u0910':'ai','\u0913':'o','\u0914':'au',
  '\u093E':'a','\u093F':'i','\u0940':'ee','\u0941':'u','\u0942':'oo','\u0943':'ri','\u0947':'e','\u0948':'ai','\u094B':'o','\u094C':'au','\u0949':'o','\u0945':'e',
  '\u0902':'n','\u0901':'n','\u0903':'h','\u094D':'','\u093C':'','\u0964':' ',
  '\u0966':'0','\u0967':'1','\u0968':'2','\u0969':'3','\u096A':'4','\u096B':'5','\u096C':'6','\u096D':'7','\u096E':'8','\u096F':'9'
};
const CONS = new Set('\u0915 \u0916 \u0917 \u0918 \u0919 \u091A \u091B \u091C \u091D \u091E \u091F \u0920 \u0921 \u0922 \u0923 \u0924 \u0925 \u0926 \u0927 \u0928 \u092A \u092B \u092C \u092D \u092E \u092F \u0930 \u0932 \u0935 \u0936 \u0937 \u0938 \u0939 \u0915\u093C \u0916\u093C \u0917\u093C \u091C\u093C \u0921\u093C \u0922\u093C \u092B\u093C'.split(' '));
const MATRA = new Set('\u093E \u093F \u0940 \u0941 \u0942 \u0943 \u0947 \u0948 \u094B \u094C \u0949 \u0945 \u0902 \u0901 \u0903 \u094D'.split(' '));

function devaToLatin(input) {
  const ch = Array.from(String(input || ''));
  let out = '';
  for (let i = 0; i < ch.length; i++) {
    const c = ch[i];
    const next = ch[i + 1];
    const m = DEV[c];
    if (m === undefined) { out += c; continue; }
    out += m;
    if (CONS.has(c) && next !== '\u094D' && !(next && MATRA.has(next))) out += 'a';
  }
  return out;
}

const norm = (s) => devaToLatin(s).toLowerCase().replace(/[^a-z0-9\u0900-\u097F]/g, '');

const DIGIT_WORDS = {
  zero:'0', oh:'0', one:'1', two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8', nine:'9',
  'double':'d', 'triple':'t', '\u0921\u092C\u0932':'d',
  '\u0936\u0942\u0928\u094D\u092F':'0','\u091C\u093C\u0940\u0930\u094B':'0','\u091C\u0940\u0930\u094B':'0','\u090F\u0915':'1','\u0926\u094B':'2','\u0924\u0940\u0928':'3','\u091A\u093E\u0930':'4','\u092A\u093E\u0902\u091A':'5','\u092A\u093E\u0901\u091A':'5',
  '\u091B\u0939':'6','\u091B\u0947':'6','\u0938\u093E\u0924':'7','\u0906\u0920':'8','\u0928\u094C':'9'
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

const ALIAS_KEY = 'jarvis_call_aliases';
const getAliases = () => { try { return JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}') || {}; } catch (e) { return {}; } };
const setAliases = (o) => { try { localStorage.setItem(ALIAS_KEY, JSON.stringify(o)); } catch (e) {} };

const APPS = [
  { label: 'YouTube', key: ['youtube', 'you tube', '\u092F\u0942\u091F\u094D\u092F\u0942\u092C', 'yt'], urls: ['vnd.youtube://', 'https://www.youtube.com'] },
  { label: 'WhatsApp', key: ['whatsapp', 'whats app', '\u0935\u094D\u0939\u093E\u091F\u094D\u0938\u090F\u092A', '\u0935\u093E\u091F\u094D\u0938\u090F\u092A', '\u0935\u094D\u0939\u093E\u091F\u094D\u0938\u0910\u092A'], urls: ['whatsapp://send'] },
  { label: 'Instagram', key: ['instagram', 'insta', '\u0907\u0902\u0938\u094D\u091F\u093E\u0917\u094D\u0930\u093E\u092E', '\u0907\u0928\u094D\u0938\u094D\u091F\u093E\u0917\u094D\u0930\u093E\u092E'], urls: ['instagram://app', 'https://www.instagram.com'] },
  { label: 'Facebook', key: ['facebook', 'fb', '\u092B\u0947\u0938\u092C\u0941\u0915'], urls: ['fb://facewebmodal', 'https://www.facebook.com'] },
  { label: 'Telegram', key: ['telegram', '\u091F\u0947\u0932\u0940\u0917\u094D\u0930\u093E\u092E'], urls: ['tg://', 'https://telegram.org'] },
  { label: 'Snapchat', key: ['snapchat', '\u0938\u094D\u0928\u0948\u092A\u091A\u0948\u091F'], urls: ['snapchat://', 'https://www.snapchat.com'] },
  { label: 'Spotify', key: ['spotify', '\u0938\u094D\u092A\u0949\u091F\u093F\u092B\u093E\u0908'], urls: ['spotify://'] },
  { label: 'Gmail', key: ['gmail', '\u091C\u0940\u092E\u0947\u0932'], urls: ['googlegmail://'] },
  { label: 'Google', key: ['google', '\u0917\u0942\u0917\u0932'], urls: ['https://www.google.com'] },
  { label: 'Chrome', key: ['chrome', '\u0915\u094D\u0930\u094B\u092E', 'browser', '\u092C\u094D\u0930\u093E\u0909\u091C\u093C\u0930'], urls: ['https://www.google.com'] },
  { label: 'Google Maps', key: ['maps', 'map', '\u0928\u0915\u094D\u0936\u093E', '\u092E\u0948\u092A\u094D\u0938'], urls: ['geo:0,0?q='] },
  { label: 'Play Store', key: ['play store', 'playstore', '\u092A\u094D\u0932\u0947 \u0938\u094D\u091F\u094B\u0930'], urls: ['market://search?q='] },
  { label: 'PhonePe', key: ['phonepe', '\u092B\u094B\u0928\u092A\u0947'], urls: ['phonepe://'] },
  { label: 'Google Pay', key: ['google pay', 'gpay', '\u091C\u0940\u092A\u0947'], urls: ['tez://'] },
  { label: 'Paytm', key: ['paytm', '\u092A\u0947\u091F\u0940\u090F\u092E'], urls: ['paytmmp://'] },
  { label: 'Swiggy', key: ['swiggy', '\u0938\u094D\u0935\u093F\u0917\u0940'], urls: ['swiggy://'] },
  { label: 'Zomato', key: ['zomato', '\u091C\u093C\u094B\u092E\u0948\u091F\u094B', '\u091C\u094B\u092E\u0948\u091F\u094B'], urls: ['zomato://'] },
  { label: 'Uber', key: ['uber', '\u0909\u092C\u0930'], urls: ['uber://'] },
  { label: 'Netflix', key: ['netflix', '\u0928\u0947\u091F\u092B\u094D\u0932\u093F\u0915\u094D\u0938'], urls: ['nflx://'] },
  { label: 'LinkedIn', key: ['linkedin', '\u0932\u093F\u0902\u0915\u094D\u0921\u0907\u0928'], urls: ['linkedin://', 'https://www.linkedin.com'] }
];

async function openFirst(urls) {
  for (const url of urls) {
    try { await AppLauncher.openUrl({ url }); return true; } catch (e) {}
  }
  return false;
}

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

const TTS_ORDER = ['hi-IN', 'en-IN', 'en-US'];
let ttsAvailable = [];
let ttsLastError = '';

async function detectTtsLangs() {
  const ok = [];
  for (const l of TTS_ORDER) {
    try {
      const r = await TextToSpeech.isLanguageSupported({ lang: l });
      if (r && r.supported) ok.push(l);
    } catch (e) {}
  }
  if (!ok.length) {
    try {
      const res = await TextToSpeech.getSupportedLanguages();
      const list = (res && res.languages) || [];
      const has = (l) => list.some((x) => String(x).toLowerCase().replace('_', '-') === l.toLowerCase());
      for (const l of TTS_ORDER) if (has(l)) ok.push(l);
    } catch (e) {}
  }
  ttsAvailable = ok.length ? ok : ['en-US'];
  return ttsAvailable;
}

async function initTts() {
  if (ttsReady) return;
  ttsReady = true;
  try {
    const list = await detectTtsLangs();
    ttsLang = list[0];
    dbg('tts lang: ' + list.join(','));
  } catch (e) {
    ttsLastError = (e && e.message) ? e.message : String(e);
  }
}

function ttsTimeoutFor(text) {
  return 8000 + text.length * 160;
}

async function speakNative(text, lang) {
  const out = /^hi/i.test(lang) ? text : devaToLatin(text);
  // NOTE: voice index jaan bujh kar nahi bhejte - engine ka default voice sabse reliable hai
  await withTimeout(
    TextToSpeech.speak({ text: out, lang: lang, rate: 1.0, pitch: 1.0, volume: 1.0 }),
    ttsTimeoutFor(out)
  );
}

function webSpeak(text, lang) {
  return new Promise((resolve) => {
    try {
      if (!window.speechSynthesis) { resolve(false); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = 1.0;
      u.pitch = 1.0;
      u.onend = () => resolve(true);
      u.onerror = () => resolve(false);
      speechSynthesis.speak(u);
    } catch (e) { resolve(false); }
  });
}

async function say(rawText) {
  const text = String(rawText);
  transcriptDiv.innerText = 'JARVIS: ' + text;
  isSpeaking = true;
  setOrb('center-orb speaking');
  setStatus('JARVIS BOL RAHA HAI...');

  // mic band karo, par plugin ka stop() kabhi resolve nahi karta - isliye timeout lagaya hai
  await nStopRec();
  try { await withTimeout(TextToSpeech.stop(), 2000); } catch (e) {}

  try {
    await initTts();

    const candidates = [];
    // Devanagari text = hi-IN, Latin (Hinglish) text = en-IN pehle (engine Hindi me slow/missing hai)
    const hasDev = /[\u0900-\u097F]/.test(text);
    const preferred = hasDev ? ['hi-IN', 'en-IN', 'en-US'] : ['en-IN', 'en-US', 'hi-IN'];
    for (const l of [...preferred, ttsLang, ...(ttsAvailable || []), ...TTS_ORDER]) {
      if (l && candidates.indexOf(l) === -1) candidates.push(l);
    }

    let spoke = false;
    for (const lang of candidates) {
      try {
        await speakNative(text, lang);
        spoke = true;
        ttsLang = lang;
        break;
      } catch (e) {
        ttsLastError = (e && e.message) ? e.message : String(e);
        try { await withTimeout(TextToSpeech.stop(), 1500); } catch (e2) {}
      }
    }

    if (!spoke) {
      const web = await webSpeak(devaToLatin(text), 'en-IN');
      if (!web) {
        errorBox.innerText = 'TTS fail: ' + ttsLastError + ' | langs: ' + (ttsAvailable || []).join(', ');
        dbg('tts fail: ' + ttsLastError);
      }
    }
  } finally {
    // awaaz khatam hone ke baad mic ko thoda waqt do, warna recognizer busy ho jata hai
    await sleep(700);
    isSpeaking = false;
    setOrb('center-orb');
  }
}

const dbgLines = [];
function dbg(msg) {
  dbgLines.push(msg);
  while (dbgLines.length > 12) dbgLines.shift();
  if (debugBox) debugBox.innerText = dbgLines.join('\n');
}

async function ttsProbe() {
  const native = (window.Capacitor && typeof Capacitor.isNativePlatform === 'function') ? Capacitor.isNativePlatform() : 'no-capacitor';
  dbg('native: ' + native);
  dbg('plugin: ' + (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.TextToSpeech ? 'mila' : 'NAHI mila'));

  const st = [];
  for (const l of ['hi-IN', 'en-IN', 'en-US']) {
    try {
      const r = await TextToSpeech.isLanguageSupported({ lang: l });
      st.push(l + ':' + (r && r.supported ? 'yes' : 'no'));
    } catch (e) {
      st.push(l + ':ERR');
    }
  }
  dbg('langs ' + st.join(' '));

  try {
    const v = await TextToSpeech.getSupportedVoices();
    const arr = (v && v.voices) || [];
    dbg('voices: ' + arr.length + (arr[0] ? ' | ' + String(arr[0].name || '').slice(0, 22) : ''));
  } catch (e) {
    dbg('voices: ERR ' + ((e && e.message) || e));
  }

  try {
    const av = await SpeechRecognition.available();
    dbg('sr available: ' + (av && av.available ? 'yes' : 'NO'));
    const st = await SpeechRecognition.checkPermissions();
    dbg('mic permission: ' + ((st && st.speechRecognition) || '?'));
  } catch (e) {
    dbg('sr check: ERR ' + ((e && e.message) || e));
  }
}

async function voiceTest() {
  dbg('--- voice test ---');
  for (const lang of ['hi-IN', 'en-IN', 'en-US']) {
    const t0 = Date.now();
    try {
      await withTimeout(
        TextToSpeech.speak({ text: 'Ek do teen. Jarvis bol raha hai.', lang: lang, rate: 1.0, pitch: 1.0, volume: 1.0 }),
        14000
      );
      dbg(lang + ': OK (' + (Date.now() - t0) + 'ms)');
      return lang;
    } catch (e) {
      dbg(lang + ': FAIL ' + String((e && e.message) || e).slice(0, 60));
    }
  }
  return null;
}

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
      body: JSON.stringify({ history: history }),
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

function extractCallName(raw) {
  let t = String(raw || '').toLowerCase();
  t = t.replace(/(\u0915\u094B|\u0938\u0947|ko|se)?\s*(phone|call|dial|fon|\u092B\u094B\u0928|\u0915\u0949\u0932|\u0915\u093E\u0932|\u092E\u093F\u0932\u093E\u0913|milao)\s*(\u0915\u0930\u094B|\u0915\u0930|\u0915\u0930 \u0926\u094B|karo|kar do|kar|lagao|\u0932\u0917\u093E\u0913|lagana|\u0932\u0917\u093E\u0928\u093E)?/g, ' ');
  t = t.replace(/\b(please|sir|jarvis|zara|abhi|mere|mera|the)\b/g, ' ');
  t = t.replace(/[?!,.\u0964]/g, ' ');
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

async function routeLocal(raw) {
  const latin = devaToLatin(raw).toLowerCase();
  const probe = latin + ' ' + String(raw).toLowerCase();

  if (/(band karo|band kar|so jao|stop jarvis|alvida|bye jarvis|\u092C\u0902\u0926 \u0915\u0930\u094B|\u0938\u094B \u091C\u093E\u0913)/.test(probe)) {
    await say('Theek hai sir, standby par ja raha hoon.');
    await stopEverything();
    return true;
  }

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

  if (/(date|tarikh|tareekh|tarik|din|\u0921\u0947\u091F|\u0924\u093E\u0930\u0940\u0916\u093C|\u0924\u093E\u0930\u0940\u0916|\u0924\u093E\u0930\u093F\u0916|\u0926\u093F\u0928|\u0906\u091C)/.test(probe)) {
    if (!/(time|samay|baje|\u091F\u093E\u0907\u092E|\u0938\u092E\u092F|\u092C\u091C\u0947)/.test(probe)) {
      const d = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      await say('Sir, aaj ' + d + ' hai.');
      return true;
    }
  }

  if (/(time|samay|baje|\u091F\u093E\u0907\u092E|\u0938\u092E\u092F|\u092C\u091C\u0947)/.test(probe)) {
    const now = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    await say('Sir, abhi ' + now + ' ho rahe hain.');
    return true;
  }

  if (/(battery|\u092C\u0948\u091F\u0930\u0940)/.test(probe)) {
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

  if (/(call|phone|fon|dial|milao|\u092E\u093F\u0932\u093E\u0913|\u0915\u0949\u0932|\u092B\u094B\u0928|\u0915\u093E\u0932)/.test(probe)) {
    const done = await handleCall(raw);
    if (done) return true;
  }

  if (/(khol|kholo|open|chalao|chala do|launch|\u0916\u094B\u0932|\u0916\u094B\u0932\u094B|\u0913\u092A\u0928|\u091A\u093E\u0932\u0942)/.test(probe)) {
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

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// SpeechRecognition.stop() kabhi resolve nahi hota (plugin ka bug),
// isliye ise hamesha timeout ke saath chalana hai warna loop atak jata hai.
function nStopRec() {
  return withTimeout(SpeechRecognition.stop(), 900).catch(() => {});
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
  let fails = 0;
  while (activeLoop) {
    if (isSpeaking || isThinking) { await sleep(120); continue; }

    let text = '';
    setStatus('JARVIS SUN RAHA HAI...');
    setOrb('center-orb listening-mode');
    try {
      text = await withTimeout(listenOnce(), 16000);
      fails = 0;
    } catch (e) {
      const msg = String((e && e.message) || e || 'error');
      text = '';
      await nStopRec();
      fails++;

      // "No match" / "timeout" = bas kuch suna nahi, normal hai - chup-chaap dobara suno
      const quiet = /no match|timeout|speech timeout|7/i.test(msg);
      if (!quiet) {
        dbg('mic: ' + msg);
        statusText.innerText = 'MIC: ' + msg.slice(0, 40);
      }
      await sleep(Math.min(400 * fails, 2000));
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
    } finally {
      isThinking = false;
    }
    await sleep(150);
  }
}

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
  await nStopRec();
  try { await withTimeout(TextToSpeech.stop(), 2000); } catch (e) {}
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
  await ttsProbe();
  await say('Namaste sir. Jarvis taiyaar hai. Kahiye, main kya karoon?');
  loop().catch((e) => { errorBox.innerText = 'Loop: ' + e.message; });
}

core.onclick = async () => {
  if (!activeLoop) await startAssistant();
  else await stopEverything();
};

if (testBtn) {
  testBtn.onclick = async (e) => {
    e.stopPropagation();
    errorBox.innerText = '';
    const okLang = await voiceTest();
    if (okLang) { ttsLang = okLang; dbg('ttsLang set: ' + okLang); }
  };
}
