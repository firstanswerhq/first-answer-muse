// The driveway measurement, checked against scenes with known answers: a pinhole camera looks at a
// driveway of known size with a 16 ft garage door at the far end. We draw what SAM would return
// (boxes and masks in its own wire format), run the measurement, and compare with the truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSam } from '../src/muse.js';
import { measureSurface, garageDoorKind, best } from '../src/measure.js';
import { scene } from './scene.js';

const run = (s) => {
  const d = parseSam(s.driveText), g = parseSam(s.doorText);
  const door = best(g.objects);
  return measureSurface({ surface: best(d.objects), ref: door, refKind: garageDoorKind(door.box), frame: d.frame });
};

test('a 2-car driveway (18 x 24 ft = 432 sq ft) measures within 12%', () => {
  const m = run(scene({ drive: { x0: -9, x1: 9, z0: 14, z1: 38 }, door: { x0: -8, x1: 8, z: 38 } }));
  assert.equal(m.ok, true);
  assert.equal(m.refKind, 'double_garage_door');
  assert.equal(m.confidence, 'good');
  assert.ok(Math.abs(m.sqft - 432) / 432 < 0.12, `got ${m.sqft}`);
  assert.ok(m.low <= 432 && m.high >= 432);
});

test('a long 3-car driveway (30 x 50 ft = 1,500 sq ft) measures within 15%', () => {
  const m = run(scene({ drive: { x0: -15, x1: 15, z0: 12, z1: 62 }, door: { x0: -8, x1: 8, z: 62 }, camX: 0, pitchDeg: 5 }));
  assert.equal(m.ok, true);
  assert.ok(Math.abs(m.sqft - 1500) / 1500 < 0.15, `got ${m.sqft}`);
});

test('a slight angle (8 degrees) still measures within 12%', () => {
  const m = run(scene({ yawDeg: 8, camX: -2, drive: { x0: -9, x1: 9, z0: 16, z1: 40 }, door: { x0: -8, x1: 8, z: 40 } }));
  assert.equal(m.confidence, 'good');
  assert.ok(Math.abs(m.sqft - 432) / 432 < 0.12, `got ${m.sqft}`);
});

test('a steep side angle is never a confident wrong number', () => {
  for (const [yaw, camX] of [[15, -6], [15, 0], [-15, 6], [25, -8]]) {
    const m = run(scene({ yawDeg: yaw, camX, drive: { x0: -9, x1: 9, z0: 16, z1: 40 }, door: { x0: -8, x1: 8, z: 40 } }));
    const off = Math.abs(m.sqft - 432) / 432;
    assert.ok(m.confidence !== 'good' || off < 0.2, `yaw ${yaw}: ${m.sqft} sq ft marked good`);
  }
});

test('a single garage door is told apart by its shape', () => {
  assert.equal(garageDoorKind({ x1: 0, y1: 0, x2: 90, y2: 70 }), 'single_garage_door');
  assert.equal(garageDoorKind({ x1: 0, y1: 0, x2: 160, y2: 70 }), 'double_garage_door');
});

test('no reference, no measurement', () => {
  assert.equal(measureSurface({ surface: null, ref: null, refKind: 'double_garage_door', frame: { w: 1, h: 1 } }).ok, false);
});
