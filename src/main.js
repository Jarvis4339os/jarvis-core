import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { AppLauncher } from '@capacitor/app-launcher';
import { Contacts } from '@capacitor-community/contacts';
import { BackgroundMode } from '@anuradev/capacitor-background-mode';

const WORKER_URL = "https://jarvis-api.sachinsainimbd4339.workers.dev";

const orb = document.getElementById('orb');
const statusText = document.getElementById('statusText');
const transcriptDiv = document.getElementById('transcript');
const errorBox = document.getElementById('errorBox');

let history = [];
let isSpeaking = false;
let activeLoop = false;
let recognition = null;
let lastUserText = "";
let ttsReady = false;

const SpeechRecognitionWeb = window.SpeechRecognition || window.webkitSpeechRecognition;

// ---------- BACKGROUND MODE ----------
async function enableBackground() {
  if (!window.Capacitor?.isNativePlatform?.()) return;
  try {
    await BackgroundMode.enable();
    BackgroundMode.on('activate', () => {
      if (activeLoop && !isSpeaking) {
        setTimeout(startMicSafe, 500);
      }
    });
  } catch (e) {
    console.log('BackgroundMode err', e);
  }
}

// ---------- TTS INIT ----------
async function initTts() {
  if (!window.Capacitor?.isNativePlatform?.()) {
    ttsReady = false;
    return;
  }
  try {
    const langs = await TextToSpeech.getSupportedLanguages().catch(() => ({ languages: [] }));
    const voices = await TextToSpeech.getSupportedVoices().catch(() => ({ voices: [] }));
    console.log('[TTS] Supported Languages:', langs?.languages || []);
    console.log('[TTS] Supported Voices:', voices?.voices?.length || 0);
    ttsReady = true;
  } catch (e) {
    console.log('[TTS] Init Error:', e);
    ttsReady = false;
  }
}

// ---------- SPEAK FUNCTION ----------
async function say(rawText) {
  const text = (rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    startMicSafe();
    return;
  }

  transcriptDiv.innerText = `JARVIS: ${text}`;
  stopMicSafe();
  if (window.speechSynthesis) window.speechSynthesis.cancel();

  isSpeaking = true;
  orb.className = 'center-orb speaking';
  statusText.innerText = 'JARVIS BOL RAHA HAI...';
  errorBox.innerText = '';

  // NATIVE TTS (CAPACITOR)
  if (window.Capacitor?.isNativePlatform?.() && ttsReady) {
    try {
      const langRes = await TextToSpeech.getSupportedLanguages().catch(() => ({ languages: [] }));
      const list = langRes.languages || [];

      let lang = 'en-US';
      if (list.includes('hi-IN')) lang = 'hi-IN';
      else if (list.includes('en-IN')) lang = 'en-IN';
      else if (list.includes('en-US')) lang = 'en-US';
      else if (list.length > 0) lang = list[0];

      await TextToSpeech.speak({
        text: text,
        lang: lang,
        rate: 0.95,
        pitch: 1.0,
        volume: 1.0,
        queueStrategy: 0
      });

      isSpeaking = false;
      orb.className = 'center-orb';
      statusText.innerText = activeLoop ? 'JARVIS SUN RAHA HAI...' : 'STANDBY - TAP TO START';
      if (activeLoop && !orb.classList.contains('thinking-mode')) {
        setTimeout(startMicSafe, 400);
      }
      return;
    } catch (e) {
      console.log('[TTS] Native speak failed, falling back to web:', e);
    }
  }

  // WEB TTS FALLBACK
  if (window.speechSynthesis) {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'hi-IN';
    utter.rate = 0.95;
    utter.pitch = 1.0;
    utter.volume = 1.0;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      isSpeaking = false;
      orb.className = 'center-orb';
      statusText.innerText = activeLoop ? 'JARVIS SUN RAHA HAI...' : 'STANDBY - TAP TO START';
      if (activeLoop && !orb.classList.contains('thinking-mode')) {
        setTimeout(startMicSafe, 400);
      }
    };

    utter.onend = finish;
    utter.onerror = finish;
    utter.onstart = () => {
      orb.className = 'center-orb speaking';
      statusText.innerText = 'JARVIS BOL RAHA HAI...';
    };

    window.speechSynthesis.speak(utter);
    setTimeout(finish, 3500 + text.length * 70);
    return;
  }

  isSpeaking = false;
  orb.className = 'center-orb';
  if (activeLoop) setTimeout(startMicSafe, 400);
}

