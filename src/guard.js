// Guards for the endpoints that spend Meta credits or show customer details.
//
//  - clientIp(req): the caller's address behind Render's proxy (Cloudflare headers only with TRUST_CLOUDFLARE=1).
//  - rateLimiter({ max, windowMs }): a small in-memory sliding-window limit per IP.
//  - tokenOk(given, expected): constant-time token check (for /api/diag and the owner board).
//  - dailyCap / metaCalls: a global per-day cap on Meta calls.
//  - redactLead / redactBooking: what the public owner demo may show (an allowlist: no phone, address, note or transcript).

import crypto from 'node:crypto';

// The RIGHTMOST x-forwarded-for entry by default: Render's proxy appends the address it saw, so
// anything to its left was written by the caller and can be faked. Headers like cf-connecting-ip and
// true-client-ip can be written by anyone when the app is not behind Cloudflare, so they are trusted
// only when TRUST_CLOUDFLARE=1 says the app really sits behind Cloudflare.
export function clientIp(req, { trustCloudflare = process.env.TRUST_CLOUDFLARE === '1' } = {}) {
  const h = (k) => {
    const v = req.headers?.[k];
    return Array.isArray(v) ? v[v.length - 1] : v;
  };
  if (trustCloudflare) {
    const cf = h('cf-connecting-ip') || h('true-client-ip');
    if (cf) return String(cf).trim();
  }
  const xff = h('x-forwarded-for');
  if (xff) {
    const last = String(xff).split(',').map((x) => x.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// A global cap on Meta calls per day (UTC), whatever IP they come from, so rotating addresses
// can't drain the credits. Every Meta call in muse.js takes one; endpoints check there is room first.
export function dailyCap({ max = 1500, clock = () => Date.now() } = {}) {
  let day = null, used = 0;
  const roll = () => {
    const d = new Date(clock()).toISOString().slice(0, 10);
    if (d !== day) { day = d; used = 0; }
  };
  return {
    max,
    take(n = 1) {
      roll();
      if (used + n > max) return false;
      used += n;
      return true;
    },
    remaining() { roll(); return Math.max(0, max - used); },
    used() { roll(); return used; },
    reset() { used = 0; },
  };
}
export const metaCalls = dailyCap({ max: Number(process.env.META_DAILY_CAP) || 1500 });
export class MetaBudgetError extends Error {
  constructor() { super('Meta daily limit reached'); this.name = 'MetaBudgetError'; }
}
export const DAILY_CAP_MESSAGE = 'The demo has used today’s share of Meta model calls. Please try again tomorrow.';
// Middleware: refuse up front when today's Meta budget can't cover this request (need = calls it may make).
export function metaBudgetGate(need = 1, isLive = () => true) {
  return (req, res, next) => {
    if (!isLive() || metaCalls.remaining() >= need) return next();
    res.status(429).json({ ok: false, error: DAILY_CAP_MESSAGE, ask: DAILY_CAP_MESSAGE, retry: false, rateLimited: true, dailyCap: true });
  };
}

export function rateLimiter({ max = 20, windowMs = 10 * 60 * 1000, message } = {}) {
  const hits = new Map(); // ip -> [timestamps]
  const msg = message || `That's a lot of photos in a few minutes. Give it about ${Math.round(windowMs / 60000)} minutes and try again.`;
  function check(ip, now = Date.now()) {
    const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      hits.set(ip, list);
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) };
    }
    list.push(now);
    hits.set(ip, list);
    // Keep the map small: drop idle IPs now and then.
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= windowMs) hits.delete(k);
    return { ok: true, remaining: max - list.length };
  }
  const middleware = (req, res, next) => {
    const r = check(clientIp(req));
    if (r.ok) return next();
    res.set('Retry-After', String(r.retryAfterS));
    res.status(429).json({ ok: false, error: msg, ask: msg, retry: false, rateLimited: true });
  };
  middleware.check = check;
  middleware.reset = () => hits.clear();
  return middleware;
}

export function tokenOk(given, expected) {
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

const maskPhone = (p) => (p ? `•••-•••-${String(p).replace(/\D/g, '').slice(-2).padStart(2, '•')}` : null);
const firstName = (n) => (n ? String(n).trim().split(/[\s,]+/)[0] : null);

// Phone numbers and street addresses typed into a message, blanked out.
export function scrub(text) {
  if (!text) return text;
  return String(text)
    .replace(/\+?\(?\d[\d\s().-]{7,}\d/g, '•••')
    .replace(/\b\d{1,6}\s+(?:[A-Za-z][\w.']*\s+){1,4}(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way|pl|place|pike|cir|circle|hwy|highway|pkwy|parkway|ter|terrace|trl|trail)\b\.?/gi, '(address)');
}

// What the public board says instead of a lead's free text: "Voicemail lead · 0:42".
const CHANNEL_LABEL = { text: 'Text lead', photo: 'Photo lead', voicemail: 'Voicemail lead', call: 'Call lead', sight: 'Sight lead' };
export function publicLabel(l) {
  const base = CHANNEL_LABEL[l.channel] || 'Lead';
  const d = Number(l.durationS);
  return Number.isFinite(d) && d > 0 ? `${base} · ${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}` : base;
}

// The public owner board gets an allowlist of fields, never the whole record: a field added later
// (a note, an address, a photo) stays private until someone decides it is safe to show. Free text a
// customer or the agent wrote (message summaries, voicemail text, crew notes, names) is never shown
// publicly: scrubbing can't catch every name, gate code or address. Sight leads keep their summary,
// which is our own measured headline, not the customer's words.
export function redactLead(l) {
  const q = l.quote;
  return {
    id: l.id,
    channel: l.channel,
    status: l.status,
    createdAt: l.createdAt,
    bookingId: l.bookingId || null,
    business: l.business ? { id: l.business.id, name: l.business.name } : null,
    name: null,
    phone: maskPhone(l.phone),
    summary: l.channel === 'sight' && l.sight ? l.summary : publicLabel(l),
    notes: null,
    quote: q ? { serviceName: q.serviceName, detail: scrub(q.detail), total: q.total } : null,
    sight: l.sight ? { task: l.sight.task, job: scrub(l.sight.job), materials: (l.sight.materials || []).map(scrub), quote: scrub(l.sight.quote), measuredAgainst: l.sight.measuredAgainst || null, confidence: l.sight.confidence || null, checked: l.sight.checked || null, headline: l.sight.headline || null, spark: l.sight.spark ? { verdict: l.sight.spark.verdict, corrected: Boolean(l.sight.spark.corrected) } : null, hasPhoto: Boolean(l.sight.hasPhoto) } : null,
    transcript: l.transcript ? '(voicemail transcript: owner only)' : null,
  };
}

export function redactBooking(b) {
  return {
    id: b.id,
    slot: b.slot,
    when: b.when,
    hours: b.hours,
    service: b.service,
    serviceName: b.serviceName,
    detail: b.detail,
    quoteTotal: b.quoteTotal,
    channel: b.channel,
    createdAt: b.createdAt,
    customer: firstName(b.customer),
    phone: maskPhone(b.phone),
    address: b.address ? '(address: owner only)' : null,
  };
}

export function redactSnapshot(s) {
  return { leads: s.leads.map(redactLead), bookings: s.bookings.map(redactBooking) };
}
