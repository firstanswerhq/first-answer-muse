// Muse Spark checks SAM's work before a number goes out: it sees the photo with SAM's outlines drawn
// on it (plus a close-up of each) and must agree. If it doesn't, the customer gets a retake tip, not
// a number. Spark also answers in the customer's language, with every number still checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { measureAnything, stepDetail, checkPrompt, CHECK_SCHEMA } from '../src/anything.js';
import { checkImages, decodeDataUrl } from '../src/overlay.js';
import { parseSam } from '../src/muse.js';
import { camera, samSeg, ellipseShape } from './flatscene.js';
import { scene } from './scene.js';

const cam = camera({ tiltDeg: 25, D: 300, f: 1500 });
const coin = ellipseShape(-25, 0, 12.13, 12.13), chip = ellipseShape(8, 3, 7, 6);
const segs = { chip: samSeg(cam, chip.inside, chip.boundary), coin: samSeg(cam, coin.inside, coin.boundary) };
const READ = { task: 'windshield_chip', target: 'chip', second_target: '', ruler: 'quarter', item_width_in: 0, tile_w_in: 0, tile_l_in: 0, shoe_for: 'unknown', language: 'en', summary: '' };

// A plain gray JPEG the size of the scene's photo (no people, nothing personal).
function grayJpeg(W, H) {
  const data = Buffer.alloc(W * H * 4, 128);
  return `data:image/jpeg;base64,${Buffer.from(jpeg.encode({ width: W, height: H, data }, 80).data).toString('base64')}`;
}
const PHOTO = grayJpeg(cam.W, cam.H);
const agree = async (images, prompt, schema) => {
  const n = (prompt.match(/^- /gm) || []).length;
  return { outlines: Array.from({ length: n }, (_, i) => ({ color: i ? 'ORANGE' : 'MAGENTA', ok: true, seen: i ? 'a US quarter' : 'a small chip in the glass' })), problem: '', retake_tip: '' };
};
const run = (check, extra = {}) => measureAnything({ dataUrl: PHOTO, text: 'repair or replace?', deps: { read: async () => extra.read || READ, segment: async (_d, c) => segs[c], check, word: extra.word }, ...extra.opts });

test('Spark gets the photo with SAM’s outlines drawn on it and a close-up of each', async () => {
  let got = null;
  const r = await run(async (images, prompt, schema) => { got = { images, prompt, schema }; return agree(images, prompt, schema); });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.checked, 'agreed');
  assert.equal(got.images.length, 3);
  assert.ok(got.images.every((u) => /^data:image\/jpeg;base64,/.test(u)));
  assert.match(got.prompt, /MAGENTA outline: should be the chip/);
  assert.match(got.prompt, /ORANGE outline: should be a quarter \(24\.26 mm\)/);
  assert.equal(got.schema, CHECK_SCHEMA);
  // The overlay really has SAM's magenta outline at the chip's place.
  const ov = decodeDataUrl(got.images[0]);
  const b = segs.chip.objects[0].box, s = ov.width / cam.W;
  let magenta = 0;
  for (let y = Math.floor(b.y1 * s); y <= Math.ceil(b.y2 * s); y++) for (let x = Math.floor(b.x1 * s); x <= Math.ceil(b.x2 * s); x++) {
    const i = (y * ov.width + x) * 4;
    if (ov.data[i] > 200 && ov.data[i + 1] < 110 && ov.data[i + 2] > 160) magenta++;
  }
  assert.ok(magenta > 10, `magenta pixels at the chip: ${magenta}`);
  const step = r.pipeline.find((p) => /check SAM/.test(p.step));
  assert.equal(step.model, 'muse-spark-1.3');
  assert.match(stepDetail(step), /^agrees · measured: a small chip in the glass, ruler: a US quarter/);
});

test('Spark disagrees about the object: no number, a specific retake tip, outlines kept to show', async () => {
  const r = await run(async () => ({ outlines: [{ color: 'MAGENTA', ok: false, seen: 'a water spot' }, { color: 'ORANGE', ok: true, seen: 'a quarter' }], problem: 'The magenta outline is a water spot, not a chip.', retake_tip: 'Wipe the glass and retake close up with the chip in the middle.' }));
  assert.equal(r.ok, false);
  assert.equal(r.refused, 'spark-check');
  assert.equal(r.headline, null);
  assert.deepEqual(r.numbers, []);
  assert.match(r.ask, /didn’t measure.*outline of the thing to measure and saw a water spot, not the chip\. Wipe the glass/);
  assert.ok(r.overlay.outlines.length >= 2);
  assert.match(stepDetail(r.pipeline.find((p) => /check SAM/.test(p.step))), /^disagrees · The outline of the thing to measure is a water spot/);
});

test('Spark sees a different coin: the tip tells them how to say so', async () => {
  const r = await run(async () => ({ outlines: [{ color: 'MAGENTA', ok: true, seen: 'chip' }, { color: 'ORANGE', ok: false, seen: 'a dime' }], problem: 'That coin is a dime.', retake_tip: 'Use a quarter, about 24 mm.' }));
  assert.equal(r.ok, false);
  assert.match(r.ask, /looks like a dime, not a quarter.*“it’s a dime”/);
});

test('a numbered tip from Spark is never shown; ours is', async () => {
  const r = await run(async () => ({ outlines: [{ color: 'MAGENTA', ok: false, seen: 'a scratch' }, { color: 'ORANGE', ok: true, seen: 'quarter' }], problem: 'x', retake_tip: 'The chip is 0.4 in, retake.' }));
  assert.doesNotMatch(r.ask, /0\.4/);
  assert.match(r.ask, /Retake it with the chip whole/);
});

