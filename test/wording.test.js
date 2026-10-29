// Muse Spark words the answer, but only from our numbers: any number it changes, adds or spells out
// sends us back to the template. Slow or failed calls fall back too. The page sees real step progress.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { measureAnything, checkWording, numbersIn, stepDetail, wordingFacts } from '../src/anything.js';
import { camera, samSeg, ellipseShape } from './flatscene.js';

const cam = camera({ tiltDeg: 25, D: 300, f: 1500 });
const coin = ellipseShape(-25, 0, 12.13, 12.13), chip = ellipseShape(8, 3, 7, 6);
const READ = { task: 'windshield_chip', target: 'chip', second_target: '', ruler: 'quarter', item_width_in: 0, tile_w_in: 0, tile_l_in: 0, shoe_for: 'unknown', summary: 'a chip in a windshield beside a quarter' };
const segs = { chip: samSeg(cam, chip.inside, chip.boundary), coin: samSeg(cam, coin.inside, coin.boundary) };
const run = (word, extra = {}) => measureAnything({ dataUrl: 'x', text: 'repair or replace?', deps: { read: async () => READ, segment: async (_d, c) => segs[c], word }, ...extra });

test('numbers are read the same way on both sides', () => {
  assert.deepEqual(numbersIn('About 1,500 sq ft, 0.56 in, 1/16 in, 24.26 mm'), ['1500', '0.56', '1/16', '24.26']);
});

test('the check passes faithful wording and catches every changed, added or spelled-out number', () => {
  const facts = { headline: 'About 430 sq ft', numbers: ['Area: 430 sq ft', 'Range: 380 – 480 sq ft', 'Concrete sealer: 3 gallons per coat'], next_steps: ['Clean it first: pressure wash and let it dry 24 hours.'] };
  assert.equal(checkWording('Your driveway is about 430 sq ft (380 to 480). Get 3 gallons of concrete sealer per coat, and pressure wash it 24 hours before.', facts, facts.headline).ok, true);
  assert.match(checkWording('Your driveway is about 440 sq ft.', facts, facts.headline).reason, /440/);
  assert.match(checkWording('About 430 sq ft; buy 4 gallons.', facts, facts.headline).reason, /4\b/);
  assert.match(checkWording('About 430 sq ft; buy three gallons.', facts, facts.headline).reason, /three/);
  assert.match(checkWording('Buy 3 gallons of sealer per coat.', facts, facts.headline).reason, /main number/);
  assert.match(checkWording('About 430 sq ft, roughly $120 of sealer.', facts, facts.headline).reason, /money|120/);
  assert.match(checkWording('**About 430 sq ft**', facts, facts.headline).reason, /formatting/);
  assert.equal(checkWording('', facts).ok, false);
});

test('Spark wording is used when every number is ours, and the page is told so', async () => {
  let gotFacts = null;
  const r = await run(async (system, facts) => {
    gotFacts = JSON.parse(facts);
    assert.match(system, /never round, convert/i);
    const size = gotFacts.numbers.find((n) => n.startsWith('Chip size')).split(': ')[1];
    return `Good news: that chip is ${size}, smaller than a quarter, so it can usually be repaired. Put clear tape over it and get it fixed soon.`;
  });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.wording, 'spark');
  assert.match(r.answer, /^Good news/);
  assert.match(r.answerTemplate, /smaller than a quarter/);
  assert.equal(gotFacts.measured_against, 'quarter (24.26 mm)');
  const step = r.pipeline.at(-1);
  assert.equal(step.result.used, true);
  assert.match(stepDetail(step), /checked against ours/);
});

test('Spark changes a number: the template answer stays', async () => {
  const r = await run(async () => 'That chip is 0.75 in, so it can be repaired.');
  assert.equal(r.ok, true);
  assert.equal(r.wording, 'template');
  assert.equal(r.answer, r.answerTemplate);
  assert.match(r.pipeline.at(-1).result.fellBack, /numbers not ours: 0\.75/);
});

test('Spark is slow or fails: the template answer stays, quickly', async () => {
  const t0 = Date.now();
  const slow = await run(() => new Promise(() => {}), { wordTimeoutMs: 200 });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(slow.wording, 'template');
  assert.match(slow.pipeline.at(-1).error, /no reply/);
  const broken = await run(async () => { throw new Error('Meta 503'); });
  assert.equal(broken.wording, 'template');
  assert.equal(broken.ok, true);
});

test('no word function (tests, no key): no wording step', async () => {
  const r = await run(undefined);
  assert.equal(r.wording, undefined);
  assert.ok(!r.pipeline.some((s) => /word the answer/.test(s.step)));
});

test('the facts handed to Spark are our answer, nothing else', async () => {
  const r = await run(undefined);
  const f = wordingFacts(r);
  assert.equal(f.headline, r.headline);
  assert.ok(f.numbers.every((n) => /: /.test(n)));
});

test('steps report live with timings, SAM outline counts and confidence', async () => {
  const seen = [];
  const r = await run(undefined, { onStep: (s) => seen.push(s.model) });
  assert.deepEqual(seen, r.pipeline.map((s) => s.model));
  assert.deepEqual(seen.slice(0, 2), ['muse-spark-1.3', 'sam-3.1']);
  const sam = r.pipeline.find((s) => s.model === 'sam-3.1');
  assert.deepEqual(sam.result.objects.map((o) => o.concept), ['chip', 'coin']);
  assert.ok(sam.result.objects.every((o) => o.count === 1 && o.conf > 0));
  assert.match(stepDetail(sam), /^chip: 1 outline \(conf 0\.\d\d\) · coin: 1 outline/);
  assert.ok(r.pipeline.every((s) => Number.isFinite(s.ms)));
});

test('/api/measure streams progress lines when asked (Accept: application/x-ndjson)', async () => {
  delete process.env.MODEL_API_KEY;
  const { app } = await import('../src/server.js');
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  try {
    const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/measure`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ dataUrl: tiny, text: 'how big' }) });
    assert.match(res.headers.get('content-type'), /ndjson/);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'start');
    assert.equal(lines.at(-1).type, 'result');
    assert.equal(lines.at(-1).ok, false); // no key in tests
  } finally {
    server.close();
  }
});

test('measure errors become specific guidance with Retry', async () => {
  const { measureErrorMessage } = await import('../src/server.js');
  assert.match(measureErrorMessage(new Error('SAM 502: bad gateway')), /Meta SAM 3\.1.*tap Retry/);
  assert.match(measureErrorMessage(new Error('fetch failed')), /Couldn’t reach the Meta models; tap Retry/);
  assert.match(measureErrorMessage(new Error('Request timed out.')), /too long.*Retry/);
  assert.doesNotMatch(measureErrorMessage(new Error('weird')), /Something went wrong on our side/);
});
