// JARVIS v6 - streaming replies, HD orb HUD, fast TTS language order
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { BackgroundMode } from '@anuradev/capacitor-background-mode';
import { AppLauncher } from '@capacitor/app-launcher';
import { Contacts } from '@capacitor-community/contacts';
import { registerPlugin } from '@capacitor/core';

// custom plugin - phone ke SARE installed apps ka label + package deta hai
// (build me workflow android/app/src/main/java/com/jarvis/hud/AppListPlugin.java banata hai)
const AppList = registerPlugin('AppList');

const WORKER_URL = 'https://jarvis-api.sachinsainimbd4339.workers.dev';
const LANG = 'hi-IN';

const orb = document.getElementById('orb');
const statusText = document.getElementById('statusText');
const transcriptDiv = document.getElementById('transcript');
const errorBox = document.getElementById('errorBox');
const core = document.getElementById('core');
const debugBox = document.getElementById('debugBox');
const testBtn = document.getElementById('testVoice');
const liveBox = document.getElementById('liveBox');
const modeTag = document.getElementById('modeTag');
const modeBtn = document.getElementById('modeBtn');

let history = [];
let activeLoop = false;
let isSpeaking = false;
let isThinking = false;
let pendingCallName = null;
let contactCache = null;
let ttsLang = 'hi-IN';
let ttsVoice = null;
let ttsReady = false;
let ttsGoodLang = ''; // jo language SACH ME bol chuki hai (proven)
const ttsDead = new Set(); // jo language timeout/fail hui - dobara try karke time barbaad na karo
const ttsFail = {}; // har language kitni baar fail hui (2 = dead)

// ---- full-duplex state (ChatGPT / Gemini Live jaise) ----
let duplex = true;            // true = bolte waqt bhi sunta hai (barge-in)
let duplexFails = 0;          // device ne audio roka to apne aap half-duplex ho jao
let speakGen = 0;             // interrupt par badhta hai - purani sentences ruk jati hain
let ttsSpokeThisReply = false;// is jawab me kuch bola ja chuka? (duplicate bolna band)
let micRunning = false;       // recognizer window abhi chal raha hai
let spokeSinceWindow = false; // is window me Jarvis bhi bola? (echo filter)
let winText = '';             // is window ka best text
let winPartialAt = 0;         // aakhri partial ka time
let winHasSpeech = false;     // is window me kuch suna gaya?
let winEnded = false;         // recognizer ne khud end kaha (listeningState stopped)
let livePartial = '';
let novelBuffer = '';         // Jarvis bolte waqt user ne jo kaha - save rehta hai
let userQueue = [];           // jo suna gaya, brain usko process karega
let listenersBound = false;
const spokenRecent = [];      // Jarvis ne abhi-abhi jo bola (echo filter ke liye)
const SILENCE_MS = 900;       // itni chup = user ki baat poori

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

// ---- words + echo filter ----
// mic ko Jarvis ki APNI awaaz bhi sunai deti hai. Usko user ki baat na maanne ke liye
// hum yaad rakhte hain ki Jarvis ne last 20s me kya bola.
const bw = (s) => String(devaToLatin(s || '')).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function rememberSpoken(text) {
  const words = bw(text);
  if (!words.length) return;
  const now = Date.now();
  spokenRecent.push({ t: now, words: words });
  while (spokenRecent.length && now - spokenRecent[0].t > 20000) spokenRecent.shift();
}

function spokenWordSet() {
  const set = new Set();
  const now = Date.now();
  for (const e of spokenRecent) {
    if (now - e.t > 20000) continue;
    for (const w of e.words) set.add(w);
  }
  return set;
}

// Hindi STT Devanagari deta hai (\u092F\u0942\u091F\u094D\u092F\u0942\u092C) jabki hum Latin bolte hain
// (YouTube) - spelling bilkul alag aati hai. Isliye consonants se compare karte hain:
// "yootyooba" -> ytb aur "youtube" -> ytb = same awaaz.
const VOWELISH = new Set('aeiouwy'.split(''));
function consonantKey(w) {
  const s = String(w || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  let out = s[0];
  const seen = new Set([s[0]]);
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (VOWELISH.has(c) || seen.has(c)) continue;
    seen.add(c);
    out += c;
  }
  return out;
}

// STT thode words alag likhta hai - isliye fuzzy + consonants dono se match karte hain
function wordInSet(w, set) {
  if (set.has(w)) return true;
  const ck = consonantKey(w);
  for (const s of set) {
    if (w.length >= 4 && Math.abs(s.length - w.length) <= 2 && similarity(w, s) >= 0.72) return true;
    if (ck.length >= 2 && consonantKey(s) === ck) return true;
  }
  return false;
}

