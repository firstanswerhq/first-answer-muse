// Close-up measuring with everyday rulers, checked against scenes with known answers: a camera tilted
// over a flat surface photographs a ruler (gift card, paper, dollar, coin) and a stain or a crack of
// known size. We draw what SAM would return, measure, and compare with the truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSam } from '../src/muse.js';
import { measureFlat, FLAT_REFERENCES } from '../src/flat.js';
import { encodeSegmentationMask } from '../node_modules/@meta-sam/parser/dist/mask-codec.js';

// Camera over the plane z=0 (units: mm). Tilt in degrees around the x axis, distance D from the
// center of view, focal length f in pixels, photo W x H.
function camera({ tiltDeg = 30, D = 380, f = 1400, W = 1280, H = 960, panDeg = 10 }) {
  const t = (tiltDeg * Math.PI) / 180, p = (panDeg * Math.PI) / 180;
  // camera axes in world coords: looks toward the plane from above and to the side
  const fwd = [Math.sin(t) * Math.sin(p), Math.sin(t) * Math.cos(p), -Math.cos(t)];
  const C = fwd.map((v) => -v * D); // camera center
  const up0 = [0, 0, 1];
  const right = norm(cross(fwd, up0).every((v) => Math.abs(v) < 1e-9) ? [1, 0, 0] : cross(fwd, up0));
  const down = norm(cross(fwd, right));
  const project = ([X, Y]) => {
    const d = [X - C[0], Y - C[1], 0 - C[2]];
    const z = dot(d, fwd), x = dot(d, right), y = dot(d, down);
    return [W / 2 + (f * x) / z, H / 2 + (f * y) / z];
  };
  const unproject = ([u, v]) => {
    const dir = add(add(fwd, scale(right, (u - W / 2) / f)), scale(down, (v - H / 2) / f));
    const s = -C[2] / dir[2];
    return [C[0] + s * dir[0], C[1] + s * dir[1]];
  };
  return { project, unproject, W, H };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map((v) => v * s);

// A SAM record for a shape on the plane, given by an inside() test and some boundary points.
function samFor(cam, inside, boundary) {
  const img = boundary.map(cam.project);
  let x1 = Math.floor(Math.min(...img.map((p) => p[0]))) - 2, x2 = Math.ceil(Math.max(...img.map((p) => p[0]))) + 2;
  let y1 = Math.floor(Math.min(...img.map((p) => p[1]))) - 2, y2 = Math.ceil(Math.max(...img.map((p) => p[1]))) + 2;
  x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(cam.W - 1, x2); y2 = Math.min(cam.H - 1, y2);
  const w = x2 - x1 + 1, h = y2 - y1 + 1;
  const r = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) r[j * w + i] = inside(cam.unproject([x1 + i + 0.5, y1 + j + 0.5])) ? 1 : 0;
  const m = encodeSegmentationMask(r, w, h);
  const text = `<0f>0<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${cam.W};h=${cam.H};c=0.95|><|mask;x=0;y=0;c=0.95;data=${m.height},${m.width},${m.payload}|>`;
  return parseSam(text).objects[0];
}

const rectShape = (cx, cy, L, S, rotDeg) => {
  const a = (rotDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const inside = ([x, y]) => { const dx = x - cx, dy = y - cy; const u = dx * c + dy * s, v = -dx * s + dy * c; return Math.abs(u) <= L / 2 && Math.abs(v) <= S / 2; };
  const boundary = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [cx + (i * L / 2) * c - (j * S / 2) * s, cy + (i * L / 2) * s + (j * S / 2) * c]);
  return { inside, boundary };
};
const ellipseShape = (cx, cy, a, b) => ({
  inside: ([x, y]) => ((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 <= 1,
  boundary: Array.from({ length: 36 }, (_, k) => [cx + a * Math.cos((k * Math.PI) / 18), cy + b * Math.sin((k * Math.PI) / 18)]),
});

const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) / want <= tol, `${what}: got ${got}, want ${want}`);

test('a gift card on a tilted surface measures a stain within 3%', () => {
  const cam = camera({ tiltDeg: 35 });
  const card = rectShape(-70, 10, 85.6, 53.98, 15);
  const stain = ellipseShape(40, -5, 40, 25); // area = pi*40*25 = 3141.6 mm^2, length 80 mm
  const m = measureFlat({ target: samFor(cam, stain.inside, stain.boundary), ref: samFor(cam, card.inside, card.boundary), refKind: 'card' });
  assert.equal(m.ok, true);
  near(m.areaMm2, Math.PI * 40 * 25, 0.03, 'area');
  near(m.lengthMm, 80, 0.03, 'length');
  assert.equal(m.confidence, 'good');
});

test('a sheet of paper on the floor measures a big stain within 3%', () => {
  const cam = camera({ tiltDeg: 40, D: 1500, f: 1100 });
  const paper = rectShape(-250, 0, 279.4, 215.9, -8);
  const stain = ellipseShape(220, 40, 180, 110);
  const m = measureFlat({ target: samFor(cam, stain.inside, stain.boundary), ref: samFor(cam, paper.inside, paper.boundary), refKind: 'paper_letter' });
  near(m.areaMm2, Math.PI * 180 * 110, 0.03, 'area');
  near(m.lengthMm, 360, 0.03, 'length');
});

test('a quarter right beside a crack gives its length and width', () => {
  const cam = camera({ tiltDeg: 20, D: 320, f: 1500 });
  const coin = ellipseShape(-30, 0, 12.13, 12.13);
  const crack = rectShape(10, 5, 50, 3, 25); // 50 mm long, 3 mm wide, starting next to the coin
  const m = measureFlat({ target: samFor(cam, crack.inside, crack.boundary), ref: samFor(cam, coin.inside, coin.boundary), refKind: 'quarter' });
  near(m.lengthMm, 50, 0.05, 'length');
  near(m.widthMm, 3, 0.15, 'width');
  assert.ok(m.tiltDeg >= 12 && m.tiltDeg <= 28, `tilt ${m.tiltDeg}`);
});

test('a coin far from a big target at an angle is flagged, not trusted', () => {
  const cam = camera({ tiltDeg: 25, D: 300, f: 1500 });
  const coin = ellipseShape(-55, 0, 12.13, 12.13);
  const crack = rectShape(30, 5, 90, 3, 25);
  const m = measureFlat({ target: samFor(cam, crack.inside, crack.boundary), ref: samFor(cam, coin.inside, coin.boundary), refKind: 'quarter' });
  assert.equal(m.confidence, 'low');
  assert.match(m.notes.join(' '), /sheet of paper or a gift card/);
});

test('a dollar bill works the same way', () => {
  const cam = camera({ tiltDeg: 20, D: 500, f: 1300 });
  const bill = rectShape(-100, 0, 156, 66.3, 5);
  const spot = ellipseShape(60, 10, 30, 30);
  const m = measureFlat({ target: samFor(cam, spot.inside, spot.boundary), ref: samFor(cam, bill.inside, bill.boundary), refKind: 'dollar' });
  near(m.areaMm2, Math.PI * 900, 0.03, 'area');
});

test('every ruler has a real size and a SAM prompt', () => {
  for (const [k, r] of Object.entries(FLAT_REFERENCES)) {
    assert.ok(r.samConcept, k);
    assert.ok(r.shape === 'circle' ? r.diameter > 0 : r.long > r.short, k);
  }
});