test('Spark slow or broken: the measurement goes out, and the panel says the check was skipped', async () => {
  const r = await run(() => new Promise(() => {}), { opts: { checkTimeoutMs: 200 } });
  assert.equal(r.ok, true);
  assert.equal(r.checked, 'skipped');
  assert.match(stepDetail(r.pipeline.find((p) => /check SAM/.test(p.step))), /check skipped \(no reply in 0\.2 s\)/);
});

test('the check and the wording run at the same time; each step keeps its own time', async () => {
  const wait = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  let t0 = Date.now();
  await run(agree, { word: async (_s, f) => JSON.parse(f).template_answer });
  const base = Date.now() - t0;
  t0 = Date.now();
  const r = await run(async (...a) => wait(400, await agree(...a)), { word: async (_s, f) => wait(400, JSON.parse(f).template_answer) });
  const took = Date.now() - t0;
  assert.ok(took < base + 650, `took ${took} ms (no-wait run ${base} ms; one after the other would be about ${base + 800})`);
  const steps = r.pipeline.filter((p) => /check SAM|word the answer/.test(p.step));
  assert.equal(steps.length, 2);
  assert.ok(steps.every((p) => p.ms >= 350), steps.map((p) => p.ms).join(','));
});

test('driveway: Spark checks the driveway and the garage door', async () => {
  const s = scene({ drive: { x0: -9, x1: 9, z0: 14, z1: 38 }, door: { x0: -8, x1: 8, z: 38 } });
  let prompt = '';
  const r = await measureAnything({ dataUrl: grayJpeg(s.frame.w, s.frame.h), text: 'how big is my driveway', deps: {
    read: async () => ({ ...READ, task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }),
    segment: async (_d, c) => (c === 'driveway' ? parseSam(s.driveText) : parseSam(s.doorText)),
    check: async (images, p, sc) => { prompt = p; return agree(images, p, sc); },
  } });
  assert.equal(r.ok, true, r.ask);
  assert.match(prompt, /MAGENTA outline: should be the whole driveway/);
  assert.match(prompt, /ORANGE outline: should be a double garage door \(16 × 7 ft\)/);
});

test('a photo that isn’t JPEG still gets checked (the plain photo, no drawn outlines)', () => {
  assert.equal(checkImages('data:image/png;base64,iVBORw0KGgo=', [{ role: 'target', obj: segs.chip.objects[0] }], { w: cam.W, h: cam.H }), null);
  assert.match(checkPrompt([{ role: 'target', expect: 'the chip' }], false), /^You check another model's work/);
});

test('Spanish question, Spanish answer: numbers and units still checked against ours', async () => {
  const es = { ...READ, language: 'es' };
  let system = '';
  const r = await run(agree, { read: es, word: async (sys, facts) => {
    system = sys;
    assert.ok(JSON.parse(facts).first_sentence_already_written);
    return 'Ponle cinta transparente y llévalo pronto al taller.';
  } });
  assert.match(system, /Write the message in Spanish/);
  assert.equal(r.wording, 'spark');
  assert.equal(r.language, 'es');
  assert.ok(r.answer.startsWith(r.verdictSentence));
  assert.match(r.answer, /Ponle cinta transparente y llévalo pronto al taller\.$/);
  assert.match(stepDetail(r.pipeline.find((p) => /word the answer/.test(p.step))), /used \(Spanish\)/);
  // A Spanish reply that flips the verdict or changes a number keeps the (English) template.
  const flipped = await run(agree, { read: es, word: async () => 'Esa grieta es más grande que una moneda, así que hay que cambiar el parabrisas.' });
  assert.equal(flipped.wording, 'template');
  const wrong = await run(agree, { read: es, word: async () => 'Esa grieta mide 2 pulgadas, así que se puede reparar.' });
  assert.equal(wrong.wording, 'template');
  const words = await run(agree, { read: es, word: async () => 'Esa grieta mide dos pulgadas, así que se puede reparar.' });
  assert.equal(words.wording, 'template');
});

test('a refused answer’s panel says the wording was not sent', async () => {
  const r = await run(async () => ({ outlines: [{ color: 'MAGENTA', ok: false, seen: 'a scratch' }, { color: 'ORANGE', ok: true, seen: 'quarter' }], problem: 'x', retake_tip: '' }), { word: async (_s, f) => JSON.parse(f).template_answer });
  assert.equal(r.ok, false);
  assert.match(stepDetail(r.pipeline.find((p) => /word the answer/.test(p.step))), /not sent: Spark’s check disagreed/);
  assert.equal(r.answer, null);
});

test('a refused answer shows no number in any step, or on the photo', async () => {
  const r = await run(async () => ({ outlines: [{ color: 'MAGENTA', ok: false, seen: 'the driveway' }, { color: 'ORANGE', ok: true, seen: 'quarter' }], problem: 'The outline covers the whole driveway.', retake_tip: '' }), { word: async (_s, f) => JSON.parse(f).first_sentence_already_written ? 'Put clear tape over it.' : 'x' });
  assert.equal(r.ok, false);
  const details = r.pipeline.map(stepDetail);
  const math = r.pipeline.filter((p) => p.model === 'first-answer math');
  assert.ok(math.length >= 1);
  for (const p of math) assert.equal(stepDetail(p), 'measured, but not sent: Spark disagreed with the outlines');
  // Only SAM's confidences may carry digits; no inches, mm, sq ft anywhere.
  for (const d of details) assert.doesNotMatch(d.replace(/conf \d\.\d\d|\d+ outlines?/g, ''), /\d/, d);
  assert.deepEqual(r.overlay.lines, []);
  const chk = details.find((d) => /disagrees/.test(d));
  assert.match(chk, /whole driveway; no number sent$/);
  assert.doesNotMatch(chk, /\.;/);
});