// partial me se sirf WO words jo Jarvis ne nahi bole = user ki baat
function novelWords(partial) {
  const set = spokenWordSet();
  const out = [];
  for (const w of bw(partial)) if (!wordInSet(w, set)) out.push(w);
  return out;
}

const FILLER = new Set('ko ka ki ke se me mein hai he hain ho to bhi na ya aur ek sir ji ok okay hmm uh um tha wo ye yeh is us abhi thoda'.split(' '));

// barge-in: user ne 2+ asli naye words bole to turant chup ho jao
function bargeHold(text) {
  const strong = novelWords(text).filter((w) => w.length > 2 && !FILLER.has(w));
  if (!strong.length) return false;
  const line = strong.join(' ');
  if (bw(line).length >= bw(novelBuffer).length) novelBuffer = line;
  return (strong.length >= 2 && strong.join('').length >= 5);
}

// jo aakhri me suna gaya + jo bolte waqt bacha liya - dono jodo
function looksLikeEcho(text) {
  // chhote filler words (ko, hai, to) decide nahi karenge - warna user ki baat ud jaati
  const words = bw(text).filter((w) => w.length >= 4);
  if (words.length < 2) return false; // bharosa nahi - user ki baat hi maano
  const set = spokenWordSet();
  let hit = 0;
  for (const w of words) if (wordInSet(w, set)) hit++;
  return hit / words.length >= 0.72; // mostly humari hi baatein wapas aayi
}

function takeUserText(finalText) {
  const f = String(finalText || '').trim();
  const acc = novelBuffer.trim();
  novelBuffer = '';
  let keep = f;
  if (f && spokeSinceWindow && looksLikeEcho(f)) keep = '';
  if (!acc) return keep;
  if (!keep) return acc;
  const fw = bw(keep);
  const nw = bw(acc);
  let hit = 0;
  for (const w of nw) if (fw.indexOf(w) !== -1) hit++;
  if (nw.length && hit / nw.length >= 0.5) return keep;
  return (acc + ' ' + keep).trim();
}

