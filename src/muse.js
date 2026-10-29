// Thin client for the Meta Model API (https://api.meta.ai/v1).
// Muse Spark for the conversation and the photo read, SAM 3.1 for counting what's in the photo,
// Muse Voice Transcribe for voicemail. The key is read from MODEL_API_KEY and never logged.

import OpenAI from 'openai';
import { metaCalls, MetaBudgetError } from './guard.js';

export const DIRECT_URL = process.env.MODEL_API_BASE_URL || 'https://api.meta.ai/v1';
// Optional relay (relay/meta-relay.ts on Supabase) for hosts Meta's API turns away. When
// META_RELAY_URL is set, every REST call goes through it; realtime voice stays direct.
// Default: First Answer's relay. Set META_RELAY_URL=direct to call Meta directly again once Meta fixes hosted access.
const DEFAULT_RELAY = 'https://kqgbohllsbwpvigkhpmr.supabase.co/functions/v1/meta-relay';
const relaySetting = process.env.META_RELAY_URL ?? DEFAULT_RELAY;
export const RELAY_URL = relaySetting === 'direct' || relaySetting === '' ? '' : relaySetting;
export const BASE_URL = RELAY_URL || DIRECT_URL;
export const relayHeaders = () => (RELAY_URL && process.env.META_RELAY_KEY ? { 'x-relay-key': process.env.META_RELAY_KEY } : {}); // optional extra gate
export const SPARK = process.env.MUSE_SPARK_MODEL || 'muse-spark-1.3';
export const SAM = 'sam-3.1';
export const TRANSCRIBE = 'muse-voice-transcribe-1.0';

export const hasKey = () => Boolean(process.env.MODEL_API_KEY);

// Every Meta call counts against the global daily cap (guard.js); past it, calls fail fast.
function spend() {
  if (!metaCalls.take(1)) throw new MetaBudgetError();
}

let client;
function api() {
  if (!client) client = new OpenAI({ baseURL: BASE_URL, apiKey: process.env.MODEL_API_KEY, defaultHeaders: relayHeaders(), timeout: 60_000, maxRetries: 2 });
  return client;
}

// One Chat Completions call with tools. Returns the assistant message.
export async function sparkChat({ messages, tools, effort = 'low' }) {
  spend();
  const r = await api().chat.completions.create({
    model: SPARK,
    messages,
    tools,
    tool_choice: tools?.length ? 'auto' : undefined,
    reasoning_effort: effort,
  });
  return { message: r.choices[0].message, usage: r.usage };
}

// Muse Spark reads a photo and returns structured JSON about the job in it.
export async function sparkReadPhoto({ dataUrl, prompt, schema }) {
  spend();
  const r = await api().chat.completions.create({
    model: SPARK,
    reasoning_effort: 'low',
    messages: [
      { role: 'developer', content: prompt },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: 'Read this photo.' }] },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'photo_read', strict: true, schema } },
  });
  return JSON.parse(r.choices[0].message.content);
}

// Muse Spark words a short reply from facts we hand it (no photo, no tools). Short timeout, no retries:
// the caller falls back to its own template if this is slow or fails.
export async function sparkWrite({ system, facts, timeoutMs = 6000 }) {
  spend();
  const r = await api().chat.completions.create({
    model: SPARK,
    reasoning_effort: 'low',
    max_completion_tokens: 600,
    messages: [
      { role: 'developer', content: system },
      { role: 'user', content: typeof facts === 'string' ? facts : JSON.stringify(facts) },
    ],
  }, { timeout: timeoutMs, maxRetries: 0 });
  return String(r.choices[0].message.content || '').trim();
}

