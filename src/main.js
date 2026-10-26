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

const DEV = {
  'à¤•':'k','à¤–':'kh','à¤—':'g','à¤˜':'gh','à¤™':'n','à¤š':'ch','à¤›':'chh','à¤œ':'j','à¤':'jh','à¤ž':'n',
  'à¤Ÿ':'t','à¤ ':'th','à¤¡':'d','à¤¢':'dh','à¤£':'n','à¤¤':'t','à¤¥':'th','à¤¦':'d','à¤§':'dh','à¤¨':'n',
  'à¤ª':'p','à¤«':'ph','à¤¬':'b','à¤­':'bh','à¤®':'m','à¤¯':'y','à¤°':'r','à¤²':'l','à¤µ':'v','à¤¶':'sh',
  'à¤·':'sh','à¤¸':'s','à¤¹':'h','à¤³':'l','à¤•à¤¼':'q','à¤–à¤¼':'kh','à¤—à¤¼':'g','à¤œà¤¼':'z','à¤¡à¤¼':'r','à¤¢à¤¼':'rh','à¤«à¤¼':'f',
  'à¤…':'a','à¤†':'aa','à¤‡':'i','à¤ˆ':'ee','à¤‰':'u','à¤Š':'oo','à¤‹':'ri','à¤':'e','à¤':'ai','à¤“':'o','à¤”':'au',
  'à¤¾':'a','à¤¿':'i','à¥€':'ee','à¥':'u','à¥‚':'oo','à¥ƒ':'ri','à¥‡':'e','à¥ˆ':'ai','à¥‹':'o','à¥Œ':'au','à¥‰':'o','à¥…':'e',
  'à¤‚':'n','à¤':'n','à¤ƒ':'h','à¥':'','à¤¼':'','à¥¤':' ',
  'à¥¦':'0','à¥§':'1','à¥¨':'2','à¥©':'3','à¥ª':'4','à¥«':'5','à¥¬':'6','à¥­':'7','à¥®':'8','à¥¯':'9'
};
const CONS = new Set('à¤• à¤– à¤— à¤˜ à¤™ à¤š à¤› à¤œ à¤ à¤ž à¤Ÿ à¤  à¤¡ à¤¢ à¤£ à¤¤ à¤¥ à¤¦ à¤§ à¤¨ à¤ª à¤« à¤¬ à¤­ à¤® à¤¯ à¤° à¤² à¤µ à¤¶ à¤· à¤¸ à¤¹ à¤•à¤¼ à¤–à¤¼ à¤—à¤¼ à¤œà¤¼ à¤¡à¤¼ à¤¢à¤¼ à¤«à¤¼'.split(' '));
const MATRA = new Set('à¤¾ à¤¿ à¥€ à¥ à¥‚ à¥ƒ à¥‡ à¥ˆ à¥‹ à¥Œ à¥‰ à¥… à¤‚ à¤ à¤ƒ à¥'.split(' '));

function devaToLatin(input) {
  const ch = Array.from(String(input || ''));
  let out = '';
  for (let i = 0; i < ch.length; i++) {
    const c = ch[i];
    const next = ch[i + 1];
    const m = DEV[c];
    if (m === undefined) { out += c; continue; }
    out += m;
    if (CONS.has(c) && next !== 'à¥' && !(next && MATRA.has(next))) out += 'a';
  }
  return out;
}

const norm = (s) => devaToLatin(s).toLowerCase().replace(/[^a-z0-9\u0900-\u097F]/g, '');