function applyModeTag() {
  if (modeTag) modeTag.innerText = duplex ? 'DUPLEX // LIVE MIC' : 'HALF-DUPLEX';
  if (modeBtn) modeBtn.innerText = 'MODE: ' + (duplex ? 'DUPLEX' : 'HALF');
}

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
  { label: 'YouTube', key: ['youtube', 'you tube', '\u092F\u0942\u091F\u094D\u092F\u0942\u092C', 'yt'], urls: ['vnd.youtube://', 'com.google.android.youtube', 'https://www.youtube.com'] },
  { label: 'WhatsApp', key: ['whatsapp', 'whats app', '\u0935\u094D\u0939\u093E\u091F\u094D\u0938\u090F\u092A', '\u0935\u093E\u091F\u094D\u0938\u090F\u092A', '\u0935\u094D\u0939\u093E\u091F\u094D\u0938\u0910\u092A'], urls: ['whatsapp://send', 'com.whatsapp'] },
  { label: 'Instagram', key: ['instagram', 'insta', '\u0907\u0902\u0938\u094D\u091F\u093E\u0917\u094D\u0930\u093E\u092E', '\u0907\u0928\u094D\u0938\u094D\u091F\u093E\u0917\u094D\u0930\u093E\u092E'], urls: ['instagram://app', 'com.instagram.android', 'https://www.instagram.com'] },
  { label: 'Facebook', key: ['facebook', 'fb', '\u092B\u0947\u0938\u092C\u0941\u0915'], urls: ['fb://facewebmodal', 'com.facebook.katana', 'https://www.facebook.com'] },
  { label: 'Telegram', key: ['telegram', '\u091F\u0947\u0932\u0940\u0917\u094D\u0930\u093E\u092E'], urls: ['tg://', 'org.telegram.messenger', 'https://telegram.org'] },
  { label: 'Snapchat', key: ['snapchat', '\u0938\u094D\u0928\u0948\u092A\u091A\u0948\u091F'], urls: ['snapchat://', 'com.snapchat.android', 'https://www.snapchat.com'] },
  { label: 'Spotify', key: ['spotify', '\u0938\u094D\u092A\u0949\u091F\u093F\u092B\u093E\u0908'], urls: ['spotify://', 'com.spotify.music'] },
  { label: 'Gmail', key: ['gmail', '\u091C\u0940\u092E\u0947\u0932'], urls: ['googlegmail://', 'com.google.android.gm'] },
  { label: 'Google', key: ['google', '\u0917\u0942\u0917\u0932'], urls: ['com.google.android.googlequicksearchbox', 'https://www.google.com'] },
  { label: 'Chrome', key: ['chrome', '\u0915\u094D\u0930\u094B\u092E', 'browser', '\u092C\u094D\u0930\u093E\u0909\u091C\u093C\u0930'], urls: ['com.android.chrome', 'https://www.google.com'] },
  { label: 'Google Maps', key: ['maps', 'map', '\u0928\u0915\u094D\u0936\u093E', '\u092E\u0948\u092A\u094D\u0938'], urls: ['geo:0,0?q=', 'com.google.android.apps.maps'] },
  { label: 'Play Store', key: ['play store', 'playstore', '\u092A\u094D\u0932\u0947 \u0938\u094D\u091F\u094B\u0930'], urls: ['market://search?q=', 'com.android.vending'] },
  { label: 'PhonePe', key: ['phonepe', '\u092B\u094B\u0928\u092A\u0947'], urls: ['phonepe://', 'com.phonepe.app'] },
  { label: 'Google Pay', key: ['google pay', 'gpay', '\u091C\u0940\u092A\u0947'], urls: ['tez://', 'com.google.android.apps.nbu.paisa.user'] },
  { label: 'Paytm', key: ['paytm', '\u092A\u0947\u091F\u0940\u090F\u092E'], urls: ['paytmmp://', 'net.one97.paytm'] },
  { label: 'Swiggy', key: ['swiggy', '\u0938\u094D\u0935\u093F\u0917\u0940'], urls: ['swiggy://', 'in.swiggy.android'] },
  { label: 'Zomato', key: ['zomato', '\u091C\u093C\u094B\u092E\u0948\u091F\u094B', '\u091C\u094B\u092E\u0948\u091F\u094B'], urls: ['zomato://', 'com.application.zomato'] },
  { label: 'Uber', key: ['uber', '\u0909\u092C\u0930'], urls: ['uber://', 'com.ubercab'] },
  { label: 'Netflix', key: ['netflix', '\u0928\u0947\u091F\u092B\u094D\u0932\u093F\u0915\u094D\u0938'], urls: ['nflx://', 'com.netflix.mediaclient'] },
  { label: 'LinkedIn', key: ['linkedin', '\u0932\u093F\u0902\u0915\u094D\u0921\u0907\u0928'], urls: ['linkedin://', 'com.linkedin.android', 'https://www.linkedin.com'] },
  { label: 'Amazon', key: ['amazon', 'amazon shopping'], urls: ['com.amazon.mShop.android.shopping'] },
  { label: 'Flipkart', key: ['flipkart', 'flip kart'], urls: ['com.flipkart.android'] },
  { label: 'Hotstar', key: ['hotstar', 'disney'], urls: ['in.startv.hotstar'] },
  { label: 'YouTube Music', key: ['youtube music', 'yt music', 'youtube music app'], urls: ['com.google.android.apps.youtube.music'] },
  { label: 'Google Photos', key: ['photos', 'photo', 'gallery'], urls: ['com.google.android.apps.photos'] },
  { label: 'Truecaller', key: ['truecaller', 'true caller'], urls: ['com.truecaller'] },
  { label: 'WhatsApp Business', key: ['whatsapp business', 'wa business'], urls: ['com.whatsapp.w4b'] },
  { label: 'Notes', key: ['notes', 'note', 'keep'], urls: ['com.google.android.keep'] },
  { label: 'Drive', key: ['drive', 'google drive'], urls: ['com.google.android.apps.docs'] },
  { label: 'Calculator', key: ['calculator', 'calc'], urls: ['com.google.android.calculator'] },
  { label: 'JioCinema', key: ['jiocinema', 'jio cinema'], urls: ['com.jio.media.jiobeats'] }
];

async function openFirst(app) {
  for (const url of (app.urls || [])) {
    try {
      const r = await AppLauncher.openUrl({ url });
      // openUrl reject nahi karta, completed:false bhejta hai - isliye check zaroori hai
      if (r && r.completed !== false) return true;
    } catch (e) {}
  }
  return false;
}

// ---- installed apps (AppList plugin) ----
let installedApps = null;
async function getInstalledApps() {
  if (installedApps) return installedApps;
  try {
    const r = await AppList.list();
    installedApps = (r.apps || [])
      .map((a) => ({ label: String(a.label || ''), pkg: String(a.pkg || ''), key: norm(a.label) }))
      .filter((a) => a.key.length >= 3 && a.pkg);
    dbg('installed apps: ' + installedApps.length);
  } catch (e) {
    installedApps = [];
    dbg('AppList: ' + ((e && e.message) || e));
  }
  return installedApps;
}

