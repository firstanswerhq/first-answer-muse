// First Answer on Meta Muse: the web server.
// Customer side: /  (a phone that can text, send a photo, leave a voicemail, or call live)
// Owner side:    /owner.html  (every lead from every channel, live)

import express from 'express';
import multer from 'multer';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { business, sightBusiness, businessById, ALL_BUSINESSES } from './business.js';
import * as engine from './engine.js';
import { handleMessage, addNote, getThread } from './agent.js';
import { quoteFromPhoto, photoReply } from './photo.js';
import { measureAnything, stepDetail, friendlyError, faceEnabled } from './anything.js';
import { readExif } from './distance.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { rateLimiter, tokenOk, redactSnapshot, metaBudgetGate, DAILY_CAP_MESSAGE } from './guard.js';
import { hasKey, transcribeWav, openRealtimeTranscription, SPARK, BASE_URL, DIRECT_URL, RELAY_URL, relayHeaders } from './muse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024 } });

// ---- owner live feed (server-sent events) ----
// The owner board is public in the demo, so by default it shows redacted leads (no phone numbers,
// addresses or voicemail text). With OWNER_TOKEN set, the board sends the key in the x-owner-key
// header (opened as /owner.html#key=<token>; the fragment never reaches the server or its logs).
// Keys in the query string are ignored: URLs end up in logs and browser history.
// The event stream only says *that* something happened; the board then re-reads /api/owner/feed.
const ownerKey = (req) => req.get('x-owner-key');
const isOwner = (req) => tokenOk(ownerKey(req), process.env.OWNER_TOKEN);
const ownerView = (req) => (isOwner(req) ? engine.snapshot() : redactSnapshot(engine.snapshot()));
const listeners = new Set();
export function broadcast(kind, data = {}) {
  const msg = `event: ${kind}\ndata: ${JSON.stringify({ kind, leadId: data.leadId || null, at: new Date().toISOString() })}\n\n`;
  for (const res of listeners) res.write(msg);
}
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ kind: 'hello', at: new Date().toISOString() })}\n\n`);
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, business: business.name, mode: hasKey() ? 'muse' : 'demo', model: hasKey() ? SPARK : 'scripted demo' });
});
// ?b=<id> names one of the demo businesses (Sight sends each job to the business that does it).
app.get('/api/business', (req, res) => {
  const b = (typeof req.query.b === 'string' && businessById(req.query.b)) || business;
  res.json({ id: b.id, name: b.name, owner: b.owner, phone: b.phone || null, city: b.city, all: ALL_BUSINESSES.map((x) => ({ id: x.id, name: x.name, trade: x.trade || null })) });
});
app.get('/api/owner/feed', (req, res) => res.json({ ...ownerView(req), redacted: !isOwner(req) }));

// Endpoints that spend Meta credits get a per-IP limit (in memory; one Render instance).
export const measureLimit = rateLimiter({ max: Number(process.env.MEASURE_LIMIT) || 20, windowMs: 10 * 60 * 1000 });
export const deskLimit = rateLimiter({ max: Number(process.env.DESK_LIMIT) || 60, windowMs: 10 * 60 * 1000, message: 'That’s a lot of messages in a few minutes. Give it a few minutes and try again.' });
// /api/photo spends SAM and Muse Image per call: at least as strict as /api/measure.
export const photoLimit = rateLimiter({ max: Math.min(Number(process.env.PHOTO_LIMIT) || 20, 20), windowMs: 10 * 60 * 1000 });
// The global daily cap on Meta calls (META_DAILY_CAP): refuse up front when a request can't fit.
const live = () => hasKey();

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
    res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.', detail: friendlyError(e) });
  }
};

// Meta's request ID for a call (support asks for these; they are not secrets).
const reqId = (r) => r.headers.get('x-request-id') || r.headers.get('request-id') || r.headers.get('x-fb-trace-id') || r.headers.get('x-meta-request-id') || null;
const route = (r) => r.headers.get('x-route') || null;

// Which models this key can reach (names only; the key is never returned).
// Without the DIAG_TOKEN (header x-diag-token or ?token=) this is basic health only: the probes spend credits.
app.get('/api/diag', safe(async (req, res) => {
  if (!tokenOk(req.get('x-diag-token') || req.query.token, process.env.DIAG_TOKEN)) {
    return res.json({ ok: true, mode: hasKey() ? 'muse' : 'demo', detail: 'basic health only; send the diag token for model probes' });
  }
  if (!hasKey()) return res.json({ mode: 'demo' });
  // ?direct=1 skips the relay so the two paths can be compared.
  const direct = Boolean(req.query.direct) || !RELAY_URL;
  const base = direct ? DIRECT_URL : BASE_URL;
  const extra = direct ? {} : relayHeaders();
  const r = await fetch(`${base}/models`, { headers: { ...extra, Authorization: `Bearer ${process.env.MODEL_API_KEY}` } });
  const text = await r.text();
  let ids = null;
  try { ids = (JSON.parse(text).data || []).map((m) => m.id); } catch {}
  const probes = [];
  if (req.query.probe) {
    const h = { ...extra, Authorization: `Bearer ${process.env.MODEL_API_KEY}`, 'Content-Type': 'application/json' };
    for (const model of ['muse-spark-1.3', 'muse-spark-1.2', 'muse-wonder-1.0']) {
      const c = await fetch(`${base}/chat/completions`, { method: 'POST', headers: h, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_completion_tokens: 50 }) });
      probes.push({ api: 'chat', model, status: c.status, at: new Date().toISOString(), requestId: reqId(c), route: route(c), body: (await c.text()).slice(0, 160) });
      const x = await fetch(`${base}/responses`, { method: 'POST', headers: h, body: JSON.stringify({ model, input: 'Say OK' }) });
      probes.push({ api: 'responses', model, status: x.status, at: new Date().toISOString(), requestId: reqId(x), route: route(x), body: (await x.text()).slice(0, 160) });
    }
  }
  const headerNames = [...r.headers.keys()];
  res.json({ via: direct ? 'direct' : 'relay', status: r.status, at: new Date().toISOString(), requestId: reqId(r), route: route(r), relayed: r.headers.get('x-relayed-by'), headerNames, models: ids, raw: ids ? undefined : text.slice(0, 400), spark: SPARK, probes });
}));

// ---- text ----
app.post('/api/message', deskLimit, metaBudgetGate(6, live), safe(async (req, res) => {
  const { threadId, text, phone } = req.body || {};
  if (!threadId || !text) return res.status(400).json({ error: 'threadId and text are required' });
  ensureLead(threadId, 'text', phone, text.slice(0, 140));
  const r = await handleMessage({ threadId, text, phone });
  afterTurn(threadId, r);
  res.json(r);
}));

// ---- photo ----
app.post('/api/photo', photoLimit, metaBudgetGate(5, live), safe(async (req, res) => {
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

// ---- measure anything: one photo + one line of text ----
// What the page sees of each step: which model, what it did, how long, and its real numbers
// (SAM's outline counts and confidence, Spark's read, our math's result) as one readable line.
const publicStep = (s) => ({ model: s.model, step: s.step, failed: Boolean(s.error), ms: s.ms ?? null, detail: stepDetail(s), objects: s.result?.objects || undefined });
// While measuring, the progress lines say only which step finished: a number our math found may still
// be withheld if Spark's check disagrees, so step details arrive with the final result only.
const progressStep = (s) => ({ model: s.model, step: s.step, failed: Boolean(s.error), ms: s.ms ?? null });

// Errors in words a person can act on.
export function measureErrorMessage(e) {
  const m = String(e?.message || e || '');
  if (e?.name === 'MetaBudgetError' || /daily limit/i.test(m)) return DAILY_CAP_MESSAGE;
  if (/SAM \d|sam-3/i.test(m)) return 'Couldn’t reach Meta SAM 3.1 just now; tap Retry.';
  if (/timed? ?out|timeout|aborted|ETIMEDOUT/i.test(m)) return 'The Meta models took too long to answer; tap Retry.';
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|socket/i.test(m)) return 'Couldn’t reach the Meta models; tap Retry.';
  if (/\b(401|403)\b|api key|unauthori[sz]ed/i.test(m)) return 'The Meta models turned this server away just now. We’re on it; try again in a few minutes.';
  if (/\b429\b|rate limit/i.test(m)) return 'The Meta models are busy right now; wait a moment and tap Retry.';
  if (/\b5\d\d\b/.test(m)) return 'The Meta models had a hiccup; tap Retry.';
  return 'Something went wrong measuring that photo; tap Retry.';
}

// ---- the hand-off: a measured job goes to the business's owner board as a lead ----
// Each answer with a business block is remembered for a while under a random id. The customer's
// "Send this to <business>" button posts only that id (and an optional phone number), so what lands
// on the owner board is exactly what Sight measured, never text typed into the request.
const HANDOFF_TTL_MS = 2 * 60 * 60 * 1000;
const HANDOFF_MAX = 5000; // with 20 photos per 10 minutes per IP, plenty; only expired answers are dropped first
const handoffs = new Map(); // id -> { at, leadId, ... } in the order they were made
export function rememberHandoff(r, now = Date.now()) {
  if (!r?.ok || !r.business?.job) return null;
  for (const [k, v] of handoffs) { if (now - v.at > HANDOFF_TTL_MS) handoffs.delete(k); else break; }
  while (handoffs.size >= HANDOFF_MAX) handoffs.delete(handoffs.keys().next().value);
  const id = crypto.randomBytes(12).toString('base64url');
  // Each job goes to the demo business that does it, priced from that business's own demo price list.
  const biz = sightBusiness(r.task);
  const priced = engine.sightQuote({ task: r.task, r });
  const block = { ...r.business, quote: priced ? priced.line : r.business.quote, priced: Boolean(priced), demoPrices: true };
  // checked: 'agreed' when Muse Spark confirmed SAM's outlines; 'skipped' when its check didn't come back.
  handoffs.set(id, { at: now, leadId: null, phoneSet: false, biz: { id: biz.id, name: biz.name, owner: biz.owner, trade: biz.trade || null }, task: r.task, headline: r.headline, measuredAgainst: r.measuredAgainst || null, confidence: r.confidence || null, checked: r.checked || 'skipped', block, priced });
  return { id, to: biz.name, owner: biz.owner, business: biz.id, block };
}

// A US phone number: 10 digits, or 11 starting with 1. Anything else (arrays, objects, 7 or 15 digits) is refused.
export function phoneDigits(phone) {
  if (phone == null || phone === '') return { ok: true, digits: '' };
  if (typeof phone !== 'string' || phone.length > 30) return { ok: false };
  const d = phone.replace(/\D/g, '');
  if (d.length === 10) return { ok: true, digits: d };
  if (d.length === 11 && d[0] === '1') return { ok: true, digits: d.slice(1) };
  return { ok: false };
}

app.post('/api/measure/send', deskLimit, safe(async (req, res) => {
  const { id, phone } = req.body || {};
  const h = typeof id === 'string' ? handoffs.get(id) : null;
  if (!h || Date.now() - h.at > HANDOFF_TTL_MS) return res.status(404).json({ ok: false, ask: 'That answer has expired. Send the photo again and tap Send.' });
  const p = phoneDigits(phone);
  if (!p.ok) return res.status(400).json({ ok: false, ask: 'That phone number doesn’t look right. Leave it blank or type all 10 digits.' });
  const digits = p.digits;
  // The phone number is set once; after that it is locked (so a sent lead can't be pointed at someone else).
  if (h.leadId && digits && h.phoneSet) return res.status(409).json({ ok: false, ask: 'This job is already on the board with a phone number. Call the business to change it.' });
  if (!h.leadId) {
    const lead = engine.addLead({ channel: 'sight', phone: digits || null, summary: `Sight photo: ${h.headline}`, quote: h.priced ? { serviceName: h.priced.serviceName, detail: h.priced.detail, total: h.priced.total } : null });
    engine.updateLead(lead.id, { business: h.biz, sight: { task: h.task, job: h.block.job, materials: h.block.materials || [], quote: h.block.quote, measuredAgainst: h.measuredAgainst, confidence: h.confidence, priced: h.block.priced, checked: h.checked } });
    h.leadId = lead.id;
    h.phoneSet = Boolean(digits);
    broadcast('lead', lead);
  } else if (digits) {
    engine.updateLead(h.leadId, { phone: digits });
    h.phoneSet = true;
    broadcast('lead', { leadId: h.leadId });
  }
  const masked = digits ? `•••-•••-${digits.slice(-4)}` : null;
  res.json({
    ok: true,
    leadId: h.leadId,
    to: h.biz.name,
    owner: h.biz.owner,
    business: h.biz.id,
    board: `/owner.html?b=${encodeURIComponent(h.biz.id)}`,
    message: `Sent to ${h.biz.name}. It’s on ${h.biz.owner}’s board now${masked ? `, and they’ll text you at ${masked}` : '; add your number if you want them to text you back'}.`,
  });
}));

// Up to 12 Meta calls: read, 3 SAM outlines, check and wording, then one correction round (SAM again,
// possibly twice, check and wording again). Every HTTP attempt is counted as it happens.
app.post('/api/measure', measureLimit, metaBudgetGate(12, live), async (req, res) => {
  const { dataUrl, text = '', exifB64 = '' } = req.body || {};
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(dataUrl || '')) return res.status(400).json({ ok: false, ask: 'Send a PNG, JPEG or WebP photo.' });
  let focal35 = null;
  try { if (exifB64) focal35 = readExif(Buffer.from(exifB64, 'base64')).focal35 || null; } catch {}
  // Streaming (Accept: application/x-ndjson): one line per finished step, then the result, so the page's
  // waiting steps follow real progress. Otherwise a single JSON reply.
  const stream = /application\/x-ndjson/.test(req.get('accept') || '');
  const line = (o) => res.write(`${JSON.stringify(o)}\n`);
  if (stream) {
    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    line({ type: 'start' });
  }
  try {
    const r = await measureAnything({ dataUrl, text: String(text).slice(0, 500), focal35, onStep: stream ? (s) => line({ type: 'step', ...progressStep(s) }) : null });
    broadcast('measure', { task: r.task, ok: r.ok, headline: r.headline });
    const handoff = rememberHandoff(r);
    const out = { ...r, business: handoff ? handoff.block : r.business, handoff: handoff ? { id: handoff.id, to: handoff.to, owner: handoff.owner, business: handoff.business } : null, pipeline: r.pipeline.map(publicStep), lens: focal35 ? 'from photo' : 'typical phone' };
    if (stream) { line({ type: 'result', ...out }); res.end(); } else res.json(out);
  } catch (e) {
    console.error(e);
    const ask = measureErrorMessage(e);
    const retry = ask !== DAILY_CAP_MESSAGE;
    if (stream) { line({ type: 'error', ok: false, retry, ask }); res.end(); } else res.status(502).json({ ok: false, retry, ask, error: ask });
  }
});

// Sample photos for the demo chips: public/samples/<id>.jpg (or .png/.webp) with <id>.txt beside it
// (first line: chip label, the rest: the message sent with the photo). Only the list comes from here;
// the photos are plain static files under /samples/, fetched when a chip is tapped.
export const SAMPLES_DIR = path.join(__dirname, '..', 'public', 'samples');
export function listSamples(dir = SAMPLES_DIR) {
  try {
    return fs.readdirSync(dir).filter((f) => /^[\w-]+\.(jpe?g|png|webp)$/i.test(f) && (faceEnabled() || !/^face\./i.test(f))).sort().map((f) => {
      const id = f.replace(/\.\w+$/, '');
      const txtFile = path.join(dir, `${id}.txt`);
      const [label, ...rest] = (fs.existsSync(txtFile) ? fs.readFileSync(txtFile, 'utf8') : id).split(/\r?\n/);
      return { id, label: label.trim(), text: rest.join('\n').trim(), url: `/samples/${encodeURIComponent(f)}` };
    });
  } catch {
    return [];
  }
}
app.get('/api/measure/samples', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(listSamples());
});

// ---- voicemail ----
// Length of a PCM WAV in seconds, from its header (for the public board's "Voicemail lead · 0:42").
export function wavSeconds(buf) {
  try {
    if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    const channels = buf.readUInt16LE(22), rate = buf.readUInt32LE(24), bits = buf.readUInt16LE(34);
    const bytesPerSec = rate * channels * (bits / 8);
    return bytesPerSec > 0 ? Math.round((buf.length - 44) / bytesPerSec) : null;
  } catch { return null; }
}
const DEMO_VOICEMAIL = "Hi, this is Marcus over on Belmont Boulevard. I've got a two-car driveway that's covered in oil stains and I want it pressure washed before my daughter's party on the fifteenth. Call or text me back. Thanks.";

app.post('/api/voicemail', deskLimit, metaBudgetGate(7, live), upload.single('audio'), safe(async (req, res) => {
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
  engine.updateLead(t.ctx.leadId, { transcript, durationS: wavSeconds(req.file?.buffer) });
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
            }).catch((e) => send({ type: 'error', message: `Something went wrong: ${friendlyError(e)}.` }));
          }
          if (ev.type === 'error') send({ type: 'error', message: ev.message });
        },
        onClose: () => send({ type: 'closed' }),
      });
    } catch (e) {
      send({ type: 'error', message: `Could not reach Muse Voice Transcribe: ${friendlyError(e)}.` });
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
