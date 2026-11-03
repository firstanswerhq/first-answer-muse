// First Answer Sight ("See it. Size it. Solve it."): one photo and one line of text in, an exact answer out.
//
//   1. Muse Spark reads the photo and the message: what is being asked (shoe size? will it fit?
//      repair or replace?), what to measure, and which everyday ruler is in the shot.
//   2. SAM 3.1 outlines the thing and the ruler (in parallel).
//   3. Our math turns pixels into inches: flat.js for things lying flat next to the ruler,
//      distance.js for ground distances and heights.
//   4. The answer comes back as a number, what to buy and what to do, plus the outlines to draw.

import { hasKey, sparkReadPhoto, samSegment, samSegmentAt, sparkWrite, sparkCheck } from './muse.js';
import { checkImagesAsync, COLOR_NAMES } from './overlay.js';
import { DAILY_CAP_MESSAGE } from './guard.js';
import { measureFlat, FLAT_REFERENCES, maskBoundary } from './flat.js';
import { floorOnPaper, combineFloors, MAX_PHOTOS } from './floor.js';
import { best, measureSurface, garageDoorKind, REFERENCES as SURFACE_REFERENCES } from './measure.js';
import { calibrate, gapBetween, heightOf, distanceTo, contactPoints, fitCheck, ftIn, UPRIGHT } from './distance.js';
import { plan as tilePlan } from './tiles.js';
import { measureFace, faceLabel, NOTE as FACE_NOTE } from './face.js';
import { decodeMaskToSVGPath } from '@meta-sam/parser';
import { es, detectLanguage, localizeResult } from './es.js';

export const faceEnabled = () => process.env.SIGHT_FACE === '1';
export const FACE_OFF = 'Sorry, measuring faces isn’t available here. Sight measures jobs for local businesses: a tile floor, a windshield chip, a shoe size, a shed fit or a driveway. Send one of those with a quarter, a sheet of paper or a door in the shot.';
export const TASKS = ['face', 'surface_area', 'floor_tile', 'windshield_chip', 'shoe_size', 'gap_fit', 'height', 'distance', 'size'];
const RULERS = ['quarter', 'penny', 'nickel', 'dime', 'ca_quarter', 'ca_dime', 'ca_nickel', 'loonie', 'toonie', 'euro_1', 'euro_2', 'uk_pound', 'uk_2p', 'card', 'paper_letter', 'dollar', 'soda_can', 'license_plate', 'interior_door', 'front_door', 'double_garage_door', 'single_garage_door', 'none'];
const UPRIGHT_CONCEPT = { interior_door: 'door', front_door: 'front door', double_garage_door: 'garage door', single_garage_door: 'garage door' };

const READ_PROMPT = `You read photos people text to First Answer to get something measured. Return JSON only.
task: what they want —
  face (a face with a card held to the forehead: proportions, symmetry),
  surface_area (a driveway, patio, concrete slab or walkway outdoors: square feet, how much sealer or coverage; a garage door or front door is the ruler),
  floor_tile (an indoor floor to tile: how much tile, what cuts),
  windshield_chip (a chip or crack in glass: repair or replace),
  shoe_size (a foot on paper: shoe size),
  gap_fit (will something fit between two things on the ground: a shed between a fence and a house, a car in a gap),
  height (how tall something standing on the ground is),
  distance (how far away something is),
  size (anything else: how big is this).
target: a short noun phrase naming the thing to measure, the way you'd label it in the photo ("chip", "crack", "foot", "floor", "fence", "tree", "stain").
second_target: for gap_fit, the other side of the gap ("house wall", "garage"); else "".
ruler: the everyday object of known size in the photo, from the list; prefer one lying flat right beside the target; doors count for gap_fit, height and distance. "none" if nothing. For a coin, look hard at which one: a penny is copper-colored; a dime is the smallest silver coin and thin; a nickel is thick with a smooth edge; a quarter is the biggest common coin with a ridged edge. Compare it with nearby things of known size. If unsure between dime and quarter, pick quarter (it is the coin people use to measure). Canadian coins: a loonie is gold-colored with 11 sides (often a loon); a toonie is two-tone (silver ring, gold center); a Canadian quarter shows a caribou; Canadian coins show the King or Queen. Euro and UK coins: name the 1 or 2 euro coin, the £1 (12-sided, two-tone) or the 2p (copper). If the message names the coin or the country, go with it.
item_width_in: for gap_fit, the width in inches of the thing they want to fit, from their message (a 12 ft shed = 144); else 0.
tile_w_in, tile_l_in: tile size in inches if they said it, else 0.
shoe_for: "men", "women" or "unknown", from the message.
language: the language their message is written in: "en" for English (or no message), "es" for Spanish, "other" for anything else.
summary: one short plain sentence of what you see.`;

const READ_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', enum: TASKS },
    target: { type: 'string' },
    second_target: { type: 'string' },
    ruler: { type: 'string', enum: RULERS },
    item_width_in: { type: 'number' },
    tile_w_in: { type: 'number' },
    tile_l_in: { type: 'number' },
    shoe_for: { type: 'string', enum: ['men', 'women', 'unknown'] },
    language: { type: 'string', enum: ['en', 'es', 'other'] },
    summary: { type: 'string' },
  },
  required: ['task', 'target', 'second_target', 'ruler', 'item_width_in', 'tile_w_in', 'tile_l_in', 'shoe_for', 'language', 'summary'],
  additionalProperties: false,
};

// The coin the person names, if any ("it's a loonie", "Canadian quarter", "a 2 euro coin").
export function coinFromText(t) {
  const ca = /canad|loonie|toonie/.test(t);
  if (/toonie|\$2 coin|two dollar coin/.test(t)) return 'toonie';
  if (/loonie|\$1 coin|one dollar coin/.test(t)) return 'loonie';
  if (/(2|two)[ -]?euro/.test(t)) return 'euro_2';
  if (/(1|one)[ -]?euro/.test(t)) return 'euro_1';
  if (/£1|pound coin/.test(t)) return 'uk_pound';
  if (/\b2p\b|two pence/.test(t)) return 'uk_2p';
  const m = t.replace(/\bnickle\b/g, "nickel").replace(/\bpennies\b/g, "penny").match(/\b(quarter|dime|nickel|penny)\b/);
  if (!m) return null;
  return ca && m[1] !== 'penny' ? `ca_${m[1]}` : m[1];
}

// Outdoor ground surfaces measured in square feet with a door as the ruler.
const SURFACE_STRONG = /driveway|patio|concrete|slab|walkway|sidewalk|blacktop|asphalt|sealer|seal ?coat|pool deck|parking pad/;
// Looser words (stoop, front steps, porch, landing) mean a slab to size only with a size or area cue ("what is a stoop" is not a measuring job),
// and none of them ever override a message that is plainly about fit, a gap, a windshield, a shoe, a height or a distance.
const SURFACE_WEAK = /\bstoop\b|\bfront steps\b/;
const SURFACE_PORCH = /\b(?:porch|landing)\b/;
const SURFACE_CUE = /what size|\bseal|how (?:big|large|long|wide)|sq\.? ?ft|square|sealer|concrete|how much/;
const NOT_SURFACE = /\bfit\b|between|windshield|chip|\bshoes?\b|how tall|how far|\bheight\b|distance|\bpage\b|ceiling|\bstairs\b|\bpaint\b/;
export const looksLikeSurface = (t, target = t) => {
  const tl = String(t).toLowerCase(), tg = String(target).toLowerCase();
  if (SURFACE_STRONG.test(tg)) return true;
  if (NOT_SURFACE.test(tl)) return false;
  return (SURFACE_WEAK.test(tg) || SURFACE_PORCH.test(tg)) && SURFACE_CUE.test(tl);
};
// SAM returns nothing for "stoop" (real test, Nov 3) but outlines "concrete slab in front of the door" fine, so
// these words are asked of SAM as "concrete slab" (surface jobs only); the person's own word stays in the answer.
const STOOP_WORDS = /\b(?:stoop|porch|steps?|landing)\b/;
export const samWordFor = (target) => (STOOP_WORDS.test(String(target || '').toLowerCase()) ? 'concrete slab' : target || 'driveway');

