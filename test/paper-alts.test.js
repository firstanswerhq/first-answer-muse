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
