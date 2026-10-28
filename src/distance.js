// Distance from one photo: how far apart two things are on the ground, how tall something is,
// and how far away something stands, with an honest range instead of a fake exact number.
//
// How it works. A phone photo is a pinhole camera held some height above flat ground, tipped
// down a little and maybe tilted sideways. Once we know (1) the lens (from the photo's own camera
// info, or a typical phone lens), (2) how far the camera is tipped down and (3) how high it is,
// every pixel on the ground maps to a real spot in feet. We get those from what is already in the
// picture:
//  - the tip-down angle from two lines that are parallel on the ground (a fence base and a house
//    wall base, the two edges of a sidewalk): where they meet in the photo is on the horizon;
//  - the camera height from an upright object of known height standing on the ground (a door,
//    a garage door);
//  - the sideways tilt from that object's vertical sides.
// When one of these is missing, we try every reasonable value (a phone is held 4-6 ft up) and the
// answer becomes a range. Sloppy photos widen the range; they don't produce a confident wrong number.

import { decodeMaskToRaster } from '@meta-sam/parser';

const DEG = Math.PI / 180;

// Upright references: their height is what we use (it doesn't change with the viewing angle).
export const UPRIGHT = {
  interior_door: { label: 'door', heightFt: 80 / 12, trust: 'standard' },
  front_door: { label: 'front door', heightFt: 80 / 12, trust: 'standard' },
  double_garage_door: { label: 'garage door', heightFt: 7, trust: 'standard' },
  single_garage_door: { label: 'garage door', heightFt: 7, trust: 'standard' },
  privacy_fence: { label: '6 ft privacy fence', heightFt: 6, trust: 'varies' },
  soda_can: { label: 'soda can', heightFt: 122.7 / 304.8, trust: 'exact' },
};

// ---------- the lens ----------

// Focal length in pixels. From the photo's camera info when present (35 mm equivalent focal length,
// defined on the diagonal), else a typical phone main camera (69 degrees across the long side).
export function focalPx({ w, h, focal35 = null, hfovDeg = 69 }) {
  if (focal35 && focal35 > 8 && focal35 < 300) return { fPx: (focal35 / 43.27) * Math.hypot(w, h), source: 'photo' };
  return { fPx: (0.5 * Math.max(w, h)) / Math.tan((hfovDeg * DEG) / 2), source: 'typical phone' };
}

// Minimal reader for the camera info inside a JPEG: 35 mm-equivalent focal length and orientation.
export function readExif(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return {};
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1], len = b.readUInt16BE(i + 2);
    if (marker === 0xe1 && b.toString('ascii', i + 4, i + 8) === 'Exif') return parseTiff(b, i + 10);
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return {};
}
function parseTiff(b, t) {
  const le = b.toString('ascii', t, t + 2) === 'II';
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const out = {};
  const ifd = (off, onTag) => {
    if (t + off + 2 > b.length) return;
    const n = u16(t + off);
    for (let k = 0; k < n; k++) {
      const e = t + off + 2 + k * 12;
      if (e + 12 > b.length) return;
      onTag(u16(e), u16(e + 2), e + 8);
    }
  };
  let exifOff = null;
  ifd(u32(t + 4), (tag, type, v) => {
    if (tag === 0x0112) out.orientation = u16(v);
    if (tag === 0x8769) exifOff = u32(v);
  });
  if (exifOff != null) {
    ifd(exifOff, (tag, type, v) => {
      if (tag === 0xa405) out.focal35 = u16(v);
      if (tag === 0x920a) { const o = t + u32(v); if (o + 8 <= b.length) out.focalMm = u32(o) / Math.max(1, u32(o + 4)); }
    });
  }
  return out;
}

// ---------- the camera ----------

/**
 * A camera at height `height` (ft) above flat ground, tipped down by `pitch` (radians) and tilted
 * sideways by `roll` (radians). Ground positions come back relative to the spot under the camera:
 * X to the right, Z straight ahead. Turning left or right doesn't change any distance, so it's left out.
 */
