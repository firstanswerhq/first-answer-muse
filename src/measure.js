// Measure a flat surface in a customer's photo (a driveway, a patio, a walkway) from one object of known size.
//
// The idea: a double garage door is 16 ft wide. SAM 3.1 outlines the door and the driveway.
// The door's width in pixels gives feet-per-pixel at the door. The driveway's edges get narrower
// toward the house, and where they would meet is the horizon. Door scale + horizon give the true
// scale on every row of the ground, so we add up the real square footage row by row.
//
// Assumptions, said out loud: the ground is flat, the reference sits on it, and the photo is from a
// phone's main camera (about 69 degrees across the long side). The crew confirms on site.

import { decodeMaskToRaster } from '@meta-sam/parser';

export const REFERENCES = {
  double_garage_door: { label: 'double garage door', widthFt: 16, heightFt: 7 },
  single_garage_door: { label: 'single garage door', widthFt: 9, heightFt: 7 },
  front_door: { label: 'front door', widthFt: 3, heightFt: 6.67 },
};

// A garage door's shape tells single from double: about 9x7 (1.3) vs 16x7 (2.3).
export function garageDoorKind(box) {
  const aspect = (box.x2 - box.x1) / Math.max(1, box.y2 - box.y1);
  return aspect >= 1.75 ? 'double_garage_door' : 'single_garage_door';
}

// The pick of several SAM objects: most confident, then biggest.
export function best(objects, minConfidence = 0.4) {
  const ok = objects.filter((o) => o.c == null || o.c >= minConfidence);
  return ok.sort((a, b) => (b.c ?? 1) - (a.c ?? 1) || b.areaShare - a.areaShare)[0] || null;
}

// Row widths of a SAM object's mask, in source pixels: [{ y, w }]. Rows of the raster span the box.
export function maskRows(obj) {
  const { box, mask } = obj;
  if (!mask) {
    // No mask: treat the box as the shape (rough).
    const rows = [];
    for (let y = box.y1; y <= box.y2; y++) rows.push({ y, w: box.x2 - box.x1 + 1, h: 1, left: box.x1, right: box.x2 + 1 });
    return rows;
  }
  const raster = decodeMaskToRaster(mask);
  const sx = (box.x2 - box.x1 + 1) / mask.width;
  const sy = (box.y2 - box.y1 + 1) / mask.height;
  const rows = [];
  for (let r = 0; r < mask.height; r++) {
    let n = 0, first = -1, last = -1;
    for (let c = 0, i = r * mask.width; c < mask.width; c++, i++) {
      if (raster[i]) { n++; if (first < 0) first = c; last = c; }
    }
    if (n > 0) rows.push({ y: box.y1 + (r + 0.5) * sy, w: n * sx, h: sy, left: box.x1 + first * sx, right: box.x1 + (last + 1) * sx });
  }
  return rows;
}

// Least-squares line w = a*y + b over the middle 80% of rows (the ends are ragged).
function fitWidth(rows) {
  const k = Math.floor(rows.length * 0.1);
  const mid = rows.slice(k, rows.length - k);
  const n = mid.length;
  if (n < 5) return null;
  let sy = 0, sw = 0, syy = 0, syw = 0;
  for (const { y, w } of mid) { sy += y; sw += w; syy += y * y; syw += y * w; }
  const a = (n * syw - sy * sw) / (n * syy - sy * sy);
  const b = (sw - a * sy) / n;
  let ss = 0, st = 0;
  const mean = sw / n;
  for (const { y, w } of mid) { ss += (w - (a * y + b)) ** 2; st += (w - mean) ** 2; }
  return { a, b, r2: st ? 1 - ss / st : 0 };
}

// The dominant straight line through points [y, x] (a driveway's long edge), ignoring the rest
// (the slanted near end, a flare at the street). Deterministic: tries pairs of evenly spaced points.
export function dominantLine(pts, tol = 3) {
  if (pts.length < 8) return null;
  const step = Math.max(1, Math.floor(pts.length / 40));
  const sample = pts.filter((_, i) => i % step === 0);
  let bestFit = null;
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 3; j < sample.length; j++) {
      const [y1, x1] = sample[i], [y2, x2] = sample[j];
      if (y2 === y1) continue;
      const a = (x2 - x1) / (y2 - y1), b = x1 - a * y1;
      let n = 0;
      for (const [y, x] of pts) if (Math.abs(x - (a * y + b)) <= tol) n++;
      if (!bestFit || n > bestFit.n) bestFit = { a, b, n };
    }
  }
  if (!bestFit) return null;
  // Refit on the inliers.
  const inl = pts.filter(([y, x]) => Math.abs(x - (bestFit.a * y + bestFit.b)) <= tol);
  const n = inl.length;
  let sy = 0, sx = 0, syy = 0, syx = 0;
  for (const [y, x] of inl) { sy += y; sx += x; syy += y * y; syx += y * x; }
  const den = n * syy - sy * sy;
  if (!den) return null;
  const a = (n * syx - sy * sx) / den, b = (sx - a * sy) / n;
  const ys = inl.map(([y]) => y);
  return { a, b, share: n / pts.length, span: Math.max(...ys) - Math.min(...ys) };
}

/**
 * surface: SAM object for the ground surface (driveway). ref: SAM object for the reference.
 * refKind: key of REFERENCES. frame: { w, h } of the photo. hfovDeg: camera field of view on the long side.
 * Returns { ok, sqft, low, high, widthFt, lengthFt, cameraHeightFt, method, confidence, reason }.
 */