// kholne ka naam: filler words hatao, phir labels se match karo
const OPENER_WORDS = new Set([
  'khol', 'kholo', 'kholna', 'kholde', 'open', 'chalao', 'chala', 'chal', 'launch',
  'karo', 'kar', 'kardo', 'do', 'lagao', 'please', 'app', 'bana', 'banao',
  'ji', 'sir', 'jarvis', 'mera', 'mere', 'meri', 'abhi', 'zara', 'jara', 'bhai'
]);
async function matchInstalledApp(latinLower) {
  const words = String(latinLower || '').split(/[^a-z0-9]+/).filter((w) => w && !OPENER_WORDS.has(w));
  const q = words.join('');
  if (q.length < 3) return null;
  const list = await getInstalledApps();
  let best = null, score = 0;
  for (const a of list) {
    let s = similarity(a.key, q);
    if (q.indexOf(a.key) !== -1) s = Math.max(s, 0.95);
    if (s > score) { score = s; best = a; }
  }
  return score >= 0.6 ? best : null;
}

async function loadContacts() {
  if (contactCache) return contactCache;
  let st = '';
  try {
    st = (await Contacts.checkPermissions()).contacts;
    dbg('contacts check: ' + st);
    if (st !== 'granted' && st !== 'limited') st = (await Contacts.requestPermissions()).contacts;
  } catch (e) {
    dbg('contacts err: ' + ((e && e.message) || e));
  }
  dbg('contacts permission: ' + st);
  if (st !== 'granted' && st !== 'limited') throw new Error('CONTACT_' + st);

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
// 1.0 = normal/male jaisi, 1.4 = female jaisi awaaz
const TTS_PITCH = 1.4;
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
  await pickVoice();
}

// engine ki voice list se gender-appropriate voice dhoondho
// NOTE: "female" naam me bhi "male" hota hai - isliye male check me female exclude karo
async function pickVoice() {
  try {
    const v = await TextToSpeech.getSupportedVoices();
    const arr = (v && v.voices) || [];
    if (!arr.length) { ttsVoice = -1; return; }
    const want = String(ttsLang || 'hi-IN').split('-')[0].toLowerCase();
    let idx = -1;
    for (let i = 0; i < arr.length; i++) {
      const nm = String(arr[i].name || '').toLowerCase();
      const lg = String(arr[i].lang || '').toLowerCase();
      if (lg && lg.indexOf(want) !== 0 && nm.indexOf(want) === -1) continue;
      if (voiceMode === 'male') {
        if (nm.indexOf('male') === -1) continue;
        if (nm.indexOf('female') !== -1) continue;
      } else {
        if (nm.indexOf('female') === -1 && nm.indexOf('fem') === -1) continue;
      }
      idx = i;
      break;
    }
    ttsVoice = idx;
    dbg('voice(' + voiceMode + '): ' + (idx >= 0 ? String(arr[idx].name).slice(0, 26) : 'engine default'));
  } catch (e) {
    ttsVoice = -1;
  }
}

// engine voice mili to uska apna natural pitch, warna pitch se gender banao
function currentPitch() {
  if (typeof ttsVoice === 'number' && ttsVoice >= 0) return 1.0;
  return voiceMode === 'male' ? 0.85 : TTS_PITCH;
}

// engine ko chup-chaap taiyaar karo (bina koi awaaz / mute 'ok' bole)
// pehle yahan muted 'ok' bol kar 3s wait hota tha - wahi start par atakne ki wajah tha
async function bootTts() {
  try { await initTts(); } catch (e) {}
}

// ek sentence bolne ka timeout - bahut lamba timeout = dheera jawab
function ttsTimeoutFor(text) {
  // asli bolne ki speed (~14 char/sec) ka 2x headroom. Timeout sirf dead engine par lagta hai.
  return 2500 + text.length * 140;
}