// What people type, read without the model (used when there's no key, and to back up the model).
export function guessFromText(text = '') {
  const t = text.toLowerCase();
  const num = (re) => { const m = t.match(re); return m ? parseFloat(m[1]) : 0; };
  const ftOrIn = () => {
    const ft = t.match(/(\d+(?:\.\d+)?)\s*(?:ft|foot|feet|')/);
    const inch = t.match(/(\d+(?:\.\d+)?)\s*(?:in\b|inch|inches|")/);
    return (ft ? parseFloat(ft[1]) * 12 : 0) + (inch && !ft ? parseFloat(inch[1]) : 0);
  };
  const tile = t.match(/(\d+)\s*(?:x|by)\s*(\d+)\s*(?:in|inch|")?\s*tile/) || t.match(/tile[^\d]*(\d+)\s*(?:x|by)\s*(\d+)/);
  let task = 'size';
  const notFace = /face ?mask|face ?shield|face ?plate|face ?frame|eye ?bolt|thermometer|eye[- ]level|eye height|from (?:the |my )?(?:monitor|screen|face)/.test(t);
  if (!notFace && (/\b(?:my|your|her|his|their|kid'?s|son'?s|daughter'?s)\s+(?:face|eyes?|forehead|pupils?|pd|nose|mouth)\b|between (?:my |the |your |her |his )?eyes|eye (?:spacing|distance)|\bpupils?\b|pupillary|\bipd\b|p\.d\.|\bpd measurement|face symmetr|^\s*(?:measure|what(?:'s| is))\s+my\s+pd\b/.test(t)
    || /symmetr/.test(t) && /\b(?:my|your) (?:face|eyes)\b/.test(t))) task = 'face';
  else if (looksLikeSurface(t) && !/\btiles?\b|tiling/.test(t)) task = 'surface_area';
  else if (/shoe|\bfoot\b(?! ?print)|feet size|what size am i/.test(t) && !/square (?:foot|feet)|sq\.? ?f(?:ee)?t/.test(t)) task = 'shoe_size';
  else if (/windshield|chip|crack in (?:the )?glass|repair or replace/.test(t)) task = 'windshield_chip';
  else if (/tile|floor/.test(t)) task = 'floor_tile';
  else if (/\bfit\b|between/.test(t)) task = 'gap_fit';
  else if (/how tall|height/.test(t)) task = 'height';
  else if (/how far|distance/.test(t)) task = 'distance';
  return {
    task,
    item_width_in: task === 'gap_fit' ? ftOrIn() : 0,
    tile_w_in: tile ? +tile[1] : 0,
    tile_l_in: tile ? +tile[2] : 0,
    shoe_for: /women|woman|her\b|ladies/.test(t) ? 'women' : /\bmen\b|man\b|his\b/.test(t) ? 'men' : 'unknown',
    coin: coinFromText(t),
    language: /[¿¡ñ]|\b(?:cu[aá]nto|cu[aá]ntos|necesito|tama[nñ]o|zapato|parabrisas|cabe|baldosas?|azulejos?|entrada|mi pie|qu[eé] talla)\b/.test(t) ? 'es' : 'en',
    _num: num,
  };
}

const DEFAULT_TARGET = { surface_area: 'driveway', floor_tile: 'floor', windshield_chip: 'chip', shoe_size: 'foot', gap_fit: 'fence', face: 'face', height: 'tree', distance: 'tree', size: 'object' };
const DEFAULT_RULER = { surface_area: 'double_garage_door', floor_tile: 'paper_letter', windshield_chip: 'quarter', shoe_size: 'paper_letter', gap_fit: 'interior_door', face: 'card', height: 'interior_door', distance: 'interior_door', size: 'card' };

// ---------- the answers ----------

// US men's size by heel-to-toe foot length in inches (the common sizing chart); women's runs 1.5 higher.
const MEN_CHART = [[6, 9.25], [6.5, 9.5], [7, 9.625], [7.5, 9.75], [8, 9.9375], [8.5, 10.125], [9, 10.25], [9.5, 10.4375], [10, 10.5625], [10.5, 10.75], [11, 10.9375], [11.5, 11.125], [12, 11.25], [13, 11.5625], [14, 11.875], [15, 12.1875]];

// US shoe size from foot length, from the chart, to the nearest half size.
export function shoeSize(lengthMm, who = 'unknown') {
  const L = lengthMm / 25.4;
  const half = (x) => Math.round(x * 2) / 2;
  let men;
  if (L <= MEN_CHART[0][1]) men = MEN_CHART[0][0] - (MEN_CHART[0][1] - L) / 0.25 * 0.5;
  else if (L >= MEN_CHART.at(-1)[1]) men = MEN_CHART.at(-1)[0] + (L - MEN_CHART.at(-1)[1]) / 0.3125;
  else {
    const i = MEN_CHART.findIndex(([, l]) => l >= L);
    const [s0, l0] = MEN_CHART[i - 1], [s1, l1] = MEN_CHART[i];
    men = s0 + ((L - l0) / (l1 - l0)) * (s1 - s0);
  }
  men = half(Math.max(1, men));
  const women = men + 1.5;
  const eu = Math.round((lengthMm + 15) / 6.67);
  return { men, women, eu, pick: who === 'women' ? `${women} women’s` : who === 'men' ? `${men} men’s` : `${men} men’s / ${women} women’s` };
}

// Auto glass rule of thumb: a chip smaller than a quarter or a crack shorter than a dollar bill (6 in)
// can usually be repaired; bigger means replace.
export function chipVerdict(m) {
  const isCrack = m.widthMm > 0 && m.lengthMm / Math.max(m.widthMm, 0.1) > 6;
  const limitMm = isCrack ? 152.4 : 25.4;
  const repair = m.lengthMm <= limitMm;
  return {
    kind: isCrack ? 'crack' : 'chip',
    repair,
    text: repair
      ? `That ${isCrack ? 'crack' : 'chip'} is ${inchStr(m.lengthMm)} — ${isCrack ? 'under 6 in' : 'smaller than a quarter'}, so it can usually be repaired instead of replacing the glass.`
      : `That ${isCrack ? 'crack' : 'chip'} is ${inchStr(m.lengthMm)} — ${isCrack ? 'longer than 6 in' : 'bigger than a quarter'}, so most shops will say replace the windshield.`,
  };
}

const inchStr = (mm) => {
  const inch = mm / 25.4;
  // Under an inch, sixteenths are too coarse (0.54 in would read 0.56): hundredths.
  if (inch < 1) return `${String(Math.round(inch * 100) / 100)} in`;
  if (inch < 2) { const e = Math.round(inch * 16); return `${e % 16 === 0 ? e / 16 : (e / 16).toFixed(2).replace(/0$/, '')} in`; }
  return `${(Math.round(inch * 4) / 4).toString()} in`;
};

// What the answer was measured against, in words: "quarter (24.26 mm)", "sheet of printer paper (11 × 8.5 in)".
export function rulerSpec(refKind) {
  const F = FLAT_REFERENCES[refKind];
  if (F) {
    if (F.shape === 'circle') return `${F.label} (${F.diameter} mm)`;
    if (F.long < 100) return `${F.label} (${F.long} × ${F.short} mm)`;
    const i = (mm) => String(Math.round((mm / 25.4) * 100) / 100);
    return `${F.label} (${i(F.long)} × ${i(F.short)} in)`;
  }
  const S = SURFACE_REFERENCES[refKind];
  if (S) return Number.isInteger(S.heightFt) ? `${S.label} (${S.widthFt} × ${S.heightFt} ft)` : `${S.label} (${Math.round(S.widthFt * 12)} × ${Math.round(S.heightFt * 12)} in)`;
  const U = UPRIGHT[refKind];
  if (U) return `${U.label} (${Math.round(U.heightFt * 12)} in tall)`;
  return refKind;
}

// A measured length with its ± range, in inches: "0.5 – 0.63 in".
// Sixteenths can round an end onto the measured value ("0.5 in – 0.56 in" for 0.56 in): then use hundredths.
export const rangeIn = (mm, pm) => {
  const lo = Math.max(0, mm - pm), hi = mm + pm, mid = inchStr(mm);
  if (inchStr(lo) !== mid && inchStr(hi) !== mid) return `${inchStr(lo)} – ${inchStr(hi)}`;
  const h = (x) => `${(x / 25.4).toFixed(2)} in`;
  return `${h(lo)} – ${h(hi)}`;
};

// ---------- pictures for the page ----------

function outlineOf(obj, label, role) {
  if (!obj) return null;
  const conf = obj.c != null ? Math.round(obj.c * 100) / 100 : null;
  if (!obj.mask) return { label, role, conf, box: obj.box };
  try { return { label, role, conf, path: decodeMaskToSVGPath(obj.mask), box: obj.box, w: obj.mask.width, h: obj.mask.height }; } catch { return { label, role, conf, box: obj.box }; }
}

// The longest straight line across an outline, in photo pixels (for drawing the measurement).
function longestLine(obj) {
  try {
    const pts = maskBoundary(obj);
    const step = Math.max(1, Math.floor(pts.length / 300));
    const s = pts.filter((_, i) => i % step === 0);
    let bestD = -1, a = null, b = null;
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
      const d = (s[i][0] - s[j][0]) ** 2 + (s[i][1] - s[j][1]) ** 2;
      if (d > bestD) { bestD = d; a = s[i]; b = s[j]; }
    }
    return a ? { from: a, to: b } : null;
  } catch { return null; }
}

// A line along the long side of a boxy outline (through its middle), in photo pixels.
function rectSideLine(obj) {
  try {
    const pts = maskBoundary(obj);
    if (pts.length < 8) return null;
    const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of P) { while (lo.length >= 2 && cr(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
    for (const p of P.slice().reverse()) { while (up.length >= 2 && cr(up.at(-2), up.at(-1), p) <= 0) up.pop(); up.push(p); }
    const hull = lo.slice(0, -1).concat(up.slice(0, -1));
    let bestR = null;
    for (let i = 0; i < hull.length; i++) {
      const [x1, y1] = hull[i], [x2, y2] = hull[(i + 1) % hull.length];
      const L = Math.hypot(x2 - x1, y2 - y1);
      if (L < 1e-9) continue;
      const u = [(x2 - x1) / L, (y2 - y1) / L], v = [-u[1], u[0]];
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of hull) { const a = x * u[0] + y * u[1], b = x * v[0] + y * v[1]; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
      const area = (a1 - a0) * (b1 - b0);
      if (!bestR || area < bestR.area) bestR = { area, u, v, a0, a1, b0, b1 };
    }
    const { u, v, a0, a1, b0, b1 } = bestR;
    const long = a1 - a0 >= b1 - b0;
    const pt = (a, b) => [a * u[0] + b * v[0], a * u[1] + b * v[1]];
    // Run the line along the near (bottom) long edge, nudged inside, so it reads like a tape on that side.
    return long ? { from: pt(a0, b1 - (b1 - b0) * 0.08), to: pt(a1, b1 - (b1 - b0) * 0.08) } : { from: pt(a1 - (a1 - a0) * 0.08, b0), to: pt(a1 - (a1 - a0) * 0.08, b1) };
  } catch { return null; }
}

// ---------- the main flow ----------

// The steps the models and our math took, each stamped with how long it took (steps run one after
// another, so the time since the previous step is this step's time). onStep reports progress live.
function makePipeline(onStep) {
  const steps = [];
  let last = performance.now();
  steps.add = (s) => {
    const t = performance.now();
    if (steps.attempt > 1 && !s.noAttempt) s.step = `${s.step} (attempt ${steps.attempt})`;
    delete s.noAttempt;
    if (s.ms == null) s.ms = Math.round(t - last);
    last = t;
    steps.push(s);
    try { onStep?.(s); } catch {}
    return s;
  };
  return steps;
}

// SAM's result per concept: how many outlines it returned and its best confidence.
function samResult(concepts, segs) {
  return {
    objects: concepts.map((concept, i) => {
      const objs = segs[i]?.objects || [];
      const cs = objs.map((o) => o.c).filter((c) => c != null);
      return { concept, count: objs.length, conf: cs.length ? Math.round(Math.max(...cs) * 100) / 100 : null };
    }),
  };
}

/**
 * measureAnything({ dataUrl, dataUrls, text, focal35, deps, onStep })
 *   dataUrls: 2 to 4 photos of ONE floor with the same sheet of paper in every shot (floor_tile only);
 *             the first is also dataUrl. Any other task uses the first photo alone.
 *   deps (for tests): { read(dataUrl, prompt, schema) -> json, segment(dataUrl, concept) -> { objects, frame },
 *                       segmentAt?(dataUrl, frame, point) -> { objects, frame },
 *                       word?(system, facts) -> text, check?(images, prompt, schema) -> json }
 *   onStep(step): called as each step finishes (for live progress on the page).
 */
export async function measureAnything(opts) {
  const r = await measureAll(opts);
  // A Spanish question gets the whole card in Spanish (our template strings, translated statically).
  return r?.read?.language === 'es' ? localizeResult(r) : { ...r, lang: 'en' };
}

async function measureAll({ dataUrl, dataUrls = null, text = '', focal35 = null, deps = null, onStep = null, wordTimeoutMs = WORD_TIMEOUT_MS, checkTimeoutMs = CHECK_TIMEOUT_MS }) {
  const pipeline = makePipeline(onStep);
  const urls = Array.isArray(dataUrls) && dataUrls.length > 1 ? dataUrls.slice(0, MAX_PHOTOS) : null;
  if (urls && !dataUrl) dataUrl = urls[0];
  const live = deps || (hasKey() ? {
    read: (d, p, s) => sparkReadPhoto({ dataUrl: d, prompt: p, schema: s }),
    segment: (d, c) => samSegment({ dataUrl: d, concept: c }),
    segmentAt: (d, frame, point) => samSegmentAt({ dataUrl: d, frame, point }),
    word: (system, facts) => sparkWrite({ system, facts, timeoutMs: WORD_TIMEOUT_MS }),
    check: (images, prompt, schema) => sparkCheck({ images, prompt, schema, timeoutMs: CHECK_TIMEOUT_MS }),
  } : null);
  const sam = { cache: new Map(), override: null };
  let r;
  if (urls) {
    // Several photos: Spark reads the first one; a floor goes to the multi-photo flow, anything else
    // is measured from the first photo alone (and the answer says so).
    const rd = await readTask({ dataUrl, text, live, pipeline });
    if (rd.done) return rd.done;
    if (rd.read.task === 'floor_tile') {
      r = await floorMultiFlow({ dataUrls: urls, text, live, read: rd.read, pipeline, focal35, wordTimeoutMs, checkTimeoutMs });
      if (!r.ok) return r;
      return checkAndWord({ r, dataUrl, text, focal35, live, pipeline, sam, wordTimeoutMs, checkTimeoutMs });
    }
    r = await measureCore({ dataUrl, text, focal35, live, pipeline, sam, presetRead: rd.read });
    if (r.ok) r.note = `Only the first photo was measured: several photos at once are for a floor, with the same sheet of paper in every shot.`;
  } else {
    r = await measureCore({ dataUrl, text, focal35, live, pipeline, sam });
  }
  if (!r.ok) return r;
  return checkAndWord({ r, dataUrl, text, focal35, live, pipeline, sam, wordTimeoutMs, checkTimeoutMs });
}

// Muse Spark checks SAM's outlines (every photo's, for a multi-photo floor) while it words the answer
// (in parallel, to save time). If it disagrees with what SAM outlined, no number goes out as it is.
// Several photos' checks share one budget: the single-photo timeout plus CHECK_EXTRA_MS per further photo
// (capped), run two at a time so the drawing (a worker thread each) and Spark's replies don't all fight
// for the same seconds and time out together, as they did on the first live run.
export const CHECK_EXTRA_MS = 6000;
export const CHECK_BUDGET_MAX_MS = 30000;
export const checkBudgetMs = (n, base = CHECK_TIMEOUT_MS) => Math.min(CHECK_BUDGET_MAX_MS, base + CHECK_EXTRA_MS * Math.max(0, n - 1));
async function runChecks({ checks, dataUrl, live, pipeline, timeoutMs }) {
  if (checks.length <= 1) return Promise.all(checks.map((c) => checkOutlines({ dataUrl: c.dataUrl || dataUrl, live, check: c, pipeline, timeoutMs, label: c.label })));
  const deadline = performance.now() + checkBudgetMs(checks.length, timeoutMs);
  const out = new Array(checks.length);
  let next = 0;
  const worker = async () => {
    while (next < checks.length) {
      const i = next++;
      const left = Math.max(2000, Math.round(deadline - performance.now()));
      out[i] = await checkOutlines({ dataUrl: checks[i].dataUrl || dataUrl, live, check: checks[i], pipeline, timeoutMs: Math.min(timeoutMs, left), label: checks[i].label });
    }
  };
  await Promise.all([worker(), worker()]);
  return out;
}

async function checkAndWord({ r, dataUrl, text, focal35, live, pipeline, sam, wordTimeoutMs, checkTimeoutMs }) {
  const checks = pipeline.checks || (pipeline.check ? [pipeline.check] : []);
  const [chks] = await Promise.all([
    live?.check && checks.length ? runChecks({ checks, dataUrl, live, pipeline, timeoutMs: checkTimeoutMs }) : [],
    live?.word ? wordAnswer(r, live, pipeline, wordTimeoutMs) : null,
  ]);
  // The per-photo checks finish in any order; the panel lists them by photo.
  if (pipeline.checks) {
    const idx = pipeline.map((p, i) => (/check SAM’s outlines/.test(p.step) ? i : -1)).filter((i) => i >= 0);
    const sorted = idx.map((i) => pipeline[i]).sort((a, b) => a.step.localeCompare(b.step, 'en', { numeric: true }));
    idx.forEach((i, k) => { pipeline[i] = sorted[k]; });
  }
  const got = chks.filter(Boolean);
  const chk = got.find((c) => c.agreed === false) || (got.some((c) => c.skipped) ? { skipped: true } : got.length ? { agreed: true } : null);
  if (chk) r.checked = chk.agreed ? 'agreed' : chk.skipped ? 'skipped' : 'disagreed';
  const thumb = checks.find((c) => c.thumb)?.thumb;
  if (thumb) r.thumb = thumb;
  if (!chk || chk.agreed !== false) return r;
  // The wording ran alongside the check; it is not sent, and the panel says so.
  const w = pipeline.find((p) => /word the answer/.test(p.step));
  if (w) { w.result = { used: false, fellBack: chk.fix ? 'not sent: Spark corrected SAM, so we re-measured' : 'not sent: Spark’s check disagreed' }; delete w.error; }
  // The correction round is for one photo; a multi-photo floor asks for that photo again instead.
  if (!chk.fix || pipeline.checks) return refuse(r, pipeline, chk.tip);
  return correctOnce({ r, chk, dataUrl, text, focal35, live, pipeline, sam, wordTimeoutMs, checkTimeoutMs });
}

// Closing the loop: Spark disagreed with one of SAM's outlines and told us what to look for instead
// (a better concept phrase, and a point on the right thing when it can). SAM outlines it once more,
// our geometry re-measures, and Spark checks again. One correction round at most; if Spark still
// disagrees, or its second check doesn't come back, no number goes out.
async function correctOnce({ r, chk, dataUrl, text, focal35, live, pipeline, sam, wordTimeoutMs, checkTimeoutMs }) {
  const { fix } = chk;
  const item = pipeline.check.items.find((it) => it.role === fix.role);
  const frame = pipeline.check.frame;
  const t0 = performance.now();
  let seg = null, how = null;
  const tries = [];
  if (fix.point && live.segmentAt && frame?.w) {
    const point = { x: Math.min(frame.w - 1, Math.max(0, Math.floor(fix.point.x * frame.w))), y: Math.min(frame.h - 1, Math.max(0, Math.floor(fix.point.y * frame.h))) };
    try { seg = await live.segmentAt(dataUrl, frame, point); how = `a point Spark marked (${point.x}, ${point.y})`; } catch (e) { tries.push(`point prompt failed: ${friendlyError(e)}`); }
    if (seg && !seg.objects?.length) { tries.push('point prompt found nothing'); seg = null; }
  }
  if (!seg && fix.phrase) {
    try { seg = await live.segment(dataUrl, fix.phrase); how = `“${fix.phrase}”`; } catch (e) { tries.push(`concept prompt failed: ${friendlyError(e)}`); }
    if (seg && !seg.objects?.length) { tries.push(`nothing found for “${fix.phrase}”`); seg = null; }
  }
  pipeline.add({ model: 'sam-3.1', step: `outline the ${item?.name?.replace(/^(the|a) /, '') || 'object'} again with Spark’s fix`, ms: Math.round(performance.now() - t0), noAttempt: true,
    result: seg ? { objects: [{ concept: how, count: seg.objects.length, conf: confOf(seg) }] } : { corrected: false, why: tries.join('; ') || 'no fix to try' } });
  if (!seg) return refuse(r, pipeline, chk.tip);
  if (!seg.frame) seg.frame = frame;
  const firstTry = (r.overlay?.outlines || []).find((o) => o.role === (fix.role === 'other' ? 'target' : fix.role) && (fix.role !== 'other' || o.label === item?.name?.replace(/^the /, '')));
  pipeline.attempt = 2;
  sam.override = { idx: ROLE_INDEX[fix.role], seg };
  const r2 = await measureCore({ dataUrl, text, focal35, live, pipeline, sam, presetRead: r.read });
  if (!r2.ok) return { ...r2, corrected: { role: fix.role, how, ok: false } };
  const [chk2] = await Promise.all([
    live.check && pipeline.check ? checkOutlines({ dataUrl, live, check: pipeline.check, pipeline, timeoutMs: checkTimeoutMs, final: true }) : null,
    live.word ? wordAnswer(r2, live, pipeline, wordTimeoutMs) : null,
  ]);
  if (pipeline.check?.thumb) r2.thumb = pipeline.check.thumb;
  const firstSeen = chk.outlines?.find((o) => o.role === fix.role)?.seen || null;
  r2.corrected = { role: fix.role, how, firstSeen };
  if (firstTry && r2.overlay) r2.overlay.outlines = [{ ...firstTry, role: 'rejected', label: `SAM’s first try${firstSeen ? `: ${firstSeen}` : ''}` }, ...r2.overlay.outlines];
  if (chk2?.agreed) { r2.checked = 'agreed'; return r2; }
  const w2 = pipeline.filter((p) => /word the answer/.test(p.step)).at(-1);
  if (w2) { w2.result = { used: false, fellBack: 'not sent: Spark’s second check didn’t agree' }; delete w2.error; }
  const tip = chk2?.tip || `I didn’t measure this one: Muse Spark couldn’t confirm SAM’s second outline in time. Retake it with ${item?.name || 'the object'} whole, in focus and near the middle of the shot.`;
  return { ...refuse(r2, pipeline, tip), corrected: r2.corrected };
}
// A pale sheet on a gray floor can come back from SAM with no outline for "sheet of paper"; try two other
// plain wordings for the same thing (only when the first finds nothing) before giving up on the ruler.
const PAPER_ALTS = ['white paper', 'rectangular white sheet'];
// Clear glass on a dark dashboard is hard for SAM to outline as a "chip"; other plain wordings for the same
// damage are tried (one at a time, only while nothing is found).
const GLASS_ALTS = ['star-shaped crack in glass', 'small crack in windshield', 'damaged spot on glass'];
// The glass wordings are only for a windshield job: a crack in a wall or sidewalk must not turn into a window.
// Stoops, porches and patios: other plain wordings for the same concrete, tried only while nothing is found (surface jobs only).
const SLAB_ALTS = ['concrete pad', 'concrete step', 'porch floor'];
const PATIO_ALTS = ['concrete slab', 'paved patio area'];
const altsFor = (concept, task) => (concept === 'sheet of paper' ? PAPER_ALTS : task === 'windshield_chip' && (concept === 'chip' || concept === 'crack') ? GLASS_ALTS : task === 'surface_area' && concept === 'concrete slab' ? SLAB_ALTS : task === 'surface_area' && concept === 'patio' ? PATIO_ALTS : []);
export async function segmentWithAlts(live, dataUrl, concept, task) {
  let seg = await live.segment(dataUrl, concept);
  for (const alt of altsFor(concept, task)) {
    if ((seg.objects || []).length) break;
    try { const s2 = await live.segment(dataUrl, alt); if ((s2.objects || []).length) seg = s2; } catch { /* keep the empty result */ }
  }
  return seg;
}
// A sheet of paper meant for a floor lies ON the floor: among SAM's paper outlines, prefer the best one whose
// centre falls inside the floor's box (a paper towel on the wall does not), else the best one overall.
export function bestOnFloor(objects, floor) {
  const objs = objects || [];
  const b = floor && floor.box;
  if (b && objs.length > 1) {
    const on = objs.filter((o) => o.box && (o.box.x1 + o.box.x2) / 2 >= b.x1 && (o.box.x1 + o.box.x2) / 2 <= b.x2 && (o.box.y1 + o.box.y2) / 2 >= b.y1 && (o.box.y1 + o.box.y2) / 2 <= b.y2);
    if (on.length) return best(on);
  }
  return best(objs);
}
const ROLE_INDEX = { target: 0, ruler: 1, other: 2 };
const confOf = (seg) => { const cs = (seg.objects || []).map((o) => o.c).filter((c) => c != null); return cs.length ? Math.round(Math.max(...cs) * 100) / 100 : null; };

async function measureCore({ dataUrl, text, focal35, live, pipeline, sam = { cache: new Map(), override: null }, presetRead = null }) {
  // SAM's outlines for this photo, by concept: a second attempt reuses them, except the one Spark fixed.
  const segsFor = (concepts, task) => Promise.all(concepts.map((c, i) => {
    if (sam.override && sam.override.idx === i) return sam.override.seg;
    if (!sam.cache.has(c)) sam.cache.set(c, segmentWithAlts(live, dataUrl, c, task));
    return sam.cache.get(c);
  }));
  if (presetRead) return measureFrom({ dataUrl, text, focal35, live, pipeline, read: presetRead, segsFor, sam });
  const rd = await readTask({ dataUrl, text, live, pipeline });
  if (rd.done) return rd.done;
  const { read } = rd;
  if (read.task === 'face') return faceFlow({ dataUrl, live, read, pipeline, focal35 });
  return measureFrom({ dataUrl, text, focal35, live, pipeline, read, segsFor, sam });
}

// 1. Read the photo and the message (Spark, backed up by the words they typed). Returns { read } or,
// when the answer is already known (face off, no models), { done: result }.
async function readTask({ dataUrl, text, live, pipeline }) {
  const guess = guessFromText(text);

  let read;
  if (live) {
    try {
      read = await live.read(dataUrl, READ_PROMPT + (text ? `\nTheir message: "${text}"` : ''), READ_SCHEMA);
      pipeline.add({ model: 'muse-spark-1.3', step: 'read the photo and the question', result: { ...read } });
    } catch (e) {
      pipeline.add({ model: 'muse-spark-1.3', step: 'read the photo and the question', error: String(e.message).slice(0, 200) });
    }
  }
  if (!read) read = { task: guess.task, target: DEFAULT_TARGET[guess.task], second_target: guess.task === 'gap_fit' ? 'house wall' : '', ruler: DEFAULT_RULER[guess.task], item_width_in: guess.item_width_in, tile_w_in: guess.tile_w_in, tile_l_in: guess.tile_l_in, shoe_for: guess.shoe_for, language: guess.language, summary: '' };
  if (!read.language) read.language = guess.language;
  // The person's own words win on numbers they typed.
  if (guess.item_width_in) read.item_width_in = guess.item_width_in;
  if (guess.tile_w_in) { read.tile_w_in = guess.tile_w_in; read.tile_l_in = guess.tile_l_in; }
  if (guess.coin) read.ruler = guess.coin; // "it's a quarter" corrects the coin
  // A driveway, patio or slab is square feet against a door, whatever the model filed it under.
  if (read.task !== 'surface_area' && read.task !== 'face' && (guess.task === 'surface_area' || (read.task === 'size' && looksLikeSurface(text, read.target)))) {
    if (live) pipeline.add({ model: 'first-answer math', step: 'routed by the message to square feet', result: { from: read.task, to: 'surface area' } });
    read.task = 'surface_area';
    if (!looksLikeSurface(text, read.target)) read.target = (String(text).toLowerCase().match(/driveway|patio|stoop|porch|landing|front steps|steps|walkway|sidewalk|slab|pool deck|parking pad/) || ['driveway'])[0];
  }
  if (read.task === 'surface_area' && !SURFACE_REFERENCES[read.ruler]) read.ruler = 'double_garage_door';
  // A stoop or porch leads to the front door, not a garage, unless the message mentions the garage.
  if (read.task === 'surface_area' && read.ruler === 'double_garage_door' && STOOP_WORDS.test(String(read.target).toLowerCase()) && !/garage/i.test(text)) read.ruler = 'front_door';
  if (read.ruler === 'none') read.ruler = DEFAULT_RULER[read.task];

  // Face measuring is off unless SIGHT_FACE=1 (the code stays; the demo is about jobs for a business).
  if (read.task === 'face' && !faceEnabled()) return { done: { ...finishErr(read, pipeline, FACE_OFF), unavailable: 'face' } };
  if (!live) return { done: finishErr(read, pipeline, 'Measuring needs the Meta models switched on for this server.') };
  return { read };
}

async function measureFrom({ dataUrl, text, focal35, live, pipeline, read, segsFor, sam }) {
  if (read.task === 'surface_area') return surfaceFlow({ dataUrl, live, read, pipeline, focal35, text, segsFor, sam });

  // 2. Outline the target(s) and the ruler at the same time.
  const upright = Boolean(UPRIGHT_CONCEPT[read.ruler]);
  const rulerConcept = upright ? UPRIGHT_CONCEPT[read.ruler] : FLAT_REFERENCES[read.ruler]?.samConcept || 'card';
  const concepts = [read.target || DEFAULT_TARGET[read.task], rulerConcept];
  if (read.task === 'gap_fit') concepts.push(read.second_target || 'house wall');
  let segs;
  try {
    segs = await segsFor(concepts, read.task);
  } catch (e) {
    pipeline.add({ model: 'sam-3.1', step: 'outline', error: String(e.message).slice(0, 200) });
    return finishErr(read, pipeline, samDown(e));
  }
  const [tSeg, rSeg, bSeg] = segs;
  const frame = tSeg.frame || rSeg.frame || bSeg?.frame;
  const target = best(tSeg.objects), other = bSeg ? best(bSeg.objects) : null;
  const ruler = target && concepts[1] === 'sheet of paper' ? bestOnFloor(rSeg.objects, target) : best(rSeg.objects);
  if (!sam.override) pipeline.add({ model: 'sam-3.1', step: `outline: ${concepts.join(', ')}`, result: samResult(concepts, segs) });

  const outlines = [outlineOf(target, concepts[0], 'target'), outlineOf(ruler, rulerLabel(read.ruler), 'ruler'), other && outlineOf(other, concepts[2], 'target')].filter(Boolean);
  // What Spark will be asked to confirm, if we get as far as a number.
  pipeline.check = { frame, items: [
    target && { role: 'target', obj: target, name: `the ${concepts[0]}`, expect: `the ${concepts[0]} the person wants measured` },
    other && { role: 'other', obj: other, name: `the ${concepts[2]}`, expect: `the ${concepts[2]} (the other side of the gap)` },
    ruler && { role: 'ruler', obj: ruler, name: `a ${rulerLabel(read.ruler)}`, expect: upright ? `a ${rulerLabel(read.ruler)} standing on the ground` : `a ${rulerSpec(FLAT_REFERENCES[read.ruler] ? read.ruler : DEFAULT_RULER[read.task])}`, ruler: read.ruler },
  ].filter(Boolean) };
  const overlay = { frame, outlines, lines: [] };
  const base = { task: read.task, read, overlay, pipeline };

  // 3. Measure.
  if (['gap_fit', 'height', 'distance'].includes(read.task)) {
    if (!target) return finishErr(read, pipeline, `I couldn’t find the ${concepts[0]} in that photo. Try again with it in the middle of the shot.`, null, overlay);
    const cal = calibrate({ frame, focal35, ref: upright ? ruler : null, refKind: upright ? read.ruler : null, groundLines: [contactPoints(target, frame), ...(other ? [contactPoints(other, frame)] : [])] });
    pipeline.add({ model: 'first-answer math', step: 'set up the camera from the photo', result: { how: cal.how, confidence: cal.confidence, cameraHeightFt: cal.primary && +cal.primary.height.toFixed(1), notes: cal.notes } });
    if (!cal.ok) return finishErr(read, pipeline, cal.ask, null, overlay);
    base.measuredAgainst = upright && ruler && cal.how.includes('reference') ? rulerSpec(read.ruler) : 'a typical phone height (no door in the shot)';
    if (read.task === 'gap_fit') {
      if (!other) return finishErr(read, pipeline, `I found the ${concepts[0]} but not the ${concepts[2]}. Step back so both are in the shot.`, null, overlay);
      const g = gapBetween(target, other, cal, frame);
      pipeline.add({ model: 'first-answer math', step: 'measure the gap', result: g });
      if (!g.ok) return finishErr(read, pipeline, `I couldn’t see where both sides meet the ground. ${g.reason}.`, null, overlay);
      if (g.depthwise) return finishErr(read, pipeline, `This gap runs toward the camera, and one photo can’t judge distance in that direction, so I’m not going to guess a number. Stand at one end and point the camera along the gap, so both sides run away from you, or measure it with a tape.`, null, overlay);
      const itemFt = read.item_width_in ? read.item_width_in / 12 : null;
      const fit = itemFt ? fitCheck({ gap: g.tightest, itemFt }) : null;
      return finish({
        ...base,
        headline: fit ? cap(fit.verdict) : `${ftIn(g.tightest.ft)} at the narrowest`,
        business: {
          job: itemFt ? `Shed install: a ${ftIn(itemFt)} wide unit in a ${ftIn(g.tightest.ft)} gap (${fit.verdict})` : `Side-yard gap: ${ftIn(g.tightest.ft)} at the narrowest, ${ftIn(g.typical.ft)} typical`,
          materials: itemFt ? [`${ftIn(itemFt)} wide shed kit`, 'Gravel or paver pad, a little bigger than the shed'] : ['Depends on what goes in the gap'],
          quote: 'Install: $X per shed + $Y per sq ft of pad (set by the business)',
        },
        verdictSentence: fit ? fit.text : null,
        answer: fit ? fit.text : `The gap is about ${ftIn(g.typical.ft)}, and ${ftIn(g.tightest.ft)} at the narrowest spot.`,
        numbers: [
          { label: 'Narrowest', value: ftIn(g.tightest.ft) },
          { label: 'Typical', value: ftIn(g.typical.ft) },
          { label: 'Range', value: `${ftIn(g.tightest.low)} – ${ftIn(g.tightest.high)}` },
          ...(itemFt ? [{ label: 'Needs', value: ftIn(itemFt) }] : []),
        ],
        fit: fit ? { verdict: fit.verdict, itemFt } : null,
        shopping: fit && fit.verdict !== 'won’t fit' ? [`${ftIn(itemFt)} wide unit`, 'Gravel or pavers for a level pad, a little bigger than the unit'] : [],
        steps: ['Tape the narrowest spot once before you buy.', 'Leave room to open the doors and walk around it.', 'Check your city’s setback rule for how close to the fence it can sit.'],
        confidence: g.confidence,
        ask: cal.confidence === 'low' ? 'For an exact number, take the photo with a door in it, standing on the same ground.' : null,
      });
    }
    const m = read.task === 'height' ? heightOf(target, cal) : distanceTo(target, cal);
    pipeline.add({ model: 'first-answer math', step: read.task === 'height' ? 'measure the height' : 'measure the distance', result: m });
    if (!m.ok) return finishErr(read, pipeline, m.reason, null, overlay);
    return finish({
      ...base,
      headline: ftIn(m.ft),
      business: {
        job: `${cap(concepts[0])}: about ${ftIn(m.ft)} ${read.task === 'height' ? 'tall' : 'away'} (${ftIn(m.low)} – ${ftIn(m.high)})`,
        materials: [],
        quote: read.task === 'height' ? `$X per job for a ${concepts[0]} this tall (set by the business)` : '$X per job (set by the business)',
      },
      answer: `${cap(concepts[0])}: about ${ftIn(m.ft)} ${read.task === 'height' ? 'tall' : 'away'} (between ${ftIn(m.low)} and ${ftIn(m.high)}).`,
      numbers: [{ label: read.task === 'height' ? 'Height' : 'Distance', value: ftIn(m.ft) }, { label: 'Range', value: `${ftIn(m.low)} – ${ftIn(m.high)}` }],
      shopping: [], steps: [], confidence: m.confidence,
      ask: cal.confidence === 'low' ? 'For an exact number, include a door standing on the same ground.' : null,
    });
  }

  // Flat measuring next to an everyday ruler.
  if (!target) return finishErr(read, pipeline, `I couldn’t find the ${concepts[0]} in that photo. Try again closer, with it in the middle.`, null, overlay);
  if (!ruler) return finishErr(read, pipeline, `I need something of known size next to it: lay a ${read.task === 'windshield_chip' ? 'quarter' : read.task === 'size' ? 'gift card or a quarter' : 'sheet of printer paper'} right beside it and send one more.`, null, overlay);
  const refKind = FLAT_REFERENCES[read.ruler] ? read.ruler : read.task === 'windshield_chip' ? 'quarter' : 'paper_letter';
  const m = measureFlat({ target, ref: ruler, refKind, focal35 });
  pipeline.add({ model: 'first-answer math', step: `measure against the ${FLAT_REFERENCES[refKind].label}`, result: m });
  if (!m.ok) return finishErr(read, pipeline, m.reason, null, overlay);
  const line = longestLine(target);
  base.measuredAgainst = rulerSpec(refKind);
  const pm = m.plusMinusMm, pmPct = Math.round(m.plusMinusPct * 100);

  if (read.task === 'shoe_size') {
    const s = shoeSize(m.lengthMm, read.shoe_for);
    const ratio = m.widthMm / m.lengthMm;
    // Feret width of a foot ≈ ball width; area/length underestimates it, so use the outline's spread.
    const widthWord = ratio < 0.33 ? 'narrow' : ratio > 0.4 ? 'wide' : 'regular';
    if (line) overlay.lines.push({ ...line, label: inchStr(m.lengthMm) });
    return finish({
      ...base,
      headline: `Size ${s.pick}`,
      business: { job: `Shoe fitting: US ${s.pick}, ${widthWord} width`, materials: [`Shoes in US ${s.pick} (about EU ${s.eu})`], quote: '$X per pair (set by the store)' },
      shoe: { pick: s.pick, men: s.men, women: s.women, eu: s.eu },
      answer: `Your foot is ${inchStr(m.lengthMm)} long (${(m.lengthMm / 10).toFixed(1)} cm). That’s a US ${s.pick}, about EU ${s.eu}.`,
      numbers: [{ label: 'Foot length', value: `${inchStr(m.lengthMm)} · ${(m.lengthMm / 10).toFixed(1)} cm` }, { label: 'Range', value: `${rangeIn(m.lengthMm, pm)} (±${pmPct}%)` }, { label: 'US men’s', value: String(s.men) }, { label: 'US women’s', value: String(s.women) }, { label: 'EU', value: String(s.eu) }],
      shopping: [], steps: ['Measure both feet and go by the bigger one.', 'Feet swell a little by evening; measure then if you can.', 'Between sizes, go half a size up.', 'Brands vary: some, like Nike, often run small, so try a half to a full size up.'],
      confidence: m.confidence, ask: m.notes.length ? m.notes.join('; ') : null,
    });
  }

  if (read.task === 'windshield_chip') {
    const v = chipVerdict(m);
    if (line) overlay.lines.push({ ...line, label: inchStr(m.lengthMm) });
    return finish({
      ...base,
      headline: v.repair ? 'Repair it' : 'Replace it',
      business: v.repair
        ? { job: `Windshield ${v.kind} repair: ${inchStr(m.lengthMm)} ${v.kind}`, materials: ['Resin repair kit'], quote: '$X per chip repair (set by the business)' }
        : { job: `Windshield replacement: ${inchStr(m.lengthMm)} ${v.kind}`, materials: ['Windshield glass', 'Camera recalibration if the car has lane or collision cameras'], quote: '$X per windshield + $Y recalibration (set by the business)' },
      answer: v.text,
      verdictSentence: v.text,
      chip: { repair: v.repair, kind: v.kind },
      numbers: [{ label: v.kind === 'crack' ? 'Crack length' : 'Chip size', value: inchStr(m.lengthMm) }, { label: 'Range', value: `${rangeIn(m.lengthMm, pm)} (±${pmPct}%)` }, { label: 'Repair limit', value: v.kind === 'crack' ? '6 in' : '1 in (a quarter)' }],
      shopping: v.repair ? ['Windshield chip repair (many insurers cover it — check your policy)'] : ['Windshield replacement'],
      steps: v.repair ? ['Put clear tape over it to keep dirt out.', 'Skip the car wash and blasting the defroster until it’s fixed.', 'Get it repaired soon — chips spread with heat and bumps.'] : ['Get two quotes; ask if your insurance covers glass.', 'If your car has lane or collision cameras, ask about recalibration.'],
      confidence: m.confidence,
      ask: [...m.notes, ...(Math.abs(m.lengthMm - (v.kind === 'crack' ? 152.4 : 25.4)) <= pm ? ['It’s within measuring error of the repair limit, so have a shop look before deciding.'] : [])].join('; ') || null,
    });
  }

  if (read.task === 'floor_tile') {
    // The whole floor in the shot: the tile answer. The floor running off the photo's edge: a partial
    // ("so far"), and we ask for another photo from another doorway (the paper left where it is).
    if (m.clipped) return partialFloorAnswer({ ...base, m, photos: 1 });
    // A room is a rectangle: its long and short sides, not the corner-to-corner diagonal.
    const roomL = (m.rectLengthMm || m.lengthMm) / 25.4, roomW = (m.rectWidthMm || m.areaMm2 / m.lengthMm) / 25.4;
    if (line) overlay.lines.push({ ...line, label: ftIn(roomL / 12) });
    return tileAnswer({ ...base, roomW, roomL, plusMinusPct: m.plusMinusPct, confidence: m.confidence, notes: m.notes });
  }

  // General size. Boxy things (a coaster, a rug, a phone) get their two sides; round or odd shapes
  // get their longest stretch and average width.
  const boxy = m.rectLengthMm && m.rectWidthMm && m.areaMm2 / (m.rectLengthMm * m.rectWidthMm) > 0.85;
  const coinTip = FLAT_REFERENCES[refKind].shape === 'circle' ? `Measured with a ${FLAT_REFERENCES[refKind].label} as the ruler — if that coin is something else, reply with its name (quarter, dime, nickel or penny).` : null;
  const tips = [...m.notes, coinTip].filter(Boolean).join(' ') || null;
  if (boxy) {
    const side = rectSideLine(target);
    if (side) overlay.lines.push({ ...side, label: inchStr(m.rectLengthMm) });
    const sq = Math.abs(m.rectLengthMm - m.rectWidthMm) / m.rectLengthMm < 0.06;
    return finish({
      ...base,
      headline: sq ? `${inchStr(m.rectLengthMm)} square` : `${inchStr(m.rectLengthMm)} × ${inchStr(m.rectWidthMm)}`,
      business: { job: `${cap(concepts[0])}: ${inchStr(m.rectLengthMm)} × ${inchStr(m.rectWidthMm)}`, materials: [], quote: '$X for this size (set by the business)' },
      answer: `${cap(concepts[0])}: ${inchStr(m.rectLengthMm)} × ${inchStr(m.rectWidthMm)} (${(m.rectLengthMm / 10).toFixed(1)} × ${(m.rectWidthMm / 10).toFixed(1)} cm), measured against the ${m.ruler}.`,
      numbers: [{ label: 'Long side', value: `${inchStr(m.rectLengthMm)} · ${(m.rectLengthMm / 10).toFixed(1)} cm` }, { label: 'Short side', value: `${inchStr(m.rectWidthMm)} · ${(m.rectWidthMm / 10).toFixed(1)} cm` }, { label: 'Accuracy', value: `±${inchStr(m.rectLengthMm * m.plusMinusPct)} (±${pmPct}%)` }, { label: 'Area', value: `${m.areaIn2} sq in` }],
      shopping: [], steps: ['Send the same shot again later to see if it changed.'],
      confidence: m.confidence, ask: tips,
    });
  }
  if (line) overlay.lines.push({ ...line, label: inchStr(m.lengthMm) });
  return finish({
    ...base,
    headline: `${inchStr(m.lengthMm)} long`,
    business: { job: `${cap(concepts[0])}: ${inchStr(m.lengthMm)} long, about ${inchStr(m.widthMm)} wide`, materials: [], quote: '$X for this size (set by the business)' },
    answer: `${cap(concepts[0])}: ${inchStr(m.lengthMm)} long, about ${inchStr(m.widthMm)} wide, ${m.areaIn2} sq in, measured against the ${m.ruler}.`,
    numbers: [{ label: 'Length', value: `${inchStr(m.lengthMm)} · ${(m.lengthMm / 10).toFixed(1)} cm` }, { label: 'Range', value: `${rangeIn(m.lengthMm, pm)} (±${pmPct}%)` }, { label: 'Width', value: inchStr(m.widthMm) }, { label: 'Area', value: `${m.areaIn2} sq in` }],
    shopping: [], steps: ['Send the same shot again later to see if it changed.'],
    confidence: m.confidence, ask: tips,
  });
}

// The tile answer from a room's sides in inches: tiles to buy, layout, cut list. photos > 1 when the room
// was combined from several photos on the paper's plane (floorMultiFlow).
export function tileAnswer({ read, roomW, roomL, plusMinusPct, confidence, notes = [], photos = 1, floorSqft = null, other = null, ...base }) {
  const tw = read.tile_w_in || 12, tl = read.tile_l_in || read.tile_w_in || 12;
  const p = tilePlan({ roomW, roomL, tileW: tw, tileL: tl });
  // floorSqft: the floor is not a plain rectangle (a vanity, tub or toilet takes a bite), so the floor to
  // tile is the union's area, less than the room's rectangle. Tiles to buy follow the open floor; the
  // layout and cut list still come from the rectangle (the walls), and the steps say so.
  const open = floorSqft != null && floorSqft < p.room.sqft;
  const sqft = open ? Math.round(floorSqft * 10) / 10 : p.room.sqft;
  // Tiles laid scale the plan's count (full tiles plus one per cut piece) by the open share of the
  // rectangle, so the count and the cut list under it agree.
  const tilesForFloor = open ? Math.ceil(p.tilesForFloor * (sqft / p.room.sqft)) : p.tilesForFloor;
  const pmPct = Math.round(plusMinusPct * 100);
  // The other reading of the half turn (see combineFloors): the range spans both readings' areas.
  const otherSqft = other ? (open ? other.areaMm2 / 92903.04 : (other.widthMm * other.lengthMm) / 92903.04) : null;
  const lo = Math.round(Math.min(sqft, otherSqft ?? sqft) * (1 - 2 * plusMinusPct)), hi = Math.round(Math.max(sqft, otherSqft ?? sqft) * (1 + 2 * plusMinusPct));
  // The order is sized on the HIGH end of the range, then the extra for cuts: running short costs more than a
  // few spare tiles (a second order can come from another dye lot). The measured area and range still show.
  // Capped at 25% over the measured area: a poor photo has a very wide range, and the order should not double.
  const ORDER_CAP = 1.25;
  const rawScale = Math.max(1, hi / sqft), capped = rawScale > ORDER_CAP, orderScale = Math.min(rawScale, ORDER_CAP);
  const tilesForOrder = Math.ceil(tilesForFloor * orderScale);
  const buyTiles = Math.ceil(tilesForOrder * (1 + p.extraPct / 100));
  base.pipeline.add({ model: 'first-answer math', step: 'tile layout and cut list', result: { buyTiles, cuts: p.cuts?.length, ...(open ? { openFloorSqft: sqft } : {}) } });
  const room = `${ftIn(roomW / 12)} by ${ftIn(roomL / 12)}`;
  const first = open
    ? `Combined from ${photos} photos: the room is about ${room}; the floor to tile is ${sqft} sq ft (the floor isn’t a plain rectangle, so only the floor itself is counted).`
    : photos > 1 ? `Combined from ${photos} photos: the floor is about ${room} (${sqft} sq ft).` : `The floor is about ${room} (${sqft} sq ft).`;
  const next = photos > 1 ? ` ${photos < MAX_PHOTOS ? NEXT_OR_SEND : AT_LIMIT}` : '';
  return finish({
    ...base, read,
    headline: `Buy ${buyTiles} tiles`,
    business: {
      job: open ? `Tile ${sqft} sq ft of floor in a ${ftIn(roomW / 12)} × ${ftIn(roomL / 12)} room (from ${photos} photos; not a plain rectangle)` : `Tile a ${ftIn(roomW / 12)} × ${ftIn(roomL / 12)} floor: ${sqft} sq ft${photos > 1 ? ` (from ${photos} photos)` : ''}`,
      materials: [`${buyTiles} tiles, ${tw} × ${tl} in`, 'Thinset, grout and spacers'],
      quote: `${sqft} sq ft × $X per sq ft installed (set by the business)`,
    },
    job: { sqft },
    answer: `${first} In ${tw} × ${tl} in tile that’s ${tilesForFloor} tiles laid. To be safe the order covers ${capped ? `${Math.round((ORDER_CAP - 1) * 100)}% more than the measured area` : `the high end of the range (${hi} sq ft)`}, plus ${p.extraPct}% extra for cuts and mistakes: buy ${buyTiles} tiles.${next}`,
    photos, wantMore: photos > 1 && photos < MAX_PHOTOS, openFloor: open || undefined,
    numbers: [{ label: open ? 'Room' : 'Floor', value: `${ftIn(roomW / 12)} × ${ftIn(roomL / 12)}` }, { label: open ? 'Floor to tile' : 'Area', value: `${sqft} sq ft` }, { label: 'Range', value: other ? `${lo} – ${hi} sq ft` : `${lo} – ${hi} sq ft (±${2 * pmPct}%)` }, ...(photos > 1 ? [{ label: 'Photos', value: `${photos} photos` }] : []), ...(open ? [] : [{ label: 'Full tiles', value: String(p.fullTiles) }]), { label: 'Buy', value: `${buyTiles} tiles (+${p.extraPct}% for cuts)` }],
    shopping: [`${buyTiles} tiles, ${tw} × ${tl} in (same lot number on every box)`, 'Thinset mortar and a notched trowel (ask the store which notch fits your tile)', 'Grout and 1/8 in spacers', 'Tile cutter or wet saw'],
    steps: [`Start at the center of the room: ${p.layout.across} across, ${p.layout.along} along.`, ...p.cuts.map((c) => `${c.count} × ${c.what}: ${c.cut}.`), ...(open ? ['The cut list is for the open floor; fixtures take their own cuts.'] : []), 'Tape-measure one wall before the first cut.'],
    confidence: other ? 'low' : confidence === 'good' ? 'fair' : confidence,
    ask: [...notes, ...(other ? [TWO_ENDS_NOTE] : []), photos > 1 ? `Combined from ${photos} photos — check one wall with a tape before cutting.` : 'Measured from one photo — check one wall with a tape before cutting.'].join(' '),
  });
}

// The conversation around a floor: the customer texts one photo, gets what it shows and is asked for
// more; each further photo is combined with the earlier ones (the page sends them all each time).
export const ASK_MORE = 'Send one or two more photos from another doorway or corner, and leave the sheet of paper where it is, so I can measure the whole room.';
export const NEXT_OR_SEND = 'Send one more if a corner is still missing, or tap Send to the business.';
export const AT_LIMIT = 'That’s the limit of 4 photos; tap Send to the business.';
export const AT_LIMIT_PARTIAL = 'That’s the limit of 4 photos; tap Start over and shoot the floor again with the sheet where every photo can see it.';
export const OPEN_SIDE_ASK = 'Send a photo from the end of the room the others didn’t reach, with the sheet in the shot, and leave the sheet where it is.';
export const TWO_ENDS_NOTE = 'Two photos from opposite ends can’t always tell which way is which; a third photo from a side wall settles it.';

// One photo that shows only part of the floor (it runs off the photo's edge): the area seen so far, no
// tiles and no job yet, and a request for more photos.
function partialFloorAnswer({ m, photos = 1, atLimit = false, ...base }) {
  const sqft = Math.round(m.areaMm2 / 92903.04);
  // The part seen is measured like any close-up; that it runs off the edge is the point here, not a flaw (measureFlat adds 8% for it).
  const pm = Math.max(0.03, Math.round((m.plusMinusPct - 0.08) * 1000) / 1000);
  const pmPct = Math.round(pm * 100);
  const step = base.pipeline.findLast((x) => /measure against/.test(x.step) && x.result);
  if (step) step.result = { ...step.result, plusMinusPct: pm, partial: true };
  const notes = m.notes.filter((n) => !/runs off the edge/.test(n));
  return finish({
    ...base,
    headline: `About ${sqft} sq ft so far`,
    answer: `I can see part of the floor: about ${sqft} sq ft so far. ${atLimit ? AT_LIMIT_PARTIAL : ASK_MORE}`,
    numbers: [{ label: 'Seen so far', value: `${sqft} sq ft` }, { label: 'Range', value: `${Math.round(sqft * (1 - 2 * pm))} – ${Math.round(sqft * (1 + 2 * pm))} sq ft (±${2 * pmPct}%)` }],
    shopping: [], steps: [],
    confidence: 'fair',
    ask: notes.length ? notes.join(' ') : null,
    partial: true, photos, wantMore: !atLimit,
  });
}

// ---------- whole floor from several photos ----------
//
// 2 to 4 photos of ONE floor with the same sheet of paper in every shot (floor.js has the geometry and
// the 180° rule). Per photo: SAM outlines the floor and the paper, our geometry maps the floor onto the
// paper's plane. The floors are then combined into one, and Spark checks every photo's outlines before
// the number goes out (checkAndWord). The result carries overlays, one per photo, for the page.
export const MULTI_PAPER_TIP = 'Leave the sheet of paper where it is and shoot the floor from another doorway or corner.';
const SQFT_PER_MM2 = 1 / 92903.04;

async function floorMultiFlow({ dataUrls, text, live, read, pipeline, focal35 = null, wordTimeoutMs, checkTimeoutMs }) {
  const n = dataUrls.length;
  const refKind = FLAT_REFERENCES[read.ruler]?.shape === 'rect' ? read.ruler : 'paper_letter';
  const R = FLAT_REFERENCES[refKind];
  const concepts = [read.target || 'floor', R.samConcept];
  const label = (i) => `photo ${i + 1} of ${n}`;
  // 2. Outline the floor and the paper in every photo, all at once (one step per photo as it comes back).
  const t0 = performance.now();
  let segs;
  try {
    segs = await Promise.all(dataUrls.map((d, i) => Promise.all(concepts.map((c) => segmentWithAlts(live, d, c))).then((sg) => {
      pipeline.add({ model: 'sam-3.1', step: `${label(i)}: outline ${concepts.join(' and ')}`, ms: Math.round(performance.now() - t0), result: samResult(concepts, sg) });
      return sg;
    })));
  } catch (e) {
    pipeline.add({ model: 'sam-3.1', step: `outline ${n} photos`, error: String(e.message).slice(0, 200) });
    return finishErr(read, pipeline, samDown(e));
  }

  // Every photo's outlines go to the page and to Spark's check, whatever happens next.
  const overlays = [], found = [];
  pipeline.checks = [];
  for (let i = 0; i < n; i++) {
    const [tSeg, rSeg] = segs[i];
    const frame = tSeg.frame || rSeg.frame;
    const target = best(tSeg.objects), ruler = bestOnFloor(rSeg.objects, target);
    found.push({ target, ruler });
    overlays.push({ frame, outlines: [outlineOf(target, concepts[0], 'target'), outlineOf(ruler, rulerLabel(refKind), 'ruler')].filter(Boolean), lines: [], photo: i + 1 });
    pipeline.checks.push({ dataUrl: dataUrls[i], label: label(i), frame, items: [
      target && { role: 'target', obj: target, name: `the ${concepts[0]}`, expect: `the ${concepts[0]} the person wants measured` },
      ruler && { role: 'ruler', obj: ruler, name: `a ${R.label}`, expect: `a ${rulerSpec(refKind)}`, ruler: refKind },
    ].filter(Boolean) });
  }
  // A refused answer shows no number anywhere: our math's steps for the other photos are withheld too.
  // The page draws r.overlay on the first photo and overlays[i] on photo i + 1, so the main overlay is always photo 1's.
  const fail = (i, ask) => {
    for (const p of pipeline) if (p.model === 'first-answer math' && p.result) { p.result = { withheld: true, why: 'retake' }; delete p.error; }
    return { ...finishErr(read, pipeline, ask, null, overlays[0]), overlays, photo: i + 1 };
  };
  // 3. Map each photo's floor onto the paper's plane. A photo that can't be used (no sheet, no floor,
  // the sheet too small to read) is dropped and the customer is asked to send that one again; the good
  // photos still answer. Only when none is good does the whole request fail.
  const photos = [], dropped = [], asks = [];
  const dropWhy = (i, why) => { dropped.push(i + 1); asks.push(`${n > 1 ? `Photo ${i + 1}: ` : ''}${why}`); pipeline.checks[i].items = []; };
  for (let i = 0; i < n; i++) {
    if (!found[i].target) { dropWhy(i, NO_FLOOR); continue; }
    if (!found[i].ruler) { dropWhy(i, NO_SHEET); continue; }
    const f = floorOnPaper({ target: found[i].target, ref: found[i].ruler, refKind, focal35 });
    pipeline.add({ model: 'first-answer math', step: `${label(i)}: map the floor onto the ${R.label}’s plane`, result: f.ok ? { sqftSeen: Math.round(f.areaMm2 * SQFT_PER_MM2), plusMinusPct: f.plusMinusPct, confidence: f.confidence } : { ok: false, reason: f.reason } });
    if (!f.ok) { dropWhy(i, /nothing to measure|does not reach/.test(f.reason) ? NO_FLOOR : GET_CLOSER); continue; }
    if (f.errorMm != null) pipeline.at(-1).result.farWallErrorIn = Math.round(f.errorMm / 25.4);
    photos.push({ ...f, index: i });
  }
  if (!photos.length) return { ...fail(dropped[0] - 1, asks.join(' ')), dropped };
  // The drop notices stay a list (asks: one per dropped photo; askTail: the answer's own tip) so each
  // piece is translated on its own; ask is the joined form for anything that reads only ask.
  const withDrops = (r) => {
    if (!dropped.length) return r;
    r.dropped = dropped;
    r.asks = asks;
    r.askTail = r.ask || null;
    r.ask = [...asks, r.ask].filter(Boolean).join(' ');
    return r;
  };
  // One good photo left: the same answer one photo gets (partial or whole).
  if (photos.length === 1) {
    const m = photos[0].measured;
    const base1 = { task: read.task, read, pipeline, measuredAgainst: rulerSpec(refKind), overlay: overlays[0], overlays };
    if (m.clipped) return withDrops(partialFloorAnswer({ ...base1, m, photos: 1 }));
    return withDrops(tileAnswer({ ...base1, roomW: (m.rectWidthMm || m.areaMm2 / m.lengthMm) / 25.4, roomL: (m.rectLengthMm || m.lengthMm) / 25.4, plusMinusPct: m.plusMinusPct, confidence: m.confidence, notes: m.notes }));
  }

  // 4. Combine. A photo whose floor is more than a meter from the others is not the same floor (or
  // the paper moved), and a union that does not fill a rectangle is not a room (an L shape, or a photo
  // that did not line up): the best single photo answers instead, and the note says why.
  const c = combineFloors(photos);
  const k2 = photos.length; // photos that were combined (dropped ones excepted)
  const base = { task: read.task, read, pipeline, measuredAgainst: rulerSpec(refKind), overlays };
  if (!c.ok) {
    const why = c.refused != null ? `photo ${photos[c.refused].index + 1} doesn’t touch the floor seen in the others, so it may be a different floor, or the paper moved`
      : c.misaligned ? `photos ${photos[c.misaligned[0]].index + 1} and ${photos[c.misaligned[1]].index + 1} share only ${Math.round(c.pairOverlap * 100)}% of the floor around the sheet, so one of them didn’t line up (or the paper moved)`
      : `the floor seen in the photos fills only ${Math.round((c.fill || 0) * 100)}% of a rectangle, so a photo probably didn’t line up`;
    pipeline.add({ model: 'first-answer math', step: `combine ${k2} photos on the ${R.label}’s plane`, result: { combined: false, photo: c.refused != null ? photos[c.refused].index + 1 : null, gapMm: c.gapMm ?? null, fill: c.fill ?? null, why: c.refused != null ? 'does not touch the floor in the other photos' : c.misaligned ? `photos ${photos[c.misaligned[0]].index + 1} and ${photos[c.misaligned[1]].index + 1} overlap only ${Math.round(c.pairOverlap * 100)}%` : `fills only ${Math.round((c.fill || 0) * 100)}% of a rectangle` } });
    // The best single photo: the finest map at the sheet (fewest mm per pixel), never the biggest floor
    // (a blown-up map is the biggest floor). A photo that shows only part of the floor answers as the
    // partial it is ("so far"), never as the room.
    const k = photos.indexOf(photos.reduce((a, b) => (b.mmPerPx < a.mmPerPx ? b : a)));
    const m = photos[k].measured;
    const r = m.clipped
      ? partialFloorAnswer({ ...base, overlay: overlays[0], m, photos: 1, atLimit: k2 >= MAX_PHOTOS })
      : tileAnswer({ ...base, overlay: overlays[0], roomW: (m.rectWidthMm || m.areaMm2 / m.lengthMm) / 25.4, roomL: (m.rectLengthMm || m.lengthMm) / 25.4, plusMinusPct: Math.max(m.plusMinusPct, photos[k].plusMinusPct), confidence: m.confidence, notes: photos[k].notes });
    r.note = `The photos weren’t combined: ${why}. This answer is from photo ${photos[k].index + 1} alone. ${MULTI_PAPER_TIP}`;
    r.combined = { photos: k2, ok: false, from: photos[k].index + 1, fill: c.fill ?? null };
    r.photos = k2;
    r.wantMore = k2 < MAX_PHOTOS;
    return withDrops(r);
  }
  const coverage = c.photos.map((p, i) => `photo ${photos[i].index + 1} ${Math.round(p.coverage * 100)}%`).join(', ');
  pipeline.add({ model: 'first-answer math', step: `combine ${k2} photos on the ${R.label}’s plane`, result: { sqftSeen: c.sqft, widthFt: Math.round((c.widthMm / 304.8) * 10) / 10, lengthFt: Math.round((c.lengthMm / 304.8) * 10) / 10, fill: `${Math.round(c.fill * 100)}%${c.rectangle ? '' : ' (not a plain rectangle: the floor seen is the area)'}; photos overlap ${Math.round(c.pairOverlap * 100)}%${c.openSides.length ? `; no photo reaches the wall on ${c.openSides.length} side${c.openSides.length === 1 ? '' : 's'}` : ''}${c.ambiguous ? `; the other half-turn reads ${Math.round((c.ambiguous.widthMm / 304.8) * 10) / 10} × ${Math.round((c.ambiguous.lengthMm / 304.8) * 10) / 10} ft, ${c.ambiguous.sqft} sq ft` : ''}`, coverage, turned: c.photos.filter((p) => p.flipped).length, plusMinusPct: c.plusMinusPct } });
  const notes = [...new Set(photos.flatMap((p) => p.notes))];
  // No photo's frame reaches past the floor on some side: the floor just ran out of the photos there,
  // so this is still a partial ("so far"), and the next photo should come from that end.
  if (c.openSides.length) {
    const sqft = Math.round(c.areaMm2 / 92903.04);
    const pm = c.plusMinusPct, pmPct = Math.round(pm * 100);
    const r = finish({
      ...base, overlay: overlays[0],
      headline: `About ${sqft} sq ft so far`,
      answer: `I can see about ${sqft} sq ft of the floor so far, combined from ${k2} photos, but no photo shows where the floor ends on every side. ${k2 < MAX_PHOTOS ? OPEN_SIDE_ASK : AT_LIMIT_PARTIAL}`,
      numbers: [{ label: 'Seen so far', value: `${sqft} sq ft` }, { label: 'Range', value: `${Math.round(sqft * (1 - 2 * pm))} – ${Math.round(sqft * (1 + 2 * pm))} sq ft (±${2 * pmPct}%)` }, { label: 'Photos', value: `${k2} photos` }],
      shopping: [], steps: [], confidence: 'fair', ask: notes.length ? notes.join(' ') : null,
      partial: true, photos: k2, wantMore: k2 < MAX_PHOTOS,
    });
    r.combined = { photos: k2, ok: true, sqft: c.sqft, fill: c.fill, openSides: c.openSides, coverage: c.photos.map((p) => p.coverage), turned: c.photos.map((p) => p.flipped) };
    return withDrops(r);
  }
  const r = tileAnswer({ ...base, overlay: overlays[0], roomW: c.widthMm / 25.4, roomL: c.lengthMm / 25.4, plusMinusPct: c.plusMinusPct, confidence: photos.every((p) => p.confidence === 'good') ? 'good' : 'low', notes, photos: k2, floorSqft: c.rectangle ? null : c.areaMm2 / 92903.04, other: c.ambiguous });
  r.combined = { photos: k2, ok: true, sqft: c.sqft, fill: c.fill, rectangle: c.rectangle, pairOverlap: c.pairOverlap, openSides: c.openSides, ambiguous: c.ambiguous ? { lengthFt: Math.round((c.ambiguous.lengthMm / 304.8) * 10) / 10, sqft: c.ambiguous.sqft } : null, coverage: c.photos.map((p) => p.coverage), turned: c.photos.map((p) => p.flipped) };

  return withDrops(r);
}
const NO_SHEET = 'I can’t line that one up without the paper. Send it again with the whole sheet in the shot (and leave the sheet where it is).';
const NO_FLOOR = 'I couldn’t find the floor in that one. Send it again with more of the floor and the whole sheet in the shot.';
const GET_CLOSER = 'Get closer to the sheet for that one and send it again.';

// Face: SAM outlines the card, the face, both eyes, the nose and the mouth at once.
async function faceFlow({ dataUrl, live, read, pipeline, focal35 }) {
  const concepts = ['card', 'eye', 'nose', 'mouth'];
  let segs;
  try {
    segs = await Promise.all(concepts.map((c) => live.segment(dataUrl, c)));
  } catch (e) {
    pipeline.add({ model: 'sam-3.1', step: 'outline the face', error: String(e.message).slice(0, 200) });
    return finishErr(read, pipeline, samDown(e), 'face');
  }
  const [cardS, eyeS, noseS, mouthS] = segs;
  const frame = cardS.frame || eyeS.frame || noseS.frame;
  const card = best(cardS.objects), nose = best(noseS.objects), mouth = best(mouthS.objects);
  // Every 'eye' SAM returns (maybe eyebrows or glasses too); face.js picks the real pair by shape and position.
  const eyes = eyeS.objects.filter((o) => o.c == null || o.c >= 0.3).sort((a, b) => (b.c ?? 1) - (a.c ?? 1)).slice(0, 8);
  pipeline.add({ model: 'sam-3.1', step: 'outline: card, eyes, nose, mouth', result: samResult(concepts, segs) });
  const overlay = { frame, outlines: [outlineOf(card, 'gift card', 'ruler')].filter(Boolean), lines: [] };
  const f = measureFace({ card, eyes, nose, mouth, frame, focal35 });
  pipeline.add({ model: 'first-answer math', step: 'scale the face with the card', result: f.ok ? { confidence: f.confidence, phoneDistanceMm: f.distanceMm, headTurnDeg: f.yawDeg } : f.ask });
  if (!f.ok) return finishErr(read, pipeline, f.ask, 'face', overlay);
  for (const e of f.eyeObjects) overlay.outlines.push(outlineOf(e, 'eye', 'target'));
  for (const [o, l] of [[nose, 'nose'], [mouth, 'mouth']]) if (o) overlay.outlines.push(outlineOf(o, l, 'target'));
  overlay.lines.push({ from: f.eyeCentersPx[0], to: f.eyeCentersPx[1], label: `${f.numbers.eyeCenterDistanceMm} mm` });
  const mmIn = (v) => (v == null ? null : `${v} mm (${(v / 25.4).toFixed(2)} in)`);
  const sy = f.symmetry;
  let symLine;
  if (!sy) symLine = f.numbers.noseWidthMm == null ? ' A left-right comparison needs the nose clearly in the shot.' : '';
  else {
    const mid = sy.midlineSame
      ? 'Both eyes sit about the same distance from the midline of the nose (within what one photo can show)'
      : `The eyes sit ${sy.leftEyeToMidlineMm} mm (photo left) and ${sy.rightEyeToMidlineMm} mm (photo right) from the midline of the nose`;
    const wid = sy.widthSame ? 'and the eye widths are about the same.' : `and the eye widths differ by ${sy.eyeWidthDifferenceMm} mm.`;
    symLine = ` ${mid}, ${wid}`;
  }
  return finish({
    task: 'face', read, overlay, pipeline, measuredAgainst: rulerSpec('card'),
    headline: `Eye centers ${f.numbers.eyeCenterDistanceMm} mm apart`,
    answer: `Measured against the gift card on your forehead${f.distanceMm ? `, phone about ${Math.round(f.distanceMm / 25.4)} in away` : ''}.${symLine}`,
    numbers: Object.entries(f.numbers).filter(([, v]) => v != null).map(([k, v]) => ({ label: faceLabel(k), value: mmIn(v) })),
    shopping: [],
    steps: ['Face the camera straight on, phone at eye height, about a foot to arm’s length away.', 'Good, even light; glasses off.', 'One photo is good to about ±5% for eye spacing; nose and mouth are rough.'],
    confidence: f.confidence,
    ask: f.fixes.length ? f.fixes.join(' ') : null,
    note: FACE_NOTE,
  });
}

// Sealer coverage, from typical product labels (the label on the pail wins).
export const SEALER = {
  concrete: { perGallon: 200, labelRange: '150–300', unit: 'gallon' },
  asphalt: { perPail: 300, labelRange: '250–350', unit: 'five-gallon pail' },
};
export function sealerNeeded(sqftHigh, surface = 'unknown') {
  const out = [];
  if (surface !== 'asphalt') out.push({ kind: 'concrete', qty: Math.ceil(sqftHigh / SEALER.concrete.perGallon), unit: 'gallon', text: `Concrete sealer: ${Math.ceil(sqftHigh / SEALER.concrete.perGallon)} ${Math.ceil(sqftHigh / SEALER.concrete.perGallon) === 1 ? 'gallon' : 'gallons'} per coat (at about ${SEALER.concrete.perGallon} sq ft per gallon; labels say ${SEALER.concrete.labelRange})` });
  if (surface !== 'concrete') out.push({ kind: 'asphalt', qty: Math.ceil(sqftHigh / SEALER.asphalt.perPail), unit: 'five-gallon pail', text: `Asphalt sealer: ${Math.ceil(sqftHigh / SEALER.asphalt.perPail)} ${Math.ceil(sqftHigh / SEALER.asphalt.perPail) === 1 ? 'five-gallon pail' : 'five-gallon pails'} per coat (at about ${SEALER.asphalt.perPail} sq ft per pail; labels say ${SEALER.asphalt.labelRange})` });
  return out;
}

// How much of box a lies inside box b (0 to 1).
export function boxInside(a, b) {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1), h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  const area = Math.max(1, (a.x2 - a.x1) * (a.y2 - a.y1));
  return w > 0 && h > 0 ? (w * h) / area : 0;
}

// Driveway, patio, slab: SAM outlines the surface and the door; measure.js adds up real square feet
// row by row using the door as the ruler and the surface's edges for the horizon.
async function surfaceFlow({ dataUrl, live, read, pipeline, focal35, text, segsFor, sam }) {
  const front = read.ruler === 'front_door';
  const concepts = [read.target || 'driveway', front ? 'front door' : 'garage door'];
  const samConcepts = [samWordFor(concepts[0]), concepts[1]]; // what SAM is asked for; concepts[0] stays the person's word
  let segs;
  try {
    segs = await segsFor(samConcepts, 'surface_area');
  } catch (e) {
    pipeline.add({ model: 'sam-3.1', step: 'outline', error: String(e.message).slice(0, 200) });
    return finishErr(read, pipeline, samDown(e));
  }
  const [sSeg, dSeg] = segs;
  const frame = sSeg.frame || dSeg.frame;
  const surface = best(sSeg.objects), door = best(dSeg.objects);
  if (!sam.override) pipeline.add({ model: 'sam-3.1', step: `outline: ${samConcepts.join(', ')}`, result: samResult(samConcepts, segs) });
  const refKind = front ? 'front_door' : door ? garageDoorKind(door.box) : 'double_garage_door';
  const R = SURFACE_REFERENCES[refKind];
  const overlay = { frame, outlines: [outlineOf(surface, concepts[0], 'target'), outlineOf(door, R.label, 'ruler')].filter(Boolean), lines: [] };
  pipeline.check = { frame, items: [
    surface && { role: 'target', obj: surface, name: `the ${concepts[0]}`, expect: `the whole ${concepts[0]} (the ground surface to measure)` },
    door && { role: 'ruler', obj: door, name: `a ${R.label}`, expect: `a ${rulerSpec(refKind)}`, ruler: refKind },
  ].filter(Boolean) };
  if (!surface) return finishErr(read, pipeline, `I couldn’t find the ${concepts[0]} in that photo. Stand at the street end so all of it is in the shot.`, null, overlay);
  if (!door) return finishErr(read, pipeline, `I need the ${front ? 'front door' : 'garage door'} in the shot as the ruler. Stand at the street end of the ${concepts[0]} so the ${front ? 'door' : 'garage door'} is at the far end, and send one more.`, null, overlay);
  if (!frame) return finishErr(read, pipeline, 'Couldn’t read the photo size; please send it again.', null, overlay);
  // A ground surface never sits on a door. If SAM's "driveway" outline is mostly inside any door it found,
  // it outlined the door, not the ground: refuse instead of measuring a door as a driveway.
  const onDoor = (dSeg.objects || []).find((o) => o.box && surface.box && (o === door || (o.c ?? 1) >= 0.5) && boxInside(surface.box, o.box) > 0.6);
  if (onDoor) return finishErr(read, pipeline, `My outline of the ${concepts[0]} ended up on the ${front ? 'front door' : 'garage door'} instead of the ground, so I held off on a number. Step back so the ground in front of the ${front ? 'door' : 'garage door'} is in the shot, and send it again.`, null, overlay);
  const hfovDeg = focal35 && focal35 > 8 && focal35 < 300 ? (2 * Math.atan(18 / focal35) * 180) / Math.PI : 69;
  const m = measureSurface({ surface, ref: door, refKind, frame, hfovDeg, raisedDoor: front && STOOP_WORDS.test(String(concepts[0]).toLowerCase()) });
  pipeline.add({ model: 'first-answer math', step: `square feet against the ${R.label}`, result: { sqft: m.sqft, low: m.low, high: m.high, method: m.method, confidence: m.confidence, cameraHeightFt: m.cameraHeightFt } });
  if (!m.ok) return finishErr(read, pipeline, `I couldn’t measure the ${concepts[0]} from that angle. Stand at the street end, straight on, with the whole ${concepts[0]} and the ${front ? 'door' : 'garage door'} in the shot.`, null, overlay);
  const t = String(text).toLowerCase();
  const kind = /asphalt|blacktop/.test(t) ? 'asphalt' : /concrete|slab|cement/.test(t) ? 'concrete' : 'unknown';
  const seal = sealerNeeded(m.high, kind);
  const fmt = (n) => n.toLocaleString('en-US');
  const sizeWords = m.widthFt && m.lengthFt ? ` (about ${m.widthFt} ft wide by ${m.lengthFt} ft long)` : '';
  const answer = `Your ${concepts[0]} is about ${fmt(m.sqft)} sq ft${sizeWords}. A single photo can be off by a third or more, so plan on somewhere between ${fmt(m.low)} and ${fmt(m.high)} sq ft until you tape it. (Measured against the ${R.label}.) ${seal.length === 1 ? `Buy ${seal[0].qty} ${seal[0].qty === 1 ? seal[0].unit : `${seal[0].unit}s`} of ${seal[0].kind} sealer per coat.` : `That’s ${seal[0].qty} ${seal[0].qty === 1 ? 'gallon' : 'gallons'} of concrete sealer or ${seal[1].qty} ${seal[1].qty === 1 ? 'five-gallon pail' : 'five-gallon pails'} of asphalt sealer per coat.`}`;
  return finish({
    task: 'surface_area', read, overlay, pipeline, measuredAgainst: rulerSpec(refKind),
    headline: `Roughly ${fmt(m.sqft)} sq ft`,
    business: {
      job: `${cap(concepts[0])}: roughly ${fmt(m.sqft)} sq ft (${fmt(m.low)} – ${fmt(m.high)})${m.widthFt && m.lengthFt ? `, ${m.widthFt} × ${m.lengthFt} ft` : ''}`,
      materials: seal.map((x) => `${x.qty} ${x.qty === 1 ? x.unit : `${x.unit}s`} of ${x.kind} sealer per coat`),
      quote: `${fmt(m.sqft)} sq ft × $X per sq ft (set by the business)`,
    },
    answer,
    numbers: [
      { label: 'Area', value: `${fmt(m.sqft)} sq ft` },
      { label: 'Range', value: `${fmt(m.low)} – ${fmt(m.high)} sq ft` },
      ...(m.widthFt && m.lengthFt ? [{ label: 'Size', value: `${m.widthFt} × ${m.lengthFt} ft` }] : []),
      ...seal.map((x) => ({ label: x.kind === 'concrete' ? 'Concrete sealer' : 'Asphalt sealer', value: `${x.qty} ${x.qty === 1 ? x.unit : `${x.unit}s`} per coat` })),
    ],
    shopping: [...seal.map((x) => x.text), 'Buy for the high end of the range, or tape it first and buy for that; return unopened extras'],
    steps: ['Tape the width and length once before you order: a photo estimate can be off by a third or more.', 'Clean it first: pressure wash and let it dry 24 hours.', 'Check the forecast: no rain for 24–48 hours, above 50°F.', 'Two thin coats beat one thick one; the second coat needs the same amount again.'],
    confidence: m.confidence === 'good' ? 'fair' : m.confidence, // a driveway is never "Measured": real driveways read 15-20% low and 32% high
    ask: m.confidence === 'low' ? `Rough number: for a tighter one, stand at the street end, straight on, phone at chest height, with the whole ${concepts[0]} and the ${front ? 'door' : 'garage door'} in the shot.` : (m.clipped ? `Part of the ${concepts[0]} runs out of the photo; the edges were carried on, so check that end with a tape.` : null),
    surface: { sqft: m.sqft, low: m.low, high: m.high, widthFt: m.widthFt, lengthFt: m.lengthFt, kind },
  });
}

// ---------- Muse Spark words the answer from OUR numbers ----------
//
// The geometry has already produced every number. Spark only turns them into two or three plain
// sentences. Every number in its text must be one of ours, or we keep the template.

export const WORD_TIMEOUT_MS = 6000;

export const WORD_PROMPT = `You write the text message First Answer sends back after measuring someone's photo.
Use ONLY the facts in the JSON you are given. Write 2 or 3 short, plain sentences: first the answer, then the most useful next step.
Numbers: copy every number exactly as it appears in the facts, with its unit. Never round, convert, add, average or calculate. Never write a number that is not in the facts, and never spell numbers out as words.
No prices, no dates, no greetings, no emoji, no markdown, no lists. Do not mention AI, models or photos being analyzed.`;

export const WORD_PROMPT_ES = `
Write the message in Spanish (plain Latin American Spanish, as you would text a customer). Keep every number exactly as in the facts, as digits, and write its unit in Spanish: sq ft = pies cuadrados, sq in = pulgadas cuadradas, gallons = galones, five-gallon pails = cubetas de cinco galones, in = pulgadas, ft = pies, tiles = baldosas, photos = fotos, men’s = de hombre, women’s = de mujer, US stays EE. UU. before the number, EU stays EU before the number, mm and cm stay. A quarter (the coin) is "una moneda de un cuarto de dólar". Repair = reparar, replace = reemplazar, fits = cabe, won't fit = no cabe, tight = justo.`;

const NUM_RE = /\d+(?:,\d{3})*(?:\.\d+)?(?:\/\d+)?/g;
const NUMBER_WORDS = /(?<![\p{L}])(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozen|half|halves|quarter|third|double|twice|triple|single|once|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|quince|veinte|treinta|cuarenta|cincuenta|cien|ciento|mil|docena|mitad|doble|triple)(?![\p{L}])/giu;
const normNum = (n) => n.replace(/,(?=\d{3}\b)/g, '').replace(/\.0+$/, '');

// The numbers (and number words) a text uses.
export function numbersIn(text) {
  return [...String(text).matchAll(NUM_RE)].map((m) => normNum(m[0]));
}

// Units a number can carry, read in English or Spanish. Order matters: longer forms first
// ("sq ft" before "ft", "five-gallon pails" before "gallons").
const APOS = '[’\']';
const SUFFIX_UNITS = [
  ['sqft', new RegExp(`^\\s*(?:sq\\.?\\s*f(?:ee)?t\\b|square\\s+f(?:ee|oo)t\\b|pies?\\s+cuadrados?\\b)`, 'i')],
  ['sqin', /^\s*(?:sq\.?\s*in\b|square\s+inch(?:es)?\b|pulgadas?\s+cuadradas?\b)/i],
  ['pail', /^\s*(?:(?:five|5|cinco)[- ]gallon\s+)?(?:pails?|buckets?|cubetas?(?:\s+de\s+(?:cinco|5)\s+galones)?)\b/i],
  ['gallon', /^\s*(?:gal(?:lon)?s?\b|gal[oó]n(?:es)?\b)/i],
  ['tiles', /^\s*(?:(?:full\s+)?tiles?\b|baldosas?\b|azulejos?\b|losetas?\b)/i],
  ['mm', /^\s*(?:mm\b|millimet(?:er|re)s?\b|mil[ií]metros?\b)/i],
  ['cm', /^\s*(?:cm\b|centimet(?:er|re)s?\b|cent[ií]metros?\b)/i],
  ['in', /^\s*(?:in\b(?!\s+(?:the|a|an|your|it|one|two)\b)|inch(?:es)?\b|"|″|pulgadas?\b)/i],
  ['ft', /^\s*(?:ft\b|feet\b|foot\b|'|′|pies?\b)/i],
  ['pct', /^\s*(?:%|percent\b|por\s*ciento\b)/i],
  ['hour', /^\s*(?:hours?\b|hrs?\b|horas?\b)/i],
  ['degF', /^\s*(?:°\s*F\b|degrees?\s+F(?:ahrenheit)?\b|grados?\s+F(?:ahrenheit)?\b)/i],
  ['photos', /^\s*(?:photos?\b|pictures?\b|shots?\b|fotos?\b|im[aá]gen(?:es)?\b)/i],
  ['men', new RegExp(`^\\s*(?:men${APOS}?s\\b|(?:de\\s+)?(?:hombre|caballero)s?\\b)`, 'i')],
  ['women', new RegExp(`^\\s*(?:women${APOS}?s\\b|(?:de\\s+)?(?:mujer|dama|señora)s?\\b)`, 'i')],
];
// Units written before the number: "US men’s: 10.5", "EU 44", "talla 10.5 de hombre" is a suffix.
const PREFIX_UNITS = [
  ['women', new RegExp(`(?:women${APOS}?s|mujer(?:es)?|dama(?:s)?)\\s*:?\\s*(?:size\\s+|talla\\s+)?$`, 'i')],
  ['men', new RegExp(`(?:men${APOS}?s|hombres?|caballeros?)\\s*:?\\s*(?:size\\s+|talla\\s+)?$`, 'i')],
  ['eu', /\b(?:EU|UE)\s*:?\s*(?:size\s+|talla\s+)?$/i],
  ['us', /\b(?:US|EE\.?\s*UU\.?)\s*:?\s*(?:size\s+|talla\s+)?$/i],
  ['tiles', /\b(?:tiles?|baldosas?)\s*:\s*$/i],
];
// "between 370 and 470 sq ft", "370 – 470 sq ft", "de 370 a 470 pies": the first number takes the second's unit.
// "18 × 24 ft" and "18 by 24 ft" too.
const RANGE_JOIN = /^\s*(?:–|—|-|to|and|or|a|y|o|hasta|×|x|by|por)\s*(?=\d)/i;

// The facts as plain lines (JSON quotes would read as inch marks).
const factLines = (facts) => {
  if (typeof facts === 'string') return facts;
  const out = [];
  const walk = (v) => { if (v == null) return; if (typeof v === 'object') Object.values(v).forEach(walk); else out.push(String(v)); };
  walk(facts);
  return out.join('\n');
};

// Every number in a text with the unit it carries (or '' when it has none): [{ n, unit }].
export function numberUnits(text) {
  const s = String(text);
  const found = [...s.matchAll(NUM_RE)].map((m) => ({ n: normNum(m[0]), at: m.index, end: m.index + m[0].length }));
  const unitAfter = (i) => {
    const rest = s.slice(i, i + 40);
    for (const [u, re] of SUFFIX_UNITS) if (re.test(rest)) return u;
    return '';
  };
  const unitBefore = (i) => {
    const head = s.slice(Math.max(0, i - 24), i);
    for (const [u, re] of PREFIX_UNITS) if (re.test(head)) return u;
    return '';
  };
  const out = found.map((f) => ({ n: f.n, unit: unitAfter(f.end) || unitBefore(f.at), f }));
  for (let k = out.length - 2; k >= 0; k--) {
    if (out[k].unit) continue;
    const gap = s.slice(out[k].f.end, out[k + 1].f.at + 1);
    if (RANGE_JOIN.test(gap)) out[k].unit = out[k + 1].unit;
  }
  return out.map(({ n, unit }) => ({ n, unit }));
}

// The verdict a headline gives (repair / replace, fits / tight / won't fit / too close to call).
const VERDICTS = [
  { when: /^repair it/i, name: 'repair' },
  { when: /^replace it/i, name: 'replace' },
  { when: /^won[’']t fit/i, name: 'won’t fit' },
  { when: /^fits, but tight/i, name: 'tight' },
  { when: /^fits\b/i, name: 'fits' },
  { when: /^too close to call/i, name: 'too close to call' },
];
export const verdictOf = (headline) => VERDICTS.find((v) => v.when.test(String(headline || ''))) || null;

// The verdict sentence is ours (the template's, locked); Spark only writes what comes after it.
// Word-matching negation is a losing game ("I would not repair it", "Skip the repair"), so on these
// tasks Spark's text may not use a verdict word of either polarity, a negation or a comparison at all.
export const VERDICT_TASKS = new Set(['windshield_chip', 'gap_fit']);
const VERDICT_WORDS = new RegExp([
  // English: repair / replace and friends, fit / tight and friends, the glass itself
  String.raw`repair\w*|fix\w*|mend\w*|patch\w*|replac\w*|swap\w*|new|glass|windshield\w*|crack\w*|spread\w*|fit\w*|tight\w*|snug\w*|room\w*|space\w*|squeez\w*|clearance|cramped|plenty|enough|wide|narrow\w*|big\w*|small\w*|larg\w*|limit\w*|okay|ok|fine|safe|bad|worth|option\w*|skip\w*|instead|rather`,
  // negations and comparisons
  String.raw`not|no|never|none|nothing|nor|cannot|\w+n[’']t|than|too`,
  // Spanish
  String.raw`repar\w*|arregl\w*|reemplaz\w*|cambi\w*|nuev\w*|vidrio\w*|cristal\w*|parabrisas|grieta\w*|cab(?:e|en|er|rá|ría|ía)|quep\w*|entr(?:a|an|ar|ará|aría)|justo|justa|apretad\w*|espacio|sobra\w*|holgad\w*|suficiente\w*|ancho\w*|estrech\w*|grande\w*|pequeñ\w*|menor\w*|mayor\w*|demasiad\w*|límite|nunca|jamás|tampoco|ni|mejor|peor`,
].join('|'), 'iu');
const VERDICT_WORD_RE = new RegExp(`(?<![\\p{L}\\d])(?:${VERDICT_WORDS.source})(?![\\p{L}\\d])`, 'iu');
// A comparison with a size or the limit ("under 6 in", "more than a quarter", "bajo el límite").
const COMPARE_RE = /(?<![\p{L}])(?:under|over|above|below|beyond|past|within|more|less|bajo|sobre|encima|debajo|dentro|más|menos)\s+(?:(?:the|a|an|el|la|una?|de|del)\s+)?(?:\d|limit|quarter|moneda|cuarto|límite)/iu;
export function verdictWordIn(text) {
  const t = String(text || '');
  const m = t.match(VERDICT_WORD_RE) || t.match(COMPARE_RE);
  return m ? m[0] : null;
}

// Vague quantities stand in for a number without being one ("a couple of gallons", "a few pails").
const VAGUE = /(?<![\p{L}])(?:a couple|couple of|a few|few|several|many|lots? of|a lot|handful|dozens|give or take|plus or minus|or so|unos cuantos|unas cuantas|un par|varios|varias|muchos|muchas|algunos|algunas|bastantes|más o menos unos)(?![\p{L}])/iu;

// Is Spark's wording safe to show?
//  - Allowlist: every number must carry a unit we know, and that exact number + unit pair must be in
//    our facts ("18 by 24 meters", "24 yards", "wait 3 days" all fail: no known unit). Number words,
//    vague quantities and money fail. Spanish decimal commas ("0,56") fail (no unit on the "0").
//  - On a verdict task the verdict sentence is ours, prepended by the caller; Spark's text must use no
//    verdict word, negation or comparison (either language). Elsewhere the headline's main number and
//    unit must be there. Short plain text only.
export function checkWording(text, facts, headline = '', { task = facts?.task } = {}) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (t.length > 700) return { ok: false, reason: 'too long' };
  if (/[*#`|]|^\s*[-•]/m.test(t)) return { ok: false, reason: 'formatting' };
  const factText = factLines(facts);
  const allowed = new Set(numbersIn(factText));
  const bad = numbersIn(t).filter((n) => !allowed.has(n));
  if (bad.length) return { ok: false, reason: `numbers not ours: ${[...new Set(bad)].join(', ')}` };
  const factPairs = new Set(numberUnits(factText).map((p) => `${p.n} ${p.unit}`));
  const pairs = numberUnits(t);
  const noUnit = pairs.filter((p) => !p.unit);
  if (noUnit.length) return { ok: false, reason: `number without a unit we know: ${[...new Set(noUnit.map((p) => p.n))].join(', ')}` };
  const wrongUnit = pairs.filter((p) => !factPairs.has(`${p.n} ${p.unit}`));
  if (wrongUnit.length) return { ok: false, reason: `unit not ours: ${[...new Set(wrongUnit.map((p) => `${p.n} ${UNIT_NAME[p.unit]}`))].join(', ')}` };
  const factWords = new Set([...factText.matchAll(NUMBER_WORDS)].map((m) => m[0].toLowerCase()));
  // "cubetas de cinco galones" is how Spanish says the facts' "five-gallon pails".
  const tWords = /five[- ]gallon/i.test(factText) ? t.replace(/cubetas?\s+de\s+cinco\s+galones/gi, 'pails') : t;
  const badWords = [...tWords.matchAll(NUMBER_WORDS)].map((m) => m[0].toLowerCase()).filter((w) => !factWords.has(w));
  if (badWords.length) return { ok: false, reason: `number words not ours: ${[...new Set(badWords)].join(', ')}` };
  const vague = t.match(VAGUE);
  if (vague) return { ok: false, reason: `vague quantity: ${vague[0]}` };
  if (/\$|€|£|\b(?:usd|dollars?|bucks|d[oó]lares|pesos|cents?)\b/i.test(t) && !/\$|€|£/.test(factText)) return { ok: false, reason: 'money' };
  if (VERDICT_TASKS.has(task) || verdictOf(headline)) {
    const w = verdictWordIn(t);
    if (w) return { ok: false, reason: `verdict word “${w}” (the verdict sentence is ours)` };
    if (verdictOf(headline)) return { ok: true }; // our verdict sentence carries the main number
  }
  const main = numberUnits(headline)[0];
  if (main) {
    if (!pairs.some((p) => p.n === main.n)) return { ok: false, reason: 'left out the main number' };
    if (main.unit && !pairs.some((p) => p.n === main.n && p.unit === main.unit)) return { ok: false, reason: `main number without its unit (${UNIT_NAME[main.unit]})` };
  }
  return { ok: true };
}
const UNIT_NAME = { sqft: 'sq ft', sqin: 'sq in', pail: 'pails', gallon: 'gallons', tiles: 'tiles', mm: 'mm', cm: 'cm', in: 'in', ft: 'ft', pct: '%', men: 'men’s', women: 'women’s', eu: 'EU', us: 'US', hour: 'hours', degF: '°F', photos: 'photos' };

export function wordingFacts(r) {
  // On a verdict task Spark gets only material without verdict words, so it has nothing to flip.
  const clean = VERDICT_TASKS.has(r.task) ? (list) => list.filter((x) => !verdictWordIn(x)) : (list) => list;
  return {
    task: r.task,
    headline: r.headline,
    ...(r.verdictSentence ? { first_sentence_already_written: r.verdictSentence } : { template_answer: r.answer }),
    numbers: (r.numbers || []).map((n) => `${n.label}: ${n.value}`),
    what_to_buy: clean((r.shopping || []).slice(0, 3)),
    next_steps: clean((r.steps || []).slice(0, 3)),
    measured_against: r.measuredAgainst || null,
    confidence: r.confidence,
    tip: r.ask && !(VERDICT_TASKS.has(r.task) && verdictWordIn(r.ask)) ? r.ask : null,
  };
}

export const WORD_PROMPT_LOCKED = `
The first sentence, with the verdict, is already written (first_sentence_already_written) and is sent before your text. Write only 1 or 2 short sentences that come after it: the most useful next step. Do not repeat, restate or comment on the verdict. Do not use the words repair, replace, fix, fit, tight, room, glass or windshield, any negation (not, no, never, don't, won't) or any comparison (than, too, under, over), in English or Spanish.`;

async function wordAnswer(r, live, pipeline, timeoutMs = WORD_TIMEOUT_MS) {
  const facts = wordingFacts(r);
  const lang = r.read?.language === 'es' ? 'es' : 'en';
  r.answerTemplate = r.answer;
  r.wording = 'template';
  const t0 = performance.now();
  const step = { model: 'muse-spark-1.3', step: lang === 'es' ? 'word the answer in Spanish from our numbers' : 'word the answer from our numbers' };
  const ms = () => Math.round(performance.now() - t0);
  let timer;
  try {
    const text = await Promise.race([
      live.word(WORD_PROMPT + (r.verdictSentence ? WORD_PROMPT_LOCKED : '') + (lang === 'es' ? WORD_PROMPT_ES : ''), JSON.stringify(facts)),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no reply in ${timeoutMs / 1000} s`)), timeoutMs); }),
    ]);
    let check = checkWording(text, facts, r.headline, { task: r.task });
    // The "en español" label must be true: Spark's text has to be in the language we asked for.
    const wrote = detectLanguage(text);
    if (check.ok && wrote !== lang) check = { ok: false, reason: `written in ${wrote === 'es' ? 'Spanish' : 'English'}, not ${lang === 'es' ? 'Spanish' : 'English'}` };
    if (check.ok) {
      // The verdict sentence is ours, always first (in the customer's language); Spark's text follows it.
      const verdict = r.verdictSentence && (lang === 'es' ? es(r.verdictSentence) : r.verdictSentence);
      r.answer = verdict ? `${verdict} ${String(text).trim()}` : String(text).trim();
      r.wording = 'spark';
      r.language = wrote;
      pipeline.add({ ...step, ms: ms(), result: { used: true, numbersChecked: numbersIn(text).length, language: wrote } });
    } else {
      pipeline.add({ ...step, ms: ms(), result: { used: false, fellBack: check.reason === 'empty' ? 'Spark returned no text' : check.reason } });
    }
  } catch (e) {
    pipeline.add({ ...step, ms: ms(), error: String(e.message).slice(0, 200), result: { used: false, fellBack: friendlyError(e.message) } });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Muse Spark checks SAM's work ----------
//
// Before a number goes out, Spark looks at the photo with SAM's outlines drawn on it (and a close-up
// of each) and says whether each outline is what we think it is. If it isn't, the customer gets a
// specific retake tip instead of a wrong number. If Spark is slow or fails, we say so and measure
// without the check.

export const CHECK_TIMEOUT_MS = 10000;
const ROLE_WORD = { MAGENTA: 'measured', ORANGE: 'ruler', BLUE: 'other side' };
const ROLE_PHRASE = { magenta: 'outline of the thing to measure', orange: 'outline of the ruler', blue: 'outline of the other side' };
const uncolor = (t) => String(t || '').replace(/\b(magenta|orange|blue)(?: outline)?\b/gi, (_, c) => ROLE_PHRASE[c.toLowerCase()]);
const COLOR_OF = COLOR_NAMES;

export const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    outlines: { type: 'array', items: { type: 'object', properties: { color: { type: 'string' }, ok: { type: 'boolean' }, seen: { type: 'string' }, better_phrase: { type: 'string' }, point_x: { type: 'number' }, point_y: { type: 'number' } }, required: ['color', 'ok', 'seen', 'better_phrase', 'point_x', 'point_y'], additionalProperties: false } },
    problem: { type: 'string' },
    retake_tip: { type: 'string' },
  },
  required: ['outlines', 'problem', 'retake_tip'],
  additionalProperties: false,
};

export function checkPrompt(items, withCrops, { drawn = true, frame = null } = {}) {
  const lines = items.map((it) => `- ${COLOR_OF[it.role]} outline: should be ${it.expect}.`).join('\n');
  const b = (o) => `x ${Math.round(o.box.x1)} to ${Math.round(o.box.x2)}, y ${Math.round(o.box.y1)} to ${Math.round(o.box.y2)}`;
  const pics = drawn
    ? `Image 1 is the photo with the outlines drawn on it.${withCrops ? ' The next images are close-ups of each outline, in this order: ' + items.map((it) => COLOR_OF[it.role]).join(', ') + '.' : ''}`
    : `Image 1 is the customer's photo, with nothing drawn on it. The outlines are given as boxes, in pixels of a ${frame?.w || '?'} × ${frame?.h || '?'} grid laid over the photo (x from the left edge, y from the top):\n${items.map((it) => `- ${COLOR_OF[it.role]} box: ${b(it.obj)}`).join('\n')}`;
  return `You check another model's work before First Answer sends someone a measurement. Meta SAM 3.1 outlined objects in the customer's photo; our geometry will measure the first one using the ${COLOR_NAMES.ruler} one as a ruler of known size.
${pics}
${lines}
For each outline, in that order, return color, ok (true only if the outline really is that thing, mostly whole, not a different object, not a reflection or a picture of it), and seen (a short phrase naming what is actually inside it; for a coin, name the coin).
If an outline is wrong and you can see the right thing in the photo, help SAM find it: better_phrase is a short noun phrase for it (2 to 5 words, like "small chip in windshield" or "concrete driveway", no commands, no numbers), and point_x, point_y mark one spot clearly on the right thing, as fractions of Image 1's width and height (0 to 1, from the top left). If the outline is right, or the right thing isn't in the photo, better_phrase is "" and point_x and point_y are -1.
problem: one short sentence on what is wrong, or "" if every outline is right.
retake_tip: if something is wrong, one short sentence telling the person how to retake the photo; else "". Never write numbers or measurements.`;
}

// Spark's fix for a wrong outline, if it gave a usable one: a short phrase (letters only) and/or a point
// inside the photo. A wrong coin is not "fixed" here: the coin's size changes, so the person is asked.
export function fixFrom(outlines, got) {
  const i = outlines.findIndex((o) => !o.ok);
  if (i < 0) return null;
  const bad = outlines[i], g = got[i] || {};
  if (bad.role === 'ruler' && FLAT_REFERENCES[bad.ruler]?.shape === 'circle') return null;
  const words = String(g.better_phrase || '').trim().toLowerCase();
  const phrase = /^[\p{L} '’-]{2,40}$/u.test(words) && words.split(/\s+/).length <= 5 && !/\b(?:segment|find|outline|show|the photo)\b/.test(words) ? words : null;
  const x = Number(g.point_x), y = Number(g.point_y);
  const point = x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  return phrase || point ? { role: bad.role, phrase, point } : null;
}

async function checkOutlines({ dataUrl, live, check, pipeline, timeoutMs = CHECK_TIMEOUT_MS, final = false, label = null }) {
  const items = check.items.filter((it) => it.obj);
  if (!items.length) return null;
  const t0 = performance.now();
  const step = { model: 'muse-spark-1.3', step: label ? `${label}: check SAM’s outlines on the photo` : 'check SAM’s outlines on the photo' };
  let timer, images = [];
  try {
    // The timeout starts now and covers drawing the outlines (in a worker thread) as well as Spark's reply.
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no reply in ${timeoutMs / 1000} s`)), timeoutMs); });
    const ask = async () => {
      const pics = await checkImagesAsync(dataUrl, items.map((it) => ({ role: it.role, obj: it.obj })), check.frame, { timeoutMs: Math.min(4000, timeoutMs) });
      if (pics?.thumb) check.thumb = pics.thumb;
      images = pics ? [pics.overlay, ...pics.crops.map((c) => c.url)] : [dataUrl];
      return live.check(images, checkPrompt(items, Boolean(pics?.crops?.length), { drawn: Boolean(pics), frame: check.frame }), CHECK_SCHEMA);
    };
    const ans = await Promise.race([ask(), timeout]);
    const got = Array.isArray(ans?.outlines) ? ans.outlines : [];
    const outlines = items.map((it, i) => ({ color: COLOR_OF[it.role], ok: got[i]?.ok !== false, seen: String(got[i]?.seen || '').slice(0, 60) || 'something else', role: it.role, ruler: it.ruler, name: it.name }));
    const agreed = got.length >= items.length && outlines.every((o) => o.ok);
    const problem = String(ans?.problem || '').slice(0, 160);
    const fix = agreed || final ? null : fixFrom(outlines, got);
    pipeline.add({ ...step, ms: Math.round(performance.now() - t0), result: { check: agreed ? 'agrees' : 'disagrees', outlines: outlines.map(({ color, ok, seen }) => ({ color, ok, seen })), problem: agreed ? '' : problem, images: images.length, fix: fix ? (fix.phrase || 'a point') : null } });
    if (agreed) return { agreed: true, outlines };
    return { agreed: false, tip: retakeTip(outlines, ans?.retake_tip, label), fix, outlines };
  } catch (e) {
    pipeline.add({ ...step, ms: Math.round(performance.now() - t0), error: String(e.message).slice(0, 200), result: { check: 'skipped', why: friendlyError(e.message) } });
    return { skipped: true };
  } finally {
    clearTimeout(timer);
  }
}

// The retake tip the customer sees. A wrong coin gets the fix in their words ("it's a dime");
// Spark's own tip is used only if it is short and has no numbers in it.
function retakeTip(outlines, sparkTip, label = null) {
  const bad = outlines.find((o) => !o.ok) || outlines[0];
  const coin = bad.role === 'ruler' && FLAT_REFERENCES[bad.ruler]?.shape === 'circle' ? coinFromText(bad.seen.toLowerCase()) : null;
  if (coin && coin !== bad.ruler) return `Muse Spark says the coin looks like a ${rulerLabel(coin)}, not a ${rulerLabel(bad.ruler)}, so I didn’t measure. If it is, send the photo again and say “it’s a ${rulerLabel(coin)}”.`;
  const tip = String(sparkTip || '').trim();
  const own = tip && tip.length <= 200 && !/\d/.test(tip) ? tip : `Retake ${label ? 'that one' : 'it'} with ${bad.name} whole, in focus and near the middle of the shot.`;
  // For a multi-photo floor the tip names the photo ("in photo 2 of 3, ...").
  return `I didn’t measure this one: ${label ? `in ${label}, ` : ''}Muse Spark checked SAM’s ${ROLE_PHRASE[bad.color.toLowerCase()]} and saw ${bad.seen}, not ${bad.name}. ${uncolor(own)}`;
}

// A failed call in a few plain words for the public panel; raw upstream bodies never reach the page.
export function friendlyError(msg) {
  const m = String(msg?.message ?? msg ?? '');
  const t = m.match(/no reply in ([\d.]+) s/);
  if (t) return `no reply in ${t[1]} s`;
  if (/returned no text/i.test(m)) return 'Spark returned no text (its whole token budget went to thinking)';
  if (/daily (?:limit|cap)|budget/i.test(m)) return 'today’s limit of Meta calls is used up';
  if (/\b429\b|rate limit/i.test(m)) return 'Meta was busy (rate limited)';
  if (/\b(?:401|403)\b|unauthori[sz]ed|api key/i.test(m)) return 'Meta turned the request away';
  if (/timed? ?out|timeout|aborted|ETIMEDOUT/i.test(m)) return 'timed out';
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|socket/i.test(m)) return 'couldn’t connect';
  const code = m.match(/\b(5\d\d)\b/);
  if (code) return `Meta’s server had a hiccup (${code[1]})`;
  if (/\b4\d\d\b/.test(m)) return 'Meta couldn’t use that request';
  if (/JSON|Unexpected token|parse/i.test(m)) return 'unexpected reply';
  return 'unexpected error';
}

// One short line per step for the "How Meta's models measured it" panel.
export function stepDetail(s) {
  if (s.error && !s.result) return `failed: ${friendlyError(s.error)}`;
  const r = s.result;
  if (!r) return '';
  if (Array.isArray(r.objects)) return r.objects.map((o) => `${o.concept}: ${o.count} outline${o.count === 1 ? '' : 's'}${o.conf != null ? ` (conf ${o.conf.toFixed(2)})` : ''}`).join(' · ');
  if ('used' in r && /^not sent/.test(r.fellBack || '')) return r.fellBack;
  if ('used' in r) return r.used ? `used${r.language === 'es' ? ' (Spanish)' : ''}; ${r.numbersChecked} number${r.numbersChecked === 1 ? '' : 's'} checked against ours` : `kept our template (${r.fellBack})`;
  if ('check' in r) {
    if (r.check === 'skipped') return `check skipped (${r.why}); measured without it`;
    // The page draws its own colors, so the panel names each outline by its role, not the color Spark saw.
    const seen = (r.outlines || []).map((o) => `${ROLE_WORD[o.color] || o.color.toLowerCase()}: ${o.seen}`).join(', ');
    const what = uncolor(r.problem).replace(/[\s.!?;,]+$/, '') || seen;
    if (r.check === 'agrees') return `agrees · ${seen}`;
    return r.fix ? `disagrees · ${what}; Spark told SAM what to look for${r.fix === 'a point' ? ' (a point)' : `: “${r.fix}”`}` : `disagrees · ${what}; no number sent`;
  }
  if (r.withheld) return r.why === 'retake' ? 'measured, but not sent: a photo needs a retake' : 'measured, but not sent: Spark disagreed with the outlines';
  if (r.corrected === false) return `nothing new from SAM (${r.why}); no number sent`;
  if (r.combined === false) return `not combined: ${r.photo ? `photo ${r.photo} ${r.why}` : /^photos/.test(r.why) ? r.why : `the union ${r.why}`}${r.gapMm ? ` (${Math.round(r.gapMm / 304.8 * 10) / 10} ft away)` : ''}; best single photo used`;
  if (r.task && r.ruler) return `task: ${r.task.replace(/_/g, ' ')} · target: ${r.target} · ruler: ${rulerLabel(r.ruler)}${r.language === 'es' ? ' · language: Spanish' : ''}`;
  const NAMED = { plusMinusPct: 'accuracy', overFt: 'distance along the ground (ft)', sqftSeen: 'floor seen (sq ft)', turned: 'turned 180°', fill: 'fills a rectangle', pairOverlap: 'photos overlap', openFloorSqft: 'open floor (sq ft)', farWallErrorIn: 'far wall error from the sheet’s corners (in)' };
  const pretty = (k) => NAMED[k] || k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s?Mm2\b/, ' mm²').replace(/\s?Mm\b/, ' mm').replace(/\s?Ft\b/, ' ft').replace(/\s?In2\b/, ' sq in').replace(/\s?Pct\b/, ' %').toLowerCase();
  const keep = Object.entries(r).filter(([k, v]) => !['ok', 'notes', 'reason', 'clipped'].includes(k) && v != null && ['number', 'string', 'boolean'].includes(typeof v));
  return keep.slice(0, 5).map(([k, v]) => `${pretty(k)}: ${typeof v === 'number' ? (k.endsWith('Pct') ? `±${Math.round(v * 100)}%` : Math.round(v * 100) / 100) : v}`).join(' · ');
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const rulerLabel = (k) => FLAT_REFERENCES[k]?.label || UPRIGHT[k]?.label || k;

// SAM didn't answer: say why in words a person can act on.
const samDown = (e) => (e?.name === 'MetaBudgetError' ? DAILY_CAP_MESSAGE : 'Couldn’t reach Meta SAM 3.1 just now; tap Retry.');

// A refused answer shows no number anywhere: not in the steps (our math's results are withheld),
// not on the photo (no measurement lines or labels), only SAM's outlines and the retake tip.
function refuse(r, pipeline, tip) {
  for (const p of pipeline) if (p.model === 'first-answer math' && p.result) { p.result = { withheld: true }; delete p.error; }
  const overlay = r.overlay ? { ...r.overlay, lines: [] } : null;
  const overlays = r.overlays ? r.overlays.map((o) => ({ ...o, lines: [] })) : undefined;
  return { ...finishErr(r.read, pipeline, tip, r.task, overlay), ...(overlays ? { overlays } : {}), refused: 'spark-check', checked: 'disagreed' };
}

function finish(r) {
  return { ok: true, note: null, business: null, ...r };
}
function finishErr(read, pipeline, ask, task = null, overlay = null) {
  const retry = /tap Retry/.test(ask);
  return { ok: false, retry, task: task || read?.task, read, ask, overlay, pipeline, headline: null, answer: null, numbers: [], shopping: [], steps: [], confidence: 'low' };
}
