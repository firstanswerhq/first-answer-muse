// The booking engine. Every path (text, photo, voicemail) goes through these functions,
// so a quote and a calendar slot can only ever come from here, never from the model's imagination.

import { business } from './business.js';

const state = {
  bookings: [], // { id, slot, hours, service, quoteTotal, customer, phone, address, channel, createdAt }
  leads: [], // { id, channel, phone, name, summary, quote, status, createdAt, transcript? }
  seq: 1,
};

export function reset() {
  state.bookings = [];
  state.leads = [];
  state.seq = 1;
}

export function snapshot() {
  return { bookings: [...state.bookings], leads: [...state.leads] };
}

const nextId = (p) => `${p}-${String(state.seq++).padStart(4, '0')}`;

// ---------- quotes ----------

export function quote({ service, count, tier }) {
  const s = business.services[service];
  if (!s) return { ok: false, error: `Unknown service "${service}". Services: ${Object.keys(business.services).join(', ')}.` };
  if (s.tiers) {
    const t = s.tiers[tier];
    if (!t) return { ok: false, error: `For ${s.name} pick a size: ${Object.keys(s.tiers).join(', ')}.` };
    return { ok: true, service, serviceName: s.name, detail: t.label, total: t.price, hours: t.hours, note: s.note };
  }
  const n = Math.round(Number(count));
  if (!Number.isFinite(n) || n < 1 || n > 200) return { ok: false, error: `Need a ${s.unit} count between 1 and 200.` };
  const raw = n * s.price;
  const total = Math.max(raw, s.minimum);
  return {
    ok: true,
    service,
    serviceName: s.name,
    detail: `${n} ${s.unit}${n === 1 ? '' : 's'} at $${s.price} each${total > raw ? ` (job minimum $${s.minimum})` : ''}`,
    count: n,
    total,
    hours: s.hours(n),
    note: s.note,
  };
}

// ---------- time (all in the business's own time zone) ----------

const fmtParts = (d) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: business.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, wd: p.weekday };
};
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function slotLabel(slot) {
  // slot = 'YYYY-MM-DDTHH' in local business time
  const [date, hh] = slot.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const h = Number(hh);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${day} ${mon} ${d}, ${hr} ${h < 12 ? 'AM' : 'PM'}`;
}

function overlaps(slot, hours) {
  const [date, hh] = slot.split('T');
  const start = Number(hh);
  return state.bookings.some((b) => {
    const [bd, bh] = b.slot.split('T');
    if (bd !== date) return false;
    const bs = Number(bh);
    return start < bs + b.hours && bs < start + hours;
  });
}

export function openTimes({ hours = 1, limit = 4, now = new Date() } = {}) {
  const out = [];
  const today = fmtParts(now);
  for (let i = 1; i <= 21 && out.length < limit; i++) {
    // start from tomorrow so a crew can be scheduled
    const dt = new Date(Date.UTC(today.y, today.m - 1, today.d + i, 12));
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate(), wd = dt.getUTCDay();
    if (!business.hours.days.includes(wd)) continue;
    for (let h = business.hours.open; h + hours <= business.hours.close && out.length < limit; h += 1) {
      const slot = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}`;
      if (overlaps(slot, hours)) continue;
      out.push({ slot, label: slotLabel(slot) });
      h += Math.max(0, 3 - 1); // spread the offers out: one morning, one afternoon
    }
  }
  return out;
}

// ---------- bookings and leads ----------

export function book({ slot, service, count, tier, customer, phone, address, channel = 'text', now = new Date() }) {
  const q = quote({ service, count, tier });
  if (!q.ok) return q;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(String(slot))) return { ok: false, error: 'Pick one of the open times offered.' };
  const valid = openTimes({ hours: q.hours, limit: 200, now }).some((o) => o.slot === slot);
  if (!valid) return { ok: false, error: 'That time is no longer open. Offer the customer fresh times.' };
  if (!customer || String(customer).trim().length < 2) return { ok: false, error: "Ask for the customer's name before booking." };
  if (!address || String(address).trim().length < 5) return { ok: false, error: 'Ask for the service address before booking.' };
  const b = {
    id: nextId('BK'),
    slot,
    when: slotLabel(slot),
    hours: q.hours,
    service,
    serviceName: q.serviceName,
    detail: q.detail,
    quoteTotal: q.total,
    customer: String(customer).trim(),
    phone: phone || null,
    address: String(address).trim(),
    channel,
    createdAt: now.toISOString(),
  };
  state.bookings.push(b);
  return { ok: true, booking: b };
}

export function addLead({ channel, phone, name, summary, quote: q, transcript, photo, now = new Date() }) {
  const lead = {
    id: nextId('LD'),
    channel,
    phone: phone || null,
    name: name || null,
    summary: summary || '',
    quote: q || null,
    transcript: transcript || null,
    photo: photo || null,
    status: 'new',
    createdAt: now.toISOString(),
  };
  state.leads.push(lead);
  return lead;
}

export function updateLead(id, patch) {
  const l = state.leads.find((x) => x.id === id);
  if (l) Object.assign(l, patch);
  return l;
}
