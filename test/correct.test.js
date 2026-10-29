// Closing the loop: when Muse Spark disagrees with one of SAM's outlines, it tells SAM what to look for
// (a better phrase and a point), SAM outlines it once more, our geometry re-measures, and Spark checks
// again. One round at most, then refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { measureAnything, stepDetail, fixFrom } from '../src/anything.js';
import { camera, samSeg, ellipseShape } from './flatscene.js';

const cam = camera({ tiltDeg: 25, D: 300, f: 1500 });
const coin = ellipseShape(-25, 0, 12.13, 12.13), chip = ellipseShape(8, 3, 7, 6), smudge = ellipseShape(30, -20, 20, 14);
const S = { chip: samSeg(cam, chip.inside, chip.boundary), coin: samSeg(cam, coin.inside, coin.boundary), smudge: samSeg(cam, smudge.inside, smudge.boundary) };
const READ = { task: 'windshield_chip', target: 'chip', second_target: '', ruler: 'quarter', item_width_in: 0, tile_w_in: 0, tile_l_in: 0, shoe_for: 'unknown', language: 'en', summary: '' };
const PHOTO = `data:image/jpeg;base64,${Buffer.from(jpeg.encode({ width: cam.W, height: cam.H, data: Buffer.alloc(cam.W * cam.H * 4, 128) }, 80).data).toString('base64')}`;

// SAM first outlines a smudge as "chip"; Spark's fix finds the real chip.
function rig({ second = 'agree', pointFails = false, phrase = 'small chip in glass', point = { x: 0.52, y: 0.5 } } = {}) {
  const calls = { segment: [], segmentAt: [], check: 0, word: 0 };
  const deps = {
    read: async () => READ,
    segment: async (_d, c) => { calls.segment.push(c); return c === 'chip' ? S.smudge : c === phrase ? S.chip : S[c] || { objects: [], frame: S.chip.frame }; },
    segmentAt: async (_d, frame, p) => { calls.segmentAt.push(p); if (pointFails) throw new Error('SAM 400: bad prompt'); return S.chip; },
    check: async (images, prompt) => {
      calls.check++;
      const n = (prompt.match(/^- \w+ outline/gm) || []).length;
      if (calls.check === 1) return { outlines: [{ color: 'MAGENTA', ok: false, seen: 'a smudge on the glass', better_phrase: phrase, point_x: point.x, point_y: point.y }, { color: 'ORANGE', ok: true, seen: 'a US quarter', better_phrase: '', point_x: -1, point_y: -1 }], problem: 'The magenta outline is a smudge, not the chip.', retake_tip: 'Wipe the glass.' };
      if (second === 'agree') return { outlines: Array.from({ length: n }, (_, i) => ({ color: i ? 'ORANGE' : 'MAGENTA', ok: true, seen: i ? 'a US quarter' : 'a small chip', better_phrase: '', point_x: -1, point_y: -1 })), problem: '', retake_tip: '' };
      if (second === 'slow') return new Promise(() => {});
      return { outlines: [{ color: 'MAGENTA', ok: false, seen: 'a reflection', better_phrase: 'chip', point_x: 0.1, point_y: 0.1 }, { color: 'ORANGE', ok: true, seen: 'quarter', better_phrase: '', point_x: -1, point_y: -1 }], problem: 'Still not the chip.', retake_tip: '' };
    },
    word: async (_s, f) => { calls.word++; return 'Put clear tape over it and book a visit this week.'; },
  };
  return { deps, calls };
}

