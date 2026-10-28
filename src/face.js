// Face measuring from one selfie with a gift card held flat on the forehead.
//
// How it stays honest on a real, curved face:
//  - Scale from the card's LENGTH. The card's long sides give millimeters per pixel. A forehead that
//    slopes back, or a phone tipped up or down, shortens the card's short sides but barely its long
//    ones, so the scale holds. (The card's full perspective is used only for the quality checks.)
//  - Depth. Eyes sit ~12 mm behind the forehead, the nose wings ~8, the mouth ~20, so from arm's
//    length they look a little smaller. Phone distance comes from the card's size in the photo, and
//    each feature is corrected for its typical depth.
//  - Pose. The card turns with the head: if its left and right ends look different sizes, the head is
//    turned. That decides whether a left-right comparison is trustworthy; it is never confused with
//    the face's own shape.
//  - The card itself. Its corners are found from straight-line fits to its edges, so a rounded corner
//    or a small fingertip nick doesn't shift the scale; a covered edge or a bigger nick is refused.
//  - Wrong picks. SAM's "eye" can include eyebrows or glasses; the eye pair is chosen by shape and
//    position, and glasses get a polite retake request.
// Accuracy from one photo: eye spacing about ±5%; nose and mouth are rough (about ±8%, they depend on
// typical depths). Measures only; never a diagnosis.

import { decodeMaskToRaster } from '@meta-sam/parser';
import { maskPoints, maskBoundary, rectCorners, focalPxFor } from './flat.js';

export const NOTE = 'Measurements only, not a medical opinion.';
const CARD = { long: 85.6, short: 53.98 };
const DEPTH = { eye: 12, nose: 8, mouth: 20 };
const DEG = Math.PI / 180;
const mm0 = (x) => (x == null ? null : Math.round(x));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const dotp = (a, b) => a[0] * b[0] + a[1] * b[1];

function centroid(pts) {
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  return [sx / pts.length, sy / pts.length];
}
function extent(pts, u) {
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { const a = dotp(p, u); if (a < lo) lo = a; if (a > hi) hi = a; }
  return hi - lo;
}

// Straight line through points (total least squares): { p, d }.
function fitLine(pts) {
  const [mx, my] = centroid(pts);
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: [mx, my], d: [Math.cos(a), Math.sin(a)] };
}
function intersect(L1, L2) {
  const den = L1.d[0] * L2.d[1] - L1.d[1] * L2.d[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((L2.p[0] - L1.p[0]) * L2.d[1] - (L2.p[1] - L1.p[1]) * L2.d[0]) / den;
  return [L1.p[0] + t * L1.d[0], L1.p[1] + t * L1.d[1]];
}

// The card, measured: refined corners, scale, pose, and whether it can be trusted.
export function cardGeometry(card) {
  const { pts } = maskPoints(card, 40000);
  const rough = rectCorners(pts);
  if (!rough) return { ok: false, why: 'not found' };
  const boundary = maskBoundary(card);
  // Fit each edge from its middle 60%, then intersect neighbors for true corners.
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const A = rough[i], B = rough[(i + 1) % 4];
    const L = len(sub(B, A)), u = unit(sub(B, A)), nrm = [-u[1], u[0]];
    const tol = Math.max(3, 0.04 * L);
    const near = boundary.filter((p) => { const q = sub(p, A); const t = dotp(q, u) / L; return t > 0.2 && t < 0.8 && Math.abs(dotp(q, nrm)) < tol; });
    if (near.length < 6) return { ok: false, why: 'edges unclear' };
    lines.push(fitLine(near));
  }
  const c = [0, 1, 2, 3].map((i) => intersect(lines[(i + 3) % 4], lines[i]));
  if (c.some((p) => !p)) return { ok: false, why: 'edges unclear' };
  const sides = [0, 1, 2, 3].map((i) => len(sub(c[(i + 1) % 4], c[i])));
  const longFirst = sides[0] + sides[2] >= sides[1] + sides[3];
  const [l1, l2] = longFirst ? [sides[0], sides[2]] : [sides[1], sides[3]];
  const [s1, s2] = longFirst ? [sides[1], sides[3]] : [sides[0], sides[2]];
  const longPx = (l1 + l2) / 2;
  const mmPerPx = CARD.long / longPx;
  // Long-axis direction (average of the two long sides, pointing the same way) and the card center.
  const la = longFirst ? [sub(c[1], c[0]), sub(c[2], c[3])] : [sub(c[2], c[1]), sub(c[3], c[0])];
  const longDir = unit([la[0][0] + la[1][0], la[0][1] + la[1][1]]);
  const center = centroid(c);
  // A corner pulled in by a fingertip or a crop shows up as a gap between the edge-line corner and the outline.
  const cornerGapMm = Math.max(...c.map((p, i) => len(sub(p, rough[i])))) * mmPerPx;
  // Edges covered? Sample a thin band just inside each edge.
  const raster = card.mask ? decodeMaskToRaster(card.mask) : null;
  let inside = 0, total = 0;
  if (raster) {
    const { box, mask } = card;
    const sx = mask.width / (box.x2 - box.x1 + 1), sy = mask.height / (box.y2 - box.y1 + 1);
    const inset = 0.05 * Math.min(s1, s2);
    for (let i = 0; i < 4; i++) {
      const A = c[i], B = c[(i + 1) % 4];
      const toC = unit(sub(center, A));
      for (let k = 1; k < 20; k++) {
        const t = k / 20;
        const p = [A[0] + (B[0] - A[0]) * t + toC[0] * inset, A[1] + (B[1] - A[1]) * t + toC[1] * inset];
        const col = Math.floor((p[0] - box.x1) * sx), row = Math.floor((p[1] - box.y1) * sy);
        total++;
        if (col >= 0 && row >= 0 && col < mask.width && row < mask.height && raster[row * mask.width + col]) inside++;
      }
    }
  }
  return {
    ok: true, corners: c, longPx, mmPerPx, longDir, center,
    shortPx: (s1 + s2) / 2,
    aspect: longPx / ((s1 + s2) / 2),
    turnRatio: Math.max(s1, s2) / Math.min(s1, s2),
    tipRatio: Math.max(l1, l2) / Math.min(l1, l2),
    cornerGapMm,
    edgeCover: total ? inside / total : 1,
  };
}