export function makeCamera({ w, h, fPx, pitch, height, roll = 0 }) {
  const cx = w / 2, cy = h / 2;
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  const fwd = [0, -sp, cp];
  const right0 = [1, 0, 0], down0 = [0, -cp, -sp];
  const right = right0.map((v, k) => v * cr + down0[k] * sr);
  const down = down0.map((v, k) => v * cr - right0[k] * sr);
  const ray = (u, v) => { const a = (u - cx) / fPx, c = (v - cy) / fPx; return [0, 1, 2].map((k) => fwd[k] + a * right[k] + c * down[k]); };
  const groundPoint = (u, v) => {
    const r = ray(u, v);
    if (r[1] >= -1e-6) return null; // at or above the horizon
    const s = height / -r[1];
    return { X: s * r[0], Z: s * r[2] };
  };
  const project = (X, Y, Z) => {
    const d = [X, Y - height, Z];
    const z = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
    if (z <= 1e-6) return null;
    const x = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
    const y = d[0] * down[0] + d[1] * down[1] + d[2] * down[2];
    return [cx + (fPx * x) / z, cy + (fPx * y) / z];
  };
  // Height of an upright thing whose base is at image point `base` and top at image point `top`.
  const heightAt = (base, top) => {
    const P = groundPoint(base[0], base[1]);
    if (!P) return null;
    const p0 = project(P.X, 0, P.Z);
    const p1 = project(P.X, 1, P.Z);
    if (!p0 || !p1) return null;
    const dir = [p1[0] - p0[0], p1[1] - p0[1]];
    const L = Math.hypot(...dir);
    const along = (pt) => ((pt[0] - p0[0]) * dir[0] + (pt[1] - p0[1]) * dir[1]) / L;
    const target = along(top);
    if (target <= 0) return 0;
    let lo = 0, hi = 1;
    while (hi < 1e4) { const q = project(P.X, hi, P.Z); if (!q || along(q) >= target) break; hi *= 2; }
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      const q = project(P.X, mid, P.Z);
      if (!q || along(q) > target) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  };
  return { w, h, fPx, pitch, height, roll, groundPoint, project, heightAt };
}

// The tip-down angle from a point on the horizon (a vanishing point of ground lines), given the roll.
export function pitchFromVanishing([vx, vy], { w, h, fPx, roll = 0 }) {
  const a = (vx - w / 2) / fPx, b = (vy - h / 2) / fPx;
  return Math.atan(-(a * Math.sin(roll) + b * Math.cos(roll)));
}

// ---------- reading SAM outlines ----------

function raster(obj) {
  const { box, mask } = obj;
  if (!mask) {
    const mw = box.x2 - box.x1 + 1, mh = box.y2 - box.y1 + 1;
    return { r: new Uint8Array(mw * mh).fill(1), mw, mh, sx: 1, sy: 1 };
  }
  return { r: decodeMaskToRaster(mask), mw: mask.width, mh: mask.height, sx: (box.x2 - box.x1 + 1) / mask.width, sy: (box.y2 - box.y1 + 1) / mask.height };
}

// Where an object meets the ground: the lowest outlined pixel in each column. Columns that run off
// the bottom of the photo are dropped (the real bottom isn't visible there).
export function contactPoints(obj, frame) {
  const { r, mw, mh, sx, sy } = raster(obj);
  const pts = [];
  for (let c = 0; c < mw; c++) {
    let last = -1;
    for (let k = mh - 1; k >= 0; k--) if (r[k * mw + c]) { last = k; break; }
    if (last < 0) continue;
    const x = obj.box.x1 + (c + 0.5) * sx, y = obj.box.y1 + (last + 1) * sy;
    if (y >= frame.h - 2) continue;
    pts.push([x, y]);
  }
  return pts;
}

// The vertical middle of an upright object: the middle of its bottom row and of its top row,
// and the tilt of its two sides (for the sideways roll).
export function uprightAxis(obj) {
  const { r, mw, mh, sx, sy } = raster(obj);
  const rows = [];
  for (let k = 0; k < mh; k++) {
    let first = -1, last = -1;
    for (let c = 0; c < mw; c++) if (r[k * mw + c]) { if (first < 0) first = c; last = c; }
    if (first >= 0) rows.push({ y: obj.box.y1 + (k + 0.5) * sy, left: obj.box.x1 + first * sx, right: obj.box.x1 + (last + 1) * sx });
  }
  if (rows.length < 4) return null;
  const top = rows[0], bot = rows[rows.length - 1];
  const sideFit = (key) => {
    const mid = rows.slice(Math.floor(rows.length * 0.1), Math.ceil(rows.length * 0.9));
    const n = mid.length;
    let sy2 = 0, sx2 = 0, syy = 0, syx = 0;
    for (const q of mid) { sy2 += q.y; sx2 += q[key]; syy += q.y * q.y; syx += q.y * q[key]; }
    const den = n * syy - sy2 * sy2;
    return den ? (n * syx - sy2 * sx2) / den : 0; // dx per dy
  };
  const lean = (Math.atan(sideFit('left')) + Math.atan(sideFit('right'))) / 2;
  return { base: [(bot.left + bot.right) / 2, bot.y + sy / 2], top: [(top.left + top.right) / 2, top.y - sy / 2], lean };
}