async function speakNative(text, lang, flush) {
  const out = /^hi/i.test(lang) ? text : devaToLatin(text);
  const opts = { text: out, lang: lang, rate: 1.0, pitch: currentPitch(), volume: 1.0 };
  if (typeof ttsVoice === 'number' && ttsVoice >= 0) opts.voice = ttsVoice;
  // flush=false = nayi line purani queue ke peeche lagti hai (streaming jawab ke liye)
  if (flush === false) opts.queueStrategy = 1;
  await withTimeout(TextToSpeech.speak(opts), ttsTimeoutFor(out));
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
  const wasActive = activeLoop;
  const gen = speakGen;
  ttsSpokeThisReply = false;
  isSpeaking = true;
  setOrb('center-orb speaking');
  setStatus('JARVIS BOL RAHA HAI...');

  try {
    await initTts();
    // sentence-wise bolo - pehla sentence turant shuru hota hai, awaaz atakti nahi
    const chunks = splitSentences(text);
    let spoke = false;
    for (let i = 0; i < chunks.length; i++) {
      if (wasActive && !activeLoop) break; // user ne beech me band kar diya
      if (gen !== speakGen) break;         // user ne bolna shuru kiya (barge-in)
      if (await speakSentence(chunks[i], i === 0, gen)) spoke = true;
    }
    if (!spoke) {
      const web = await webSpeak(devaToLatin(text), 'en-IN');
      if (!web) {
        errorBox.innerText = 'TTS fail: ' + ttsLastError + ' | langs: ' + (ttsAvailable || []).join(', ');
        dbg('tts fail: ' + ttsLastError);
      }
    }
  } finally {
    // mic band NAHI karte - full-duplex me recognizer chalta rehta hai
    isSpeaking = false;
    setOrb('center-orb');
    if (!wasActive && !activeLoop) setStatus('TAP CORE TO START');
    else if (!isThinking) setStatus('JARVIS SUN RAHA HAI...');
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
  await initTts();
  for (const lang of ['hi-IN', 'en-IN', 'en-US']) {
    const t0 = Date.now();
    try {
      await withTimeout(
        TextToSpeech.speak({ text: 'Ek do teen. Jarvis bol raha hai.', lang: lang, rate: 1.0, pitch: currentPitch(), volume: 1.0, voice: (typeof ttsVoice === 'number' && ttsVoice >= 0) ? ttsVoice : undefined }),
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

// ---- text ko sentences me todo (boundary: . ! ? danda \u0964 newline) ----
function splitSentences(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    cur += c;
    const isEnd = (c === '.' || c === '!' || c === '?' || c === '\u0964' || c === '\n');
    if (!isEnd) continue;
    if (c === '.' && s[i + 1] && s[i + 1] >= '0' && s[i + 1] <= '9') continue; // 3.5 jaisa decimal
    const t = cur.trim();
    if (t) out.push(t);
    cur = '';
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [s];
}

// pehla sentence boundary dhoondho (. ? ! danda \u0964 newline) - decimal (3.5) mat todo
function firstBoundary(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '.' || c === '!' || c === '?' || c === '\u0964' || c === '\n') {
      if (c === '.' && s[i + 1] && s[i + 1] >= '0' && s[i + 1] <= '9') continue;
      return i + 1;
    }
  }
  return -1;
}

// language order: jo proven hai pehle, phir script ke hisaab se, aur dead sabse aakhir me
function buildLangOrder(s) {
  // Devanagari text = hi-IN pehle, Latin (Hinglish) = en-IN pehle
  const hasDev = /[\u0900-\u097F]/.test(s);
  const pref = hasDev ? ['hi-IN', 'en-IN', 'en-US'] : ['en-IN', 'en-US', 'hi-IN'];
  const raw = [];
  if (ttsGoodLang) raw.push(ttsGoodLang);
  for (const l of pref) raw.push(l);
  if (ttsLang) raw.push(ttsLang);
  for (const l of TTS_ORDER) raw.push(l);
  const out = [];
  for (const l of raw) if (l && out.indexOf(l) === -1 && !ttsDead.has(l)) out.push(l);
  for (const l of raw) if (l && out.indexOf(l) === -1) out.push(l);
  return out;
}

// device ne TTS rok diya (audio focus) to duplex band kar do - warna awaaz atakti hai
function duplexFail() {
  if (!duplex || !micRunning) return;
  duplexFails++;
  if (duplexFails >= 2) {
    duplex = false;
    applyModeTag();
    dbg('DUPLEX OFF (device ne audio roka)');
  }
}

// ek sentence bolo. Pehli sentence flush hoti hai, baaki queue me (streaming).
// ZAROORI: ek sentence sirf EK language me bolte hain - warna wahi line dobara
// bol kar "atak atak" jaisa lagta tha.
async function speakSentence(text, flush, gen) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (gen !== undefined && gen !== speakGen) return false;
  if (flush) {
    TextToSpeech.stop().catch(() => {}); // fire-and-forget - pehli awaaz jaldi aaye
    isSpeaking = true;
    setOrb('center-orb speaking');
    setStatus('JARVIS BOL RAHA HAI...');
  }
  const order = buildLangOrder(s);
  // pehli sentence = probe (2-3 language try), baaki sentences = sirf 1 try
  const maxTry = ttsSpokeThisReply ? 1 : Math.min(3, order.length);
  for (let i = 0; i < maxTry; i++) {
    const lang = order[i];
    if (!lang) break;
    if (gen !== undefined && gen !== speakGen) return false;
    const t0 = Date.now();
    try {
      writeSpoken(s);
      await speakNative(s, lang, flush);
      ttsLang = lang;
      ttsGoodLang = lang;
      ttsDead.delete(lang);
      ttsFail[lang] = 0;
      ttsSpokeThisReply = true;
      dbg('tts ' + lang + ' ok ' + (Date.now() - t0) + 'ms');
      return true;
    } catch (e) {
      ttsLastError = (e && e.message) ? e.message : String(e);
      dbg('tts ' + lang + ' fail ' + (Date.now() - t0) + 'ms');
      if (/timeout/i.test(ttsLastError)) {
        ttsFail[lang] = (ttsFail[lang] || 0) + 1;
        if (ttsFail[lang] >= 2) ttsDead.add(lang);
        if (ttsGoodLang === lang) ttsGoodLang = '';
        duplexFail();
      }
      try { await withTimeout(TextToSpeech.stop(), 800); } catch (e2) {}
    }
  }
  return false;
}

async function askGemini(promptText) {
  const payload = '[' + nowContext() + ' Isi ko sach maano, apni purani date use mat karo.] ' + promptText + ' [Jawab sirf 1-2 line ka rakho, bolne ke liye hai.]';
  history.push({ role: 'user', parts: [{ text: payload }] });
  if (history.length > 8) history = history.slice(-8);
  while (history.length && history[0].role !== 'user') history.shift();

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: history, stream: true }),
      signal: AbortSignal.timeout(60000)
    });
    const ctype = (res.headers.get('content-type') || '').toLowerCase();

    // ---- naya path: worker SSE stream bhejta hai - pehla sentence milti hi bolo ----
    if (res.ok && res.body && ctype.indexOf('event-stream') >= 0) {
      await initTts();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let full = '';
      let pending = '';
      let first = true;
      let anySpoke = false;
      const gen = speakGen;
      // sentences ek-ek karke chain me - har utterance apna timeout sahi rakhe
      let chain = Promise.resolve();
      const enqueue = (s, f) => {
        chain = chain.then(() => {
          if (!activeLoop || gen !== speakGen) return; // band / user ne rok diya
          return speakSentence(s, f, gen).then((ok) => { if (ok) anySpoke = true; });
        });
      };
      const flushTo = (final) => {
        for (;;) {
          let cut = firstBoundary(pending);
          if (cut < 0 && pending.length > 300) cut = pending.lastIndexOf(' ');
          if (cut <= 0) break;
          const s = pending.slice(0, cut).trim();
          pending = pending.slice(cut);
          if (!s) continue;
          const f = first;
          first = false;
          enqueue(s, f);
        }
        if (final && pending.trim()) {
          const s = pending.trim();
          pending = '';
          const f = first;
          first = false;
          enqueue(s, f);
        }
      };
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.indexOf('data:') !== 0) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const cand = j.candidates && j.candidates[0];
            const parts = cand && cand.content && cand.content.parts;
            const t = parts ? parts.map((p) => p.text || '').join('') : '';
            if (t) {
              full += t;
              pending += t;
              transcriptDiv.innerText = 'JARVIS: ' + full.trim();
              flushTo(false);
            }
          } catch (e) {}
        }
      }
      flushTo(true);
      await chain;
      if (full.trim()) {
        history.push({ role: 'model', parts: [{ text: full.trim() }] });
        // TTS bilkul fail hua to text wapas bolo
        if (!anySpoke) return full.trim();
        isSpeaking = false;
        setOrb('center-orb');
        return '';
      }
      throw new Error('khaali jawab');
    }

    // ---- purana path: worker JSON deta hai (abhi tak wahi deployed hai) ----
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
    const cst = String((e && e.message) || '').replace('CONTACT_', '') || 'nahi';
    await say('Sir, contacts permission ' + cst + ' hai. Settings, Apps, JARVIS, Permissions me Contacts allow karein.');
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
    // 1) built-in list (deep links - sabse reliable)
    for (const app of APPS) {
      if (app.key.some((k) => probe.includes(k))) {
        const ok = await openFirst(app);
        await say(ok ? app.label + ' khol raha hoon sir.' : app.label + ' install nahi khula, sir.');
        return true;
      }
    }
    // 2) phone me installed SARI apps (AppList plugin se) - koi bhi app bol sakte hain
    try {
      const dyn = await matchInstalledApp(latin);
      if (dyn) {
        const ok = await openFirst({ urls: [dyn.pkg] });
        await say(ok ? dyn.label + ' khol raha hoon sir.' : dyn.label + ' khula nahi, sir.');
        return true;
      }
    } catch (e) {}
    await say('Wo app mere paas nahi hai sir. YouTube, WhatsApp, Instagram, Telegram, Facebook, Snapchat, Spotify, Gmail, Maps, Play Store, PhonePe, GPay, Paytm, Swiggy, Zomato, Uber, Netflix, LinkedIn, Amazon, Flipkart, Hotstar ya koi aur installed app boliye.');
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

