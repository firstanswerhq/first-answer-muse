// The Driveway chip: driveways, patios and slabs go to the square-feet engine (src/measure.js) with the
// garage door as the ruler, never to the flat "size" path that would read the door as a sheet of paper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureAnything, guessFromText, sealerNeeded } from '../src/anything.js';
import { parseSam } from '../src/muse.js';
import { scene } from './scene.js';

const R = (o) => ({ task: 'size', target: 'object', second_target: '', ruler: 'card', item_width_in: 0, tile_w_in: 0, tile_l_in: 0, shoe_for: 'unknown', summary: '', ...o });
const EMPTY = { objects: [], frame: { w: 900, h: 1200 } };
const driveway = (opts) => {
  const s = scene(opts);
  return { driveway: parseSam(s.driveText), 'garage door': parseSam(s.doorText) };
};
const deps = (read, byConcept, asked = []) => ({
  read: async () => read,
  segment: async (_d, concept) => { asked.push(concept); return byConcept[concept] || EMPTY; },
});
const TWO_CAR = { drive: { x0: -9, x1: 9, z0: 14, z1: 38 }, door: { x0: -8, x1: 8, z: 38 } }; // 18 x 24 ft = 432 sq ft

test('driveway, patio and sealer requests are read as square feet, tile floors are not', () => {
  for (const t of ['How big is my driveway? I need to know how much sealer to buy.', 'how many square feet is my patio', 'seal my concrete slab', 'how much asphalt sealer for the blacktop']) assert.equal(guessFromText(t).task, 'surface_area', t);
  assert.equal(guessFromText('how much tile for my concrete floor').task, 'floor_tile');
  assert.equal(guessFromText('what shoe size am I? my foot is on paper').task, 'shoe_size');
  assert.notEqual(guessFromText('how many square feet is this').task, 'shoe_size');
});

test('the Driveway chip: Spark says "size", the text says driveway: measured in sq ft against the garage door', async () => {
  const asked = [];
  const r = await measureAnything({
    dataUrl: 'x', text: 'How big is my driveway? I need to know how much sealer to buy.',
    deps: deps(R({ task: 'size', target: 'garage door', ruler: 'card' }), driveway(TWO_CAR), asked),
  });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.task, 'surface_area');
  assert.deepEqual(asked.sort(), ['driveway', 'garage door']);
  const sqft = parseFloat(r.headline.replace(/[^\d.]/g, ''));
  assert.ok(Math.abs(sqft - 432) / 432 < 0.12, `got ${r.headline}`);
  assert.equal(r.confidence, 'good');
  assert.ok(r.surface.low <= 432 && r.surface.high >= 432, 'range covers the truth');
  assert.match(r.numbers.find((n) => n.label === 'Range').value, /^\d[\d,]* – \d[\d,]* sq ft$/);
  // Sealer is bought for the high end of the range.
  const gallons = Math.ceil(r.surface.high / 200);
  assert.equal(r.numbers.find((n) => n.label === 'Concrete sealer').value, `${gallons} gallons per coat`);
  assert.ok(r.shopping.some((s) => /Asphalt sealer: \d+ five-gallon pails/.test(s)));
  assert.equal(r.overlay.outlines.length, 2);
  assert.ok(r.overlay.outlines.some((o) => o.role === 'ruler' && /garage door/.test(o.label)));
});

test('Spark files it as surface_area directly; "asphalt" in the message gives pails only', async () => {
  const r = await measureAnything({
    dataUrl: 'x', text: 'how much sealer for my asphalt driveway',
    deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), driveway(TWO_CAR)),
  });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.surface.kind, 'asphalt');
  assert.ok(!r.numbers.some((n) => n.label === 'Concrete sealer'));
  assert.match(r.answer, /pails? of asphalt sealer/);
});

test('no garage door in the shot: asks for one instead of guessing', async () => {
  const s = driveway(TWO_CAR);
  const r = await measureAnything({
    dataUrl: 'x', text: 'how big is my driveway',
    deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), { driveway: s.driveway }),
  });
  assert.equal(r.ok, false);
  assert.match(r.ask, /garage door in the shot/);
});

test('a steep side angle is never a confident wrong driveway number', async () => {
  const r = await measureAnything({
    dataUrl: 'x', text: 'how big is my driveway',
    deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), driveway({ yawDeg: 25, camX: -8, drive: { x0: -9, x1: 9, z0: 16, z1: 40 }, door: { x0: -8, x1: 8, z: 40 } })),
  });
  if (r.ok) {
    const off = Math.abs(r.surface.sqft - 432) / 432;
    assert.ok(r.confidence !== 'good' || off < 0.2, `${r.surface.sqft} marked good`);
    if (r.confidence === 'low') assert.match(r.ask, /straight on/);
  }
});

test('sealer math rounds up', () => {
  assert.deepEqual(sealerNeeded(401, 'concrete').map((x) => x.qty), [3]);
  assert.deepEqual(sealerNeeded(600, 'asphalt').map((x) => x.qty), [2]);
  assert.equal(sealerNeeded(100).length, 2);
});

test('every answer for a business carries job size, materials and a quote line with no invented price', async () => {
  const r = await measureAnything({
    dataUrl: 'x', text: 'how big is my driveway',
    deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), driveway(TWO_CAR)),
  });
  assert.match(r.business.job, /^Driveway: about [\d,]+ sq ft/);
  assert.ok(r.business.materials.length >= 1);
  assert.match(r.business.quote, /\$X per sq ft \(set by the business\)/);
  assert.doesNotMatch(JSON.stringify(r.business), /\$\d/);
});
