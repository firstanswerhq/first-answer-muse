// Whole floor from several photos.
//
// One photo of a floor from a doorway hides part of it. So the customer lays ONE sheet of printer
// paper on the floor, square to a wall, leaves it there, and takes 2 to 4 photos from different
// doorways or corners, with the paper in every shot. Each photo's paper gives a homography (flat.js)
// from that photo's pixels to millimeters on the paper's plane, with the paper's corner as the origin
// and its edges as the axes. Every photo's floor outline lands in that ONE frame, so their union is
// the whole floor, and because the paper is square to a wall, the frame's axes are the walls: the
// union's axis-aligned bounding rectangle is the room.
//
// The union is done on a grid of 25 mm cells: for each cell center on the paper's plane we ask each
// photo "is this spot inside SAM's floor mask?" by mapping the point back into that photo. No polygon
// clipping, no holes, and the error is half a cell per side.
//
// The 180° ambiguity. The paper's long edge is always the x axis, and the homography keeps the
// floor's handedness (the camera is above the floor in every shot), so the only thing one photo's
// frame can differ from another's by is a half turn about the paper. We try both (as is, and turned
// 180°) and keep the one whose floor overlaps the union of the earlier photos more. If neither
// overlaps, the one that comes closer wins when the gap is under a meter (the photos only touch);
// a bigger gap means these are probably not the same floor, or the paper moved, and the combined
// number is refused.

import { decodeMaskToRaster } from '@meta-sam/parser';
import { rulerMap, maskBoundary, measureFlat, applyH, homography } from './flat.js';

export const CELL_MM = 25;
export const MAX_GAP_MM = 1000;
export const MAX_PHOTOS = 4;
// How much of its bounding rectangle the union fills. At RECT_FILL and above the floor is a plain
// rectangle and the rectangle's area is the floor. Between MIN_FILL and RECT_FILL the floor is real but
// not a plain rectangle (a vanity, tub or toilet takes a bite: the first real bathroom pair filled 78%),
// so the union's own area is the floor to tile. Under MIN_FILL the photos probably did not line up.
export const RECT_FILL = 0.9;
export const MIN_FILL = 0.55;
// Two photos of the same floor with the same sheet both see the floor around the sheet, so their floors
// overlap by a good share of the smaller one; a pair under this did not line up (the half-turn was wrong
// or the sheet moved). This is the alignment check; fill is about the room's shape.
export const MIN_PAIR_OVERLAP = 0.4;
const REACH_MM = 15000; // nothing on the floor is more than 15 m from the paper; farther points are a blown-up map
const MAX_AREA_MM2 = 200e6; // 200 m²: no room a sheet of paper can measure is bigger
const CORNER_PX = 0.35; // how well a sheet's corner is known on the photo (a line fit through the mask's edge pixels)

// Inverse of a 3×3 homography (row-major, 9 numbers).
export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/**
 * One photo's floor, mapped onto the paper's plane.
 * target: SAM object for the floor. ref: SAM object for the paper. refKind: a rectangle in FLAT_REFERENCES.
 * Returns { ok, sample(x, y), bounds, paper: { long, short }, areaMm2, plusMinusPct, confidence, notes, clipped, measured }.
 *   sample(x, y) says whether the point (mm on the paper's plane, long edge along x) is floor in this photo.
 */