// A straight line through points that ignores stragglers. Returns { p: point on line, d: unit direction, share }.
export function robustLine(pts, tol = 3) {
  if (pts.length < 6) return null;
  const step = Math.max(1, Math.floor(pts.length / 40));
  const sample = pts.filter((_, i) => i % step === 0);
  let best = null;
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 2; j < sample.length; j++) {
      const [x1, y1] = sample[i], [x2, y2] = sample[j];
      const L = Math.hypot(x2 - x1, y2 - y1);
      if (L < 1e-9) continue;
      const n = [-(y2 - y1) / L, (x2 - x1) / L], d0 = n[0] * x1 + n[1] * y1;
      let k = 0;
      for (const [x, y] of pts) if (Math.abs(n[0] * x + n[1] * y - d0) <= tol) k++;
      if (!best || k > best.k) best = { n, d0, k };
    }
  }
  if (!best) return null;
  const inl = pts.filter(([x, y]) => Math.abs(best.n[0] * x + best.n[1] * y - best.d0) <= tol);
  // Total least squares on the inliers.
  const mx = inl.reduce((t, p) => t + p[0], 0) / inl.length, my = inl.reduce((t, p) => t + p[1], 0) / inl.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of inl) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: [mx, my], d: [Math.cos(ang), Math.sin(ang)], share: inl.length / pts.length, n: inl.length };
}

export function intersect(L1, L2) {
  const [a, b] = L1.p, [c, d] = L1.d, [e, f] = L2.p, [g, h] = L2.d;
  const den = c * h - d * g;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((e - a) * h - (f - b) * g) / den;
  return [a + t * c, b + t * d];
}

// ---------- setting up the camera from what's in the photo ----------

/**
 * calibrate({ frame, focal35, ref, refKind, groundLines })
 *   ref/refKind: an upright object of known height standing on the ground (optional).
 *   groundLines: arrays of image points along lines that are parallel on the ground (optional, 2+).
 * Returns { cameras: [...], primary, how, confidence, notes }.
 */
export function calibrate({ frame, focal35 = null, ref = null, refKind = null, groundLines = [] }) {
  const { w, h } = frame;
  const lens = focalPx({ w, h, focal35 });
  const notes = [];
  if (lens.source !== 'photo') notes.push('no lens info in the photo; used a typical phone lens');
  const R = refKind ? UPRIGHT[refKind] : null;
  const axis = ref && R ? uprightAxis(ref) : null;
  let roll = axis ? axis.lean : 0;

  // Tip-down angle from parallel ground lines.
  const lines = groundLines.map((pts) => robustLine(pts)).filter((L) => L && L.share > 0.5 && L.n >= 8);
  let vp = null;
  if (lines.length >= 2) {
    const v = intersect(lines[0], lines[1]);
    if (v && v[1] < h / 2 + h) vp = v; // a vanishing point below the photo would mean the lines aren't parallel on the ground
  }
  // Sideways tilt: the reference's sides lean partly because of the tilt and partly because the
  // camera is tipped down (upright lines lean in toward the bottom away from the photo's center).
  // Take out the tip-down part: guess the tilt, predict the lean, correct, repeat.
  if (axis && vp) {
    for (let k = 0; k < 8; k++) {
      const pitch = pitchFromVanishing(vp, { w, h, fPx: lens.fPx, roll });
      const predicted = predictedLean(makeCamera({ w, h, fPx: lens.fPx, pitch, height: 1, roll }), axis.base);
      if (predicted == null) break;
      roll += axis.lean - predicted;
    }
  }
  if (Math.abs(roll) > 2 * DEG) notes.push(`photo tilted about ${Math.round(Math.abs(roll) / DEG)} degrees; corrected`);
  const fScales = lens.source === 'photo' ? [1] : [1, 0.95, 1.05];
  const cameras = [];
  let how;
  for (const fs of fScales) {
    const fPx = lens.fPx * fs;
    if (vp && axis) {
      // Best case: angle from the lines, height from the reference.
      const pitch = pitchFromVanishing(vp, { w, h, fPx, roll });
      const unit = makeCamera({ w, h, fPx, pitch, height: 1, roll });
      const hh = unit.heightAt(axis.base, axis.top);
      if (hh > 0) cameras.push(makeCamera({ w, h, fPx, pitch, height: R.heightFt / hh, roll }));
      how = 'ground lines + reference height';
    } else if (axis) {
      // Height unknown: try every normal phone height, solve the angle from the reference.
      for (const camH of [4.5, 5, 5.5, 6]) {
        const pitch = solvePitch({ w, h, fPx, roll, camH, axis, H: R.heightFt });
        if (pitch != null) cameras.push(makeCamera({ w, h, fPx, pitch, height: camH, roll }));
      }
      how = 'reference height + typical phone height';
    } else if (vp) {
      for (const camH of [4.5, 5, 5.5]) cameras.push(makeCamera({ w, h, fPx, pitch: pitchFromVanishing(vp, { w, h, fPx }), height: camH }));
      how = 'ground lines + typical phone height (no reference)';
    }
  }
  if (!cameras.length) return { ok: false, cameras: [], notes, ask: 'Take the photo so a door or garage door is in the picture, standing on the same ground.' };

  // Sanity: a phone is held between about 2.5 and 8 ft up.
  const heights = cameras.map((c) => c.height);
  let confidence = how.startsWith('ground lines + reference') ? 'good' : how.startsWith('reference') ? 'fair' : 'low';
  if (heights.some((x) => x < 2.5 || x > 8)) { confidence = 'low'; notes.push('camera height came out odd; check the reference'); }
  if (R && R.trust === 'varies' && confidence === 'good') confidence = 'fair';
  if (lens.source !== 'photo' && confidence === 'good') confidence = 'fair';
  const primary = cameras[Math.floor(cameras.length / 2)] && pickPrimary(cameras);
  return { ok: true, cameras, primary, how, confidence, notes, lens: lens.source, vanishingPoint: vp };
}

