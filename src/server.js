// First Answer on Meta Muse: the web server.
// Customer side: /  (a phone that can text, send a photo, leave a voicemail, or call live)
// Owner side:    /owner.html  (every lead from every channel, live)

import express from 'express';
import multer from 'multer';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { business } from './business.js';
import * as engine from './engine.js';
import { handleMessage, addNote, getThread } from './agent.js';
import { quoteFromPhoto, photoReply } from './photo.js';
import { hasKey, transcribeWav, openRealtimeTranscription, SPARK } from './muse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024 } });

// ---- owner live feed (server-sent events) ----
const listeners = new Set();
export function broadcast(kind, data) {
  const msg = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) res.write(msg);
}
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify(engine.snapshot())}\n\n`);
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, business: business.name, mode: hasKey() ? 'muse' : 'demo', model: hasKey() ? SPARK : 'scripted demo' });
});
app.get('/api/business', (req, res) => res.json({ name: business.name, owner: business.owner, phone: business.phone, city: business.city }));
app.get('/api/owner/feed', (req, res) => res.json(engine.snapshot()));

function ensureLead(threadId, channel, phone, summary) {
  const t = getThread(threadId);
  t.ctx.channel = t.ctx.channel || channel;
  if (!t.ctx.leadId) {
    const lead = engine.addLead({ channel, phone, summary });
    t.ctx.leadId = lead.id;
    broadcast('lead', lead);
  }
  return t;
}

function afterTurn(threadId, result) {
  const t = getThread(threadId);
  if (t.ctx.booking && !t.ctx.bookingAnnounced) {
    t.ctx.bookingAnnounced = true;
    broadcast('booking', t.ctx.booking);
  }
  broadcast('message', { threadId, leadId: t.ctx.leadId, reply: result.reply, tools: result.tools.map((x) => x.name) });
}

const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.', detail: String(e.message).slice(0, 300) });
  }
};

// Meta's request ID for a call (support asks for these; they are not secrets).
const reqId = (r) => r.headers.get('x-request-id') || r.headers.get('request-id') || r.headers.get('x-fb-trace-id') || r.headers.get('x-meta-request-id') || null;
const route = (r) => r.headers.get('x-route') || null;

// Which models this key can reach (names only; the key is never returned).
app.get('/api/diag', safe(async (req, res) => {
  if (!hasKey()) return res.json({ mode: 'demo' });
  const r = await fetch(`${process.env.MODEL_API_BASE_URL || 'https://api.meta.ai/v1'}/models`, { headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}` } });
  const text = await r.text();
  let ids = null;
  try { ids = (JSON.parse(text).data || []).map((m) => m.id); } catch {}
  const probes = [];
  if (req.query.probe) {
    const base = process.env.MODEL_API_BASE_URL || 'https://api.meta.ai/v1';
    const h = { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, 'Content-Type': 'application/json' };
    for (const model of ['muse-spark-1.3', 'muse-spark-1.2', 'muse-wonder-1.0']) {
      const c = await fetch(`${base}/chat/completions`, { method: 'POST', headers: h, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_completion_tokens: 50 }) });
      probes.push({ api: 'chat', model, status: c.status, at: new Date().toISOString(), requestId: reqId(c), route: route(c), body: (await c.text()).slice(0, 160) });
      const x = await fetch(`${base}/responses`, { method: 'POST', headers: h, body: JSON.stringify({ model, input: 'Say OK' }) });
      probes.push({ api: 'responses', model, status: x.status, at: new Date().toISOString(), requestId: reqId(x), route: route(x), body: (await x.text()).slice(0, 160) });
    }
  }
  // Response header names (not values) from /models, so we can see where Meta puts its request ID.
  const headerNames = [...r.headers.keys()];
  res.json({ status: r.status, at: new Date().toISOString(), requestId: reqId(r), route: route(r), headerNames, models: ids, raw: ids ? undefined : text.slice(0, 400), spark: SPARK, probes });
}));

// ---- text ----
app.post('/api/message', safe(async (req, res) => {
  const { threadId, text, phone } = req.body || {};
  if (!threadId || !text) return res.status(400).json({ error: 'threadId and text are required' });
  ensureLead(threadId, 'text', phone, text.slice(0, 140));
  const r = await handleMessage({ threadId, text, phone });
  afterTurn(threadId, r);
  res.json(r);
}));