const DIGIT_WORDS = {
  zero:'0', oh:'0', one:'1', two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8', nine:'9',
  'double':'d', 'triple':'t', 'à¤¡à¤¬à¤²':'d',
  'à¤¶à¥‚à¤¨à¥à¤¯':'0','à¤œà¤¼à¥€à¤°à¥‹':'0','à¤œà¥€à¤°à¥‹':'0','à¤à¤•':'1','à¤¦à¥‹':'2','à¤¤à¥€à¤¨':'3','à¤šà¤¾à¤°':'4','à¤ªà¤¾à¤‚à¤š':'5','à¤ªà¤¾à¤à¤š':'5',
  'à¤›à¤¹':'6','à¤›à¥‡':'6','à¤¸à¤¾à¤¤':'7','à¤†à¤ ':'8','à¤¨à¥Œ':'9'
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
  { label: 'YouTube', key: ['youtube', 'you tube', 'à¤¯à¥‚à¤Ÿà¥à¤¯à¥‚à¤¬', 'yt'], urls: ['vnd.youtube://', 'https://www.youtube.com'] },
  { label: 'WhatsApp', key: ['whatsapp', 'whats app', 'à¤µà¥à¤¹à¤¾à¤Ÿà¥à¤¸à¤à¤ª', 'à¤µà¤¾à¤Ÿà¥à¤¸à¤à¤ª', 'à¤µà¥à¤¹à¤¾à¤Ÿà¥à¤¸à¤à¤ª'], urls: ['whatsapp://send'] },
  { label: 'Instagram', key: ['instagram', 'insta', 'à¤‡à¤‚à¤¸à¥à¤Ÿà¤¾à¤—à¥à¤°à¤¾à¤®', 'à¤‡à¤¨à¥à¤¸à¥à¤Ÿà¤¾à¤—à¥à¤°à¤¾à¤®'], urls: ['instagram://app', 'https://www.instagram.com'] },
  { label: 'Facebook', key: ['facebook', 'fb', 'à¤«à¥‡à¤¸à¤¬à¥à¤•'], urls: ['fb://facewebmodal', 'https://www.facebook.com'] },
  { label: 'Telegram', key: ['telegram', 'à¤Ÿà¥‡à¤²à¥€à¤—à¥à¤°à¤¾à¤®'], urls: ['tg://', 'https://telegram.org'] },
  { label: 'Snapchat', key: ['snapchat', 'à¤¸à¥à¤¨à¥ˆà¤ªà¤šà¥ˆà¤Ÿ'], urls: ['snapchat://', 'https://www.snapchat.com'] },
  { label: 'Spotify', key: ['spotify', 'à¤¸à¥à¤ªà¥‰à¤Ÿà¤¿à¤«à¤¾à¤ˆ'], urls: ['spotify://'] },
  { label: 'Gmail', key: ['gmail', 'à¤œà¥€à¤®à¥‡à¤²'], urls: ['googlegmail://'] },
  { label: 'Google', key: ['google', 'à¤—à¥‚à¤—à¤²'], urls: ['https://www.google.com'] },
  { label: 'Chrome', key: ['chrome', 'à¤•à¥à¤°à¥‹à¤®', 'browser', 'à¤¬à¥à¤°à¤¾à¤‰à¤œà¤¼à¤°'], urls: ['https://www.google.com'] },
  { label: 'Google Maps', key: ['maps', 'map', 'à¤¨à¤•à¥à¤¶à¤¾', 'à¤®à¥ˆà¤ªà¥à¤¸'], urls: ['geo:0,0?q='] },
  { label: 'Play Store', key: ['play store', 'playstore', 'à¤ªà¥à¤²à¥‡ à¤¸à¥à¤Ÿà¥‹à¤°'], urls: ['market://search?q='] },
  { label: 'PhonePe', key: ['phonepe', 'à¤«à¥‹à¤¨à¤ªà¥‡'], urls: ['phonepe://'] },
  { label: 'Google Pay', key: ['google pay', 'gpay', 'à¤œà¥€à¤ªà¥‡'], urls: ['tez://'] },
  { label: 'Paytm', key: ['paytm', 'à¤ªà¥‡à¤Ÿà¥€à¤à¤®'], urls: ['paytmmp://'] },
  { label: 'Swiggy', key: ['swiggy', 'à¤¸à¥à¤µà¤¿à¤—à¥€'], urls: ['swiggy://'] },
  { label: 'Zomato', key: ['zomato', 'à¤œà¤¼à¥‹à¤®à¥ˆà¤Ÿà¥‹', 'à¤œà¥‹à¤®à¥ˆà¤Ÿà¥‹'], urls: ['zomato://'] },
  { label: 'Uber', key: ['uber', 'à¤‰à¤¬à¤°'], urls: ['uber://'] },
  { label: 'Netflix', key: ['netflix', 'à¤¨à¥‡à¤Ÿà¤«à¥à¤²à¤¿à¤•à¥à¤¸'], urls: ['nflx://'] },
  { label: 'LinkedIn', key: ['linkedin', 'à¤²à¤¿à¤‚à¤•à¥à¤¡à¤‡à¤¨'], urls: ['linkedin://', 'https://www.linkedin.com'] }
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
    if (!/^hi/i.test(list[0])) {
      try { await TextToSpeech.openInstall(); } catch (e) {}
    }
  } catch (e) {
    ttsLastError = (e && e.message) ? e.message : String(e);
  }
}

