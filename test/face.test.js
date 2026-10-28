// Face measuring against a gift card on the forehead, checked on drawn scenes with known sizes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureFace, compareVisits } from '../src/face.js';
import { measureAnything } from '../src/anything.js';
import { camera, samSeg, rectShape, ellipseShape } from './flatscene.js';

// A face drawn on a plane, in mm: card 85.6 x 54 on the forehead, eyes 63 mm apart center to center.
function faceScene({ tiltDeg = 8, rightEyeW = 30, rightEyeX = 31.5, rollDeg = 0 } = {}) {
  const cam = camera({ tiltDeg, D: 450, f: 1500, panDeg: 3 });
  const rot = (x, y) => { const a = (rollDeg * Math.PI) / 180; return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]; };
  const at = (x, y) => rot(x, y);
  const shape = (fn, x, y, ...r) => { const [cx, cy] = at(x, y); return fn(cx, cy, ...r); };
  const s = (o) => samSeg(cam, o.inside, o.boundary).objects[0];
  return {
    card: s(shape(rectShape, 0, -65, 85.6, 53.98, rollDeg)),
    face: s(shape(ellipseShape, 0, 0, 72, 105)),
    eyes: [s(shape(ellipseShape, -31.5, -10, 15, 6)), s(shape(ellipseShape, rightEyeX, -10, rightEyeW / 2, 6))],
    nose: s(shape(ellipseShape, 0, 15, 17, 12)),
    mouth: s(shape(ellipseShape, 0, 45, 25, 8)),
  };
}
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) / want <= tol, `${what}: got ${got}, want ${want}`);

test('straight-on selfie: eye spacing, nose, mouth and face width within 3%', () => {
  const sc = faceScene();
  const f = measureFace(sc);
  assert.equal(f.ok, true, f.ask);
  near(f.numbers.eyeCenterDistanceMm, 63, 0.03, 'eye spacing');
  near(f.numbers.noseWidthMm, 34, 0.04, 'nose');
  near(f.numbers.mouthWidthMm, 50, 0.04, 'mouth');
  near(f.numbers.faceWidthMm, 144, 0.03, 'face width');
  assert.ok(f.symmetry.overallPct >= 95, `symmetry ${f.symmetry.overallPct}`);
  assert.equal(f.confidence, 'good');
  assert.match(f.note, /not a medical opinion/);
});

test('a tilted head (roll) still measures right', () => {
  const f = measureFace(faceScene({ rollDeg: 12 }));
  near(f.numbers.eyeCenterDistanceMm, 63, 0.03, 'eye spacing');
});

test('a turned head is flagged with the exact fix', () => {
  const f = measureFace(faceScene({ rightEyeW: 22, rightEyeX: 24 }));
  assert.equal(f.confidence, 'low');
  assert.match(f.fixes.join(' '), /face the camera straight on/i);
});

test('visits compare and flag changes over 2 mm', () => {
  const a = { numbers: { mouthWidthMm: 50, noseWidthMm: 34 } };
  const b = { numbers: { mouthWidthMm: 53, noseWidthMm: 34.5 } };
  const c = compareVisits(a, b);
  assert.equal(c.find((x) => x.measure === 'mouthWidthMm').changed, true);
  assert.equal(c.find((x) => x.measure === 'noseWidthMm').changed, false);
});

test('end to end: a selfie with a card comes back as a face answer', async () => {
  const sc = faceScene();
  const seg = (o) => ({ objects: o ? [].concat(o) : [], frame: { w: 1280, h: 960 } });
  const deps = { read: async () => ({ task: 'face', target: 'face', second_target: '', ruler: 'card', item_width_in: 0, tile_w_in: 0, tile_l_in: 0, shoe_for: 'unknown', summary: '' }),
    segment: async (_d, c) => seg({ card: sc.card, face: sc.face, eye: sc.eyes, nose: sc.nose, mouth: sc.mouth }[c]) };
  const r = await measureAnything({ dataUrl: 'x', text: 'measure my face', deps });
  assert.equal(r.ok, true, r.ask);
  assert.match(r.headline, /% symmetric$/);
  assert.match(r.note, /not a medical opinion/);
  assert.ok(r.numbers.some((n) => n.label === 'Eye center to eye center'));
});
