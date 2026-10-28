// Photo-to-quote. A customer texts a picture of the job:
//   1. Muse Spark reads the photo: which service, what size, anything unusual.
//   2. SAM 3.1 counts the windows (one box per window) so the quote is a count, not a guess.
//   3. The engine prices it from the real price list.
//   4. Muse Image renders an "after" picture of the same house, cleaned, to send with the quote.

import { business } from './business.js';
import * as engine from './engine.js';
import { hasKey, sparkReadPhoto, samSegment, museImageEdit } from './muse.js';

const READ_PROMPT = `You look at photos texted to ${business.name}, an exterior cleaning company (window cleaning, driveway pressure washing, gutter cleaning).
Return JSON only. service: the best-matching service, or "none" if the photo shows none of them.
driveway_tier: small (1 car), medium (2 cars), large (3+ cars or long) when a driveway is shown, else "unknown".
stories: 1, 2 or 3 for the visible house, or 0 if no house.
windows_estimate: your rough count of exterior windows visible, 0 if none.
notes: one short sentence a crew lead would want to know (heavy stains, tall second story, steep roof, moss), plain words.
summary: one short sentence describing the job for the owner.`;

const READ_SCHEMA = {
  type: 'object',
  properties: {
    service: { type: 'string', enum: ['windows', 'driveway', 'gutters', 'none'] },
    driveway_tier: { type: 'string', enum: ['small', 'medium', 'large', 'unknown'] },
    stories: { type: 'integer' },
    windows_estimate: { type: 'integer' },
    notes: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['service', 'driveway_tier', 'stories', 'windows_estimate', 'notes', 'summary'],
  additionalProperties: false,
};

const TIER_BY_STORIES = { 1: 'one', 2: 'two', 3: 'three' };

// Count with SAM: keep confident boxes, drop tiny ones (reflections, vents).
export function countFromSam(seg, { minConfidence = 0.5, minArea = 0.0015 } = {}) {
  const kept = seg.objects.filter((o) => (o.c == null || o.c >= minConfidence) && o.areaShare >= minArea);
  return { count: kept.length, boxes: kept.map((o) => o.box), frame: seg.frame };
}

export async function quoteFromPhoto({ dataUrl, hint = '', wantAfter = true, demoRead = null }) {
  const steps = [];
  let read;
  if (!hasKey()) {
    read = demoRead || {
      service: 'windows', driveway_tier: 'unknown', stories: 2, windows_estimate: 18,
      notes: 'Two-story front; second-floor windows need the water-fed pole.', summary: 'Two-story home, front windows.',
    };
    steps.push({ model: 'demo', step: 'read photo', result: read });
  } else {
    read = await sparkReadPhoto({ dataUrl, prompt: READ_PROMPT + (hint ? `\nCustomer said: "${hint}"` : ''), schema: READ_SCHEMA });
    steps.push({ model: 'muse-spark-1.3', step: 'read photo', result: read });
  }

  let service = read.service;
  if (/window/i.test(hint)) service = 'windows';
  else if (/driveway|pressure/i.test(hint)) service = 'driveway';
  else if (/gutter/i.test(hint)) service = 'gutters';
  if (service === 'none') return { ok: false, read, steps, reason: 'no matching service in photo' };

  let q, args, count = null, boxes = [], frame = null;
  if (service === 'windows') {
    if (hasKey()) {
      const seg = await samSegment({ dataUrl, concept: 'window' });
      ({ count, boxes, frame } = countFromSam(seg));
      steps.push({ model: 'sam-3.1', step: 'count windows', result: { count, raw: seg.objects.length } });
    }
    if (!count) count = read.windows_estimate || null;
    if (!count) return { ok: false, read, steps, reason: 'could not count windows' };
    // A front photo shows one side. Quote the visible windows and say so.
    args = { service, count };
    q = engine.quote(args);
  } else if (service === 'driveway') {
    if (read.driveway_tier === 'unknown') return { ok: false, read, steps, reason: 'driveway size unclear' };
    args = { service, tier: read.driveway_tier };
    q = engine.quote(args);
  } else {
    const tier = TIER_BY_STORIES[read.stories];
    if (!tier) return { ok: false, read, steps, reason: 'stories unclear' };
    args = { service, tier };
    q = engine.quote(args);
  }
  steps.push({ model: 'engine', step: 'price from list', result: q });

  let after = null;
  if (wantAfter && hasKey()) {
    try {
      after = await museImageEdit({
        dataUrl,
        prompt: afterPrompt(service),
      });
      steps.push({ model: 'muse-image-1.0', step: 'after preview', result: after ? 'image' : 'none' });
    } catch (e) {
      steps.push({ model: 'muse-image-1.0', step: 'after preview', error: String(e.message).slice(0, 200) });
    }
  }

  return { ok: q.ok, service, args, read, count, boxes, frame, quote: q, after, steps };
}

function afterPrompt(service) {
  const what = {
    windows: 'every window glass is spotless and streak-free, frames wiped clean',
    driveway: 'the driveway concrete is freshly pressure washed, evenly clean and bright, stains gone',
    gutters: 'the gutters are clean and clear, no leaves or debris, downspouts clear',
  }[service];
  return `Edit this exact photo of the customer's property so that ${what}. Keep the same house, angle, lighting, landscaping and everything else unchanged. Photorealistic. No text, no logos, no people.`;
}

// Text the customer would see after a photo, built only from engine numbers.
export function photoReply(r) {
  if (!r.ok) {
    if (r.reason === 'driveway size unclear') return 'Thanks for the photo! Is that a 1-car, 2-car or 3-car driveway?';
    if (r.reason === 'stories unclear') return 'Thanks for the photo! Is the house one, two or three stories?';
    if (r.reason === 'could not count windows') return 'Thanks! I could not count the windows from that one. How many windows would you like cleaned?';
    return `Thanks for the photo! We do window cleaning, driveway pressure washing and gutter cleaning. Which one are you after?`;
  }
  const q = r.quote;
  const counted = r.service === 'windows' ? `I count ${r.count} windows on the front. ` : '';
  return `${counted}${q.serviceName}: ${q.detail}, $${q.total} total, about ${q.hours} hour${q.hours > 1 ? 's' : ''}. No deposit needed.${r.after ? ' Here is how it will look when we are done.' : ''} Want to see open times?`;
}
