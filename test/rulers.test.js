import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseScale, CATALOG } from '../src/rulers.js';

test('two rulers that agree give a confident scale', () => {
  const r = chooseScale([
    { kind: 'outlet_cover', mmPerPx: 0.5, distancePx: 100, samePlane: true },
    { kind: 'interior_door', mmPerPx: 0.52, distancePx: 300, samePlane: true },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.confidence, 'good');
  assert.equal(r.agreeing.length, 1);
  assert.ok(r.mmPerPx > 0.5 && r.mmPerPx < 0.52);
});

test('an exact ruler beats a "varies" ruler, and the disagreement is reported', () => {
  const r = chooseScale([
    { kind: 'brick', mmPerPx: 0.9, distancePx: 50, samePlane: true },
    { kind: 'sheet_of_paper', mmPerPx: 0.6, distancePx: 80, samePlane: true },
  ]);
  assert.equal(r.used, 'sheet_of_paper');
  assert.equal(r.disagreeing[0].kind, 'brick');
});

test('only a "varies" ruler means low confidence and an ask for paper or a can', () => {
  const r = chooseScale([{ kind: 'shingle_row', mmPerPx: 2, distancePx: 0, samePlane: true }]);
  assert.equal(r.confidence, 'low');
  assert.match(r.ask, /sheet of paper|soda can/);
});

test('nothing usable asks for a ruler', () => {
  const r = chooseScale([]);
  assert.equal(r.ok, false);
  assert.match(r.ask, /soda can/);
});

test('every catalog entry has a size and a SAM prompt', () => {
  for (const [k, v] of Object.entries(CATALOG)) assert.ok(v.sizeMm.length && v.samConcept, k);
});
