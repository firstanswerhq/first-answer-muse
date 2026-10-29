// Measure anything, end to end with stand-ins for Muse Spark and SAM: scenes with known answers
// (a chip beside a quarter, a foot on paper, a floor with paper on it, a side yard), and we check the
// answer a person would read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureAnything, guessFromText, shoeSize, chipVerdict } from '../src/anything.js';
import { camera, samSeg, rectShape, ellipseShape } from './flatscene.js';
import { camera3d, render } from './scene3d.js';

const EMPTY = { objects: [], frame: { w: 1280, h: 960 } };
const deps = (read, byConcept) => ({
  read: async () => read,
  segment: async (_d, concept) => byConcept[concept] || EMPTY,
});
const R = (o) => ({ task: 'size', target: 'object', second_target: '', ruler: 'card', item_width_in: 0, tile_w_in: 0, tile_l_in: 0, shoe_for: 'unknown', summary: '', ...o });

test('windshield chip next to a quarter: smaller than a quarter means repair', async () => {
  const cam = camera({ tiltDeg: 25, D: 300, f: 1500 });
  const coin = ellipseShape(-25, 0, 12.13, 12.13), chip = ellipseShape(8, 3, 7, 6); // 14 mm chip
  const r = await measureAnything({
    dataUrl: 'x', text: 'repair or replace?',
    deps: deps(R({ task: 'windshield_chip', target: 'chip', ruler: 'quarter' }), { chip: samSeg(cam, chip.inside, chip.boundary), coin: samSeg(cam, coin.inside, coin.boundary) }),
  });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.headline, 'Repair it');
  assert.match(r.answer, /smaller than a quarter/);
  assert.ok(r.overlay.outlines.length === 2 && r.overlay.lines.length === 1);
});

test('a long crack is replace', () => {
  assert.equal(chipVerdict({ lengthMm: 200, widthMm: 2 }).repair, false);
  assert.equal(chipVerdict({ lengthMm: 120, widthMm: 2 }).repair, true);
  assert.equal(chipVerdict({ lengthMm: 30, widthMm: 25 }).repair, false);
});

test('foot on a sheet of paper gives the shoe size', async () => {
  const cam = camera({ tiltDeg: 15, D: 900, f: 1100 });
  const paper = rectShape(0, 0, 279.4, 215.9, 90); // paper long side running up the photo
  const foot = ellipseShape(0, 0, 50, 132); // 264 mm foot (10.4 in)
  const r = await measureAnything({
    dataUrl: 'x', text: 'what shoe size am I? (men)',
    deps: deps(R({ task: 'shoe_size', target: 'foot', ruler: 'paper_letter', shoe_for: 'men' }), { foot: samSeg(cam, foot.inside, foot.boundary), 'sheet of paper': samSeg(cam, paper.inside, paper.boundary) }),
  });
  assert.equal(r.ok, true, r.ask);
  const want = shoeSize(264, 'men');
  assert.ok(Math.abs(parseFloat(r.headline.replace('Size ', '')) - want.men) <= 0.5, `${r.headline} vs ${want.men}`);
  assert.ok(r.steps.length >= 3);
});

test('a floor with a sheet of paper on it gives a tile count and a cut list', async () => {
  const cam = camera({ tiltDeg: 35, D: 4500, f: 1100, panDeg: 5 }); // phone held in the doorway, whole floor in the shot
  const floor = rectShape(0, 0, 3658, 3048, 0); // 12 x 10 ft
  const paper = rectShape(300, 200, 279.4, 215.9, 20);
  const r = await measureAnything({
    dataUrl: 'x', text: 'how much 12x12 tile for this floor',
    deps: deps(R({ task: 'floor_tile', target: 'floor', ruler: 'paper_letter', tile_w_in: 12, tile_l_in: 12 }), { floor: samSeg(cam, floor.inside, floor.boundary), 'sheet of paper': samSeg(cam, paper.inside, paper.boundary) }),
  });
  assert.equal(r.ok, true, r.ask);
  const area = r.numbers.find((n) => n.label === 'Area').value;
  assert.ok(Math.abs(parseFloat(area) - 120) / 120 < 0.07, `area ${area}`);
  assert.match(r.numbers.find((n) => n.label === 'Floor').value, /^(9 ft 1[01] in|10 ft( [01] in)?) × 1[12] ft/);
  assert.match(r.headline, /^Buy \d+ tiles$/);
  assert.ok(r.shopping.length >= 3 && r.steps.some((s) => /cut each tile/.test(s)));
});

test('will a 12 ft shed fit between the fence and the house? (13.5 ft gap)', async () => {
  const cam = camera3d({ pitchDeg: 12 });
  const { objects } = render(cam, [
    { name: 'fence', axis: 'x', at: -6, from: 8, to: 60, top: 6 },
    { name: 'house', axis: 'x', at: 7.5, from: 8, to: 60, top: 10 },
    { name: 'door', axis: 'z', at: 40, from: -1.5, to: 1.5, top: 80 / 12 },
  ]);
  const seg = (o) => ({ objects: [o], frame: { w: cam.W, h: cam.H } });
  const r = await measureAnything({
    dataUrl: 'x', text: 'Will a 12 ft wide shed fit between my fence and the house?',
    deps: deps(R({ task: 'gap_fit', target: 'fence', second_target: 'house wall', ruler: 'interior_door' }), { fence: seg(objects.fence), 'house wall': seg(objects.house), door: seg(objects.door) }),
  });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.headline, 'Fits');
  assert.match(r.answer, /12 ft wide one fits/);
});

