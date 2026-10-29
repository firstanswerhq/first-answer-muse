// First Answer Sight ("See it. Size it. Solve it."): one photo and one line of text in, an exact answer out.
//
//   1. Muse Spark reads the photo and the message: what is being asked (shoe size? will it fit?
//      repair or replace?), what to measure, and which everyday ruler is in the shot.
//   2. SAM 3.1 outlines the thing and the ruler (in parallel).
//   3. Our math turns pixels into inches: flat.js for things lying flat next to the ruler,
//      distance.js for ground distances and heights.
//   4. The answer comes back as a number, what to buy and what to do, plus the outlines to draw.

import { hasKey, sparkReadPhoto, samSegment, sparkWrite, sparkCheck } from './muse.js';
import { checkImages, COLOR_NAMES } from './overlay.js';
import { DAILY_CAP_MESSAGE } from './guard.js';
import { measureFlat, FLAT_REFERENCES, maskBoundary } from './flat.js';
import { best, measureSurface, garageDoorKind, REFERENCES as SURFACE_REFERENCES } from './measure.js';
import { calibrate, gapBetween, heightOf, distanceTo, contactPoints, fitCheck, ftIn, UPRIGHT } from './distance.js';
import { plan as tilePlan } from './tiles.js';
import { measureFace, faceLabel, NOTE as FACE_NOTE } from './face.js';
import { decodeMaskToSVGPath } from '@meta-sam/parser';

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
const SURFACE_WORDS = /driveway|patio|concrete|slab|walkway|sidewalk|blacktop|asphalt|sealer|seal ?coat|pool deck|parking pad/;

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
  else if (SURFACE_WORDS.test(t) && !/\btiles?\b|tiling/.test(t)) task = 'surface_area';
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
const rangeIn = (mm, pm) => `${inchStr(Math.max(0, mm - pm))} – ${inchStr(mm + pm)}`;

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
 * measureAnything({ dataUrl, text, focal35, deps, onStep })
 *   deps (for tests): { read(dataUrl, prompt, schema) -> json, segment(dataUrl, concept) -> { objects, frame },
 *                       word?(system, facts) -> text, check?(images, prompt, schema) -> json }
 *   onStep(step): called as each step finishes (for live progress on the page).
 */
export async function measureAnything({ dataUrl, text = '', focal35 = null, deps = null, onStep = null, wordTimeoutMs = WORD_TIMEOUT_MS, checkTimeoutMs = CHECK_TIMEOUT_MS }) {
  const pipeline = makePipeline(onStep);
  const live = deps || (hasKey() ? {
    read: (d, p, s) => sparkReadPhoto({ dataUrl: d, prompt: p, schema: s }),
    segment: (d, c) => samSegment({ dataUrl: d, concept: c }),
    word: (system, facts) => sparkWrite({ system, facts, timeoutMs: WORD_TIMEOUT_MS }),
    check: (images, prompt, schema) => sparkCheck({ images, prompt, schema, timeoutMs: CHECK_TIMEOUT_MS }),
  } : null);
  const r = await measureCore({ dataUrl, text, focal35, live, pipeline });
  if (!r.ok) return r;
  // Muse Spark checks SAM's outlines while it words the answer (in parallel, to save time). If it
  // disagrees with what SAM outlined, no number goes out: the customer gets a specific retake tip.
  const [chk] = await Promise.all([
    live?.check && pipeline.check ? checkOutlines({ dataUrl, live, check: pipeline.check, pipeline, timeoutMs: checkTimeoutMs }) : null,
    live?.word ? wordAnswer(r, live, pipeline, wordTimeoutMs) : null,
  ]);
  if (chk) r.checked = chk.agreed ? 'agreed' : chk.skipped ? 'skipped' : 'disagreed';
  if (chk && chk.agreed === false) {
    // The wording ran alongside the check; it is not sent, and the panel says so.
    const w = pipeline.find((p) => /word the answer/.test(p.step));
    if (w) { w.result = { used: false, fellBack: 'not sent: Spark’s check disagreed' }; delete w.error; }
    return refuse(r, pipeline, chk.tip);
  }
  return r;
}

