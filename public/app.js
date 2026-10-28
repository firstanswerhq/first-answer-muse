import { startMic, wavFromInt16 } from './audio.js';

const $ = (id) => document.getElementById(id);
const threadId = `web-${Math.random().toString(36).slice(2, 10)}`;
const phone = '(615) 555-0199';
const thread = $('thread');
const steps = $('steps');

const MODEL_LABEL = {
  'muse-spark-1.3': 'Muse Spark',
  'sam-3.1': 'SAM 3.1',
  'muse-image-1.0': 'Muse Image',
  'muse-voice-transcribe-1.0': 'Muse Voice Transcribe',
  engine: 'Price list',
  demo: 'Demo brain',
};

function bubble(who, html, extra = '') {
  const el = document.createElement('div');
  el.className = `msg ${who} ${extra}`;
  el.innerHTML = html;
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
  return el;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const typing = () => bubble('them', '<span class="dots"><i></i><i></i><i></i></span>', 'typing');

function step(model, text) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="tag t-${model.replace(/[^a-z]/gi, '')}">${esc(MODEL_LABEL[model] || model)}</span> ${esc(text)}`;
  steps.prepend(li);
  return li;
}

const TOOL_TEXT = {
  list_services: 'looked up the services and policies',
  quote_job: 'priced the job from the price list',
  open_times: 'pulled real open times from the calendar',
  book_job: 'booked the job on the calendar',
  hand_to_owner: 'flagged it for the owner',
};
function showTools(r) {
  const brain = r.mode === 'demo' ? 'demo' : 'muse-spark-1.3';
  for (const t of r.tools || []) step(brain, TOOL_TEXT[t.name || t] || t.name || t);
  step(brain, 'wrote the reply');
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---------- text ----------
async function sendText(text) {
  bubble('me', esc(text));
  const t = typing();
  try {
    const r = await post('/api/message', { threadId, text, phone });
    t.remove();
    bubble('them', esc(r.reply).replace(/\n/g, '<br>'));
    showTools(r);
  } catch (e) {
    t.remove();
    bubble('them', esc(e.message), 'err');
  }
}

$('compose').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('textIn').value.trim();
  if (!v) return;
  $('textIn').value = '';
  sendText(v);
});

// ---------- photo ----------
async function fileToDataUrl(file, max = 1280) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.86);
}

function drawBoxes(wrap, boxes, frame, outline, measure) {
  if ((!boxes?.length && !outline) || !frame) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${frame.w} ${frame.h}`);
  svg.classList.add('boxes');
  if (outline?.path) {
    // SAM's driveway outline, from mask pixels to photo pixels.
    const b = outline.box;
    const g = document.createElementNS(svg.namespaceURI, 'path');
    g.setAttribute('d', outline.path);
    g.setAttribute('transform', `translate(${b.x1} ${b.y1}) scale(${(b.x2 - b.x1 + 1) / outline.w} ${(b.y2 - b.y1 + 1) / outline.h})`);
    g.setAttribute('vector-effect', 'non-scaling-stroke');
    g.classList.add('area');
    svg.appendChild(g);
  }
  if (measure) {
    const tag = document.createElement('span');
    tag.className = 'measure';
    tag.textContent = `≈ ${measure.sqft.toLocaleString()} sq ft · ${measure.widthFt} × ${measure.lengthFt} ft`;
    wrap.appendChild(tag);
  }
  (boxes || []).forEach((b, i) => {
    const r = document.createElementNS(svg.namespaceURI, 'rect');
    Object.entries({ x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 }).forEach(([k, v]) => r.setAttribute(k, v));
    r.style.animationDelay = `${i * 60}ms`;
    svg.appendChild(r);
  });
  wrap.appendChild(svg);
}

async function sendPhoto(dataUrl) {
  const me = bubble('me', `<div class="pic"><img src="${dataUrl}" alt="Photo sent"></div>`, 'photo');
  const t = typing();
  const pending = step('muse-spark-1.3', 'reading the photo...');
  try {
    const r = await post('/api/photo', { threadId, dataUrl, phone });
    t.remove();
    pending.remove();
    drawBoxes(me.querySelector('.pic'), r.boxes, r.frame, r.outline, r.measure);
    for (const s of (r.steps || []).slice().reverse()) {
      const txt = { 'read photo': 'read the photo: what job, what size', 'count windows': `counted ${r.count} windows (one box each)`, 'price from list': 'priced it from the price list', 'after preview': 'painted the "after" picture from their photo', 'measure driveway': r.measure ? `outlined the driveway and the garage door; door = ${r.measure.reference.match(/\d+ ft/)[0]} ruler → ${r.measure.sqft} sq ft` : 'tried to measure the driveway' }[s.step] || s.step;
      step(s.model, s.failed ? `${s.step}: skipped this time` : txt);
    }
    bubble('them', esc(r.reply));
    if (r.after) bubble('them', `<div class="pic after"><img src="${r.after}" alt="How it will look after cleaning"><span class="label">After, by Muse Image</span></div>`, 'photo');
  } catch (e) {
    t.remove();
    pending.remove();
    bubble('them', esc(e.message), 'err');
  }
}

