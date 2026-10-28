// Close-up measuring with an everyday ruler lying on the same flat surface: a quarter on a crack,
// a sheet of paper on a stain, a gift card beside a mole, a soda can next to a lump.
//
// Two kinds of ruler, two kinds of math:
//  - Four corners (paper, gift card, dollar bill, license plate, soda can seen from the side):
//    the corners pin the whole plane, so a perspective map (a homography) turns every pixel of the
//    surface into true millimeters, even when the photo is taken at an angle.
//  - A circle (a coin): tilted, it photographs as an oval. The long axis keeps the true diameter;
//    the short axis shrinks by the tilt. Stretching the short axis back undoes the tilt.
//
// Everything is measured in the plane of the ruler, so the ruler must lie flat on (or right beside)
// what is measured. The result says so, and the business confirms on site.

import { decodeMaskToRaster } from '@meta-sam/parser';

// Real sizes in millimeters. Rectangles are long side x short side.
export const FLAT_REFERENCES = {
  quarter: { label: 'quarter', shape: 'circle', diameter: 24.26, samConcept: 'coin' },
  penny: { label: 'penny', shape: 'circle', diameter: 19.05, samConcept: 'coin' },
  nickel: { label: 'nickel', shape: 'circle', diameter: 21.21, samConcept: 'coin' },
  dime: { label: 'dime', shape: 'circle', diameter: 17.91, samConcept: 'coin' },
  card: { label: 'gift or hotel card', shape: 'rect', long: 85.6, short: 53.98, samConcept: 'card' },
  paper_letter: { label: 'sheet of printer paper', shape: 'rect', long: 279.4, short: 215.9, samConcept: 'sheet of paper' },
  paper_a4: { label: 'A4 sheet of paper', shape: 'rect', long: 297, short: 210, samConcept: 'sheet of paper' },
  dollar: { label: 'dollar bill', shape: 'rect', long: 156.0, short: 66.3, samConcept: 'dollar bill' },
  soda_can: { label: '12 oz soda can', shape: 'rect', long: 122.7, short: 66.0, samConcept: 'soda can', note: 'side view; best for things standing beside it' },
  license_plate: { label: 'license plate', shape: 'rect', long: 304.8, short: 152.4, samConcept: 'license plate' },
};

const MM_PER_IN = 25.4;

// Pixel centers of a SAM object's mask, in photo pixels. Thinned to at most ~maxPts points
// (each point then stands for `weight` pixels) so big masks stay fast.
export function maskPoints(obj, maxPts = 60000) {
  const { box, mask } = obj;
  const pts = [];
  if (!mask) {
    for (let y = box.y1; y <= box.y2; y++) for (let x = box.x1; x <= box.x2; x++) pts.push([x + 0.5, y + 0.5]);
    return { pts, weight: 1, pixelArea: 1 };
  }
  const raster = decodeMaskToRaster(mask);
  const sx = (box.x2 - box.x1 + 1) / mask.width;
  const sy = (box.y2 - box.y1 + 1) / mask.height;
  let n = 0;
  for (let i = 0; i < raster.length; i++) n += raster[i];
  const step = Math.max(1, Math.ceil(Math.sqrt(n / maxPts)));
  for (let r = 0; r < mask.height; r += step) {
    for (let c = 0; c < mask.width; c += step) {
      if (raster[r * mask.width + c]) pts.push([box.x1 + (c + 0.5) * sx, box.y1 + (r + 0.5) * sy]);
    }
  }
  return { pts, weight: step * step, pixelArea: sx * sy };
}

// Edge pixels of a mask (inside pixels with an outside 4-neighbor), nudged half a pixel outward
// so they sit on the true outline rather than on the pixel centers just inside it.
export function maskBoundary(obj) {
  const { box, mask } = obj;
  if (!mask) return [];
  const raster = decodeMaskToRaster(mask);
  const W = mask.width, Hh = mask.height;
  const sx = (box.x2 - box.x1 + 1) / W, sy = (box.y2 - box.y1 + 1) / Hh;
  const at = (c, r) => (c >= 0 && r >= 0 && c < W && r < Hh ? raster[r * W + c] : 0);
  const out = [];
  for (let r = 0; r < Hh; r++) {
    for (let c = 0; c < W; c++) {
      if (!at(c, r)) continue;
      const L = !at(c - 1, r), R = !at(c + 1, r), U = !at(c, r - 1), D = !at(c, r + 1);
      if (!(L || R || U || D)) continue;
      const dx = (R ? 0.5 : 0) - (L ? 0.5 : 0), dy = (D ? 0.5 : 0) - (U ? 0.5 : 0);
      out.push([box.x1 + (c + 0.5 + dx) * sx, box.y1 + (r + 0.5 + dy) * sy]);
    }
  }
  return out;
}

