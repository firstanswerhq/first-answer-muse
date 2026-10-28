// First Answer Sight ("See it. Size it. Solve it."): one photo and one line of text in, an exact answer out.
//
//   1. Muse Spark reads the photo and the message: what is being asked (shoe size? will it fit?
//      repair or replace?), what to measure, and which everyday ruler is in the shot.
//   2. SAM 3.1 outlines the thing and the ruler (in parallel).
//   3. Our math turns pixels into inches: flat.js for things lying flat next to the ruler,
//      distance.js for ground distances and heights.
//   4. The answer comes back as a number, what to buy and what to do, plus the outlines to draw.

import { hasKey, sparkReadPhoto, samSegment } from './muse.js';
import { measureFlat, FLAT_REFERENCES, maskBoundary } from './flat.js';
import { best } from './measure.js';
import { calibrate, gapBetween, heightOf, distanceTo, contactPoints, fitCheck, ftIn, UPRIGHT } from './distance.js';
import { plan as tilePlan } from './tiles.js';
import { measureFace, faceLabel, NOTE as FACE_NOTE } from './face.js';
import { decodeMaskToSVGPath } from '@meta-sam/parser';

export const TASKS = ['face', 'floor_tile', 'windshield_chip', 'shoe_size', 'gap_fit', 'height', 'distance', 'size'];
const RULERS = ['quarter', 'penny', 'nickel', 'dime', 'ca_quarter', 'ca_dime', 'ca_nickel', 'loonie', 'toonie', 'euro_1', 'euro_2', 'uk_pound', 'uk_2p', 'card', 'paper_letter', 'dollar', 'soda_can', 'license_plate', 'interior_door', 'front_door', 'double_garage_door', 'single_garage_door', 'none'];
const UPRIGHT_CONCEPT = { interior_door: 'door', front_door: 'front door', double_garage_door: 'garage door', single_garage_door: 'garage door' };

