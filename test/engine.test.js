import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../src/engine.js';
import { parseSam } from '../src/muse.js';
import { countFromSam } from '../src/photo.js';

const NOW = new Date('2026-10-28T03:00:00Z'); // Tue Oct 27, 10 PM in Nashville

test('window quote is count x price, with the job minimum', () => {
  engine.reset();
  assert.equal(engine.quote({ service: 'windows', count: 22 }).total, 198);
  const small = engine.quote({ service: 'windows', count: 5 });
  assert.equal(small.total, 149);
  assert.match(small.detail, /minimum/);
});

test('tiered services need a valid tier', () => {
  assert.equal(engine.quote({ service: 'driveway', tier: 'medium' }).total, 189);
  assert.equal(engine.quote({ service: 'driveway' }).ok, false);
  assert.equal(engine.quote({ service: 'roof' }).ok, false);
});

test('open times start tomorrow, inside business hours, in Nashville time', () => {
  engine.reset();
  const times = engine.openTimes({ hours: 2, limit: 3, now: NOW });
  assert.equal(times.length, 3);
  assert.equal(times[0].slot, '2026-10-28T08');
  assert.equal(times[0].label, 'Wed Oct 28, 8 AM');
  for (const t of times) {
    const h = Number(t.slot.slice(11));
    assert.ok(h >= 8 && h + 2 <= 17);
  }
});

test('booking takes the slot, and an overlapping booking is refused', () => {
  engine.reset();
  const ok = engine.book({ slot: '2026-10-28T08', service: 'windows', count: 22, customer: 'Sarah Kim', address: '412 Oak St', now: NOW });
  assert.equal(ok.ok, true);
  const clash = engine.book({ slot: '2026-10-28T09', service: 'driveway', tier: 'small', customer: 'Joe Park', address: '9 Elm St', now: NOW });
  assert.equal(clash.ok, false);
  assert.ok(!engine.openTimes({ hours: 1, limit: 10, now: NOW }).some((t) => t.slot === '2026-10-28T08'));
});

test('booking needs a name, an address and an offered time', () => {
  engine.reset();
  assert.equal(engine.book({ slot: '2026-10-28T08', service: 'windows', count: 10, customer: '', address: '412 Oak St', now: NOW }).ok, false);
  assert.equal(engine.book({ slot: '2026-10-28T08', service: 'windows', count: 10, customer: 'Ann', address: '', now: NOW }).ok, false);
  assert.equal(engine.book({ slot: '2026-11-01T08', service: 'windows', count: 10, customer: 'Ann', address: '1 Main St', now: NOW }).ok, false); // Sunday: closed
});

test('SAM output parses into boxes and a count', () => {
  const line = '<0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561;c=0.91|><|mask;x=0;y=0;c=0.91;data=46,101,~abc|>,1<|box;x1=260;y1=382;x2=340;y2=427;w=537;h=561;c=0.88|><|mask;x=0;y=0;c=0.88;data=46,81,~def|>,2<|box;x1=516;y1=117;x2=518;y2=119;w=537;h=561;c=0.4|><|mask;x=0;y=0;c=0.4;data=2,2,~g|>';
  const seg = parseSam(line);
  assert.equal(seg.objects.length, 3);
  assert.deepEqual(seg.frame, { w: 537, h: 561 });
  const { count } = countFromSam(seg);
  assert.equal(count, 2); // the tiny, low-confidence box is dropped
  assert.equal(parseSam('').objects.length, 0);
});