// Sharpen rough corners: fit a straight line to each edge's outline points (ignoring the ends
// near the corners) and intersect neighboring lines. Sub-pixel corners, steadier homography.
export function refineCorners(rough, boundary) {
  if (!boundary.length) return rough;
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = rough[i], b = rough[(i + 1) % 4];
    const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey);
    if (len < 4) return rough;
    const ux = ex / len, uy = ey / len;
    const pts = boundary.filter(([x, y]) => {
      const t = ((x - a[0]) * ux + (y - a[1]) * uy) / len;
      const d = Math.abs((x - a[0]) * uy - (y - a[1]) * ux);
      return t > 0.12 && t < 0.88 && d < Math.max(3, len * 0.04);
    });
    if (pts.length < 6) return rough;
    // total least squares line through the points
    let mx = 0, my = 0;
    for (const [x, y] of pts) { mx += x; my += y; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    lines.push({ px: mx, py: my, dx: Math.cos(th), dy: Math.sin(th) });
  }
  const meet = (l1, l2) => {
    const den = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
    return [l1.px + t * l1.dx, l1.py + t * l1.dy];
  };
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = meet(lines[(i + 3) % 4], lines[i]); // corner i sits between edge i-1 and edge i
    if (!p || Math.hypot(p[0] - rough[i][0], p[1] - rough[i][1]) > 8) return rough;
    out.push(p);
  }
  return out;
}

// ---------- geometry helpers ----------

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const polyArea = (q) => {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % q.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
};

// The four corners of a photographed rectangle: the biggest quadrilateral whose corners are
// extreme points of the outline in some pair of directions. Returned in order around the shape.
export function rectCorners(points) {
  const hull = convexHull(points);
  let bestQ = null, bestA = -1;
  for (let deg = 0; deg < 90; deg += 1.5) {
    const a = (deg * Math.PI) / 180;
    const dirs = [[Math.cos(a), Math.sin(a)], [-Math.sin(a), Math.cos(a)], [-Math.cos(a), -Math.sin(a)], [Math.sin(a), -Math.cos(a)]];
    const q = dirs.map(([dx, dy]) => {
      let best = null, bv = -Infinity;
      for (const h of hull) {
        const v = h[0] * dx + h[1] * dy;
        if (v > bv) { bv = v; best = h; }
      }
      return best;
    });
    const A = polyArea(q);
    if (A > bestA) { bestA = A; bestQ = q; }
  }
  return bestQ;
}

// Solve the 8x8 system for the homography that maps src[i] -> dst[i] (four point pairs).
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gaussian elimination with partial pivoting.
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * h[k];
    h[r] = s / A[r][r];
  }
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export const applyH = (H, [x, y]) => {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
};

// Area scale of the homography at (x, y): real mm^2 per photo pixel^2.
function jacobianDet(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  const det = H[0] * (H[4] * H[8] - H[5] * H[7]) - H[1] * (H[3] * H[8] - H[5] * H[6]) + H[2] * (H[3] * H[7] - H[4] * H[6]);
  return Math.abs(det / (w * w * w));
}

// Longest straight distance across a set of points (on their hull).
function feret(points) {
  const hull = convexHull(points);
  let best = 0, pair = null;
  for (let i = 0; i < hull.length; i++) {
    for (let j = i + 1; j < hull.length; j++) {
      const d = Math.hypot(hull[i][0] - hull[j][0], hull[i][1] - hull[j][1]);
      if (d > best) { best = d; pair = [hull[i], hull[j]]; }
    }
  }
  return { length: best, pair };
}

// ---------- the two rulers ----------

// From a rectangle ruler: map from photo pixels to millimeters on the ruler's plane.
function rectMap(refPts, R, boundary = []) {
  const rough = rectCorners(refPts);
  if (!rough) return null;
  const c = refineCorners(rough, boundary);
  const side = (i) => Math.hypot(c[(i + 1) % 4][0] - c[i][0], c[(i + 1) % 4][1] - c[i][1]);
  // The longer pair of opposite sides is the ruler's long side.
  const longFirst = side(0) + side(2) >= side(1) + side(3);
  const [W, Hh] = longFirst ? [R.long, R.short] : [R.short, R.long];
  const dst = [[0, 0], [W, 0], [W, Hh], [0, Hh]];
  const H = homography(c, dst);
  if (!H) return null;
  const ratio = Math.max(side(0) + side(2), side(1) + side(3)) / Math.min(side(0) + side(2), side(1) + side(3));
  return { toMm: (p) => applyH(H, p), areaScale: (p) => jacobianDet(H, p[0], p[1]), corners: c, shapeCheck: ratio };
}