// Pick the two real eyes among SAM's "eye" objects by shape and position.
export function pickEyes(candidates, g, kEye = 1) {
  const s = g.mmPerPx * kEye;
  const across = [-g.longDir[1], g.longDir[0]];
  const halfShortMm = CARD.short / 2;
  const feats = candidates.map((o) => {
    const { pts } = maskPoints(o, 6000);
    if (pts.length < 6) return null;
    const c = centroid(pts);
    const w = extent(pts, g.longDir) * s, h = extent(pts, across) * s;
    const off = dotp(sub(c, g.center), across) * g.mmPerPx; // signed distance from the card's center line
    return { obj: o, px: c, w, h, aspect: w / Math.max(h, 0.1), off };
  }).filter(Boolean);
  const glassesLike = feats.some((f) => f.aspect < 1.7 && f.w >= 35);
  const ok = feats.filter((f) => f.aspect >= 1.7 && f.aspect <= 5.2 && f.w > 15 && f.w < 45 && Math.abs(f.off) > halfShortMm + 3);
  let best = null;
  for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) {
    const [a, b] = ok[i].px[0] <= ok[j].px[0] ? [ok[i], ok[j]] : [ok[j], ok[i]];
    if (Math.sign(a.off) !== Math.sign(b.off)) continue; // both on the same side of the card
    const v = sub(b.px, a.px);
    const sep = len(v) * s, wAvg = (a.w + b.w) / 2;
    const angle = Math.acos(Math.min(1, Math.abs(dotp(unit(v), g.longDir))));
    const level = Math.abs(a.off - b.off);
    const ratio = sep / wAvg;
    if (Math.abs(a.w - b.w) / wAvg > 0.3 || level > 0.25 * sep || angle > 25 * DEG || ratio < 1.6 || ratio > 2.8) continue;
    const score = Math.abs(ratio - 2.1) + Math.abs(a.w - b.w) / wAvg + level / sep;
    if (!best || score < best.score) best = { a, b, score };
  }
  return best ? { ...best, glassesLike } : { none: true, glassesLike };
}

/**
 * measureFace({ card, eyes, nose, mouth, frame, focal35 })
 * Returns { ok, numbers, symmetry, distanceMm, yawDeg, eyeCentersPx, eyeObjects, confidence, fixes, note } or { ok:false, ask }.
 */