$('photoIn').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) sendPhoto(await fileToDataUrl(f));
});

// ---------- voicemail ----------
let rec = null, recTimer = null;
async function startVoicemail() {
  try {
    rec = await startMic({});
  } catch {
    // No microphone: send the demo voicemail so the flow can still be seen.
    return sendVoicemail(null, 0);
  }
  const t0 = Date.now();
  $('recording').classList.remove('hidden');
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
}
$('recStop').addEventListener('click', () => {
  clearInterval(recTimer);
  $('recording').classList.add('hidden');
  const { samples, seconds } = rec.stop();
  rec = null;
  sendVoicemail(wavFromInt16(samples), seconds);
});

async function sendVoicemail(wav, seconds) {
  bubble('me', `<div class="vm"><span class="vm-ico"></span> Voicemail${seconds ? ` · ${Math.round(seconds)}s` : ''}</div>`, 'voicemail');
  const t = typing();
  const fd = new FormData();
  fd.append('threadId', threadId);
  fd.append('phone', phone);
  if (wav) fd.append('audio', wav, 'voicemail.wav');
  try {
    const res = await fetch('/api/voicemail', { method: 'POST', body: fd });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error);
    t.remove();
    step(r.mode === 'demo' ? 'demo' : 'muse-voice-transcribe-1.0', `transcribed: "${r.transcript.slice(0, 90)}${r.transcript.length > 90 ? '...' : ''}"`);
    bubble('note', `<b>Transcript</b> ${esc(r.transcript)}`);
    bubble('them', esc(r.reply).replace(/\n/g, '<br>'));
    showTools(r);
  } catch (e) {
    t.remove();
    bubble('them', esc(e.message), 'err');
  }
}
$('vmBtn').addEventListener('click', startVoicemail);

// ---------- live call ----------
let call = null;
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
async function startCall() {
  if (call) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/live?threadId=${threadId}&phone=${encodeURIComponent(phone)}`);
  ws.binaryType = 'arraybuffer';
  call = { ws, mic: null };
  $('callbar').classList.remove('hidden');
  $('liveText').textContent = 'Connecting...';
  bubble('note', '<b>Call started</b> Live captions by Muse Voice Transcribe');
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'ready') {
      call.mic = await startMic({
        onFrame: (f) => ws.readyState === 1 && ws.send(f.buffer),
        onLevel: (l) => ($('meter').style.width = `${Math.min(100, l * 160)}%`),
      });
      $('liveText').textContent = 'Listening...';
    }
    if (m.type === 'partial') $('liveText').textContent = m.text;
    if (m.type === 'final') {
      bubble('me', esc(m.text), 'spoken');
      step('muse-voice-transcribe-1.0', `heard: "${m.text}"`);
      $('liveText').textContent = '...';
    }
    if (m.type === 'reply') {
      bubble('them', esc(m.text), 'spoken');
      if (m.tools?.length) showTools({ tools: m.tools, mode: 'muse' });
      speak(m.text);
    }
    if (m.type === 'error') {
      bubble('them', esc(m.message), 'err');
      endCall();
    }
  };
  ws.onclose = () => endCall();
}
function endCall() {
  if (!call) return;
  try {
    call.ws.readyState === 1 && call.ws.send(JSON.stringify({ type: 'hangup' }));
    call.mic?.stop();
    setTimeout(() => call?.ws?.close(), 1500);
  } catch {}
  call = null;
  $('callbar').classList.add('hidden');
  bubble('note', '<b>Call ended</b>');
}
$('callBtn').addEventListener('click', startCall);
$('hangBtn').addEventListener('click', endCall);

// ---------- try-it chips ----------
document.querySelectorAll('.chip').forEach((b) =>
  b.addEventListener('click', async () => {
    if (b.dataset.say) return sendText(b.dataset.say);
    if (b.dataset.vm) return startVoicemail();
    if (b.dataset.sample) {
      const res = await fetch('/samples/house.jpg');
      if (!res.ok) return bubble('them', 'No sample photo on this server yet. Use the camera button to send your own.', 'err');
      sendPhoto(await fileToDataUrl(await res.blob()));
    }
  }),
);

// ---------- start ----------
fetch('/api/health').then((r) => r.json()).then((h) => {
  $('mode').innerHTML = h.mode === 'muse'
    ? `<span class="ok"></span> Live on Meta Model API · ${esc(h.model)}`
    : '<span class="warn"></span> Demo mode: no API key, a scripted brain calls the same tools';
});
fetch('/api/business').then((r) => r.json()).then((b) => {
  $('bizName').textContent = b.name;
  $('bizInitial').textContent = b.name[0];
  $('textIn').placeholder = `Text ${b.name.split(' ')[0]}...`;
});
bubble('note', 'You are a customer texting a local business. Text, send a photo of your house, leave a voicemail, or tap Call.');