const READ_PROMPT = `You read photos people text to First Answer to get something measured. Return JSON only.
task: what they want —
  face (a face with a card held to the forehead: proportions, symmetry),
  floor_tile (a floor to tile: how much tile, what cuts),
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
    summary: { type: 'string' },
  },
  required: ['task', 'target', 'second_target', 'ruler', 'item_width_in', 'tile_w_in', 'tile_l_in', 'shoe_for', 'summary'],
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
  const notFace = /face ?mask|face ?shield|face ?plate|face ?frame|eye ?bolt|thermometer|eye[- ]level|eye height|from (?:the |my )?(?:monitor|screen|face)|eye doctor/.test(t);
  if (!notFace && (/\b(?:my|your|her|his|their|kid'?s|son'?s|daughter'?s)\s+(?:face|eyes?|forehead|pupils?|pd|nose|mouth)\b|between (?:my |the |your |her |his )?eyes|eye (?:spacing|distance)|\bpupils?\b|pupillary|\bipd\b|p\.d\.|\bpd measurement|face symmetr|^\s*(?:measure|what(?:'s| is))\s+my\s+pd\b/.test(t)
    || /symmetr/.test(t) && /\b(?:my|your) (?:face|eyes)\b/.test(t))) task = 'face';
  else if (/shoe|foot|feet size|what size am i/.test(t)) task = 'shoe_size';
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
    _num: num,
  };
}

const DEFAULT_TARGET = { floor_tile: 'floor', windshield_chip: 'chip', shoe_size: 'foot', gap_fit: 'fence', face: 'face', height: 'tree', distance: 'tree', size: 'object' };
const DEFAULT_RULER = { floor_tile: 'paper_letter', windshield_chip: 'quarter', shoe_size: 'paper_letter', gap_fit: 'interior_door', face: 'card', height: 'interior_door', distance: 'interior_door', size: 'card' };

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

// ---------- pictures for the page ----------

function outlineOf(obj, label, role) {
  if (!obj?.mask) return obj ? { label, role, box: obj.box } : null;
  try { return { label, role, path: decodeMaskToSVGPath(obj.mask), box: obj.box, w: obj.mask.width, h: obj.mask.height }; } catch { return { label, role, box: obj.box }; }
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

/**
 * measureAnything({ dataUrl, text, focal35, deps })
 *   deps (for tests): { read(dataUrl, prompt, schema) -> json, segment(dataUrl, concept) -> { objects, frame } }
 */
export async function measureAnything({ dataUrl, text = '', focal35 = null, deps = null }) {
  const pipeline = [];
  const live = deps || (hasKey() ? { read: (d, p, s) => sparkReadPhoto({ dataUrl: d, prompt: p, schema: s }), segment: (d, c) => samSegment({ dataUrl: d, concept: c }) } : null);
  const guess = guessFromText(text);

  // 1. Read the photo and the message.
  let read;
  if (live) {
    try {
      read = await live.read(dataUrl, READ_PROMPT + (text ? `\nTheir message: "${text}"` : ''), READ_SCHEMA);
      pipeline.push({ model: 'muse-spark-1.3', step: 'read the photo and the question', result: read });
    } catch (e) {
      pipeline.push({ model: 'muse-spark-1.3', step: 'read the photo and the question', error: String(e.message).slice(0, 200) });
    }
  }
  if (!read) read = { task: guess.task, target: DEFAULT_TARGET[guess.task], second_target: guess.task === 'gap_fit' ? 'house wall' : '', ruler: DEFAULT_RULER[guess.task], item_width_in: guess.item_width_in, tile_w_in: guess.tile_w_in, tile_l_in: guess.tile_l_in, shoe_for: guess.shoe_for, summary: '' };
  // The person's own words win on numbers they typed.
  if (guess.item_width_in) read.item_width_in = guess.item_width_in;
  if (guess.tile_w_in) { read.tile_w_in = guess.tile_w_in; read.tile_l_in = guess.tile_l_in; }
  if (guess.coin) read.ruler = guess.coin; // "it's a quarter" corrects the coin
  if (read.ruler === 'none') read.ruler = DEFAULT_RULER[read.task];

  if (!live) return finishErr(read, pipeline, 'Measuring needs the Meta models switched on for this server.');
  if (read.task === 'face') return faceFlow({ dataUrl, live, read, pipeline, focal35 });

  // 2. Outline the target(s) and the ruler at the same time.
  const upright = Boolean(UPRIGHT_CONCEPT[read.ruler]);
  const rulerConcept = upright ? UPRIGHT_CONCEPT[read.ruler] : FLAT_REFERENCES[read.ruler]?.samConcept || 'card';
  const concepts = [read.target || DEFAULT_TARGET[read.task], rulerConcept];
  if (read.task === 'gap_fit') concepts.push(read.second_target || 'house wall');
  let segs;
  try {
    segs = await Promise.all(concepts.map((c) => live.segment(dataUrl, c)));
  } catch (e) {
    pipeline.push({ model: 'sam-3.1', step: 'outline', error: String(e.message).slice(0, 200) });
    return finishErr(read, pipeline, 'Couldn’t outline the photo just now; please send it again.');
  }
  const [tSeg, rSeg, bSeg] = segs;
  const frame = tSeg.frame || rSeg.frame || bSeg?.frame;
  const target = best(tSeg.objects), ruler = best(rSeg.objects), other = bSeg ? best(bSeg.objects) : null;
  pipeline.push({ model: 'sam-3.1', step: `outline: ${concepts.join(', ')}`, result: { [concepts[0]]: tSeg.objects.length, [concepts[1]]: rSeg.objects.length, ...(bSeg ? { [concepts[2]]: bSeg.objects.length } : {}) } });

  const outlines = [outlineOf(target, concepts[0], 'target'), outlineOf(ruler, rulerLabel(read.ruler), 'ruler'), other && outlineOf(other, concepts[2], 'target')].filter(Boolean);
  const overlay = { frame, outlines, lines: [] };
  const base = { task: read.task, read, overlay, pipeline };

  // 3. Measure.
  if (['gap_fit', 'height', 'distance'].includes(read.task)) {
    if (!target) return finishErr(read, pipeline, `I couldn’t find the ${concepts[0]} in that photo. Try again with it in the middle of the shot.`, null, overlay);
    const cal = calibrate({ frame, focal35, ref: upright ? ruler : null, refKind: upright ? read.ruler : null, groundLines: [contactPoints(target, frame), ...(other ? [contactPoints(other, frame)] : [])] });
    pipeline.push({ model: 'first-answer math', step: 'set up the camera from the photo', result: { how: cal.how, confidence: cal.confidence, cameraHeightFt: cal.primary && +cal.primary.height.toFixed(1), notes: cal.notes } });
    if (!cal.ok) return finishErr(read, pipeline, cal.ask, null, overlay);
    if (read.task === 'gap_fit') {
      if (!other) return finishErr(read, pipeline, `I found the ${concepts[0]} but not the ${concepts[2]}. Step back so both are in the shot.`, null, overlay);
      const g = gapBetween(target, other, cal, frame);
      pipeline.push({ model: 'first-answer math', step: 'measure the gap', result: g });
      if (!g.ok) return finishErr(read, pipeline, `I couldn’t see where both sides meet the ground. ${g.reason}.`, null, overlay);
      const itemFt = read.item_width_in ? read.item_width_in / 12 : null;
      const fit = itemFt ? fitCheck({ gap: g.tightest, itemFt }) : null;
      return finish({
        ...base,
        headline: fit ? cap(fit.verdict) : `${ftIn(g.tightest.ft)} at the narrowest`,
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
    pipeline.push({ model: 'first-answer math', step: read.task === 'height' ? 'measure the height' : 'measure the distance', result: m });
    if (!m.ok) return finishErr(read, pipeline, m.reason, null, overlay);
    return finish({
      ...base,
      headline: ftIn(m.ft),
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
  pipeline.push({ model: 'first-answer math', step: `measure against the ${FLAT_REFERENCES[refKind].label}`, result: m });
  if (!m.ok) return finishErr(read, pipeline, m.reason, null, overlay);
  const line = longestLine(target);

  if (read.task === 'shoe_size') {
    const s = shoeSize(m.lengthMm, read.shoe_for);
    const ratio = m.widthMm / m.lengthMm;
    // Feret width of a foot ≈ ball width; area/length underestimates it, so use the outline's spread.
    const widthWord = ratio < 0.33 ? 'narrow' : ratio > 0.4 ? 'wide' : 'regular';
    if (line) overlay.lines.push({ ...line, label: inchStr(m.lengthMm) });
    return finish({
      ...base,
      headline: `Size ${s.pick}`,
      answer: `Your foot is ${inchStr(m.lengthMm)} long (${(m.lengthMm / 10).toFixed(1)} cm). That’s a US ${s.pick}, about EU ${s.eu}.`,
      numbers: [{ label: 'Foot length', value: `${inchStr(m.lengthMm)} · ${(m.lengthMm / 10).toFixed(1)} cm` }, { label: 'US men’s', value: String(s.men) }, { label: 'US women’s', value: String(s.women) }, { label: 'EU', value: String(s.eu) }],
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
      answer: v.text,
      numbers: [{ label: v.kind === 'crack' ? 'Crack length' : 'Chip size', value: inchStr(m.lengthMm) }, { label: 'Repair limit', value: v.kind === 'crack' ? '6 in' : '1 in (a quarter)' }],
      shopping: v.repair ? ['Windshield chip repair (many insurers cover it — check your policy)'] : ['Windshield replacement'],
      steps: v.repair ? ['Put clear tape over it to keep dirt out.', 'Skip the car wash and blasting the defroster until it’s fixed.', 'Get it repaired soon — chips spread with heat and bumps.'] : ['Get two quotes; ask if your insurance covers glass.', 'If your car has lane or collision cameras, ask about recalibration.'],
      confidence: m.confidence, ask: m.notes.length ? m.notes.join('; ') : null,
    });
  }

  if (read.task === 'floor_tile') {
    // A room is a rectangle: its long and short sides, not the corner-to-corner diagonal.
    const roomL = (m.rectLengthMm || m.lengthMm) / 25.4, roomW = (m.rectWidthMm || m.areaMm2 / m.lengthMm) / 25.4;
    const tw = read.tile_w_in || 12, tl = read.tile_l_in || read.tile_w_in || 12;
    const p = tilePlan({ roomW, roomL, tileW: tw, tileL: tl });
    pipeline.push({ model: 'first-answer math', step: 'tile layout and cut list', result: { buyTiles: p.buyTiles, cuts: p.cuts?.length } });
    if (line) overlay.lines.push({ ...line, label: ftIn(roomL / 12) });
    return finish({
      ...base,
      headline: `Buy ${p.buyTiles} tiles`,
      answer: `The floor is about ${ftIn(roomW / 12)} by ${ftIn(roomL / 12)} (${p.room.sqft} sq ft). In ${tw} × ${tl} in tile that’s ${p.tilesForFloor} tiles laid, plus ${p.extraPct}% extra for cuts and mistakes: buy ${p.buyTiles}.`,
      numbers: [{ label: 'Floor', value: `${ftIn(roomW / 12)} × ${ftIn(roomL / 12)}` }, { label: 'Area', value: `${p.room.sqft} sq ft` }, { label: 'Full tiles', value: String(p.fullTiles) }, { label: 'Buy', value: `${p.buyTiles} tiles (+${p.extraPct}%)` }],
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
      answer: `${cap(concepts[0])}: ${inchStr(m.rectLengthMm)} × ${inchStr(m.rectWidthMm)} (${(m.rectLengthMm / 10).toFixed(1)} × ${(m.rectWidthMm / 10).toFixed(1)} cm), measured against the ${m.ruler}.`,
      numbers: [{ label: 'Long side', value: `${inchStr(m.rectLengthMm)} · ${(m.rectLengthMm / 10).toFixed(1)} cm` }, { label: 'Short side', value: `${inchStr(m.rectWidthMm)} · ${(m.rectWidthMm / 10).toFixed(1)} cm` }, { label: 'Area', value: `${m.areaIn2} sq in` }],
      shopping: [], steps: ['Send the same shot again later to see if it changed.'],
      confidence: m.confidence, ask: tips,
    });
  }
  if (line) overlay.lines.push({ ...line, label: inchStr(m.lengthMm) });
  return finish({
    ...base,
    headline: `${inchStr(m.lengthMm)} long`,
    answer: `${cap(concepts[0])}: ${inchStr(m.lengthMm)} long, about ${inchStr(m.widthMm)} wide, ${m.areaIn2} sq in, measured against the ${m.ruler}.`,
    numbers: [{ label: 'Length', value: `${inchStr(m.lengthMm)} · ${(m.lengthMm / 10).toFixed(1)} cm` }, { label: 'Width', value: inchStr(m.widthMm) }, { label: 'Area', value: `${m.areaIn2} sq in` }],
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
    pipeline.push({ model: 'sam-3.1', step: 'outline the face', error: String(e.message).slice(0, 200) });
    return finishErr(read, pipeline, 'Couldn’t outline the photo just now; please send it again.', 'face');
  }
  const [cardS, eyeS, noseS, mouthS] = segs;
  const frame = cardS.frame || eyeS.frame || noseS.frame;
  const card = best(cardS.objects), nose = best(noseS.objects), mouth = best(mouthS.objects);
  // Every 'eye' SAM returns (maybe eyebrows or glasses too); face.js picks the real pair by shape and position.
  const eyes = eyeS.objects.filter((o) => o.c == null || o.c >= 0.3).sort((a, b) => (b.c ?? 1) - (a.c ?? 1)).slice(0, 8);
  pipeline.push({ model: 'sam-3.1', step: 'outline: card, eyes, nose, mouth', result: { card: cardS.objects.length, eyes: eyeS.objects.length, nose: noseS.objects.length, mouth: mouthS.objects.length } });
  const overlay = { frame, outlines: [outlineOf(card, 'gift card', 'ruler')].filter(Boolean), lines: [] };
  const f = measureFace({ card, eyes, nose, mouth, frame, focal35 });
  pipeline.push({ model: 'first-answer math', step: 'scale the face with the card', result: f.ok ? { confidence: f.confidence, phoneDistanceMm: f.distanceMm, headTurnDeg: f.yawDeg } : f.ask });
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
    task: 'face', read, overlay, pipeline,
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

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const rulerLabel = (k) => FLAT_REFERENCES[k]?.label || UPRIGHT[k]?.label || k;

function finish(r) {
  return { ok: true, note: null, ...r };
}
function finishErr(read, pipeline, ask, task = null, overlay = null) {
  return { ok: false, task: task || read?.task, read, ask, overlay, pipeline, headline: null, answer: null, numbers: [], shopping: [], steps: [], confidence: 'low' };
}
