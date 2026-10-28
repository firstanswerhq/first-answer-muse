// Face measuring from one selfie with a gift card held flat on the forehead.
//
// SAM outlines the card, both eyes, the nose and the mouth. The card's four corners map the
// forehead plane to true millimeters. A face isn't flat, so three things are handled on purpose:
//  - Depth. The eyes sit ~12 mm behind the forehead, the mouth ~20 mm. Seen from arm's length they
//    look a few percent smaller than they are. We estimate how far the phone is from the card size
//    in the photo and correct each feature for its typical depth.
//  - Pose. The card turns with the head, so the card's own shape (its two short sides, its two long
//    sides) tells us if the head is turned or the phone tipped. A turned head gets a retake request;
//    an uneven face does not.
//  - Wrong picks. SAM's "eye" can come back as eyebrows or glasses lenses; the eye pair is chosen by
//    shape and position, and a card that is partly covered or cut off is refused, not trusted.
// Face outline width and height are not reported: hair, beards and ears make them unreliable.
// Accuracy: eye spacing about ±5% from one photo. Measures only; never a diagnosis.

import { maskPoints, rulerMap, focalPxFor } from './flat.js';

export const NOTE = 'Measurements only, not a medical opinion.';
const CARD = { long: 85.6, short: 53.98 };
const DEPTH = { eye: 12, nose: 8, mouth: 20 }; // typical depth behind the forehead plane, mm
const mm0 = (x) => (x == null ? null : Math.round(x));