test('Spark corrects SAM: SAM outlines again at Spark’s point, geometry re-measures, Spark agrees', async () => {
  const { deps, calls } = rig();
  const r = await measureAnything({ dataUrl: PHOTO, text: 'repair or replace?', deps });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.checked, 'agreed');
  assert.equal(r.corrected.role, 'target');
  assert.match(r.corrected.how, /point Spark marked/);
  assert.equal(r.corrected.firstSeen, 'a smudge on the glass');
  // The re-measured chip is the real one (14 × 12 mm ellipse): about 0.56 in, a repair.
  assert.equal(r.headline, 'Repair it');
  assert.match(r.numbers[0].value, /^0\.5/);
  // Calls: SAM chip + coin, then one point call; two checks; two wordings (the first one not sent).
  assert.deepEqual(calls.segment.sort(), ['chip', 'coin']);
  assert.equal(calls.segmentAt.length, 1);
  const p = calls.segmentAt[0];
  assert.equal(p.x, Math.floor(0.52 * cam.W));
  assert.equal(calls.check, 2);
  assert.equal(calls.word, 2);
  // The panel shows both attempts.
  const steps = r.pipeline.map((s) => `${s.step} | ${stepDetail(s)}`);
  assert.ok(steps.some((s) => /^check SAM’s outlines on the photo \| disagrees .*Spark told SAM what to look for: “small chip in glass”/.test(s)), steps.join('\n'));
  assert.ok(steps.some((s) => /^outline the chip again with Spark’s fix \| a point Spark marked/.test(s)), steps.join('\n'));
  assert.ok(steps.some((s) => /^measure against the quarter \(attempt 2\)/.test(s)));
  assert.ok(steps.some((s) => /^check SAM’s outlines on the photo \(attempt 2\) \| agrees/.test(s)));
  assert.ok(steps.some((s) => /^word the answer from our numbers \| not sent: Spark corrected SAM/.test(s)));
  // The photo shows SAM's first try, marked rejected, under the new outline.
  assert.equal(r.overlay.outlines[0].role, 'rejected');
  assert.match(r.overlay.outlines[0].label, /SAM’s first try: a smudge/);
});

test('a point SAM can’t use falls back to Spark’s phrase (both calls counted)', async () => {
  const { deps, calls } = rig({ pointFails: true });
  const r = await measureAnything({ dataUrl: PHOTO, text: 'repair or replace?', deps });
  assert.equal(r.ok, true, r.ask);
  assert.equal(calls.segmentAt.length, 1);
  assert.ok(calls.segment.includes('small chip in glass'));
  assert.match(r.corrected.how, /“small chip in glass”/);
});

test('Spark still disagrees after the fix: refuse, numbers hidden in both attempts, no third round', async () => {
  const { deps, calls } = rig({ second: 'disagree' });
  const r = await measureAnything({ dataUrl: PHOTO, text: 'repair or replace?', deps });
  assert.equal(r.ok, false);
  assert.equal(r.refused, 'spark-check');
  assert.equal(calls.check, 2);
  assert.equal(calls.segmentAt.length, 1);
  for (const p of r.pipeline.filter((s) => s.model === 'first-answer math')) assert.equal(p.result.withheld, true);
  assert.deepEqual(r.numbers, []);
  assert.match(r.ask, /didn’t measure/);
});

test('the second check doesn’t come back: refuse (a corrected outline is never sent unchecked)', async () => {
  const { deps } = rig({ second: 'slow' });
  const r = await measureAnything({ dataUrl: PHOTO, text: 'repair or replace?', deps, checkTimeoutMs: 2500 });
  assert.equal(r.ok, false);
  assert.match(r.ask, /couldn’t confirm SAM’s second outline/);
});

test('no usable fix (no phrase, no point, or a wrong coin): refuse as before, no second SAM call', async () => {
  for (const [phrase, point] of [['', { x: -1, y: -1 }], ['segment the chip please now ok', { x: 3, y: 3 }]]) {
    const { deps, calls } = rig({ phrase, point });
    const r = await measureAnything({ dataUrl: PHOTO, text: 'repair or replace?', deps });
    assert.equal(r.ok, false);
    assert.equal(calls.segmentAt.length + calls.segment.length, 2);
  }
  assert.equal(fixFrom([{ ok: true, role: 'target' }, { ok: false, role: 'ruler', ruler: 'quarter', seen: 'a dime' }], [{}, { better_phrase: 'dime', point_x: 0.2, point_y: 0.2 }]), null);
  assert.deepEqual(fixFrom([{ ok: false, role: 'target' }], [{ better_phrase: 'Concrete Driveway', point_x: -1, point_y: -1 }]), { role: 'target', phrase: 'concrete driveway', point: null });
});
