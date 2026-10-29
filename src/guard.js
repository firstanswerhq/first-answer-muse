// Guards for the endpoints that spend Meta credits or show customer details.
//
//  - clientIp(req): the caller's address behind Cloudflare / Render's proxy.
//  - rateLimiter({ max, windowMs }): a small in-memory sliding-window limit per IP.
//  - tokenOk(given, expected): constant-time token check (for /api/diag and the owner board).
//  - dailyCap / metaCalls: a global per-day cap on Meta calls.
//  - redactLead / redactBooking: what the public owner demo may show (an allowlist: no phone, address, note or transcript).

import crypto from 'node:crypto';

// Cloudflare's header first (Cloudflare overwrites it), then true-client-ip, then the RIGHTMOST
// x-forwarded-for entry: Render's proxy appends the address it saw, so anything to its left was
// written by the caller and can be faked.
export function clientIp(req) {
  const h = (k) => {
    const v = req.headers?.[k];
    return Array.isArray(v) ? v[v.length - 1] : v;
  };
  const cf = h('cf-connecting-ip');
  if (cf) return String(cf).trim();
  const tc = h('true-client-ip');
  if (tc) return String(tc).trim();
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

// The public owner board gets an allowlist of fields, never the whole record: a field added later
// (a note, an address, a photo) stays private until someone decides it is safe to show.
export function redactLead(l) {
  const q = l.quote;
  return {
    id: l.id,
    channel: l.channel,
    status: l.status,
    createdAt: l.createdAt,
    bookingId: l.bookingId || null,
    name: firstName(l.name),
    phone: maskPhone(l.phone),
    summary: scrub(l.summary),
    notes: scrub(l.notes),
    quote: q ? { serviceName: q.serviceName, detail: scrub(q.detail), total: q.total } : null,
    sight: l.sight ? { task: l.sight.task, job: scrub(l.sight.job), materials: (l.sight.materials || []).map(scrub), quote: scrub(l.sight.quote), measuredAgainst: l.sight.measuredAgainst || null, confidence: l.sight.confidence || null } : null,
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