function ttsTimeoutFor(text) {
  return 5000 + text.length * 130;
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
  try { await SpeechRecognition.stop(); } catch (e) {}
  try { await TextToSpeech.stop(); } catch (e) {}
  await initTts();

  const candidates = [];
  for (const l of [ttsLang, ...(ttsAvailable || []), ...TTS_ORDER]) {
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
      try { await TextToSpeech.stop(); } catch (e2) {}
    }
  }

  if (!spoke) {
    const web = await webSpeak(devaToLatin(text), 'en-IN');
    if (!web) {
      try { await TextToSpeech.openInstall(); } catch (e) {}
      errorBox.innerText = 'TTS fail: ' + ttsLastError + ' | langs: ' + (ttsAvailable || []).join(', ');
    }
  }

  await sleep(250);
  isSpeaking = false;
  setOrb('center-orb');
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
  t = t.replace(/(à¤•à¥‹|à¤¸à¥‡|ko|se)?\s*(phone|call|dial|fon|à¤«à¥‹à¤¨|à¤•à¥‰à¤²|à¤•à¤¾à¤²|à¤®à¤¿à¤²à¤¾à¤“|milao)\s*(à¤•à¤°à¥‹|à¤•à¤°|à¤•à¤° à¤¦à¥‹|karo|kar do|kar|lagao|à¤²à¤—à¤¾à¤“|lagana|à¤²à¤—à¤¾à¤¨à¤¾)?/g, ' ');
  t = t.replace(/\b(please|sir|jarvis|zara|abhi|mere|mera|the)\b/g, ' ');
  t = t.replace(/[?!,.à¥¤]/g, ' ');
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

  if (/(band karo|band kar|so jao|stop jarvis|alvida|bye jarvis|à¤¬à¤‚à¤¦ à¤•à¤°à¥‹|à¤¸à¥‹ à¤œà¤¾à¤“)/.test(probe)) {
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

  if (/(date|tarikh|tareekh|tarik|din|à¤¡à¥‡à¤Ÿ|à¤¤à¤¾à¤°à¥€à¤–à¤¼|à¤¤à¤¾à¤°à¥€à¤–|à¤¤à¤¾à¤°à¤¿à¤–|à¤¦à¤¿à¤¨|à¤†à¤œ)/.test(probe)) {
    if (!/(time|samay|baje|à¤Ÿà¤¾à¤‡à¤®|à¤¸à¤®à¤¯|à¤¬à¤œà¥‡)/.test(probe)) {
      const d = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      await say('Sir, aaj ' + d + ' hai.');
      return true;
    }
  }

  if (/(time|samay|baje|à¤Ÿà¤¾à¤‡à¤®|à¤¸à¤®à¤¯|à¤¬à¤œà¥‡)/.test(probe)) {
    const now = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    await say('Sir, abhi ' + now + ' ho rahe hain.');
    return true;
  }

  if (/(battery|à¤¬à¥ˆà¤Ÿà¤°à¥€)/.test(probe)) {
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

  if (/(call|phone|fon|dial|milao|à¤®à¤¿à¤²à¤¾à¤“|à¤•à¥‰à¤²|à¤«à¥‹à¤¨|à¤•à¤¾à¤²)/.test(probe)) {
    const done = await handleCall(raw);
    if (done) return true;
  }

  if (/(khol|kholo|open|chalao|chala do|launch|à¤–à¥‹à¤²|à¤–à¥‹à¤²à¥‹|à¤“à¤ªà¤¨|à¤šà¤¾à¤²à¥‚)/.test(probe)) {
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