// ---- listening: ek window = ek utterance (partialResults ke saath) ----
// Plugin ka native code: partialResults:true par start() turant resolve hota hai,
// text `partialResults` event se aata hai (final result bhi usi event se).
async function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;
  try {
    await SpeechRecognition.addListener('partialResults', (d) => onPartial((d && d.matches) || []));
    await SpeechRecognition.addListener('listeningState', (d) => {
      // sirf CHAL RAHE window ka end maano - purane window ka late event naye window ko
      // jaldi band nahi karega (warna beech me 1-2s kaan band ho jata hai)
      if (micRunning && d && d.status === 'stopped') winEnded = true;
    });
    dbg('mic listeners: bound');
  } catch (e) {
    dbg('mic listener: ' + ((e && e.message) || e));
  }
}

// user ne bolna shuru kiya - turant chup ho jao (barge-in)
async function hush() {
  speakGen++;
  isSpeaking = false;
  setOrb('center-orb listening-mode');
  setStatus('JARVIS SUN RAHA HAI...');
  try { await withTimeout(TextToSpeech.stop(), 1200); } catch (e) {}
  try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
}

// jo bol rahe hain wo yaad rakho - isse echo filter chalta hai
function writeSpoken(text) {
  rememberSpoken(text);
  spokeSinceWindow = true;
  isSpeaking = true;
}