test('a floor that runs off the photo is flagged, not trusted', async () => {
  const cam = camera({ tiltDeg: 35, D: 2500, f: 1100, panDeg: 5 });
  const floor = rectShape(0, 0, 3658, 3048, 0), paper = rectShape(-100, 150, 279.4, 215.9, 15);
  const r = await measureAnything({
    dataUrl: 'x', text: 'tile for this floor',
    deps: deps(R({ task: 'floor_tile', target: 'floor', ruler: 'paper_letter' }), { floor: samSeg(cam, floor.inside, floor.boundary), 'sheet of paper': samSeg(cam, paper.inside, paper.boundary) }),
  });
  assert.equal(r.confidence, 'low');
  assert.match(r.ask, /step back/);
});

test('no ruler in the shot: it asks for one, plainly', async () => {
  const cam = camera({});
  const spot = ellipseShape(0, 0, 20, 15);
  const r = await measureAnything({ dataUrl: 'x', text: 'how big is this', deps: deps(R({}), { object: samSeg(cam, spot.inside, spot.boundary) }) });
  assert.equal(r.ok, false);
  assert.match(r.ask, /gift card or a quarter/);
});

test('reading the message without the model', () => {
  assert.equal(guessFromText('Will a 12 ft shed fit between the fence and house').item_width_in, 144);
  assert.equal(guessFromText('what shoe size am I').task, 'shoe_size');
  const t = guessFromText('how many 12x24 tile for my kitchen floor');
  assert.equal(t.task, 'floor_tile');
  assert.deepEqual([t.tile_w_in, t.tile_l_in], [12, 24]);
});

test('a square coaster next to a coin: two sides, not the diagonal; "it’s a quarter" fixes the coin', async () => {
  const cam = camera({ tiltDeg: 10, D: 450, f: 1400 });
  const coaster = rectShape(-20, 0, 70, 70, 8), coin = ellipseShape(45, 10, 12.13, 12.13);
  const scene = { coaster: samSeg(cam, coaster.inside, coaster.boundary), coin: samSeg(cam, coin.inside, coin.boundary) };
  // The model says dime; the person says it's a quarter.
  const r = await measureAnything({ dataUrl: 'x', text: 'how big is this? it’s a quarter', deps: deps(R({ target: 'coaster', ruler: 'dime' }), scene) });
  assert.equal(r.ok, true, r.ask);
  assert.match(r.headline, /square$/);
  const side = r.numbers.find((n) => n.label === 'Long side').value;
  assert.match(side, /2\.75 in|2\.7\d? in|2\.8 in/, side); // 70 mm = 2.76 in
  assert.equal(r.overlay.outlines.find((o) => o.role === 'ruler').label, 'quarter');
  assert.match(r.ask, /quarter as the ruler/);
  // Believing it's a dime instead makes everything about 26% smaller — which is why the answer names the coin.
  const d = await measureAnything({ dataUrl: 'x', text: 'how big is this', deps: deps(R({ target: 'coaster', ruler: 'dime' }), scene) });
  assert.match(d.ask, /dime as the ruler/);
});

test('coins from other countries are named and sized', async () => {
  const { coinFromText } = await import('../src/anything.js');
  const { FLAT_REFERENCES } = await import('../src/flat.js');
  assert.equal(coinFromText("it's a loonie"), 'loonie');
  assert.equal(coinFromText('canadian quarter next to it'), 'ca_quarter');
  assert.equal(coinFromText('used a toonie'), 'toonie');
  assert.equal(coinFromText('a 2 euro coin'), 'euro_2');
  assert.equal(coinFromText('quarter'), 'quarter');
  assert.equal(FLAT_REFERENCES.loonie.diameter, 26.5);
  assert.ok(FLAT_REFERENCES.ca_quarter.diameter < FLAT_REFERENCES.quarter.diameter);
});

test('a ± range never rounds an end onto the measured value', async () => {
  const { rangeIn } = await import('../src/anything.js');
  // 0.5625 in ± 4%: sixteenths would give "0.5 in – 0.56 in".
  const mm = 0.5625 * 25.4;
  const r = rangeIn(mm, mm * 0.04);
  assert.equal(r, '0.54 in – 0.59 in');
  assert.equal(rangeIn(254, 254 * 0.03), '9.75 in – 10.25 in');
});

test('face measuring is off by default: a polite "not available", no SAM call', async () => {
  delete process.env.SIGHT_FACE;
  let samCalls = 0;
  const r = await measureAnything({ dataUrl: 'x', text: 'Gift card on my forehead, measure my eye spacing', deps: { read: async () => ({ task: 'face', target: 'face', second_target: '', ruler: 'card', item_width_in: 0, tile_w_in: 0, tile_l_in: 0, shoe_for: 'unknown', language: 'en', summary: '' }), segment: async () => { samCalls++; return { objects: [], frame: null }; } } });
  assert.equal(r.ok, false);
  assert.equal(r.unavailable, 'face');
  assert.match(r.ask, /isn’t available here/);
  assert.equal(samCalls, 0);
  // Without a key too (text only).
  const t = await measureAnything({ dataUrl: 'x', text: 'measure my pupillary distance' });
  assert.equal(t.unavailable, 'face');
});

test('the face sample is hidden from the chip list unless SIGHT_FACE=1', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { listSamples } = await import('../src/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'samples-'));
  for (const id of ['face', 'tile']) { fs.writeFileSync(path.join(dir, `${id}.jpg`), 'x'); fs.writeFileSync(path.join(dir, `${id}.txt`), `${id}\nmsg`); }
  delete process.env.SIGHT_FACE;
  assert.deepEqual(listSamples(dir).map((s) => s.id), ['tile']);
  process.env.SIGHT_FACE = '1';
  assert.deepEqual(listSamples(dir).map((s) => s.id), ['face', 'tile']);
  delete process.env.SIGHT_FACE;
});