async function measureCore({ dataUrl, text, focal35, live, pipeline }) {
  const guess = guessFromText(text);

  // 1. Read the photo and the message.
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
  if (read.task !== 'surface_area' && read.task !== 'face' && (guess.task === 'surface_area' || (read.task === 'size' && SURFACE_WORDS.test(String(read.target).toLowerCase())))) {
    if (live) pipeline.add({ model: 'first-answer math', step: 'routed by the message to square feet', result: { from: read.task, to: 'surface area' } });
    read.task = 'surface_area';
    if (!SURFACE_WORDS.test(String(read.target).toLowerCase())) read.target = (String(text).toLowerCase().match(/driveway|patio|walkway|sidewalk|slab|pool deck|parking pad/) || ['driveway'])[0];
  }
  if (read.task === 'surface_area' && !SURFACE_REFERENCES[read.ruler]) read.ruler = 'double_garage_door';
  if (read.ruler === 'none') read.ruler = DEFAULT_RULER[read.task];

  if (!live) return finishErr(read, pipeline, 'Measuring needs the Meta models switched on for this server.');
  if (read.task === 'face') return faceFlow({ dataUrl, live, read, pipeline, focal35 });
  if (read.task === 'surface_area') return surfaceFlow({ dataUrl, live, read, pipeline, focal35, text });

  // 2. Outline the target(s) and the ruler at the same time.
  const upright = Boolean(UPRIGHT_CONCEPT[read.ruler]);
  const rulerConcept = upright ? UPRIGHT_CONCEPT[read.ruler] : FLAT_REFERENCES[read.ruler]?.samConcept || 'card';
  const concepts = [read.target || DEFAULT_TARGET[read.task], rulerConcept];
  if (read.task === 'gap_fit') concepts.push(read.second_target || 'house wall');
  let segs;
  try {
    segs = await Promise.all(concepts.map((c) => live.segment(dataUrl, c)));
  } catch (e) {
    pipeline.add({ model: 'sam-3.1', step: 'outline', error: String(e.message).slice(0, 200) });
    return finishErr(read, pipeline, samDown(e));
  }
  const [tSeg, rSeg, bSeg] = segs;
  const frame = tSeg.frame || rSeg.frame || bSeg?.frame;
  const target = best(tSeg.objects), ruler = best(rSeg.objects), other = bSeg ? best(bSeg.objects) : null;
  pipeline.add({ model: 'sam-3.1', step: `outline: ${concepts.join(', ')}`, result: samResult(concepts, segs) });

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
  const m = measureFlat({ target, ref: ruler, refKind });
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
      answer: `Your foot is ${inchStr(m.lengthMm)} long (${(m.lengthMm / 10).toFixed(1)} cm). That’s a US ${s.pick}, about EU ${s.eu}.`,
      numbers: [{ label: 'Foot length', value: `${inchStr(m.lengthMm)} · ${(m.lengthMm / 10).toFixed(1)} cm` }, { label: 'Range', value: `${rangeIn(m.lengthMm, pm)} (±${pmPct}%)` }, { label: 'US men’s', value: String(s.men) }, { label: 'US women’s', value: String(s.women) }, { label: 'EU', value: String(s.eu) }],
      shopping: [], steps: ['Measure both feet and go by the bigger one.', 'Feet swell a little by evening; measure then if you can.', 'Between sizes, go half a size up.'],
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
      numbers: [{ label: v.kind === 'crack' ? 'Crack length' : 'Chip size', value: inchStr(m.lengthMm) }, { label: 'Range', value: `${rangeIn(m.lengthMm, pm)} (±${pmPct}%)` }, { label: 'Repair limit', value: v.kind === 'crack' ? '6 in' : '1 in (a quarter)' }],
      shopping: v.repair ? ['Windshield chip repair (many insurers cover it — check your policy)'] : ['Windshield replacement'],
      steps: v.repair ? ['Put clear tape over it to keep dirt out.', 'Skip the car wash and blasting the defroster until it’s fixed.', 'Get it repaired soon — chips spread with heat and bumps.'] : ['Get two quotes; ask if your insurance covers glass.', 'If your car has lane or collision cameras, ask about recalibration.'],
      confidence: m.confidence,
      ask: [...m.notes, ...(Math.abs(m.lengthMm - (v.kind === 'crack' ? 152.4 : 25.4)) <= pm ? ['It’s within measuring error of the repair limit, so have a shop look before deciding.'] : [])].join('; ') || null,
    });
  }

  if (read.task === 'floor_tile') {
    // A room is a rectangle: its long and short sides, not the corner-to-corner diagonal.
    const roomL = (m.rectLengthMm || m.lengthMm) / 25.4, roomW = (m.rectWidthMm || m.areaMm2 / m.lengthMm) / 25.4;
    const tw = read.tile_w_in || 12, tl = read.tile_l_in || read.tile_w_in || 12;
    const p = tilePlan({ roomW, roomL, tileW: tw, tileL: tl });
    pipeline.add({ model: 'first-answer math', step: 'tile layout and cut list', result: { buyTiles: p.buyTiles, cuts: p.cuts?.length } });
    if (line) overlay.lines.push({ ...line, label: ftIn(roomL / 12) });
    return finish({
      ...base,
      headline: `Buy ${p.buyTiles} tiles`,
      business: {
        job: `Tile a ${ftIn(roomW / 12)} × ${ftIn(roomL / 12)} floor: ${p.room.sqft} sq ft`,
        materials: [`${p.buyTiles} tiles, ${tw} × ${tl} in`, 'Thinset, grout and spacers'],
        quote: `${p.room.sqft} sq ft × $X per sq ft installed (set by the business)`,
      },
      answer: `The floor is about ${ftIn(roomW / 12)} by ${ftIn(roomL / 12)} (${p.room.sqft} sq ft). In ${tw} × ${tl} in tile that’s ${p.tilesForFloor} tiles laid, plus ${p.extraPct}% extra for cuts and mistakes: buy ${p.buyTiles}.`,
      numbers: [{ label: 'Floor', value: `${ftIn(roomW / 12)} × ${ftIn(roomL / 12)}` }, { label: 'Area', value: `${p.room.sqft} sq ft` }, { label: 'Range', value: `${Math.round(p.room.sqft * (1 - 2 * m.plusMinusPct))} – ${Math.round(p.room.sqft * (1 + 2 * m.plusMinusPct))} sq ft (±${2 * pmPct}%)` }, { label: 'Full tiles', value: String(p.fullTiles) }, { label: 'Buy', value: `${p.buyTiles} tiles (+${p.extraPct}%)` }],
      shopping: [`${p.buyTiles} tiles, ${tw} × ${tl} in (same lot number on every box)`, 'Thinset mortar and a notched trowel (ask the store which notch fits your tile)', 'Grout and 1/8 in spacers', 'Tile cutter or wet saw'],
      steps: [`Start at the center of the room: ${p.layout.across} across, ${p.layout.along} along.`, ...p.cuts.map((c) => `${c.count} × ${c.what}: ${c.cut}.`), 'Tape-measure one wall before the first cut.'],
      confidence: m.confidence === 'good' ? 'fair' : m.confidence,
      ask: [...m.notes, 'Measured from one photo — check one wall with a tape before cutting.'].join(' '),
    });
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
  if (surface !== 'asphalt') out.push({ kind: 'concrete', qty: Math.ceil(sqftHigh / SEALER.concrete.perGallon), unit: 'gallon', text: `Concrete sealer: ${Math.ceil(sqftHigh / SEALER.concrete.perGallon)} gallons per coat (at about ${SEALER.concrete.perGallon} sq ft per gallon; labels say ${SEALER.concrete.labelRange})` });
  if (surface !== 'concrete') out.push({ kind: 'asphalt', qty: Math.ceil(sqftHigh / SEALER.asphalt.perPail), unit: 'five-gallon pail', text: `Asphalt sealer: ${Math.ceil(sqftHigh / SEALER.asphalt.perPail)} five-gallon pails per coat (at about ${SEALER.asphalt.perPail} sq ft per pail; labels say ${SEALER.asphalt.labelRange})` });
  return out;
}

