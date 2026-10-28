// Face measuring against a gift card on the forehead, on a 3D test head with real depths:
// eyes 12 mm behind the forehead, nose 8, mouth 20. True sizes: eye centers 63 mm apart,
// eyes 30 wide, nose 34, mouth 50.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureFace, compareVisits } from '../src/face.js';
import { measureAnything, guessFromText } from '../src/anything.js';
import { headScene, typicalFace } from './facescene.js';

const scene = (opts = {}, over = {}) => headScene({ D: 400, ...opts, features: typicalFace(over) });
const run = (opts = {}, over = {}, extra = {}) => {
  const s = scene(opts, over);
  const o = s.objects;
  return measureFace({ card: o.card[0], eyes: o.eye, nose: o.nose[0], mouth: o.mouth[0], frame: s.frame, ...extra });
};
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) / want <= tol, `${what}: got ${got}, want ${want}`);

test('straight on at arm’s length: eye spacing within 3%, nose and mouth within 8%', () => {
  const f = run();
  assert.equal(f.ok, true, f.ask);
  near(f.numbers.eyeCenterDistanceMm, 63, 0.03, 'eye spacing');
  near(f.numbers.leftEyeWidthMm, 30, 0.08, 'eye width');
  near(f.numbers.noseWidthMm, 34, 0.08, 'nose');
  near(f.numbers.mouthWidthMm, 50, 0.08, 'mouth');
  near(f.distanceMm, 400, 0.05, 'phone distance');
  assert.equal(f.confidence, 'good');
  // a left-right claim is made only when the turn estimate is sharp enough; if made, it must say "same"
  assert.ok(f.symmetry === null || f.symmetry.midlineSame, JSON.stringify(f.symmetry));
  assert.equal(run({ D: 500 }).symmetry, null); // too far for a left-right claim
  const close = run({ D: 300 });
  assert.equal(close.symmetry.midlineSame, true, JSON.stringify(close.symmetry));
});

test('phone at 25, 40 and 50 cm: eye spacing within 3% every time', () => {
  for (const D of [250, 400, 500]) near(run({ D }).numbers.eyeCenterDistanceMm, 63, 0.03, `at ${D} mm`);
});

test('forehead sloping back 10–15 degrees does not shrink the numbers', () => {
  for (const slopeDeg of [10, 15]) {
    const f = run({}, { card: { slopeDeg } });
    assert.equal(f.ok, true, `${slopeDeg}°: ${f.ask}`);
    near(f.numbers.eyeCenterDistanceMm, 63, 0.03, `slope ${slopeDeg}`);
  }
});

test('normal small turns (3–5°) and phone tip (±10°) are not flagged', () => {
  for (const o of [{ yawDeg: 3 }, { yawDeg: -5 }, { pitchDeg: 10 }, { pitchDeg: -10 }]) {
    const f = run(o);
    assert.equal(f.ok, true, JSON.stringify(o) + f.ask);
    assert.ok(!f.fixes.join(' ').match(/turned/), JSON.stringify(o) + f.fixes.join(' '));
  }
});

test('head turned 12 degrees is caught and asks for a retake', () => {
  const f = run({ yawDeg: 12 });
  assert.equal(f.confidence, 'low');
  assert.match(f.fixes.join(' '), /turned/);
});

test('a slight turn with a nose that sticks out is not reported as an uneven face', () => {
  const f = run({ yawDeg: 5, D: 300 }, { noseD: -10 });
  assert.equal(f.ok, true, f.ask);
  assert.ok(f.symmetry === null || f.symmetry.midlineSame, JSON.stringify(f.symmetry));
});

test('a naturally uneven face, head straight: reported in mm, never called "turned"', () => {
  const f = run({ D: 300 }, { noseU: 4, eye: [{ u: -31.5, v: 0, a: 15, b: 6, d: 12 }, { u: 31.5, v: 0, a: 15, b: 6, d: 12 }] });
  assert.equal(f.ok, true, f.ask);
  assert.ok(!f.fixes.join(' ').match(/turned/));
  assert.equal(f.symmetry.midlineSame, false);
  near(f.symmetry.midlineDifferenceMm, 8, 0.25, 'midline difference');
});

test('left and right are the photo’s left and right', () => {
  // narrower eye on the person's left = photo right (u > 0 is the person's left... seen from the camera, +u is photo right)
  const f = run({}, { eye: [{ u: -31.5, v: 0, a: 15, b: 6, d: 12 }, { u: 31.5, v: 0, a: 13, b: 6, d: 12 }] });
  assert.equal(f.ok, true, f.ask);
  assert.ok(f.numbers.rightEyeWidthMm < f.numbers.leftEyeWidthMm, JSON.stringify(f.numbers));
  assert.ok(f.eyeCentersPx[0][0] < f.eyeCentersPx[1][0]);
});