// har partial yahan aata hai (final result bhi isi se aata hai)
function onPartial(matches) {
  if (!activeLoop) return;
  const text = matches && matches[0] ? String(matches[0]).trim() : '';
  if (!text) return;
  if (bw(text).length >= bw(winText).length) winText = text; // partial cumulative hai
  winPartialAt = Date.now();
  winHasSpeech = true;
  livePartial = winText;
  if (liveBox) liveBox.innerText = 'Aap: "' + winText + '"';
  if (isSpeaking) {
    // Jarvis bol raha hai: sirf user ke NAYE words dekho, apni awaaz nahi
    if (bargeHold(text)) {
      dbg('barge-in: ' + text.slice(0, 40));
      hush().catch(() => {});
    }
    return;
  }
  if (!isThinking) {
    setOrb('center-orb listening-mode');
    setStatus('JARVIS SUN RAHA HAI...');
  }
}

// ek listen window - Jarvis bolte waqt bhi chalti rehti hai (full-duplex)
async function listenWindow() {
  winText = '';
  winPartialAt = 0;
  winHasSpeech = false;
  winEnded = false;
  spokeSinceWindow = isSpeaking; // pehle se bol rahe hain = echo aayega
  livePartial = '';
  if (!isSpeaking && !isThinking) {
    setStatus('JARVIS SUN RAHA HAI...');
    setOrb('center-orb listening-mode');
  }
  try {
    await withTimeout(
      SpeechRecognition.start({ language: LANG, maxResults: 3, partialResults: true, popup: false, prompt: '' }),
      6000
    );
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/busy|delegate|already/i.test(msg)) dbg('mic start: ' + msg.slice(0, 60));
    await sleep(400);
    return '';
  }
  micRunning = true;
  const t0 = Date.now();
  let pollAt = 0;
  while (activeLoop) {
    await sleep(120);
    const now = Date.now();
    if (winEnded) { await sleep(320); break; }                  // recognizer ne khud khatam kiya
    if (winHasSpeech && now - winPartialAt > SILENCE_MS) break;  // user chup ho gaya
    if (!winHasSpeech && now - t0 > 11000) break;                // kuch bola hi nahi
    if (now - t0 > 24000) break;                                 // safety cap
    if (!duplex && isSpeaking) break;                            // half-duplex fallback
    if (now - pollAt > 450) {
      pollAt = now;
      try {
        const st = await withTimeout(SpeechRecognition.isListening(), 800);
        if (st && st.listening === false) { await sleep(200); break; } // error/no-match par bhi atkega nahi
      } catch (e) {}
    }
  }
  micRunning = false;
  if (!winEnded) {
    try { await withTimeout(SpeechRecognition.stop(), 900); } catch (e) {}
    await sleep(260); // final result aane do
  }
  const said = takeUserText(winText);
  winText = '';
  if (liveBox && !said) liveBox.innerText = '';
  return said;
}

// mic pump: hamesha sunta rehta hai, jo mila wo queue me daal deta hai
async function micPump() {
  await bindListeners();
  while (activeLoop) {
    if (!duplex && (isSpeaking || isThinking)) { await sleep(150); continue; }
    const said = await listenWindow();
    if (!activeLoop) break;
    if (!said) continue;
    dbg('suna: ' + said.slice(0, 44));
    userQueue.push(said);
    while (userQueue.length > 2) userQueue.shift();
  }
}