// SAM 3.1: segment every instance of a short noun phrase. Non-streaming; same text format as the stream.
export async function samSegment({ dataUrl, concept }) {
  spend();
  const res = await fetch(`${BASE_URL}/responses`, {
    method: 'POST',
    headers: { ...relayHeaders(), Authorization: `Bearer ${process.env.MODEL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SAM,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: concept }, { type: 'input_image', image_url: dataUrl }] }],
      metadata: { include_confidence: 'true' },
    }),
  });
  if (!res.ok) throw new Error(`SAM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const text = body.output_text ?? (body.output || []).flatMap((o) => o.content || []).map((c) => c.text || '').join('');
  return parseSam(text);
}

// Parse SAM's special-token text into objects: box, confidence, and the mask (still encoded).
// Line: <0f>id<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..;c=..|><|mask;x=0;y=0;c=..;data=H,W,~payload|>,id<|box...|>...
// The mask raster covers the object's box (H rows by W columns); measure.js decodes it.
export function parseSam(text) {
  const objects = [];
  if (!text) return { objects, frame: null };
  const line = text.split('\n').find((l) => l.startsWith('<0f>')) || text.split('\n')[0];
  const re = /(\d+)<\|box;([^|]*)\|>(?:<\|mask;(.*?)\|>)?/g;
  let m, frame = null;
  while ((m = re.exec(line))) {
    const kv = Object.fromEntries(m[2].split(';').map((p) => p.split('=')));
    const box = { x1: +kv.x1, y1: +kv.y1, x2: +kv.x2, y2: +kv.y2 };
    frame = { w: +kv.w, h: +kv.h };
    let mask = null;
    const dm = m[3] && m[3].match(/data=(\d+),(\d+),([~!])(.*)$/);
    if (dm) mask = { height: +dm[1], width: +dm[2], encoding: dm[3] === '~' ? 'lossless' : 'one_bit', payload: dm[3] + dm[4] };
    objects.push({ id: +m[1], box, c: kv.c !== undefined ? +kv.c : null, areaShare: ((box.x2 - box.x1) * (box.y2 - box.y1)) / (+kv.w * +kv.h), mask, frame: { w: +kv.w, h: +kv.h } });
  }
  return { objects, frame };
}

// Muse Voice Transcribe: one WAV (mono 16-bit PCM, 16 or 24 kHz, up to 10 minutes) in, text out.
export async function transcribeWav(wavBuffer) {
  spend();
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify({ model: TRANSCRIBE, audioEncoding: 'WAV', mode: 'ENDPOINTING' })], { type: 'application/json' }));
  form.append('audio', new Blob([wavBuffer], { type: 'audio/wav' }), 'voicemail.wav');
  const res = await fetch(`${BASE_URL}/asr/transcribe`, {
    method: 'POST',
    headers: { ...relayHeaders(), Authorization: `Bearer ${process.env.MODEL_API_KEY}`, Accept: 'text/plain' },
    body: form,
  });
  if (!res.ok) throw new Error(`Transcribe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.text()).trim();
}

// Muse Image: edit the customer's own photo into an "after" preview. Returns a data URL or null.
export async function museImageEdit({ dataUrl, prompt }) {
  spend();
  const res = await fetch(`${BASE_URL}/images/edits`, {
    method: 'POST',
    headers: { ...relayHeaders(), Authorization: `Bearer ${process.env.MODEL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'muse-image-1.0', prompt, images: [{ image_url: dataUrl }], n: 1, output_format: 'jpeg' }),
  });
  if (!res.ok) throw new Error(`Muse Image ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const item = body.data?.[0];
  if (!item) return null;
  if (item.b64_json) return `data:image/${body.output_format || 'jpeg'};base64,${item.b64_json}`;
  return item.url || null;
}

// Live calls: open a realtime transcription session for one caller. The key stays on the server;
// the browser streams 24 kHz 16-bit mono PCM to us and we relay it.
export async function openRealtimeTranscription({ onEvent, onClose, mode = 'ENDPOINTING' }) {
  spend();
  const { default: WebSocket } = await import('ws');
  const url = `${DIRECT_URL.replace(/^http/, 'ws')}/asr/realtime?sessionId=fa-${Date.now()}`;
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({
    authorization: { accessToken: `Bearer ${process.env.MODEL_API_KEY}` },
    audioEncoding: 'PCM_24KHZ',
    model: TRANSCRIBE,
    mode,
  }));
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let ev;
    try {
      ev = JSON.parse(data.toString());
    } catch {
      return;
    }
    onEvent(ev);
  });
  ws.on('close', (code, reason) => onClose?.(code, reason?.toString()));
  ws.on('error', () => {});
  return {
    sendAudio: (buf) => ws.readyState === 1 && ws.send(buf),
    end: () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'endStream' })),
    close: () => ws.close(),
  };
}