test('head tilted sideways ±15° (roll) still measures right', () => {
  for (const rollDeg of [-15, 15]) near(run({ rollDeg }).numbers.eyeCenterDistanceMm, 63, 0.03, `roll ${rollDeg}`);
});

test('a small fingertip nick on a card corner doesn’t shift the numbers; a bigger one is refused', () => {
  for (const D of [300, 400]) {
    for (const r of [3, 4, 6]) {
      const f = run({ D }, { card: { hole: (du, dv) => Math.hypot(du - 42.8, dv + 27) < r } });
      if (f.ok) near(f.numbers.eyeCenterDistanceMm, 63, 0.03, `nick r=${r} at ${D}`);
    }
    const big = run({ D }, { card: { hole: (du, dv) => Math.hypot(du - 42.8, dv + 27) < 14 } });
    assert.equal(big.ok, false);
    assert.match(big.ask, /corner|edge/);
  }
});

test('a fingertip on the middle of the card (as instructed) is fine', () => {
  const f = run({}, { card: { hole: (du, dv) => Math.hypot(du, dv) < 9 } });
  assert.equal(f.ok, true, f.ask);
  near(f.numbers.eyeCenterDistanceMm, 63, 0.03, 'eye spacing');
});

test('eyebrows returned as extra "eyes" are ignored, and only the real eyes are outlined', async () => {
  const eye = [
    { u: -31.5, v: 0, a: 15, b: 6, d: 12 }, { u: 31.5, v: 0, a: 15, b: 6, d: 12 },
    { u: -32, v: 16, a: 25, b: 4, d: 4, c: 0.97 }, { u: 32, v: 16, a: 25, b: 4, d: 4, c: 0.97 },
  ];
  const f = run({}, { eye });
  assert.equal(f.ok, true, f.ask);
  near(f.numbers.eyeCenterDistanceMm, 63, 0.03, 'eye spacing');
  near(f.numbers.leftEyeWidthMm, 30, 0.08, 'eye width');
  const s = scene({}, { eye });
  const r = await endToEnd(s);
  assert.equal(r.overlay.outlines.filter((o) => o.label === 'eye').length, 2);
});

test('glasses lenses instead of eyes: asks to take glasses off', () => {
  const f = run({}, { eye: [{ u: -32, v: 0, a: 25, b: 20, d: 2 }, { u: 32, v: 0, a: 25, b: 20, d: 2 }] });
  assert.equal(f.ok, false);
  assert.match(f.ask, /glasses/);
});

test('one eye missed: asks for another photo, no blame on glasses', () => {
  const f = run({}, { eye: [{ u: -31.5, v: 0, a: 15, b: 6, d: 12 }] });
  assert.equal(f.ok, false);
  assert.doesNotMatch(f.ask, /glasses/);
});