// brain: queue se uthata hai, samajhta hai, jawab deta hai
async function brain() {
  while (activeLoop) {
    if (!userQueue.length) { await sleep(60); continue; }
    const raw = userQueue.shift();
    if (isSpeaking) await hush();
    if (liveBox) liveBox.innerText = '';
    transcriptDiv.innerText = 'Aap: "' + raw + '"';
    isThinking = true;
    setOrb('center-orb thinking-mode');
    setStatus('JARVIS SOCH RAHA HAI...');
    try {
      const handled = await routeLocal(raw);
      if (!handled) {
        const ans = await askGemini(raw);
        if (ans) await say(ans);
      }
    } catch (e) {
      errorBox.innerText = 'Error: ' + e.message;
    } finally {
      isThinking = false;
      if (activeLoop) {
        setOrb('center-orb listening-mode');
        setStatus('JARVIS SUN RAHA HAI...');
      }
    }
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
  speakGen++;
  micRunning = false;
  winText = '';
  livePartial = '';
  novelBuffer = '';
  userQueue = [];
  try { await SpeechRecognition.removeAllListeners(); } catch (e) {}
  listenersBound = false;
  await nStopRec();
  try { await withTimeout(TextToSpeech.stop(), 2000); } catch (e) {}
  try { speechSynthesis.cancel(); } catch (e) {}
  try { await BackgroundMode.disable(); } catch (e) {}
  if (liveBox) liveBox.innerText = '';
  setOrb('center-orb');
  setStatus('STANDBY - TAP TO START');
}

async function startAssistant() {
  errorBox.innerText = '';
  activeLoop = true;
  setStatus('START HO RAHA HAI...');
  // TTS ko permissions ke SAATH parallel taiyaar karo (inline wait nahi)
  const ttsBoot = bootTts();
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

  try {
    let cp = await Contacts.checkPermissions();
    dbg('contacts (shuru): ' + cp.contacts);
    if (cp.contacts !== 'granted' && cp.contacts !== 'limited') {
      cp = await Contacts.requestPermissions();
      dbg('contacts (baad me): ' + cp.contacts);
    }
  } catch (e) { dbg('contacts ask: ' + ((e && e.message) || e)); }

  await ttsBoot;
  // greeting pehle, mic uske BAAD - isse start par awaaz atakti nahi
  await say('Namaste sir. Jarvis taiyaar hai. Kahiye, main kya karoon?');
  if (!activeLoop) return;
  applyModeTag();
  // diagnostics greeting ke BAAD, background me (awaaz ko rok kar nahi)
  setTimeout(() => { ttsProbe().catch(() => {}); }, 3500);
  // ab do parallel loops: mic hamesha sunta hai, brain jawab deta hai
  micPump().catch((e) => { errorBox.innerText = 'Mic: ' + e.message; });
  brain().catch((e) => { errorBox.innerText = 'Loop: ' + e.message; });
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
    if (okLang) { ttsLang = okLang; ttsGoodLang = okLang; ttsDead.delete(okLang); dbg('ttsLang set: ' + okLang); }
  };
}

// ---- voice mode toggle: male (default, jaisa aapne maanga) <-> female ----
const voiceBtn = document.getElementById('voiceBtn');
const VOICE_KEY = 'jarvis_voice_mode';
let voiceMode = 'male';
try { voiceMode = localStorage.getItem(VOICE_KEY) || 'male'; } catch (e) {}
function applyVoiceMode() {
  if (voiceBtn) voiceBtn.innerText = 'VOICE: ' + voiceMode.toUpperCase();
}
applyVoiceMode();
if (voiceBtn) {
  voiceBtn.onclick = (e) => {
    e.stopPropagation();
    voiceMode = voiceMode === 'male' ? 'female' : 'male';
    try { localStorage.setItem(VOICE_KEY, voiceMode); } catch (err) {}
    applyVoiceMode();
    dbg('voice mode: ' + voiceMode);
    pickVoice();
    say(voiceMode === 'male' ? 'Male voice chalu hai sir.' : 'Female voice chalu hai sir.');
  };
}

// ---- duplex toggle: DUPLEX = bolte waqt bhi sunta hai (default) ----
if (modeBtn) {
  modeBtn.onclick = (e) => {
    e.stopPropagation();
    duplex = !duplex;
    duplexFails = 0;
    applyModeTag();
    dbg('mode: ' + (duplex ? 'duplex' : 'half'));
    say(duplex ? 'Full duplex chalu hai sir, bolte waqt bhi sununga.' : 'Half duplex hai sir, meri baat ke baad sununga.');
  };
}
applyModeTag();

// app start hote hi TTS garam karo (chup warm-up) - sirf native app me, browser preview me nahi
setTimeout(() => {
  const native = window.Capacitor && typeof Capacitor.isNativePlatform === 'function' && Capacitor.isNativePlatform();
  if (native) bootTts();
}, 400);
