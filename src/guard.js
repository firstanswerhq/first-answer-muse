// Guards for the endpoints that spend Meta credits or show customer details.
//
//  - clientIp(req): the caller's address behind Cloudflare / Render's proxy.
//  - rateLimiter({ max, windowMs }): a small in-memory sliding-window limit per IP.
//  - tokenOk(given, expected): constant-time token check (for /api/diag and the owner board).
//  - redactLead / redactBooking: what the public owner demo may show (no phone, address or transcript).

import crypto from 'node:crypto';

export function clientIp(req) {
  const h = (k) => {
    const v = req.headers?.[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const cf = h('cf-connecting-ip');
  if (cf) return String(cf).trim();
  const tc = h('true-client-ip');
  if (tc) return String(tc).trim();
  const xff = h('x-forwarded-for');
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
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

export function redactLead(l) {
  return {
    ...l,
    summary: scrub(l.summary),
    notes: scrub(l.notes),
    phone: maskPhone(l.phone),
    name: firstName(l.name),
    transcript: l.transcript ? '(voicemail transcript: owner only)' : null,
    photo: null,
  };
}

export function redactBooking(b) {
  return { ...b, phone: maskPhone(b.phone), customer: firstName(b.customer), address: b.address ? '(address: owner only)' : null };
}

export function redactSnapshot(s) {
  return { leads: s.leads.map(redactLead), bookings: s.bookings.map(redactBooking) };
}