export function measureSurface({ surface, ref, refKind, frame, hfovDeg = 69 }) {
  const R = REFERENCES[refKind];
  if (!surface || !ref || !R || !frame) return { ok: false, reason: 'need a surface, a reference and the photo size' };
  const refW = ref.box.x2 - ref.box.x1 + 1, refH = ref.box.y2 - ref.box.y1 + 1;
  if (refW < 12 || refH < 8) return { ok: false, reason: 'reference too small in the photo' };
  // Scale at the reference from its HEIGHT: a door's height doesn't shrink when the photo is taken at an angle.
  const sRef = R.heightFt / refH; // feet per pixel at the reference's distance
  const yRef = ref.box.y2; // the reference's base: where it meets the ground
  const rows = maskRows(surface).filter((r) => r.w >= 2);
  if (rows.length < 8) return { ok: false, reason: 'surface too small in the photo' };
  const pixelArea = rows.reduce((t, r) => t + r.w * r.h, 0);

  // The horizon: where the surface's two long edges meet. Points cut off by the photo's edge don't count.
  const leftPts = rows.filter((r) => r.left > 2).map((r) => [r.y, r.left]);
  const rightPts = rows.filter((r) => r.right < frame.w - 2).map((r) => [r.y, r.right]);
  const L = dominantLine(leftPts), Rt = dominantLine(rightPts);
  const span = rows[rows.length - 1].y - rows[0].y;
  const edgesOk = L && Rt && L.share > 0.3 && Rt.share > 0.3 && L.span > span * 0.3 && Rt.span > span * 0.3 && L.a - Rt.a < 0;
  let yH = null, how = '';
  if (edgesOk) {
    yH = (Rt.b - L.b) / (L.a - Rt.a);
    how = 'edges';
  } else {
    const whole = rows.filter((r) => r.left > 2 && r.right < frame.w - 2);
    const fit = fitWidth(whole);
    if (fit && fit.a > 0 && fit.r2 > 0.9) { yH = -fit.b / fit.a; how = 'width'; }
  }
  const perspectiveOk = yH != null && yH < yRef - 5 && yH < rows[0].y;

  if (!perspectiveOk) {
    // Overhead or unreadable angle: one scale for the whole surface, and we say it's rough.
    const sqft = pixelArea * sRef * sRef;
    return finish({ sqft, method: 'flat scale (no perspective found)', confidence: 'low', widthFt: null, lengthFt: null, cameraHeightFt: null, refKind, R });
  }

  const f = (0.5 * Math.max(frame.w, frame.h)) / Math.tan((hfovDeg * Math.PI) / 360);
  const scaleAt = (y) => (sRef * (yRef - yH)) / (y - yH); // feet per pixel on the ground at row y
  const edgeWidth = (y) => (edgesOk ? Rt.a * y + Rt.b - (L.a * y + L.b) : 0);
  let sqft = 0, clippedRows = 0;
  for (const r of rows) {
    const top = r.y - r.h / 2, bot = r.y + r.h / 2;
    if (top <= yH + 1) continue;
    const depth = f * (scaleAt(top) - scaleAt(bot)); // feet of ground this row covers, front to back
    const cut = r.left <= 2 || r.right >= frame.w - 2;
    if (cut) clippedRows++;
    const wPx = cut ? Math.max(r.w, edgeWidth(r.y)) : r.w; // the edges carry on past the photo
    sqft += wPx * scaleAt(r.y) * depth;
  }
  const far = rows[0], near = rows[rows.length - 1];
  const lengthFt = f * (scaleAt(far.y - far.h / 2) - scaleAt(near.y + near.h / 2));
  const widthFt = edgesOk ? median(rows.map((r) => edgeWidth(r.y) * scaleAt(r.y))) : median(rows.map((r) => r.w * scaleAt(r.y)));
  const cameraHeightFt = sRef * (yRef - yH);
  // Sanity: a phone is held 3-7 ft up, and the surface is wider than the door it leads to.
  const plausible = how === 'edges' && cameraHeightFt > 3 && cameraHeightFt < 8 && lengthFt > 5 && lengthFt < 250 && widthFt >= R.widthFt * 0.6 && widthFt < 80;
  const out = finish({ sqft, method: `perspective (horizon from ${how})`, confidence: plausible ? 'good' : 'low', widthFt, lengthFt, cameraHeightFt, refKind, R });
  out.clipped = clippedRows > rows.length * 0.1; // part of the surface runs out of the photo
  return out;
}

function finish({ sqft, method, confidence, widthFt, lengthFt, cameraHeightFt, refKind, R }) {
  const spread = confidence === 'good' ? 0.12 : 0.3;
  const r10 = (x) => Math.round(x / 10) * 10;
  const r1 = (x) => (x == null ? null : Math.round(x));
  return {
    ok: Number.isFinite(sqft) && sqft > 0,
    sqft: r10(sqft),
    low: r10(sqft * (1 - spread)),
    high: r10(sqft * (1 + spread)),
    widthFt: r1(widthFt),
    lengthFt: r1(lengthFt),
    cameraHeightFt: cameraHeightFt == null ? null : Math.round(cameraHeightFt * 10) / 10,
    method,
    confidence,
    reference: `${R.label} (${R.widthFt} ft wide)`,
    refKind,
  };
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
