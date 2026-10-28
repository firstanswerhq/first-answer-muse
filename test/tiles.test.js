import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, axisLayout } from '../src/tiles.js';

test('a 10 x 12 ft room in 12 in tile: centered, no slivers, the right counts', () => {
  const p = plan({ roomW: 120, roomL: 144, tileW: 12, tileL: 12, joint: 0.125, tilesPerBox: 15 });
  assert.equal(p.ok, true);
  // every piece + every joint + both edges fills the wall exactly
  const ax = axisLayout(120, 12, 0.125);
  const used = ax.full * 12 + (ax.full - 1) * 0.125 + 2 * (ax.edge + 0.125);
  assert.ok(Math.abs(used - 120) <= 0.125, `across fills ${used}`);
  assert.ok(ax.edge >= 6, `edge ${ax.edge} at least half a tile`);
  assert.equal(p.cuts.length, 3);
  assert.equal(p.extraPct, 15); // straight 10% + 5% first-timer
  assert.equal(p.buyTiles, Math.ceil(p.tilesForFloor * 1.15));
  assert.equal(p.boxes, Math.ceil(p.buyTiles / 15));
});

test('narrow edges get shifted so no wall gets a sliver', () => {
  const ax = axisLayout(100, 12, 0.125); // 8 tiles leave ~1.9 in; shift instead
  assert.ok(ax.edge >= 6, `edge ${ax.edge}`);
  assert.equal(ax.sliver, false);
});

test('large-format diagonal needs 20% extra (25% for a first-timer)', () => {
  const p = plan({ roomW: 150, roomL: 180, tileW: 12, tileL: 24, pattern: 'diagonal', diy: true });
  assert.equal(p.extraPct, 25);
});

test('bad input is refused', () => {
  assert.equal(plan({ roomW: 0, roomL: 10, tileW: 12, tileL: 12 }).ok, false);
});