function centroid(pts) {
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  return [sx / pts.length, sy / pts.length];
}
// Extent of points along a unit direction.
function extent(pts, u) {
  let lo = Infinity, hi = -Infinity;
  for (const [x, y] of pts) { const a = x * u[0] + y * u[1]; if (a < lo) lo = a; if (a > hi) hi = a; }
  return hi - lo;
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function polyArea(c) {
  let s = 0;
  for (let i = 0; i < c.length; i++) { const [x1, y1] = c[i], [x2, y2] = c[(i + 1) % c.length]; s += x1 * y2 - x2 * y1; }
  return Math.abs(s) / 2;
}

// Is the card fully visible, flat and undistorted? Returns { ok, why, longPx, turnRatio, tipRatio }.
export function checkCard(card, map) {
  const c = map.corners;
  if (!c || c.length !== 4) return { ok: false, why: 'card corners not found' };
  const sides = [0, 1, 2, 3].map((i) => dist(c[i], c[(i + 1) % 4]));
  const longFirst = sides[0] + sides[2] >= sides[1] + sides[3];
  const [l1, l2] = longFirst ? [sides[0], sides[2]] : [sides[1], sides[3]];
  const [s1, s2] = longFirst ? [sides[1], sides[3]] : [sides[0], sides[2]];
  const aspect = (l1 + l2) / (s1 + s2);
  const { pts, weight, pixelArea } = maskPoints(card, 40000);
  const fill = (pts.length * weight * pixelArea) / polyArea(c);
  const turnRatio = Math.max(s1, s2) / Math.min(s1, s2); // head turned left/right
  const tipRatio = Math.max(l1, l2) / Math.min(l1, l2); // phone tipped up/down
  const want = CARD.long / CARD.short;
  if (fill < 0.95) return { ok: false, why: 'card partly covered', fill };
  // A straight-on card at arm's length has opposite sides within a few percent of each other.
  // A corner hidden by a fingertip pulls the fitted outline in and breaks that, so refuse at 8%.
  if (Math.abs(aspect - want) / want > 0.08) return { ok: false, why: 'card shape off', aspect };
  if (turnRatio > 1.08 || tipRatio > 1.08) return { ok: false, why: 'card at a steep angle', turnRatio, tipRatio };
  return { ok: true, longPx: (l1 + l2) / 2, turnRatio, tipRatio, fill, aspect };
}

// Pick the two real eyes among SAM's "eye" objects by shape and position (in card millimeters).
export function pickEyes(candidates, map) {
  const feats = candidates.map((o) => {
    const { pts } = maskPoints(o, 6000);
    if (pts.length < 6) return null;
    const mm = pts.map(map.toMm);
    const w = extent(mm, [1, 0]), h = extent(mm, [0, 1]);
    return { obj: o, px: centroid(pts), c: centroid(mm), w, h, aspect: w / Math.max(h, 0.1) };
  }).filter((f) => f && f.aspect >= 1.7 && f.aspect <= 5.2 && f.w > 15 && f.w < 45);
  // The card spans 0..85.6 x 0..54 in card mm. Eyes sit outside it, on one side, below it.
  let best = null;
  for (let i = 0; i < feats.length; i++) for (let j = i + 1; j < feats.length; j++) {
    const [a, b] = feats[i].c[0] < feats[j].c[0] ? [feats[i], feats[j]] : [feats[j], feats[i]];
    const sep = dist(a.c, b.c), wAvg = (a.w + b.w) / 2;
    const sizeOk = Math.abs(a.w - b.w) / wAvg <= 0.3;
    const levelOk = Math.abs(a.c[1] - b.c[1]) <= 0.25 * sep;
    const angleOk = Math.abs(Math.atan2(b.c[1] - a.c[1], b.c[0] - a.c[0])) <= (25 * Math.PI) / 180;
    const ratio = sep / wAvg, ratioOk = ratio >= 1.6 && ratio <= 2.8;
    const outsideCard = (p) => p[1] < -3 || p[1] > CARD.short + 3;
    const sameSide = Math.sign(a.c[1] - CARD.short / 2) === Math.sign(b.c[1] - CARD.short / 2);
    if (!(sizeOk && levelOk && angleOk && ratioOk && outsideCard(a.c) && outsideCard(b.c) && sameSide)) continue;
    const score = Math.abs(ratio - 2.1) + Math.abs(a.w - b.w) / wAvg + Math.abs(a.c[1] - b.c[1]) / sep;
    if (!best || score < best.score) best = { a, b, sep, score };
  }
  return best;
}

/**
 * measureFace({ card, eyes, nose, mouth, frame, focal35 })
 * Returns { ok, numbers, symmetry, distanceMm, pose, eyeCentersPx, confidence, fixes, note } or { ok:false, ask }.
 */
export function measureFace({ card, eyes = [], nose, mouth, frame, focal35 = null, refKind = 'card' }) {
  const map = rulerMap(card, refKind);
  if (!map) return { ok: false, ask: 'Hold a gift card flat against your forehead, all four corners showing, and send one more.' };
  const cc = checkCard(card, map);
  if (!cc.ok) {
    const ask = cc.why === 'card partly covered'
      ? 'Part of the card is covered or cut off. Hold it with a fingertip on its face, not its edge, so all four corners show.'
      : 'Hold a standard gift card flat against your forehead with all four corners showing (fingertip on its face, not its edge), and face the camera straight on.';
    return { ok: false, ask, card: cc };
  }
  const pair = pickEyes(eyes, map);
  if (!pair) return { ok: false, ask: 'I couldn’t find both eyes clearly. Take off glasses, face the camera straight on in good light, and send one more.' };

  // Phone distance from the card's size in the photo: D = f * real / pixels.
  const f = focalPxFor(frame, focal35);
  const D = f ? (f * CARD.long) / cc.longPx : null;
  const k = (d) => (D ? (D + d) / D : 1); // depth correction for a feature d mm behind the card
  const u = [(pair.b.c[0] - pair.a.c[0]) / pair.sep, (pair.b.c[1] - pair.a.c[1]) / pair.sep]; // the face's horizontal

  const featureMm = (obj) => {
    if (!obj) return null;
    const { pts } = maskPoints(obj, 6000);
    if (pts.length < 6) return null;
    const mm = pts.map(map.toMm);
    return { c: centroid(mm), w: extent(mm, u) };
  };
  const noseF = featureMm(nose), mouthF = featureMm(mouth);
  const ipd = pair.sep * k(DEPTH.eye);
  const eyeWL = pair.a.w * k(DEPTH.eye), eyeWR = pair.b.w * k(DEPTH.eye);
  if (ipd < 45 || ipd > 80) return { ok: false, ask: 'The sizes came out unusual. Make sure it’s a standard gift card, flat on your forehead, and send one more.' };
  if (Math.max(eyeWL, eyeWR) > 0.6 * ipd) return { ok: false, ask: 'If you wear glasses, take them off and send one more.' };

  const numbers = {
    eyeCenterDistanceMm: mm0(ipd),
    leftEyeWidthMm: mm0(eyeWL),
    rightEyeWidthMm: mm0(eyeWR),
    noseWidthMm: noseF ? mm0(noseF.w * k(DEPTH.nose)) : null,
    mouthWidthMm: mouthF ? mm0(mouthF.w * k(DEPTH.mouth)) : null,
  };
  // Symmetry only when we have a true midline (the nose); reported as plain differences in mm.
  let symmetry = null;
  if (noseF) {
    const off = (p) => Math.abs((p[0] - noseF.c[0]) * u[0] + (p[1] - noseF.c[1]) * u[1]) * k(DEPTH.eye);
    const dL = off(pair.a.c), dR = off(pair.b.c);
    symmetry = { leftEyeToMidlineMm: mm0(dL), rightEyeToMidlineMm: mm0(dR), midlineDifferenceMm: mm0(Math.abs(dL - dR)), eyeWidthDifferenceMm: mm0(Math.abs(eyeWL - eyeWR)) };
  }

  // Pose from the card (turn and tip), separate from the face's own shape.
  const fixes = [];
  let confidence = 'good';
  if (cc.turnRatio > 1.035) { confidence = 'low'; fixes.push('Your head looks turned a little: face the camera straight on and send one more.'); }
  if (cc.tipRatio > 1.035) { confidence = 'low'; fixes.push('Hold the phone level with your eyes, not above or below.'); }
  if (!D) fixes.push('Phone distance unknown, so depth correction was skipped.');
  return {
    ok: true, numbers, symmetry, confidence, fixes, note: NOTE, ruler: map.R.label,
    distanceMm: D ? mm0(D) : null,
    pose: { turnRatio: +cc.turnRatio.toFixed(3), tipRatio: +cc.tipRatio.toFixed(3) },
    eyeCentersPx: [pair.a.px, pair.b.px],
  };
}

/** Visit-to-visit comparison. Only compares photos taken from about the same distance;
 *  flags a change only when it's more than 3 mm and more than 5%. */
export function compareVisits(prev, now) {
  if (prev.distanceMm && now.distanceMm && Math.abs(prev.distanceMm - now.distanceMm) / prev.distanceMm > 0.1) {
    return { ok: false, reason: 'The two photos were taken from different distances; retake at arm’s length to compare.' };
  }
  const rows = [];
  for (const [key, v] of Object.entries(now.numbers || {})) {
    const p = prev.numbers?.[key];
    if (v == null || p == null) continue;
    const d = v - p;
    rows.push({ measure: key, before: p, now: v, changeMm: d, changed: Math.abs(d) > Math.max(3, 0.05 * p) });
  }
  return { ok: true, rows };
}

const LABELS = {
  eyeCenterDistanceMm: 'Eye center to eye center',
  leftEyeWidthMm: 'Eye width (photo left)',
  rightEyeWidthMm: 'Eye width (photo right)',
  noseWidthMm: 'Nose width',
  mouthWidthMm: 'Mouth width',
};
export const faceLabel = (key) => LABELS[key] || key;