// How an upright line standing at image point `base` should lean in the photo for this camera (dx per dy, as an angle).
function predictedLean(cam, base) {
  const P = cam.groundPoint(base[0], base[1]);
  if (!P) return null;
  const p0 = cam.project(P.X, 0, P.Z), p1 = cam.project(P.X, 0.5, P.Z);
  if (!p0 || !p1 || Math.abs(p1[1] - p0[1]) < 1e-9) return null;
  return Math.atan((p1[0] - p0[0]) / (p1[1] - p0[1]));
}

function pickPrimary(cams) {
  // the one with the middle-of-the-pack height and the unscaled lens
  const s = cams.slice().sort((a, b) => a.height - b.height);
  return s[Math.floor(s.length / 2)];
}

// The tip-down angle that makes the reference come out its true height, for a given camera height.
function solvePitch({ w, h, fPx, roll, camH, axis, H }) {
  const f = (p) => {
    const c = makeCamera({ w, h, fPx, pitch: p, height: camH, roll });
    const v = c.heightAt(axis.base, axis.top);
    return v == null ? null : v - H;
  };
  let prev = null, prevP = null;
  for (let d = -20; d <= 75; d += 1) {
    const p = d * DEG, v = f(p);
    if (v != null && prev != null && Math.sign(v) !== Math.sign(prev)) {
      let lo = prevP, hi = p, flo = prev;
      for (let k = 0; k < 50; k++) {
        const mid = (lo + hi) / 2, fm = f(mid);
        if (fm == null) break;
        if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else hi = mid;
      }
      return (lo + hi) / 2;
    }
    if (v != null) { prev = v; prevP = p; }
  }
  return null;
}

// ---------- the measurements ----------

const spread = (vals, primaryVal) => {
  const ok = vals.filter(Number.isFinite);
  return { ft: primaryVal, low: Math.min(...ok), high: Math.max(...ok) };
};
const quantile = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };

