// Scripted brain for running without an API key. It calls the same tools as Muse Spark,
// so the quotes, times and bookings are just as real; only the wording is canned.

import { business } from './business.js';

const num = (s) => {
  const m = s.match(/\b(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
};

function detectService(s) {
  if (/window/i.test(s)) return 'windows';
  if (/driveway|pressure|power ?wash/i.test(s)) return 'driveway';
  if (/gutter/i.test(s)) return 'gutters';
  return null;
}

function detectTier(service, s) {
  if (service === 'driveway') {
    if (/\b(1|one|single)[- ]?car|small/i.test(s)) return 'small';
    if (/\b(2|two|double)[- ]?car|medium/i.test(s)) return 'medium';
    if (/\b(3|three)[- ]?car|large|long/i.test(s)) return 'large';
  }
  if (service === 'gutters') {
    if (/\b(1|one|single)[- ]?(story|storey)|ranch/i.test(s)) return 'one';
    if (/\b(2|two)[- ]?(story|storey)/i.test(s)) return 'two';
    if (/\b(3|three)[- ]?(story|storey)/i.test(s)) return 'three';
  }
  return null;
}

export function demoTurn(t, text, tool) {
  const c = t.ctx;
  const s = text || '';
  c.service = c.service || detectService(s);

  if (c.booking) return `You're all set for ${c.booking.when}. Reply here anytime if anything changes.`;

  if (!c.service) {
    return `Hi! This is ${business.name}. We do window cleaning, driveway pressure washing and gutter cleaning. Which one can we help with?`;
  }

  if (!c.quote) {
    const args = { service: c.service };
    if (c.service === 'windows') {
      const n = c.windowCount || num(s);
      if (!n) return 'Happy to quote that. Text us a photo of the front of the house and we\'ll count the windows, or just tell me how many.';
      args.count = n;
    } else {
      const tier = c.tier || detectTier(c.service, s);
      if (!tier) {
        return c.service === 'driveway'
          ? 'Sure thing. Is it a 1-car, 2-car or 3-car driveway?'
          : 'Sure thing. Is the house one, two or three stories?';
      }
      args.tier = tier;
    }
    const q = tool('quote_job', args);
    if (!q.ok) return q.error;
    c.args = args;
    const o = tool('open_times', args);
    const list = o.times.map((x, i) => `${i + 1}) ${x.label}`).join('\n');
    return `${q.serviceName}: ${q.detail}, $${q.total} total, about ${q.hours} hour${q.hours > 1 ? 's' : ''}. No deposit needed.\nOpen times:\n${list}\nReply 1, 2 or 3 to grab one.`;
  }

  if (!c.pick) {
    if (!c.offered?.length && c.args) {
      const o = tool('open_times', c.args);
      return `Open times:\n${o.times.map((x, i) => `${i + 1}) ${x.label}`).join('\n')}\nReply 1, 2 or 3 to grab one.`;
    }
    const n = num(s);
    const offered = c.offered || [];
    if (n && offered[n - 1]) c.pick = offered[n - 1];
    else return `Reply 1, 2 or 3 to pick a time.`;
    return `Great, ${c.pick.label} it is. What name and service address should I put it under?`;
  }

  // name and address in one message: "Sarah Kim, 412 Oak St"
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return 'Please send your name and the service address, like: Sarah Kim, 412 Oak St.';
  const r = tool('book_job', { slot: c.pick.slot, ...c.args, customer: parts[0], address: parts.slice(1).join(', ') });
  if (!r.ok) return r.error;
  return `Booked! ${r.booking.serviceName} on ${r.booking.when} at ${r.booking.address}, $${r.booking.quoteTotal}. No deposit needed; pay when it's done. ${business.owner} will text the day before.`;
}