export function measureFace({ card, eyes = [], nose, mouth, frame, focal35 = null }) {
  if (!card) return { ok: false, ask: 'Hold a gift card flat against your forehead, all four corners showing, and send one more.' };
  const g = cardGeometry(card);
  const CARD_ASK = 'Hold a standard gift card flat against your forehead with all four corners and edges showing (fingertip on the middle of the card, not its edge), face the camera straight on, and send one more.';
  if (!g.ok) return { ok: false, ask: CARD_ASK, card: g };
  const want = CARD.long / CARD.short;
  if (g.cornerGapMm > 4) return { ok: false, ask: 'A corner of the card looks covered. ' + CARD_ASK, card: g };
  if (g.edgeCover < 0.97) return { ok: false, ask: 'An edge of the card looks covered or cut off. ' + CARD_ASK, card: g };
  if (g.aspect < want * 0.9 || g.aspect > want * 1.18) return { ok: false, ask: CARD_ASK, card: g };

  const f = focalPxFor(frame, focal35);
  const D = f ? (f * CARD.long) / g.longPx : null;
  const k = (d) => (D ? (D + d) / D : 1);
  // Head turn (left/right) and phone tip (up/down) from the card's ends: ratio ≈ 1 + length·sin(angle)/D.
  const yawDeg = D ? Math.asin(Math.min(1, ((g.turnRatio - 1) * D) / CARD.long)) / DEG : null;
  const tipDeg = D ? Math.asin(Math.min(1, ((g.tipRatio - 1) * D) / CARD.short)) / DEG : null;
  if (yawDeg != null && yawDeg > 20) return { ok: false, ask: 'Face the camera straight on and send one more.' };

  const pair = pickEyes(eyes, g, k(DEPTH.eye));
  if (pair.none) {
    return { ok: false, ask: pair.glassesLike ? 'If you’re wearing glasses, take them off and send one more.' : 'I couldn’t find both eyes clearly. Face the camera straight on in good light and send one more.' };
  }
  const s = g.mmPerPx;
  const eyeVec = sub(pair.b.px, pair.a.px);
  const ue = unit(eyeVec); // the face's own horizontal
  const ipd = len(eyeVec) * s * k(DEPTH.eye);
  if (ipd < 45 || ipd > 80) return { ok: false, ask: 'The sizes came out unusual. Make sure it’s a standard gift card flat on your forehead, and send one more.' };
  const widthOf = (obj, d) => {
    if (!obj) return null;
    const { pts } = maskPoints(obj, 6000);
    return pts.length < 6 ? null : { c: centroid(pts), w: extent(pts, ue) * s * k(d) };
  };
  const noseF = widthOf(nose, DEPTH.nose), mouthF = widthOf(mouth, DEPTH.mouth);
  const numbers = {
    eyeCenterDistanceMm: mm0(ipd),
    leftEyeWidthMm: mm0(pair.a.w),
    rightEyeWidthMm: mm0(pair.b.w),
    noseWidthMm: noseF ? mm0(noseF.w) : null,
    mouthWidthMm: mouthF ? mm0(mouthF.w) : null,
  };

  const fixes = [];
  let confidence = 'good';
  if (yawDeg != null && yawDeg > 6) { confidence = 'low'; fixes.push('Your head looks turned a little: face the camera straight on and send one more.'); }
  if (tipDeg != null && tipDeg > 20) { confidence = 'low'; fixes.push('Hold the phone level with your eyes, not above or below.'); }
  if (!D) fixes.push('Phone distance unknown, so depth correction was skipped.');

  // Left-right comparison only from a straight-on photo with the nose in view; small differences are
  // within what one photo can show, so they're reported as "about the same".
  let symmetry = null;
  if (noseF && (yawDeg == null || yawDeg <= 2.5)) {
    const off = (p) => Math.abs(dotp(sub(p, noseF.c), ue)) * s * k(DEPTH.eye);
    const dL = off(pair.a.px), dR = off(pair.b.px);
    const diff = Math.abs(dL - dR), wDiff = Math.abs(pair.a.w - pair.b.w);
    symmetry = {
      leftEyeToMidlineMm: mm0(dL), rightEyeToMidlineMm: mm0(dR),
      midlineDifferenceMm: mm0(diff), eyeWidthDifferenceMm: mm0(wDiff),
      midlineSame: diff < 3.5, widthSame: wDiff < 3,
    };
  } else if (noseF) {
    fixes.push('For a left-right comparison, face the camera dead straight.');
  }
  return {
    ok: true, numbers, symmetry, confidence, fixes, note: NOTE, ruler: 'gift card',
    distanceMm: D ? mm0(D) : null,
    yawDeg: yawDeg == null ? null : Math.round(yawDeg * 10) / 10,
    eyeCentersPx: [pair.a.px, pair.b.px],
    eyeObjects: [pair.a.obj, pair.b.obj],
  };
}

/** Visit-to-visit comparison. Only compares photos taken from about the same distance;
 *  flags a change only when it's more than 3 mm and more than 5%. (Not wired to storage yet.) */
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
  noseWidthMm: 'Nose width (rough)',
  mouthWidthMm: 'Mouth width (rough)',
};
export const faceLabel = (key) => LABELS[key] || key;
