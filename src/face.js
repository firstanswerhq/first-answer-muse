// Face measuring from one selfie with a gift card held flat on the forehead.
//
// SAM outlines the card, the face, both eyes, the nose and the mouth. The card's four corners map
// the front plane of the face to true millimeters (the same perspective map used for every flat
// ruler), so tilt and turn of the phone are undone. The face isn't perfectly flat: the eyes sit a
// little behind the forehead, so numbers are close-range estimates (about ±4%).
//
// Measures only. Never a diagnosis. Every answer says so.

import { maskPoints, rulerMap, minRect } from './flat.js';

export const NOTE = 'Measurements only, not a medical opinion.';

// Centroid and the mapped size of one outlined feature.
function feature(obj, map) {
  if (!obj) return null;
  const { pts } = maskPoints(obj, 8000);
  if (pts.length < 5) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  const c = [sx / pts.length, sy / pts.length];
  const mm = pts.map(map.toMm);
  const r = minRect(mm);
  // width = left-to-right extent along the face's own horizontal, filled in below once we know it
  return { centerPx: c, center: map.toMm(c), mm, rect: r };
}

// Extent of points along a direction (unit vector), in mm.
function extent(mm, u) {
  let lo = Infinity, hi = -Infinity;
  for (const [x, y] of mm) { const a = x * u[0] + y * u[1]; if (a < lo) lo = a; if (a > hi) hi = a; }
  return hi - lo;
}

const r1 = (x) => Math.round(x * 10) / 10;

/**
 * measureFace({ card, face, eyes: [obj, obj], nose, mouth, refKind = 'card' })
 * Returns { ok, numbers: {...mm}, symmetry: {...}, confidence, fixes: [...], note }.
 */
export function measureFace({ card, face, eyes = [], nose, mouth, refKind = 'card' }) {
  const map = rulerMap(card, refKind);
  if (!map) return { ok: false, ask: 'Hold a gift card flat against your forehead, all four corners showing, and send one more.' };
  const eyeF = eyes.map((e) => feature(e, map)).filter(Boolean);
  if (eyeF.length < 2) return { ok: false, ask: 'I need both eyes in the shot: face the camera straight on, good light, and send one more.' };
  // Image left eye first (the person's right eye).
  eyeF.sort((a, b) => a.centerPx[0] - b.centerPx[0]);
  const [eL, eR] = eyeF;
  // The face's own horizontal: the line through the eye centers (undoes head roll).
  const dx = eR.center[0] - eL.center[0], dy = eR.center[1] - eL.center[1];
  const ipd = Math.hypot(dx, dy);
  const u = [dx / ipd, dy / ipd], v = [-u[1], u[0]];
  const width = (f) => (f ? extent(f.mm, u) : null);
  const height = (f) => (f ? extent(f.mm, v) : null);

  const noseF = feature(nose, map), mouthF = feature(mouth, map), faceF = feature(face, map);
  const eyeWL = width(eL), eyeWR = width(eR);
  const n = {
    eyeCenterDistanceMm: r1(ipd),
    leftEyeWidthMm: r1(eyeWL),
    rightEyeWidthMm: r1(eyeWR),
    noseWidthMm: noseF ? r1(width(noseF)) : null,
    mouthWidthMm: mouthF ? r1(width(mouthF)) : null,
    faceWidthMm: faceF ? r1(width(faceF)) : null,
    faceHeightMm: faceF ? r1(height(faceF)) : null,
  };

  // Symmetry: each eye's distance from the midline (through the nose, else the face center), and
  // the two eye widths. Percent = 100 minus the relative difference.
  const mid = noseF?.center || faceF?.center || [(eL.center[0] + eR.center[0]) / 2, (eL.center[1] + eR.center[1]) / 2];
  const off = (p) => Math.abs((p[0] - mid[0]) * u[0] + (p[1] - mid[1]) * u[1]);
  const dL = off(eL.center), dR = off(eR.center);
  const pct = (a, b) => Math.round(Math.max(0, 100 - (Math.abs(a - b) / ((a + b) / 2)) * 100));
  const symmetry = {
    eyeSpacingPct: pct(dL, dR),
    eyeWidthPct: pct(eyeWL, eyeWR),
    leftEyeFromMidlineMm: r1(dL),
    rightEyeFromMidlineMm: r1(dR),
  };
  symmetry.overallPct = Math.round((symmetry.eyeSpacingPct + symmetry.eyeWidthPct) / 2);

  // Is the photo usable? A turned head makes one eye look narrower and off-center.
  const fixes = [];
  let confidence = 'good';
  const ratio = eyeWL / eyeWR;
  if (ratio < 0.85 || ratio > 1.15 || symmetry.eyeSpacingPct < 80) {
    confidence = 'low';
    fixes.push('Your head looks turned: face the camera straight on, phone at eye level.');
  }
  if (map.shapeCheck && Math.abs(map.shapeCheck - map.R.long / map.R.short) / (map.R.long / map.R.short) > 0.35) {
    confidence = 'low';
    fixes.push('Hold the card flat against your forehead with all four corners showing.');
  }
  if (ipd < 40 || ipd > 85) {
    confidence = 'low';
    fixes.push('The sizes came out unusual; make sure the card is a standard gift card and sits flat on your forehead.');
  }
  return { ok: true, numbers: n, symmetry, confidence, fixes, note: NOTE, ruler: map.R.label };
}

/** Visit-to-visit comparison: change in mm and %, flagged when it moves more than 2 mm. */
export function compareVisits(prev, now) {
  const out = [];
  for (const [k, v] of Object.entries(now.numbers || {})) {
    const p = prev.numbers?.[k];
    if (v == null || p == null) continue;
    const d = r1(v - p);
    out.push({ measure: k, before: p, now: v, changeMm: d, changePct: r1((d / p) * 100), changed: Math.abs(d) > 2 });
  }
  return out;
}

const LABELS = {
  eyeCenterDistanceMm: 'Eye center to eye center',
  leftEyeWidthMm: 'Eye width (photo left)',
  rightEyeWidthMm: 'Eye width (photo right)',
  noseWidthMm: 'Nose width',
  mouthWidthMm: 'Mouth width',
  faceWidthMm: 'Face width',
  faceHeightMm: 'Face height',
};
export const faceLabel = (k) => LABELS[k] || k;