// Driveway, patio, slab: SAM outlines the surface and the door; measure.js adds up real square feet
// row by row using the door's height as the ruler and the surface's edges for the horizon.
async function surfaceFlow({ dataUrl, live, read, pipeline, focal35, text }) {
  const front = read.ruler === 'front_door';
  const concepts = [read.target || 'driveway', front ? 'front door' : 'garage door'];
  let segs;
  try {
    segs = await Promise.all(concepts.map((c) => live.segment(dataUrl, c)));
  } catch (e) {
    pipeline.add({ model: 'sam-3.1', step: 'outline', error: String(e.message).slice(0, 200) });
    return finishErr(read, pipeline, samDown(e));
  }
  const [sSeg, dSeg] = segs;
  const frame = sSeg.frame || dSeg.frame;
  const surface = best(sSeg.objects), door = best(dSeg.objects);
  pipeline.add({ model: 'sam-3.1', step: `outline: ${concepts.join(', ')}`, result: samResult(concepts, segs) });
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
  const hfovDeg = focal35 && focal35 > 8 && focal35 < 300 ? (2 * Math.atan(18 / focal35) * 180) / Math.PI : 69;
  const m = measureSurface({ surface, ref: door, refKind, frame, hfovDeg });
  pipeline.add({ model: 'first-answer math', step: `square feet against the ${R.label}`, result: { sqft: m.sqft, low: m.low, high: m.high, method: m.method, confidence: m.confidence, cameraHeightFt: m.cameraHeightFt } });
  if (!m.ok) return finishErr(read, pipeline, `I couldn’t measure the ${concepts[0]} from that angle. Stand at the street end, straight on, with the whole ${concepts[0]} and the ${front ? 'door' : 'garage door'} in the shot.`, null, overlay);
  const t = String(text).toLowerCase();
  const kind = /asphalt|blacktop/.test(t) ? 'asphalt' : /concrete|slab|cement/.test(t) ? 'concrete' : 'unknown';
  const seal = sealerNeeded(m.high, kind);
  const fmt = (n) => n.toLocaleString('en-US');
  const sizeWords = m.widthFt && m.lengthFt ? ` (about ${m.widthFt} ft wide by ${m.lengthFt} ft long)` : '';
  const answer = `Your ${concepts[0]} is about ${fmt(m.sqft)} sq ft${sizeWords}, between ${fmt(m.low)} and ${fmt(m.high)} sq ft, measured against the ${R.label}. ${seal.length === 1 ? `Buy ${seal[0].qty} ${seal[0].qty === 1 ? seal[0].unit : `${seal[0].unit}s`} of ${seal[0].kind} sealer per coat.` : `That’s ${seal[0].qty} gallons of concrete sealer or ${seal[1].qty} five-gallon pails of asphalt sealer per coat.`}`;
  return finish({
    task: 'surface_area', read, overlay, pipeline, measuredAgainst: rulerSpec(refKind),
    headline: `About ${fmt(m.sqft)} sq ft`,
    business: {
      job: `${cap(concepts[0])}: about ${fmt(m.sqft)} sq ft (${fmt(m.low)} – ${fmt(m.high)})${m.widthFt && m.lengthFt ? `, ${m.widthFt} × ${m.lengthFt} ft` : ''}`,
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
    shopping: [...seal.map((x) => x.text), 'Buy for the high end of the range; return unopened extras'],
    steps: ['Clean it first: pressure wash and let it dry 24 hours.', 'Check the forecast: no rain for 24–48 hours, above 50°F.', 'Two thin coats beat one thick one; the second coat needs the same amount again.'],
    confidence: m.confidence,
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
Write the message in Spanish (plain Latin American Spanish, as you would text a customer). Keep every number exactly as in the facts, as digits, and write its unit in Spanish: sq ft = pies cuadrados, sq in = pulgadas cuadradas, gallons = galones, five-gallon pails = cubetas de cinco galones, in = pulgadas, ft = pies, tiles = baldosas, men’s = de hombre, women’s = de mujer, US stays EE. UU. before the number, EU stays EU before the number, mm and cm stay. A quarter (the coin) is "una moneda de un cuarto de dólar". Repair = reparar, replace = reemplazar, fits = cabe, won't fit = no cabe, tight = justo.`;

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
  ['in', /^\s*(?:in\b(?!\s+(?:the|a|an|your|tile|it|one|two)\b)|inch(?:es)?\b|"|″|pulgadas?\b)/i],
  ['ft', /^\s*(?:ft\b|feet\b|foot\b|'|′|pies?\b)/i],
  ['pct', /^\s*(?:%|percent\b|por\s*ciento\b)/i],
  ['hour', /^\s*(?:hours?\b|hrs?\b|horas?\b)/i],
  ['degF', /^\s*(?:°\s*F\b|degrees?\s+F(?:ahrenheit)?\b|grados?\s+F(?:ahrenheit)?\b)/i],
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
const UNIT_NAME = { sqft: 'sq ft', sqin: 'sq in', pail: 'pails', gallon: 'gallons', tiles: 'tiles', mm: 'mm', cm: 'cm', in: 'in', ft: 'ft', pct: '%', men: 'men’s', women: 'women’s', eu: 'EU', us: 'US', hour: 'hours', degF: '°F' };

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
    const check = checkWording(text, facts, r.headline, { task: r.task });
    if (check.ok) {
      // The verdict sentence is ours, always first; Spark's text follows it.
      r.answer = r.verdictSentence ? `${r.verdictSentence} ${String(text).trim()}` : String(text).trim();
      r.wording = 'spark';
      r.language = lang;
      pipeline.add({ ...step, ms: ms(), result: { used: true, numbersChecked: numbersIn(text).length, language: lang } });
    } else {
      pipeline.add({ ...step, ms: ms(), result: { used: false, fellBack: check.reason } });
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
    outlines: { type: 'array', items: { type: 'object', properties: { color: { type: 'string' }, ok: { type: 'boolean' }, seen: { type: 'string' } }, required: ['color', 'ok', 'seen'], additionalProperties: false } },
    problem: { type: 'string' },
    retake_tip: { type: 'string' },
  },
  required: ['outlines', 'problem', 'retake_tip'],
  additionalProperties: false,
};

export function checkPrompt(items, withCrops) {
  const lines = items.map((it) => `- ${COLOR_OF[it.role]} outline: should be ${it.expect}.`).join('\n');
  return `You check another model's work before First Answer sends someone a measurement. Meta SAM 3.1 outlined objects in the customer's photo; our geometry will measure the first one using the ${COLOR_NAMES.ruler} one as a ruler of known size.
Image 1 is the photo with the outlines drawn on it.${withCrops ? ' The next images are close-ups of each outline, in this order: ' + items.map((it) => COLOR_OF[it.role]).join(', ') + '.' : ''}
${lines}
For each outline, in that order, return color, ok (true only if the outline really is that thing, mostly whole, not a different object, not a reflection or a picture of it), and seen (a short phrase naming what is actually inside it; for a coin, name the coin).
problem: one short sentence on what is wrong, or "" if every outline is right.
retake_tip: if something is wrong, one short sentence telling the person how to retake the photo; else "". Never write numbers or measurements.`;
}

async function checkOutlines({ dataUrl, live, check, pipeline, timeoutMs = CHECK_TIMEOUT_MS }) {
  const items = check.items.filter((it) => it.obj);
  if (!items.length) return null;
  const t0 = performance.now();
  const step = { model: 'muse-spark-1.3', step: 'check SAM’s outlines on the photo' };
  let timer;
  try {
    const pics = checkImages(dataUrl, items.map((it) => ({ role: it.role, obj: it.obj })), check.frame);
    const images = pics ? [pics.overlay, ...pics.crops.map((c) => c.url)] : [dataUrl];
    const ans = await Promise.race([
      live.check(images, checkPrompt(items, Boolean(pics)), CHECK_SCHEMA),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no reply in ${timeoutMs / 1000} s`)), timeoutMs); }),
    ]);
    const got = Array.isArray(ans?.outlines) ? ans.outlines : [];
    const outlines = items.map((it, i) => ({ color: COLOR_OF[it.role], ok: got[i]?.ok !== false, seen: String(got[i]?.seen || '').slice(0, 60) || 'something else', role: it.role, ruler: it.ruler, name: it.name }));
    const agreed = got.length >= items.length && outlines.every((o) => o.ok);
    const problem = String(ans?.problem || '').slice(0, 160);
    pipeline.add({ ...step, ms: Math.round(performance.now() - t0), result: { check: agreed ? 'agrees' : 'disagrees', outlines: outlines.map(({ color, ok, seen }) => ({ color, ok, seen })), problem: agreed ? '' : problem, images: images.length } });
    if (agreed) return { agreed: true };
    return { agreed: false, tip: retakeTip(outlines, ans?.retake_tip) };
  } catch (e) {
    pipeline.add({ ...step, ms: Math.round(performance.now() - t0), error: String(e.message).slice(0, 200), result: { check: 'skipped', why: friendlyError(e.message) } });
    return { skipped: true };
  } finally {
    clearTimeout(timer);
  }
}

// The retake tip the customer sees. A wrong coin gets the fix in their words ("it's a dime");
// Spark's own tip is used only if it is short and has no numbers in it.
function retakeTip(outlines, sparkTip) {
  const bad = outlines.find((o) => !o.ok) || outlines[0];
  const coin = bad.role === 'ruler' && FLAT_REFERENCES[bad.ruler]?.shape === 'circle' ? coinFromText(bad.seen.toLowerCase()) : null;
  if (coin && coin !== bad.ruler) return `Muse Spark says the coin looks like a ${rulerLabel(coin)}, not a ${rulerLabel(bad.ruler)}, so I didn’t measure. If it is, send the photo again and say “it’s a ${rulerLabel(coin)}”.`;
  const tip = String(sparkTip || '').trim();
  const own = tip && tip.length <= 200 && !/\d/.test(tip) ? tip : `Retake it with ${bad.name} whole, in focus and near the middle of the shot.`;
  return `I didn’t measure this one: Muse Spark checked SAM’s ${ROLE_PHRASE[bad.color.toLowerCase()]} and saw ${bad.seen}, not ${bad.name}. ${uncolor(own)}`;
}

// A failed call in a few plain words for the public panel; raw upstream bodies never reach the page.
export function friendlyError(msg) {
  const m = String(msg?.message ?? msg ?? '');
  const t = m.match(/no reply in ([\d.]+) s/);
  if (t) return `no reply in ${t[1]} s`;
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
    return r.check === 'agrees' ? `agrees · ${seen}` : `disagrees · ${uncolor(r.problem).replace(/[\s.!?;,]+$/, '') || seen}; no number sent`;
  }
  if (r.withheld) return 'measured, but not sent: Spark disagreed with the outlines';
  if (r.task && r.ruler) return `task: ${r.task.replace(/_/g, ' ')} · target: ${r.target} · ruler: ${rulerLabel(r.ruler)}${r.language === 'es' ? ' · language: Spanish' : ''}`;
  const pretty = (k) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/Mm2\b/, ' mm²').replace(/Mm\b/, ' mm').replace(/Ft\b/, ' ft').replace(/In2\b/, ' sq in').replace(/Pct\b/, ' %').toLowerCase();
  const keep = Object.entries(r).filter(([k, v]) => !['ok', 'notes', 'reason', 'clipped'].includes(k) && v != null && ['number', 'string', 'boolean'].includes(typeof v));
  return keep.slice(0, 5).map(([k, v]) => `${pretty(k)}: ${typeof v === 'number' ? (k.endsWith('Pct') ? `±${Math.round(v * 100)}` : Math.round(v * 100) / 100) : v}`).join(' · ');
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
  return { ...finishErr(r.read, pipeline, tip, r.task, overlay), refused: 'spark-check', checked: 'disagreed' };
}

function finish(r) {
  return { ok: true, note: null, business: null, ...r };
}
function finishErr(read, pipeline, ask, task = null, overlay = null) {
  const retry = /tap Retry/.test(ask);
  return { ok: false, retry, task: task || read?.task, read, ask, overlay, pipeline, headline: null, answer: null, numbers: [], shopping: [], steps: [], confidence: 'low' };
}