export function floorOnPaper({ target, ref, refKind = 'paper_letter', focal35 = null }) {
  const m = measureFlat({ target, ref, refKind, focal35 });
  if (!m.ok) return { ok: false, reason: m.reason };
  // Sanity bounds: a paper that is too small or too far reads as a bent shape (fit score over the limit),
  // or its long side is a guess (scores too close, short side under 60 px), and its map blows the floor
  // up (a 2 m × 2 m floor became 4e43 mm² in a probe; a 71 × 23 px sheet gave 189 sq ft for 112). Such a
  // photo is retaken, never combined: a multi-photo floor extrapolates meters past the sheet, so it needs
  // a sheet it can read (RECT_MIN_PX in flat.js), where one photo only needs a rough map.
  if (m.notes.some((n) => /ruler shape|long side is a guess/.test(n))) return { ok: false, reason: 'the paper is too small or too far away in this photo to trust; get closer to it' };
  if (m.areaMm2 > MAX_AREA_MM2) return { ok: false, reason: 'the floor came out impossibly big, so the paper was read wrong; get closer to it' };
  const map = rulerMap(ref, refKind, { focal35 });
  if (map.shortPx < 35) return { ok: false, reason: 'the paper is too small or too far away in this photo to trust; get closer to it' };
  if (!map?.H || !map.extentMm) return { ok: false, reason: 'could not read the paper outline' };
  const Hi = invertH(map.H);
  if (!Hi) return { ok: false, reason: 'could not read the paper outline' };
  const { long: L, short: S } = map.R;
  // The homography puts the paper's first side along x; when that was the short side, turn the frame a
  // quarter turn (a rotation, not a mirror) so the long edge is x in every photo.
  const longFirst = map.extentMm[0] >= map.extentMm[1];
  const toPlane = (p) => { const [x, y] = applyH(map.H, p); return longFirst ? [x, y] : [y, S - x]; };
  const toPhoto = ([x, y]) => applyH(Hi, longFirst ? [x, y] : [S - y, x]);

  const { box, mask } = target;
  const raster = mask ? decodeMaskToRaster(mask) : null;
  const sx = mask ? (box.x2 - box.x1 + 1) / mask.width : 1, sy = mask ? (box.y2 - box.y1 + 1) / mask.height : 1;
  const inPhoto = ([px, py]) => {
    if (!Number.isFinite(px) || !Number.isFinite(py) || px < box.x1 || py < box.y1 || px >= box.x2 + 1 || py >= box.y2 + 1) return false;
    if (!raster) return true;
    const c = Math.floor((px - box.x1) / sx), r = Math.floor((py - box.y1) / sy);
    return c >= 0 && r >= 0 && c < mask.width && r < mask.height && raster[r * mask.width + c] === 1;
  };
  // A point behind the camera maps through the homography too (with a flipped sign); only points in
  // front of it (positive depth) count.
  const w = (x, y) => Hi[6] * x + Hi[7] * y + Hi[8];
  const sign = Math.sign(w(L / 2, S / 2)) || 1;
  const sample = (x, y) => sign * w(x, y) > 0 && inPhoto(toPhoto([x, y]));

  let bpts = maskBoundary(target);
  if (!bpts.length) bpts = [[box.x1, box.y1], [box.x2 + 1, box.y1], [box.x2 + 1, box.y2 + 1], [box.x1, box.y2 + 1]];
  const plane = bpts.map(toPlane);
  if (plane.some(([x, y]) => !(Math.hypot(x - L / 2, y - S / 2) <= REACH_MM))) return { ok: false, reason: 'the floor came out impossibly big, so the paper was read wrong; get closer to it' };
  if (plane.length < 3) return { ok: false, reason: 'the floor outline does not reach the paper' };
  const bounds = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (const [x, y] of plane) { if (x < bounds.x0) bounds.x0 = x; if (x > bounds.x1) bounds.x1 = x; if (y < bounds.y0) bounds.y0 = y; if (y > bounds.y1) bounds.y1 = y; }
  // How far off this photo's floor can be. The floor is extrapolated meters past a sheet that is a
  // hundred pixels wide, so a corner of the sheet read a third of a pixel off moves the far wall by a
  // lot: each of the sheet's four corners is nudged ±0.35 px (the corners come from a straight-line fit
  // through the mask's edge pixels, good to about a third of a pixel), the map rebuilt and the floor's
  // extent on the plane re-measured; the four
  // corners' worst shifts add in quadrature (they are independent) and that is this photo's error. (A
  // sheet near a wall or in a corner widens this: more of the floor lies far from it.) A floor that
  // runs off the photo's edge is normal here, so measureFlat's 8% for that is not added.
  const dst = [[0, 0], [map.extentMm[0], 0], [map.extentMm[0], map.extentMm[1]], [0, map.extentMm[1]]];
  const extent = (Hx) => {
    const toP = (p) => { const [x, y] = applyH(Hx, p); return longFirst ? [x, y] : [y, S - x]; };
    const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    for (const q of bpts) { const [x, y] = toP(q); if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; }
    return b;
  };
  let sumSq = 0;
  for (let k = 0; k < 4; k++) {
    let worst = 0;
    for (const [dx, dy] of [[CORNER_PX, 0], [-CORNER_PX, 0], [0, CORNER_PX], [0, -CORNER_PX]]) {
      const c2 = map.corners.map((q, i) => (i === k ? [q[0] + dx, q[1] + dy] : q));
      const H2 = homography(c2, dst);
      if (!H2) continue;
      const b2 = extent(H2);
      for (const key of ['x0', 'x1', 'y0', 'y1']) worst = Math.max(worst, Math.abs(b2[key] - bounds[key]));
    }
    sumSq += worst * worst;
  }
  const worstMm = Math.sqrt(sumSq);
  const span = Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0, 1);
  const propagated = Math.min(0.5, worstMm / span);
  const notes = m.notes.filter((n) => !/runs off the edge/.test(n));
  const plusMinusPct = Math.round(Math.max(0.03, propagated) * 1000) / 1000;
  // mm per pixel at the sheet: how coarse this photo's map is (the fallback single photo is the finest).
  const cxy = map.corners.reduce((a, q) => [a[0] + q[0] / 4, a[1] + q[1] / 4], [0, 0]);
  const mmPerPx = Math.sqrt(Math.max(0, map.areaScale(cxy)));
  return { ok: true, sample, bounds, paper: { long: L, short: S }, areaMm2: m.areaMm2, plusMinusPct, errorMm: Math.round(worstMm), mmPerPx: Math.round(mmPerPx * 100) / 100, confidence: 'good', notes, clipped: m.clipped, measured: m };
}