// Ground gap between two objects (a fence and a house wall, two trees, a car and a garage wall).
// Gives the tightest spot and the typical gap.
export function gapBetween(objA, objB, cal, frame) {
  const A = contactPoints(objA, frame), B = contactPoints(objB, frame);
  if (A.length < 6 || B.length < 6) return { ok: false, reason: 'can’t see where both meet the ground' };
  const one = (cam) => {
    const ga = A.map(([u, v]) => cam.groundPoint(u, v)).filter(Boolean);
    const gb = B.map(([u, v]) => cam.groundPoint(u, v)).filter(Boolean);
    if (ga.length < 4 || gb.length < 4) return null;
    const lineB = robustLine(gb.map((g) => [g.X, g.Z]), 0.25);
    if (!lineB) return null;
    const zMin = Math.min(...gb.map((g) => g.Z)), zMax = Math.max(...gb.map((g) => g.Z));
    const nB = [-lineB.d[1], lineB.d[0]];
    const ds = ga.filter((g) => g.Z >= zMin && g.Z <= zMax).map((g) => Math.abs((g.X - lineB.p[0]) * nB[0] + (g.Z - lineB.p[1]) * nB[1]));
    if (ds.length < 3) return null;
    return { tight: quantile(ds, 0.05), typical: quantile(ds, 0.5), alongFt: zMax - zMin };
  };
  const p = one(cal.primary);
  if (!p) return { ok: false, reason: 'the two don’t overlap from this angle' };
  const all = cal.cameras.map(one).filter(Boolean);
  return {
    ok: true,
    tightest: spread(all.map((x) => x.tight), p.tight),
    typical: spread(all.map((x) => x.typical), p.typical),
    overFt: p.alongFt,
    confidence: cal.confidence,
  };
}

// How tall an upright object standing on the ground is.
export function heightOf(obj, cal) {
  const ax = uprightAxis(obj);
  if (!ax) return { ok: false, reason: 'too small in the photo' };
  const vals = cal.cameras.map((c) => c.heightAt(ax.base, ax.top));
  return { ok: true, ...spread(vals, cal.primary.heightAt(ax.base, ax.top)), confidence: cal.confidence };
}

// How far an object stands from the person who took the photo (along the ground).
export function distanceTo(obj, cal) {
  const ax = uprightAxis(obj);
  if (!ax) return { ok: false, reason: 'too small in the photo' };
  const d = (c) => { const g = c.groundPoint(ax.base[0], ax.base[1]); return g ? Math.hypot(g.X, g.Z) : NaN; };
  return { ok: true, ...spread(cal.cameras.map(d), d(cal.primary)), confidence: cal.confidence };
}

// Distance between the bases of two upright objects (two trees, two posts).
export function between(objA, objB, cal) {
  const a = uprightAxis(objA), b = uprightAxis(objB);
  if (!a || !b) return { ok: false, reason: 'too small in the photo' };
  const d = (c) => { const p = c.groundPoint(...a.base), q = c.groundPoint(...b.base); return p && q ? Math.hypot(p.X - q.X, p.Z - q.Z) : NaN; };
  return { ok: true, ...spread(cal.cameras.map(d), d(cal.primary)), confidence: cal.confidence };
}

// Pinhole range to an object of known size anywhere (a soda can held up, a license plate on a car).
export function rangeFromSize({ sizeMm, sizePx, fPx }) {
  if (!(sizeMm > 0 && sizePx > 0 && fPx > 0)) return null;
  return (fPx * sizeMm) / sizePx / 304.8; // feet
}

// ---------- answers people can use ----------

export function ftIn(ft) {
  if (!Number.isFinite(ft)) return '?';
  let inches = Math.round(ft * 12);
  const f = Math.floor(inches / 12);
  inches -= f * 12;
  return inches ? `${f} ft ${inches} in` : `${f} ft`;
}

// Will something of width `itemFt` fit in a gap? Leaves `clearanceIn` on each side to work and walk.
export function fitCheck({ gap, itemFt, clearanceIn = 6 }) {
  const need = itemFt + (2 * clearanceIn) / 12;
  const lowSpare = gap.low - itemFt, bestSpare = gap.ft - itemFt;
  let verdict;
  if (gap.low >= need) verdict = 'fits';
  else if (gap.low >= itemFt) verdict = 'fits, but tight';
  else if (gap.high >= itemFt) verdict = 'too close to call from the photo';
  else verdict = 'won’t fit';
  const each = bestSpare > 0 ? ftIn(bestSpare / 2).replace(/^0 ft /, '') : null;
  return {
    verdict,
    text:
      verdict === 'won’t fit'
        ? `The gap is about ${ftIn(gap.ft)}, so a ${ftIn(itemFt)} wide one won’t fit.`
        : verdict === 'too close to call from the photo'
          ? `The gap is about ${ftIn(gap.ft)} (somewhere from ${ftIn(gap.low)} to ${ftIn(gap.high)}). That’s too close to call for ${ftIn(itemFt)}; tape the narrowest spot before you buy.`
          : `You have about ${ftIn(gap.ft)} (at least ${ftIn(gap.low)}). A ${ftIn(itemFt)} wide one ${verdict === 'fits' ? 'fits' : 'fits, but it’s tight'}${each ? `, with about ${each} on each side` : ''}.`,
    spareLowFt: lowSpare,
  };
}