// ---- photo ----
app.post('/api/photo', safe(async (req, res) => {
  const { threadId, dataUrl, text = '', phone } = req.body || {};
  if (!threadId || !/^data:image\/(png|jpe?g|webp);base64,/.test(dataUrl || '')) return res.status(400).json({ error: 'threadId and a PNG, JPEG or WebP photo are required' });
  const t = ensureLead(threadId, 'photo', phone, 'Sent a photo');
  const r = await quoteFromPhoto({ dataUrl, hint: text });
  if (r.ok) {
    t.ctx.quote = r.quote;
    t.ctx.service = r.service;
    if (r.service === 'windows') t.ctx.windowCount = r.count;
    engine.updateLead(t.ctx.leadId, { summary: r.read.summary, quote: r.quote, notes: r.read.notes });
  }
  const reply = photoReply(r);
  // Tell the agent what the photo showed, so the conversation continues from here.
  const facts = r.ok
    ? `[PHOTO] Customer sent a photo. Read: ${r.read.summary} Service: ${r.service}. ${r.service === 'windows' ? `SAM counted ${r.count} windows. ` : ''}${r.measure ? `Measured with SAM against the ${r.measure.reference}: about ${r.measure.sqft} sq ft (${r.measure.widthFt} x ${r.measure.lengthFt} ft). ` : ''}quote_job args: ${JSON.stringify(r.args)}. Quote: ${r.quote.detail}, $${r.quote.total}, ${r.quote.hours} h. Crew note: ${r.read.notes}`
    : `[PHOTO] Customer sent a photo; could not quote from it (${r.reason}). Read: ${r.read?.summary || 'n/a'}`;
  if (text) t.messages.push({ role: 'user', content: text });
  addNote(threadId, facts);
  t.messages.push({ role: 'assistant', content: reply });
  if (!hasKey() && r.ok) {
    // keep the scripted brain in step
    t.ctx.args = r.args;
  }
  broadcast('photo', { threadId, leadId: t.ctx.leadId, read: r.read, count: r.count, measure: r.measure, quote: r.quote, hasAfter: Boolean(r.after) });
  res.json({ reply, after: r.after, boxes: r.boxes, frame: r.frame, count: r.count, measure: r.measure, outline: r.outline, steps: r.steps.map((s) => ({ model: s.model, step: s.step, failed: Boolean(s.error) })) });
}));

// ---- voicemail ----
const DEMO_VOICEMAIL = "Hi, this is Marcus over on Belmont Boulevard. I've got a two-car driveway that's covered in oil stains and I want it pressure washed before my daughter's party on the fifteenth. Call or text me back. Thanks.";

app.post('/api/voicemail', upload.single('audio'), safe(async (req, res) => {
  const { threadId, phone } = req.body || {};
  if (!threadId) return res.status(400).json({ error: 'threadId is required' });
  let transcript;
  if (hasKey()) {
    if (!req.file) return res.status(400).json({ error: 'audio (WAV) is required' });
    transcript = await transcribeWav(req.file.buffer);
  } else {
    transcript = DEMO_VOICEMAIL;
  }
  const t = ensureLead(threadId, 'voicemail', phone, transcript.slice(0, 140));
  engine.updateLead(t.ctx.leadId, { transcript });
  broadcast('voicemail', { threadId, leadId: t.ctx.leadId, transcript });
  // The voicemail becomes the first customer message; the agent texts back from it.
  const r = await handleMessage({ threadId, text: `[VOICEMAIL from ${phone || 'unknown number'}] ${transcript}\n(Reply by text. Answer what they asked and move toward a booking.)` });
  afterTurn(threadId, r);
  res.json({ transcript, ...r });
}));

// ---- live call: browser mic -> Muse Voice Transcribe (realtime) -> Muse Spark -> reply ----
export function attachLive(server) {
  const wss = new WebSocketServer({ server, path: '/live' });
  wss.on('connection', async (sock, req) => {
    const url = new URL(req.url, 'http://x');
    const threadId = url.searchParams.get('threadId') || `call-${Date.now()}`;
    const phone = url.searchParams.get('phone') || null;
    const send = (o) => sock.readyState === 1 && sock.send(JSON.stringify(o));
    if (!hasKey()) {
      send({ type: 'error', message: 'Live calls need the Muse API key on the server. Text, photo and voicemail work in demo mode.' });
      return sock.close();
    }
    ensureLead(threadId, 'call', phone, 'Live call');
    let busy = Promise.resolve();
    let asr;
    try {
      asr = await openRealtimeTranscription({
        onEvent: (ev) => {
          if (ev.type === 'transcript') send({ type: 'partial', text: ev.transcript });
          if (ev.type === 'speechStart') send({ type: 'speechStart' });
          if (ev.type === 'speechComplete' && ev.transcript?.trim()) {
            const said = ev.transcript.trim();
            send({ type: 'final', text: said });
            busy = busy.then(async () => {
              const r = await handleMessage({ threadId, text: `[LIVE CALL, spoken] ${said}`, phone });
              afterTurn(threadId, r);
              send({ type: 'reply', text: r.reply, tools: r.tools.map((x) => x.name) });
            }).catch((e) => send({ type: 'error', message: String(e.message).slice(0, 200) }));
          }
          if (ev.type === 'error') send({ type: 'error', message: ev.message });
        },
        onClose: () => send({ type: 'closed' }),
      });
    } catch (e) {
      send({ type: 'error', message: `Could not reach Muse Voice Transcribe: ${String(e.message).slice(0, 200)}` });
      return sock.close();
    }
    send({ type: 'ready', threadId });
    const greet = `Thanks for calling ${business.name}, this is the front desk. How can I help?`;
    getThread(threadId).messages.push({ role: 'assistant', content: greet });
    send({ type: 'reply', text: greet, tools: [] });
    sock.on('message', (data, isBinary) => {
      if (isBinary) asr.sendAudio(data);
      else {
        try {
          if (JSON.parse(data.toString()).type === 'hangup') asr.end();
        } catch {}
      }
    });
    sock.on('close', () => {
      asr.end();
      setTimeout(() => asr.close(), 3000);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = http.createServer(app);
  attachLive(server);
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log(`First Answer on Muse: http://localhost:${port} (${hasKey() ? 'Muse mode' : 'demo mode, no key'})`));
}