// Cells as integer keys (cell indices can be negative: the paper is somewhere in the room, not at a corner).
const OFF = 2048, SPAN = 4096;
const key = (i, j) => (i + OFF) * SPAN + (j + OFF);
const unkey = (k) => [Math.floor(k / SPAN) - OFF, (k % SPAN) - OFF];

// The grid cells (centers) a photo's floor covers, as is or turned 180° about the paper.
function cellsOf(p, flipped, cellMm) {
  const { long: L, short: S } = p.paper;
  const b = flipped ? { x0: L - p.bounds.x1, x1: L - p.bounds.x0, y0: S - p.bounds.y1, y1: S - p.bounds.y0 } : p.bounds;
  const lim = Math.floor(REACH_MM / cellMm);
  const i0 = Math.max(-lim, Math.floor(b.x0 / cellMm)), i1 = Math.min(lim, Math.ceil(b.x1 / cellMm));
  const j0 = Math.max(-lim, Math.floor(b.y0 / cellMm)), j1 = Math.min(lim, Math.ceil(b.y1 / cellMm));
  const set = new Set();
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const x = (i + 0.5) * cellMm, y = (j + 0.5) * cellMm;
      if (p.sample(flipped ? L - x : x, flipped ? S - y : y)) set.add(key(i, j));
    }
  }
  return set;
}

const overlap = (a, b) => { let n = 0; for (const k of a) if (b.has(k)) n++; return n; };

// Cells with an empty 4-neighbor: enough to measure the gap between two sets.
function rim(set) {
  const out = [];
  for (const k of set) {
    const [i, j] = unkey(k);
    if (!set.has(key(i + 1, j)) || !set.has(key(i - 1, j)) || !set.has(key(i, j + 1)) || !set.has(key(i, j - 1))) out.push([i, j]);
  }
  return out;
}
function gapMm(a, b, cellMm) {
  const ra = rim(a), rb = rim(b);
  let best = Infinity;
  for (const [i, j] of ra) for (const [k, l] of rb) { const d = (i - k) ** 2 + (j - l) ** 2; if (d < best) best = d; }
  return Math.sqrt(best) * cellMm;
}