// From a coin: undo the tilt by stretching the oval's short axis, then scale by the diameter.
function circleMap(refPts, R) {
  const n = refPts.length;
  if (n < 20) return null;
  let mx = 0, my = 0;
  for (const [x, y] of refPts) { mx += x; my += y; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of refPts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l2 = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const a = 2 * Math.sqrt(l1), b = 2 * Math.sqrt(Math.max(l2, 1e-9)); // semi-axes of a filled ellipse
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy); // direction of the long axis
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const mmPerPx = R.diameter / (2 * a);
  const stretch = a / b;
  const toMm = ([x, y]) => {
    const dx = x - mx, dy = y - my;
    const u = dx * cos + dy * sin; // along the long axis
    const v = (-dx * sin + dy * cos) * stretch; // short axis, tilt undone
    return [u * mmPerPx, v * mmPerPx];
  };
  const k = mmPerPx * mmPerPx * stretch;
  return { toMm, areaScale: () => k, tiltDeg: Math.round((Math.acos(Math.min(1, b / a)) * 180) / Math.PI), radiusPx: a };
}

/**
 * Measure a flat thing next to an everyday ruler.
 * target: SAM object (crack, stain, mole, wound...). ref: SAM object for the ruler. refKind: key of FLAT_REFERENCES.
 * Returns { ok, areaMm2, areaIn2, lengthMm, widthMm, lengthIn, widthIn, method, confidence, notes }.
 */
export function measureFlat({ target, ref, refKind }) {
  const R = FLAT_REFERENCES[refKind];
  if (!R || !target || !ref) return { ok: false, reason: 'need the thing, a ruler and its kind' };
  const refM = maskPoints(ref, 20000);
  if (refM.pts.length < 30) return { ok: false, reason: 'ruler too small in the photo; move closer' };
  const map = R.shape === 'circle' ? circleMap(refM.pts, R) : rectMap(refM.pts, R, maskBoundary(ref));
  if (!map) return { ok: false, reason: 'could not read the ruler outline' };

  const tm = maskPoints(target);
  if (tm.pts.length < 3) return { ok: false, reason: 'nothing to measure found' };
  let area = 0;
  for (const p of tm.pts) area += map.areaScale(p) * tm.weight * tm.pixelArea;
  const mm = tm.pts.map(map.toMm);
  const { length } = feret(mm);
  const width = length > 0 ? area / length : 0;

  const notes = [];
  let confidence = 'good';
  if (R.shape === 'rect') {
    const expected = R.long / R.short;
    if (Math.abs(map.shapeCheck - expected) / expected > 0.45) { confidence = 'low'; notes.push('ruler shape looks off; is it partly hidden or bent?'); }
  } else {
    if (map.radiusPx < 15) { confidence = 'low'; notes.push('coin is small in the photo; move closer'); }
    if (map.tiltDeg > 55) { confidence = 'low'; notes.push('photo taken at a steep angle; shoot from straight above'); }
    // A coin can't capture perspective, so it's exact only close to itself.
    const reach = Math.max(...mm.map(([x, y]) => Math.hypot(x, y)));
    if (reach > 3 * R.diameter && map.tiltDeg > 12) {
      confidence = 'low';
      notes.push('for something this big, lay a sheet of paper or a gift card next to it instead of a coin');
    }
  }
  if (refKind === 'soda_can') notes.push('measured at the can\'s distance; best for things standing beside it');

  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    ok: area > 0,
    areaMm2: Math.round(area),
    areaIn2: r1(area / (MM_PER_IN * MM_PER_IN)),
    lengthMm: r1(length),
    widthMm: r1(width),
    lengthIn: r1(length / MM_PER_IN),
    widthIn: r1(width / MM_PER_IN),
    ruler: R.label,
    method: R.shape === 'circle' ? 'coin oval, tilt undone' : 'four-corner perspective map',
    tiltDeg: map.tiltDeg,
    confidence,
    notes,
  };
}

// The scale ladder: a close-up measures one repeating piece (a paver, a brick) with the small ruler;
// that piece then becomes the ruler in the wide shot. Returns a reference usable by measureSurface().
export function ladderReference({ piece, ref, refKind, label = 'paver' }) {
  const m = measureFlat({ target: piece, ref, refKind });
  if (!m.ok) return { ok: false, reason: m.reason };
  return {
    ok: true,
    reference: { label: `${label} (measured ${m.lengthIn} x ${m.widthIn} in with a ${m.ruler})`, widthFt: m.lengthIn / 12, heightFt: m.widthIn / 12 },
    measured: m,
  };
}