// ---------- MIC INIT ----------
function initMic() {
  if (window.Capacitor?.isNativePlatform?.()) {
    try {
      SpeechRecognition.requestPermissions().catch(() => {});
    } catch (e) { }
    recognition = {
      start: async () => {
        try {
          await SpeechRecognition.start({
            language: 'hi-IN',
            maxResults: 1,
            prompt: 'Bol ke batayiye...',
            partialResults: false,
            popup: false
          });
        } catch (e) {
          console.log('CapSpeech start err', e);
          if (activeLoop && !isSpeaking) setTimeout(startMicSafe, 800);
        }
      },
      stop: async () => {
        try { await SpeechRecognition.stop(); } catch (e) { }
      }
    };

    SpeechRecognition.addListener('partialResults', () => { });
    SpeechRecognition.addListener('listeningState', (state) => {
      if (state.status === 'started') {
        isSpeaking = false;
        statusText.innerText = 'JARVIS SUN RAHA HAI...';
        orb.className = 'center-orb listening-mode';
      }
    });

    SpeechRecognition.addListener('error', (e) => {
      console.log('CapSpeech error', e);
      if (activeLoop && !isSpeaking) setTimeout(startMicSafe, 800);
    });

    SpeechRecognition.addListener('result', (res) => {
      const text = res?.matches?.[0] || '';
      if (!text || text.trim() === '') {
        if (activeLoop && !isSpeaking) setTimeout(startMicSafe, 600);
        return;
      }
      handleUserSpeech(text.trim());
    });

    return;
  }

  if (!SpeechRecognitionWeb) {
    errorBox.innerText = "Speech Recognition support nahi hai is browser me.";
    return;
  }
  if (recognition && recognition._web) return;

  recognition = new SpeechRecognitionWeb();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'hi-IN';
  recognition._web = true;

  recognition.onstart = () => {
    isSpeaking = false;
    statusText.innerText = 'JARVIS SUN RAHA HAI...';
    orb.className = 'center-orb listening-mode';
  };

  recognition.onresult = (event) => {
    const userText = event.results[0][0].transcript.trim();
    if (!userText) return;
    handleUserSpeech(userText);
  };

  recognition.onerror = (e) => {
    if (e.error === 'not-allowed') {
      errorBox.innerText = "Microphone permission allow kijiye.";
    }
    if (activeLoop && !isSpeaking) setTimeout(startMicSafe, 800);
  };

  recognition.onend = () => {
    if (activeLoop && !isSpeaking && !orb.classList.contains('thinking-mode')) {
      setTimeout(startMicSafe, 400);
    }
  };
}

function handleUserSpeech(userText) {
  lastUserText = userText;
  transcriptDiv.innerText = `Aap: "${userText}"`;
  orb.className = 'center-orb thinking-mode';
  statusText.innerText = 'JARVIS SOCH RAHA HAI...';
  handleCommand(userText);
}

async function startMicSafe() {
  if (!activeLoop || isSpeaking) return;
  try {
    if (!recognition) initMic();
    if (window.Capacitor?.isNativePlatform?.()) {
      await SpeechRecognition.stop().catch(() => {});
      await recognition.start();
    } else if (recognition._web) {
      recognition.start();
    }
  } catch (e) {
    console.log('startMicSafe err', e);
    setTimeout(startMicSafe, 1000);
  }
}

async function stopMicSafe() {
  try {
    if (window.Capacitor?.isNativePlatform?.()) {
      await SpeechRecognition.stop().catch(() => {});
    } else if (recognition && recognition._web) {
      try { recognition.abort(); } catch (e) { }
    }
  } catch (e) { }
}

// ---------- CORE TAP ----------
document.getElementById('core').onclick = async () => {
  if (!activeLoop) {
    activeLoop = true;
    errorBox.innerText = '';
    if (!recognition) initMic();
    await initTts();
    await enableBackground();
    say("Namaste sir. Jarvis taiyaar hai. Kahiye, main kya karoon?", () => {
      startMicSafe();
    });
  } else {
    activeLoop = false;
    isSpeaking = false;
    stopMicSafe();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    try { await TextToSpeech.stop().catch(() => {}); } catch (e) { }
    orb.className = 'center-orb';
    statusText.innerText = 'STANDBY - TAP TO START';
    transcriptDiv.innerText = 'Jarvis chalu karne ke liye core par tap kijiye.';
  }
};