/**
 * Combine the floors of several photos (each from floorOnPaper) into one floor on the paper's plane.
 * Returns { ok, areaMm2, sqft, widthMm, lengthMm, fill, cells, photos: [{ flipped, coverage, overlapCells }], plusMinusPct }
 * or { ok: false, refused: <photo index>, gapMm } when a photo's floor is more than maxGapMm from the others,
 * or { ok: false, refused: null, fill } when the union fills less than minFill of its bounding rectangle
 * (an L-shaped room, or a photo that did not line up: a room is a rectangle, and a misplaced photo
 * makes a cross that fills far less of one).
 */
export function combineFloors(photos, { cellMm = CELL_MM, maxGapMm = MAX_GAP_MM, minFill = MIN_FILL, rectFill = RECT_FILL, minPairOverlap = MIN_PAIR_OVERLAP } = {}) {
  if (!photos.length) return { ok: false, reason: 'no photos' };
  let union = null;
  const placed = [];
  for (let k = 0; k < photos.length; k++) {
    const p = photos[k];
    const asIs = cellsOf(p, false, cellMm);
    if (!asIs.size) return { ok: false, refused: k, reason: 'no floor on the paper’s plane' };
    if (!union) { union = new Set(asIs); placed.push({ flipped: false, cells: asIs, overlapCells: null }); continue; }
    const turned = cellsOf(p, true, cellMm);
    const oa = overlap(asIs, union), ob = overlap(turned, union);
    let flipped, gap = 0;
    if (oa || ob) flipped = ob > oa;
    else {
      const ga = gapMm(asIs, union, cellMm), gb = gapMm(turned, union, cellMm);
      gap = Math.min(ga, gb);
      if (gap > maxGapMm) return { ok: false, refused: k, gapMm: Math.round(gap), photos: placed.map(({ flipped: f, cells }) => ({ flipped: f, cells: cells.size })) };
      flipped = gb < ga;
    }
    const pick = flipped ? turned : asIs;
    for (const c of pick) union.add(c);
    placed.push({ flipped, cells: pick, overlapCells: Math.max(oa, ob), gapMm: Math.round(gap) });
  }
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
  for (const k of union) { const [i, j] = unkey(k); if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
  const areaMm2 = union.size * cellMm * cellMm;
  const xMm = (i1 - i0 + 1) * cellMm, yMm = (j1 - j0 + 1) * cellMm;
  const fill = Math.round((areaMm2 / (xMm * yMm)) * 100) / 100;
  const placed2 = placed.map((q) => ({ flipped: q.flipped, coverage: Math.round((q.cells.size / union.size) * 100) / 100, overlapCells: q.overlapCells, gapMm: q.gapMm || 0 }));
  const shape = { fill, sqft: Math.round(areaMm2 / 92903.04), widthMm: Math.min(xMm, yMm), lengthMm: Math.max(xMm, yMm), photos: placed2 };
  // Alignment: every pair of photos must share a good part of the smaller one's floor.
  let worstPair = 1, pair = null;
  for (let a = 0; a < placed.length; a++) for (let b = a + 1; b < placed.length; b++) {
    const r = overlap(placed[a].cells, placed[b].cells) / Math.min(placed[a].cells.size, placed[b].cells.size);
    if (r < worstPair) { worstPair = r; pair = [a, b]; }
  }
  if (pair && worstPair < minPairOverlap) return { ok: false, refused: null, misaligned: pair, pairOverlap: Math.round(worstPair * 100) / 100, ...shape };
  if (fill < minFill) return { ok: false, refused: null, ...shape };
  return {
    ok: true,
    areaMm2,
    fill,
    rectangle: fill >= rectFill, // false: the floor to tile is the union's area, not the rectangle's
    pairOverlap: Math.round(worstPair * 100) / 100,
    sqft: Math.round(areaMm2 / 92903.04),
    widthMm: Math.min(xMm, yMm),
    lengthMm: Math.max(xMm, yMm),
    boundsMm: { x0: i0 * cellMm, x1: (i1 + 1) * cellMm, y0: j0 * cellMm, y1: (j1 + 1) * cellMm },
    cells: union.size,
    // The far part of each mask is the least precise, so the combined range is never tighter than the worst photo's.
    plusMinusPct: Math.max(...photos.map((p) => p.plusMinusPct || 0)),
    photos: placed2,
  };
}
