// Real SAM outlines from two tape-measured photos (Nov 3, 2026), fed straight into the geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { measureSurfaceRows } from '../src/measure.js';

const D = JSON.parse(readFileSync(new URL('./fixtures/real-outlines.json', import.meta.url), 'utf8'));
const run = (d, over = {}) => measureSurfaceRows({ rows: d.rows, refBox: { ...d.refBox, ...over.box }, refKind: over.kind || d.refKind, frame: d.frame, raisedDoor: over.raised ?? d === D.stoop });

test('real stoop (tape 42.9 sq ft): the front door sits on a sill, so the slab edge is the ground line, and the door width is the scale', () => {
  const m = run(D.stoop);
  assert.ok(m.ok);
  assert.ok(m.sqft >= 34 && m.sqft <= 46, `stoop read ${m.sqft}`);
  assert.ok(m.low <= D.stoop.trueSqft && m.high >= D.stoop.trueSqft, 'the true size is inside the range');
  // The stoop reading uses the door's width, so where the door's top is cut off changes the area not at all.
  for (const y1 of [0, 3, 300]) assert.equal(run(D.stoop, { box: { y1 } }).sqft, m.sqft, `door top at ${y1}`);
});

test('without the stoop rules the same outlines read about half (the old bug), so the rules are what fix it', () => {
  const off = run(D.stoop, { raised: false });
  const on = run(D.stoop);
  assert.ok(off.sqft >= 15 && off.sqft <= 25, `off read ${off.sqft}`);
  assert.ok(on.sqft >= 34 && on.sqft <= 46, `on read ${on.sqft}`);
});

test('a front door at an angle (its width and height scales disagree) is marked low confidence', () => {
  const d = D.stoop;
  const narrow = { ...d.refBox, y1: 40, x2: d.refBox.x1 + 0.6 * (d.refBox.x2 - d.refBox.x1) };
  const m = measureSurfaceRows({ rows: d.rows, refBox: narrow, refKind: 'front_door', frame: d.frame, raisedDoor: true });
  assert.equal(m.confidence, 'low');
});

test('real driveway (tape 257.9 sq ft): a garage door on the ground is read as before', () => {
  const m = run(D.driveway);
  assert.ok(m.ok);
  assert.ok(m.sqft >= 320 && m.sqft <= 360, `driveway read ${m.sqft}`);
  assert.ok(m.low <= D.driveway.trueSqft && m.high >= D.driveway.trueSqft, 'the true size is inside the range');
});

test('a front door running off the side of the photo falls back to its height; bad input is refused, not guessed', () => {
  const side = run(D.stoop, { box: { x1: 0 } });
  assert.ok(side.ok && side.sqft !== run(D.stoop).sqft, 'a side-cut door is scaled by its height, so the number differs');
  assert.equal(measureSurfaceRows({ rows: D.stoop.rows, refBox: D.stoop.refBox, refKind: 'nope', frame: D.stoop.frame }).ok, false);
  const bad = D.stoop.rows.map((r, i) => (i === 3 ? { ...r, w: NaN } : r));
  assert.equal(measureSurfaceRows({ rows: bad, refBox: D.stoop.refBox, refKind: 'front_door', frame: D.stoop.frame }).ok, false);
});