// ---------- COMMANDS ----------
function handleCommand(text) {
  const t = text.toLowerCase();

  if (/(band karo|chup ho jao|so jao|stop jarvis|alvida|bye)/.test(t)) {
    activeLoop = false;
    isSpeaking = false;
    stopMicSafe();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    try { TextToSpeech.stop().catch(() => {}); } catch (e) { }
    say("Theek hai sir. Standby par ja raha hoon.", () => {
      orb.className = 'center-orb';
      statusText.innerText = 'STANDBY - TAP TO START';
    });
    return;
  }

  if (/(time|samay|kitna baje|बजे)/.test(t)) {
    const time = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    say(`Sir, abhi ${time} ho rahe hain.`, () => startMicSafe());
    return;
  }

  if (/(date|tarikh|aaj ki taarikh|आज की तारीख)/.test(t)) {
    const date = new Date().toLocaleDateString('hi-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    say(`Sir, aaj ${date} hai.`, () => startMicSafe());
    return;
  }

  if (/(battery|बैटरी)/.test(t)) {
    if (navigator.getBattery) {
      navigator.getBattery().then(bat => {
        const level = Math.round(bat.level * 100);
        say(`Sir, phone ki battery ${level} percent hai.`, () => startMicSafe());
      }).catch(() => {
        say("Sir, battery ka status abhi nahi le pa raha hoon.", () => startMicSafe());
      });
      return;
    }
    say("Sir, is device par battery info available nahi hai.", () => startMicSafe());
    return;
  }

  if (/(youtube|यूट्यूब)/.test(t) && /(khol|open|chalao)/.test(t)) {
    say("YouTube khol raha hoon sir.", () => startMicSafe());
    if (window.Capacitor?.isNativePlatform?.()) {
      AppLauncher.openUrl({ url: 'https://www.youtube.com' }).catch(() => {
        window.location.href = 'intent://www.youtube.com#Intent;scheme=https;package=com.google.android.youtube;end';
      });
    } else {
      window.open('https://www.youtube.com', '_blank');
    }
    return;
  }

  if (/(whatsapp|व्हाट्सएप)/.test(t) && /(khol|open|chalao)/.test(t)) {
    say("WhatsApp khol raha hoon sir.", () => startMicSafe());
    if (window.Capacitor?.isNativePlatform?.()) {
      AppLauncher.openUrl({ url: 'whatsapp://' }).catch(() => {
        AppLauncher.openUrl({ url: 'https://wa.me' }).catch(() => {});
      });
    } else {
      window.open('https://web.whatsapp.com', '_blank');
    }
    return;
  }

  if (/(instagram|इंस्टाग्राम)/.test(t) && /(khol|open|chalao)/.test(t)) {
    say("Instagram khol raha hoon sir.", () => startMicSafe());
    if (window.Capacitor?.isNativePlatform?.()) {
      AppLauncher.openUrl({ url: 'instagram://' }).catch(() => {
        AppLauncher.openUrl({ url: 'https://www.instagram.com' }).catch(() => {});
      });
    } else {
      window.open('https://www.instagram.com', '_blank');
    }
    return;
  }

  if (/(google|गूगल)/.test(t) && /(khol|open|chalao)/.test(t)) {
    say("Google khol raha hoon sir.", () => startMicSafe());
    if (window.Capacitor?.isNativePlatform?.()) {
      AppLauncher.openUrl({ url: 'googlechrome://' }).catch(() => {
        AppLauncher.openUrl({ url: 'https://www.google.com' }).catch(() => {});
      });
    } else {
      window.open('https://www.google.com', '_blank');
    }
    return;
  }

  if (/(call|फोन|कॉल)/.test(t) && /(karo|lagao)/.test(t)) {
    callContact(t);
    return;
  }

  askGemini(text);
}

// ---------- CALL CONTACT ----------
async function callContact(text) {
  const query = text.replace(/call|karo|lagao|फोन|कॉल/gi, '').trim();
  if (!query) {
    say("Kisko call karun sir, naam bataiye.", () => startMicSafe());
    return;
  }

  if (!window.Capacitor?.isNativePlatform?.()) {
    say("Sir, ye feature sirf Android app me hi kaam karega.", () => startMicSafe());
    return;
  }

  try {
    const perm = await Contacts.requestPermissions();
    if (perm.contacts !== 'granted') {
      say("Sir, contacts permission allow kijiye pehle.", () => startMicSafe());
      return;
    }

    const result = await Contacts.getContacts({
      projection: { name: true, phones: true }
    });

    const contacts = result.contacts || [];
    const match = contacts.find(c => {
      const name = (c.name?.display || '').toLowerCase();
      return name.includes(query.toLowerCase());
    });

    if (!match || !match.phones || match.phones.length === 0) {
      say(`${query} ka number contacts me nahi mila sir.`, () => startMicSafe());
      return;
    }

    const number = match.phones[0].number.replace(/\s+/g, '');
    say(`${match.name.display} ko call laga raha hoon sir.`, () => startMicSafe());
    AppLauncher.openUrl({ url: `tel:${number}` }).catch(() => {});
  } catch (e) {
    console.log('call err', e);
    say("Sir, contacts se call lagaane me dikkat aa rahi hai.", () => startMicSafe());
  }
}

// ---------- GEMINI ----------
async function askGemini(promptText) {
  errorBox.innerText = '';
  history.push({ role: "user", parts: [{ text: promptText }] });
  if (history.length > 14) history = history.slice(-14);
  if (history.length > 0 && history[0].role !== "user") history.shift();

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
      errorBox.innerText = "Worker Error: " + (data.error || res.status);
      say("Sir, thodi si dikkat aa rahi hai. Ek baar fir kijiye.", () => startMicSafe());
      return;
    }

    history.push({ role: "model", parts: [{ text: data.reply }] });
    say(data.reply, () => startMicSafe());
  } catch (err) {
    history.pop();
    errorBox.innerText = "Connection error: " + err.message;
    say("Sir, internet connect nahi ho pa raha hai.", () => startMicSafe());
  }
}

// ---------- INIT ----------
window.addEventListener('load', async () => {
  if (window.Capacitor?.isNativePlatform?.()) {
    try {
      await SpeechRecognition.requestPermissions().catch(() => {});
    } catch (e) { }
    await initTts();
    await enableBackground();
  }
  initMic();
});
