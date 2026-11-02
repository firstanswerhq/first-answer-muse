import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentWithAlts } from '../src/anything.js';

test('a missed sheet of paper is retried with other wordings, once something is found it stops', async () => {
  const asked = [];
  const live = { segment: async (_d, c) => { asked.push(c); return { objects: c === 'white paper' ? [{ c: 0.8 }] : [] }; } };
  const seg = await segmentWithAlts(live, 'x', 'sheet of paper');
  assert.deepEqual(asked, ['sheet of paper', 'white paper']);
  assert.equal(seg.objects.length, 1);
});

test('only the paper concept is retried, and a first hit is kept as is', async () => {
  const asked = [];
  const live = { segment: async (_d, c) => { asked.push(c); return { objects: [] }; } };
  await segmentWithAlts(live, 'x', 'floor');
  assert.deepEqual(asked, ['floor']);
  const hit = { segment: async () => ({ objects: [{ c: 0.9 }] }) };
  assert.equal((await segmentWithAlts(hit, 'x', 'sheet of paper')).objects.length, 1);
});

import { bestOnFloor } from '../src/anything.js';
test('a paper outline on the floor beats a more confident one on the wall', () => {
  const floor = { box: { x1: 0, y1: 800, x2: 1500, y2: 2000 } };
  const wall = { c: 0.95, box: { x1: 400, y1: 0, x2: 600, y2: 200 }, mask: null };
  const paper = { c: 0.8, box: { x1: 500, y1: 1500, x2: 900, y2: 1900 }, mask: null };
  assert.equal(bestOnFloor([wall, paper], floor), paper);
  assert.equal(bestOnFloor([wall], floor), wall);
  assert.equal(bestOnFloor([wall, paper], null), wall);
});

test('a chip SAM cannot outline is retried with other glass wordings, stopping at the first hit', async () => {
  const asked = [];
  const live = { segment: async (_d, c) => { asked.push(c); return { objects: c === 'small crack in windshield' ? [{ c: 0.7 }] : [] }; } };
  const seg = await segmentWithAlts(live, 'x', 'chip');
  assert.deepEqual(asked, ['chip', 'star-shaped crack in glass', 'small crack in windshield']);
  assert.equal(seg.objects.length, 1);
  const none = [];
  await segmentWithAlts({ segment: async (_d, c) => { none.push(c); return { objects: [] }; } }, 'x', 'coin');
  assert.deepEqual(none, ['coin']);
});
