// Trust signals: every flat measurement carries a ± range that covers the truth, and every answer
// says what it was measured against ("quarter (24.26 mm)").
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureAnything, rulerSpec } from '../src/anything.js';
import { measureFlat } from '../src/flat.js';
import { camera, samSeg, rectShape, ellipseShape } from './flatscene.js';
import { camera3d, render } from './scene3d.js';
import { parseSam } from '../src/muse.js';
import { scene } from './scene.js';

const EMPTY = { objects: [], frame: { w: 1280, h: 960 } };
const deps = (read, byConcept) => ({ read: async () => read, segment: async (_d, c) => byConcept[c] || EMPTY });
const R = (o) => ({ task: 'size', target: 'object', second_target: '', ruler: 'card', item_width_in: 0, tile_w_in: 0, tile_l_in: 0, shoe_for: 'unknown', summary: '', ...o });
const parseRange = (v) => v.match(/([\d.]+) in – ([\d.]+) in/).slice(1).map(Number);

test('ruler specs read the way a person would check them', () => {
  assert.equal(rulerSpec('quarter'), 'quarter (24.26 mm)');
  assert.equal(rulerSpec('card'), 'gift or hotel card (85.6 × 53.98 mm)');
  assert.equal(rulerSpec('paper_letter'), 'sheet of printer paper (11 × 8.5 in)');
  assert.equal(rulerSpec('double_garage_door'), 'double garage door (16 × 7 ft)');
  assert.equal(rulerSpec('interior_door'), 'door (80 in tall)');
});

test('chip next to a quarter: the range covers the true size and the answer names the quarter', async () => {
  const cam = camera({ tiltDeg: 25, D: 300, f: 1500 });
  const coin = ellipseShape(-25, 0, 12.13, 12.13), chip = ellipseShape(8, 3, 7, 6); // 14 mm long
  const r = await measureAnything({ dataUrl: 'x', text: 'repair or replace?', deps: deps(R({ task: 'windshield_chip', target: 'chip', ruler: 'quarter' }), { chip: samSeg(cam, chip.inside, chip.boundary), coin: samSeg(cam, coin.inside, coin.boundary) }) });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.measuredAgainst, 'quarter (24.26 mm)');
  const range = r.numbers.find((n) => n.label === 'Range').value;
  const [lo, hi] = parseRange(range);
  assert.ok(lo <= 14 / 25.4 && hi >= 14 / 25.4, `${range} vs 0.55 in`);
  assert.match(range, /±\d+%/);
});

test('flat ranges are honest: wider for a coin than for paper, wider still for a low-confidence shot', () => {
  const cam = camera({ tiltDeg: 20, D: 600, f: 1300 });
  const t = rectShape(60, 0, 100, 40, 10);
  const paper = rectShape(-120, 0, 279.4, 215.9, 0), coin = ellipseShape(-60, 0, 12.13, 12.13);
  const target = samSeg(cam, t.inside, t.boundary).objects[0];
  const mp = measureFlat({ target, ref: samSeg(cam, paper.inside, paper.boundary).objects[0], refKind: 'paper_letter' });
  const mc = measureFlat({ target, ref: samSeg(cam, coin.inside, coin.boundary).objects[0], refKind: 'quarter' });
  assert.ok(mp.ok && mc.ok);
  assert.ok(mp.plusMinusPct >= 0.03 && mp.plusMinusPct < mc.plusMinusPct, `${mp.plusMinusPct} vs ${mc.plusMinusPct}`);
  assert.ok(Math.abs(mp.lengthMm - Math.hypot(100, 40)) <= mp.plusMinusMm, `paper ${mp.lengthMm} ± ${mp.plusMinusMm}`);
});

test('shoe size and tile floor show a range; driveway and shed name their ruler', async () => {
  const cam = camera({ tiltDeg: 15, D: 900, f: 1100 });
  const paper = rectShape(0, 0, 279.4, 215.9, 90), foot = ellipseShape(0, 0, 50, 132);
  const shoe = await measureAnything({ dataUrl: 'x', text: 'shoe size (men)', deps: deps(R({ task: 'shoe_size', target: 'foot', ruler: 'paper_letter', shoe_for: 'men' }), { foot: samSeg(cam, foot.inside, foot.boundary), 'sheet of paper': samSeg(cam, paper.inside, paper.boundary) }) });
  assert.equal(shoe.measuredAgainst, 'sheet of printer paper (11 × 8.5 in)');
  const [lo, hi] = parseRange(shoe.numbers.find((n) => n.label === 'Range').value);
  assert.ok(lo <= 264 / 25.4 && hi >= 264 / 25.4);

  const s = scene({ drive: { x0: -9, x1: 9, z0: 14, z1: 38 }, door: { x0: -8, x1: 8, z: 38 } });
  const drive = await measureAnything({ dataUrl: 'x', text: 'how big is my driveway', deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), { driveway: parseSam(s.driveText), 'garage door': parseSam(s.doorText) }) });
  assert.equal(drive.measuredAgainst, 'double garage door (16 × 7 ft)');

  const c3 = camera3d({ pitchDeg: 12 });
  const { objects } = render(c3, [
    { name: 'fence', axis: 'x', at: -6, from: 8, to: 60, top: 6 },
    { name: 'house', axis: 'x', at: 7.5, from: 8, to: 60, top: 10 },
    { name: 'door', axis: 'z', at: 40, from: -1.5, to: 1.5, top: 80 / 12 },
  ]);
  const seg = (o) => ({ objects: [o], frame: { w: c3.W, h: c3.H } });
  const shed = await measureAnything({ dataUrl: 'x', text: 'Will a 12 ft wide shed fit between my fence and the house?', deps: deps(R({ task: 'gap_fit', target: 'fence', second_target: 'house wall', ruler: 'interior_door' }), { fence: seg(objects.fence), 'house wall': seg(objects.house), door: seg(objects.door) }) });
  assert.equal(shed.ok, true, shed.ask);
  assert.equal(shed.measuredAgainst, 'door (80 in tall)');
});
