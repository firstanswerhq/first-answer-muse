// Face measuring against a gift card on the forehead, on a 3D test head with real depths:
// eyes 12 mm behind the forehead, nose 8, mouth 20. True sizes: eye centers 63 mm apart,
// eyes 30 wide, nose 34, mouth 50.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureFace, compareVisits } from '../src/face.js';
import { measureAnything } from '../src/anything.js';
import { headScene, typicalFace } from './facescene.js';

const run = (opts = {}, over = {}) => {
  const s = headScene({ ...opts, features: typicalFace(over) });
  const o = s.objects;
  return measureFace({ card: o.card[0], eyes: o.eye, nose: o.nose[0], mouth: o.mouth[0], frame: s.frame });
};
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) / want <= tol, `${what}: got ${got}, want ${want}`);

test('straight on at arm’s length: eye spacing within 3%, nose and mouth within 5%', () => {
  const f = run({ D: 400 });
  assert.equal(f.ok, true, f.ask);
  near(f.numbers.eyeCenterDistanceMm, 63, 0.03, 'eye spacing');
  near(f.numbers.leftEyeWidthMm, 30, 0.07, 'eye width');
  near(f.numbers.noseWidthMm, 34, 0.05, 'nose');
  near(f.numbers.mouthWidthMm, 50, 0.05, 'mouth');
  near(f.distanceMm, 400, 0.05, 'phone distance');
  assert.equal(f.confidence, 'good');
  assert.ok(f.symmetry.midlineDifferenceMm <= 1, JSON.stringify(f.symmetry));
  assert.equal(f.numbers.faceWidthMm, undefined); // not reported: hair/beard/ears make it unreliable
});

test('phone closer or farther: eye spacing stays within 3%, so visits stay comparable', () => {
  const a = run({ D: 300 }), b = run({ D: 500 });
  near(a.numbers.eyeCenterDistanceMm, 63, 0.03, 'at 300 mm');
  near(b.numbers.eyeCenterDistanceMm, 63, 0.03, 'at 500 mm');
  assert.ok(Math.abs(a.numbers.eyeCenterDistanceMm - b.numbers.eyeCenterDistanceMm) <= 2);
});

test('head turned 15 degrees is caught from the card and asks for a retake', () => {
  const f = run({ D: 400, yawDeg: 15 });
  assert.equal(f.confidence, 'low');
  assert.match(f.fixes.join(' '), /turned/);
});

test('a naturally uneven face is NOT told its head is turned', () => {
  // nose 3 mm off center, one eye 3 mm narrower, head straight
  const f = run({ D: 400 }, { noseU: 3, eye: [{ u: -31.5, v: 0, a: 15, b: 6, d: 12 }, { u: 31.5, v: 0, a: 13.5, b: 6, d: 12 }] });
  assert.equal(f.ok, true, f.ask);
  assert.ok(!f.fixes.join(' ').match(/turned/), f.fixes.join(' '));
  assert.ok(f.symmetry.midlineDifferenceMm >= 4 && f.symmetry.midlineDifferenceMm <= 8, JSON.stringify(f.symmetry));
});

test('head tilted sideways (roll) still measures right', () => {
  near(run({ D: 400, rollDeg: 10 }).numbers.eyeCenterDistanceMm, 63, 0.03, 'eye spacing');
});

test('eyebrows returned as extra "eyes" are ignored', () => {
  const eye = [
    { u: -31.5, v: 0, a: 15, b: 6, d: 12 }, { u: 31.5, v: 0, a: 15, b: 6, d: 12 },
    { u: -32, v: 16, a: 25, b: 4, d: 4, c: 0.97 }, { u: 32, v: 16, a: 25, b: 4, d: 4, c: 0.97 }, // eyebrows, more confident
  ];
  const f = run({ D: 400 }, { eye });
  assert.equal(f.ok, true, f.ask);
  near(f.numbers.eyeCenterDistanceMm, 63, 0.03, 'eye spacing');
  near(f.numbers.leftEyeWidthMm, 30, 0.07, 'eye width');
});

test('glasses lenses instead of eyes: asks, never a confident wrong number', () => {
  const f = run({ D: 400 }, { eye: [{ u: -32, v: 0, a: 25, b: 20, d: 2 }, { u: 32, v: 0, a: 25, b: 20, d: 2 }] });
  assert.equal(f.ok, false);
  assert.match(f.ask, /glasses/);
});

test('one eye missed: asks for another photo', () => {
  const f = run({ D: 400 }, { eye: [{ u: -31.5, v: 0, a: 15, b: 6, d: 12 }] });
  assert.equal(f.ok, false);
});

test('a fingertip over a card corner is refused, not trusted', () => {
  const card = { hole: (du, dv) => Math.hypot(du - 42.8, dv + 27) < 14 };
  const f = run({ D: 400 }, { card });
  assert.equal(f.ok, false);
  assert.match(f.ask, /corners/);
});

test('no nose in the shot: measures, but makes no left-right claim', () => {
  const s = headScene({ D: 400, features: typicalFace() });
  const o = s.objects;
  const f = measureFace({ card: o.card[0], eyes: o.eye, nose: null, mouth: o.mouth[0], frame: s.frame });
  assert.equal(f.ok, true, f.ask);
  assert.equal(f.symmetry, null);
});

test('visits: compared only at a similar distance; flags real changes only', () => {
  const a = { distanceMm: 400, numbers: { mouthWidthMm: 50, noseWidthMm: 34 } };
  const b = { distanceMm: 410, numbers: { mouthWidthMm: 55, noseWidthMm: 35 } };
  const c = compareVisits(a, b);
  assert.equal(c.rows.find((x) => x.measure === 'mouthWidthMm').changed, true);
  assert.equal(c.rows.find((x) => x.measure === 'noseWidthMm').changed, false);
  assert.equal(compareVisits(a, { ...b, distanceMm: 520 }).ok, false);
});

test('end to end: selfie + card comes back as a neutral face answer', async () => {
  const s = headScene({ D: 400, features: typicalFace() });
  const o = s.objects;
  const seg = (list) => ({ objects: list || [], frame: s.frame });
  const deps = {
    read: async () => ({ task: 'face', target: 'face', second_target: '', ruler: 'card', item_width_in: 0, tile_w_in: 0, tile_l_in: 0, shoe_for: 'unknown', summary: '' }),
    segment: async (_d, c) => seg({ card: o.card, face: o.face, eye: o.eye, nose: o.nose, mouth: o.mouth }[c]),
  };
  const r = await measureAnything({ dataUrl: 'x', text: 'measure my face', deps });
  assert.equal(r.ok, true, r.ask);
  assert.match(r.headline, /^Eye centers \d+ mm apart$/);
  assert.match(r.note, /not a medical opinion/);
  assert.doesNotMatch(r.answer + r.steps.join(' '), /symmetric|compare visits/i);
  assert.equal(r.overlay.lines.length, 1);
});

test('"surface" is not a face', async () => {
  const { guessFromText } = await import('../src/anything.js');
  assert.notEqual(guessFromText('how big is this scratch on the surface').task, 'face');
});