test('no nose in the shot: measures, but makes no left-right claim', () => {
  const s = scene({ D: 300 });
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

async function endToEnd(s) {
  const o = s.objects;
  const seg = (list) => ({ objects: list || [], frame: s.frame });
  const deps = {
    read: async () => ({ task: 'face', target: 'face', second_target: '', ruler: 'card', item_width_in: 0, tile_w_in: 0, tile_l_in: 0, shoe_for: 'unknown', summary: '' }),
    segment: async (_d, c) => seg({ card: o.card, eye: o.eye, nose: o.nose, mouth: o.mouth }[c]),
  };
  return measureAnything({ dataUrl: 'x', text: 'measure my face', deps });
}

test('end to end: selfie + card comes back as a neutral face answer', async () => {
  const r = await endToEnd(scene());
  assert.equal(r.ok, true, r.ask);
  assert.match(r.headline, /^Eye centers \d+ mm apart$/);
  assert.match(r.note, /not a medical opinion/);
  assert.doesNotMatch(r.answer + r.steps.join(' '), /symmetric|compare visits| a 8/i);
  assert.equal(r.overlay.lines.length, 1);
  assert.deepEqual(r.overlay.outlines.map((o) => o.label).sort(), ['eye', 'eye', 'gift card', 'mouth', 'nose']);
});

test('"surface" is not a face; "distance between my eyes" is', () => {
  assert.notEqual(guessFromText('how big is this scratch on the surface').task, 'face');
  assert.equal(guessFromText('what is the distance between my eyes').task, 'face');
});

test('one eye missed but its eyebrow found: no fake asymmetry, no confident wrong number', () => {
  const eye = [{ u: -31.5, v: 0, a: 15, b: 6, d: 12 }, { u: -32, v: 16, a: 18, b: 4.5, d: 4 }, { u: 32, v: 16, a: 18, b: 4.5, d: 4 }];
  const f = run({ D: 300 }, { eye });
  assert.ok(!f.ok || (f.confidence !== 'good') || Math.abs(f.numbers.eyeCenterDistanceMm - 63) <= 2, JSON.stringify(f));
  if (f.ok && f.symmetry) assert.ok(f.symmetry.midlineDifferenceMm < 5, JSON.stringify(f.symmetry));
});

test('a 3–4° turn with a forward nose at 45 cm makes no left-right claim', () => {
  for (const yawDeg of [3, 4]) {
    const f = run({ D: 450, yawDeg }, { noseD: -10 });
    assert.equal(f.ok, true, f.ask);
    assert.ok(f.symmetry === null || f.symmetry.midlineSame, JSON.stringify(f.symmetry));
  }
});

test('a card stood on end asks to turn it level', () => {
  const f = run({}, { card: { a: 26.99, b: 42.8, v: 70 } });
  assert.equal(f.ok, false);
  assert.match(f.ask, /long edge/);
});

test('card set on 8° crooked on the forehead still measures', () => {
  for (const spinDeg of [8, -8]) {
    const f = run({}, { card: { spinDeg } });
    assert.equal(f.ok, true, `${spinDeg}°: ${f.ask}`);
    near(f.numbers.eyeCenterDistanceMm, 63, 0.05, `spin ${spinDeg}`);
  }
});

test('a straight, even face off to the side of the photo is never called uneven', () => {
  for (const offX of [-60, -40, 40, 60]) for (const D of [300, 400]) {
    const f = run({ D, offX }, { noseD: -15 });
    assert.equal(f.ok, true, f.ask);
    assert.ok(f.symmetry === null || f.symmetry.midlineSame, `offX ${offX} D ${D}: ${JSON.stringify(f.symmetry)}`);
  }
});

test('card running off the edge of the photo is refused', () => {
  const s = scene({ D: 250, offX: 90 }); // card end about 4 mm past the right edge of the photo
  const o = s.objects;
  const g = measureFace({ card: o.card[0], eyes: o.eye, nose: o.nose[0], mouth: o.mouth[0], frame: s.frame });
  assert.equal(o.card[0].box.x2 >= s.frame.w - 3, true);
  assert.equal(g.ok, false);
  assert.match(g.ask, /edge/);
});

test('text routing: only a person’s face goes to face mode', () => {
  for (const t of ['windshield chip at eye level', 'card at eye height', 'face of this cabinet', 'proportion of the room']) {
    assert.notEqual(guessFromText(t).task, 'face', t);
  }
  for (const t of ['how far apart are my pupils', 'measure my PD', 'measure my face', 'how far apart are my eyes']) {
    assert.equal(guessFromText(t).task, 'face', t);
  }
});

test('review B: covered card end, brows only, second face, narrow eyes', () => {
  // hair covering a 7 mm straight strip of one end
  const cut = run({}, { card: { hole: (du) => du > 42.8 - 7 } });
  assert.ok(!cut.ok || Math.abs(cut.numbers.eyeCenterDistanceMm - 63) <= 2, JSON.stringify(cut.numbers || cut.ask));
  // only eyebrows come back as "eyes"
  const brows = run({}, { eye: [{ u: -33, v: 16, a: 15, b: 4, d: 4 }, { u: 33, v: 16, a: 15, b: 4, d: 4 }] });
  assert.ok(!brows.ok || brows.confidence === 'low', JSON.stringify(brows.numbers || brows.ask));
  // a second, smaller-spaced face far to the side, user's own eyes missed
  const other = run({}, { eye: [{ u: 120, v: 0, a: 14, b: 6, d: 12 }, { u: 178, v: 0, a: 14, b: 6, d: 12 }] });
  assert.equal(other.ok, false);
  // narrow (6 mm tall) eye openings are accepted
  const narrow = run({}, { eye: [{ u: -31.5, v: 0, a: 15, b: 3, d: 12 }, { u: 31.5, v: 0, a: 15, b: 3, d: 12 }] });
  assert.equal(narrow.ok, true, narrow.ask);
});

test('review B routing', () => {
  for (const t of ['pupillary distance', 'what is my IPD', 'eye distance please', 'distance between eyes', "measure my kid's eyes"]) assert.equal(guessFromText(t).task, 'face', t);
  for (const t of ['is this shelf symmetrical', 'size my face mask', 'face shield size', 'my eye bolt', 'forehead thermometer', 'PD said the road is closed']) assert.notEqual(guessFromText(t).task, 'face', t);
});
