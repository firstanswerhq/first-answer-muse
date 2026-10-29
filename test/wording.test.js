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

// Review round 2: numbers must keep their units, and a verdict can't be flipped.
const DRIVE = {
  task: 'surface_area', headline: 'About 420 sq ft',
  template_answer: 'Your driveway is about 420 sq ft (about 18 ft wide by 24 ft long), between 370 and 470 sq ft, measured against the double garage door. That’s 3 gallons of concrete sealer or 2 five-gallon pails of asphalt sealer per coat.',
  numbers: ['Area: 420 sq ft', 'Range: 370 – 470 sq ft', 'Size: 18 × 24 ft', 'Concrete sealer: 3 gallons per coat', 'Asphalt sealer: 2 five-gallon pails per coat'],
  next_steps: ['Clean it first: pressure wash and let it dry 24 hours.'],
};
const CHIP = { headline: 'Repair it', template_answer: 'That chip is 0.5 in — smaller than a quarter, so it can usually be repaired instead of replacing the glass.', numbers: ['Chip size: 0.5 in', 'Range: 0.48 in – 0.52 in (±4%)', 'Repair limit: 1 in (a quarter)'] };
const SHOE = { headline: 'Size 10.5 men’s / 12 women’s', template_answer: 'Your foot is 10.5 in long (26.7 cm). That’s a US 10.5 men’s / 12 women’s, about EU 44.', numbers: ['Foot length: 10.5 in · 26.7 cm', 'US men’s: 10.5', 'US women’s: 12', 'EU: 44'] };

test('a number with the wrong unit fails: 2 gallons when 2 is the pail count', () => {
  assert.match(checkWording('Your driveway is about 420 sq ft. Buy 2 gallons of concrete sealer per coat.', DRIVE, DRIVE.headline).reason, /unit not ours: 2 gallons/);
  assert.equal(checkWording('Your driveway is about 420 sq ft, between 370 and 470 sq ft. Buy 3 gallons of concrete sealer or 2 five-gallon pails of asphalt sealer per coat.', DRIVE, DRIVE.headline).ok, true);
  assert.equal(checkWording(DRIVE.template_answer, DRIVE, DRIVE.headline).ok, true);
  assert.match(checkWording('Your driveway is about 420 ft, so buy 3 gallons.', DRIVE, DRIVE.headline).reason, /unit not ours: 420 ft/);
  assert.match(checkWording('It is 18 × 24 sq ft, 420 sq ft in all.', DRIVE, DRIVE.headline).reason, /unit not ours/);
});

test('a flipped verdict fails: “Repair it” reworded to replace', () => {
  assert.equal(checkWording(CHIP.template_answer, CHIP, CHIP.headline).ok, true);
  assert.equal(checkWording('Good news: that 0.5 in chip is smaller than a quarter, so it can usually be repaired. Put clear tape over it.', CHIP, CHIP.headline).ok, true);
  assert.equal(checkWording('That 0.5 in chip is bigger than a quarter, so replace the windshield.', CHIP, CHIP.headline).ok, false);
  assert.match(checkWording('That 0.5 in chip is bigger than a quarter, so skip the repair and replace the windshield.', CHIP, CHIP.headline).reason, /opposite of “repair”/);
  const REPL = { headline: 'Replace it', template_answer: 'That crack is 8 in — longer than 6 in, so most shops will say replace the windshield.', numbers: ['Crack length: 8 in', 'Repair limit: 6 in'] };
  assert.equal(checkWording(REPL.template_answer, REPL, REPL.headline).ok, true);
  assert.match(checkWording('That 8 in crack can usually be repaired, no need to replace it.', REPL, REPL.headline).reason, /opposite/);
});

test('fits / tight / won’t fit must be said, never contradicted', () => {
  const f = (headline) => ({ headline, numbers: ['Narrowest: 13 ft 2 in', 'Needs: 12 ft'] });
  assert.equal(checkWording('The narrowest spot is 13 ft 2 in, so a 12 ft shed fits.', f('Fits'), 'Fits').ok, true);
  assert.equal(checkWording('The narrowest spot is 13 ft 2 in, so a 12 ft shed won’t fit.', f('Fits'), 'Fits').ok, false);
  assert.equal(checkWording('At 13 ft 2 in it fits, but it’s tight.', f('Fits, but tight'), 'Fits, but tight').ok, true);
  assert.equal(checkWording('At 13 ft 2 in a 12 ft shed won’t fit.', f('Won’t fit'), 'Won’t fit').ok, true);
  assert.match(checkWording('At 13 ft 2 in, the 12 ft shed will fit.', f('Won’t fit'), 'Won’t fit').reason, /verdict|opposite/);
});

test('men’s and women’s shoe sizes swapped fails', () => {
  assert.equal(checkWording(SHOE.template_answer, SHOE, SHOE.headline).ok, true);
  assert.equal(checkWording('Your foot is 10.5 in long. That’s a US men’s 10.5 or women’s 12, about EU 44.', SHOE, SHOE.headline).ok, true);
  assert.match(checkWording('That is a US women’s 10.5, or men’s 12.', SHOE, SHOE.headline).reason, /unit not ours: 10\.5 women’s, 12 men’s/);
  assert.match(checkWording('Your foot is 10.5 in long, about EU 12.', SHOE, SHOE.headline).reason, /12 EU/);
});

test('numbers with units are read the same in Spanish', () => {
  assert.equal(checkWording('Tu entrada mide unos 420 pies cuadrados (entre 370 y 470). Compra 3 galones de sellador para concreto o 2 cubetas de cinco galones de sellador para asfalto por capa.', DRIVE, DRIVE.headline).ok, true);
  assert.match(checkWording('Tu entrada mide unos 420 pies cuadrados. Compra 2 galones de sellador.', DRIVE, DRIVE.headline).reason, /2 gallons/);
  assert.equal(checkWording('Esa grieta de 0.5 in es más pequeña que una moneda de un cuarto de dólar, así que se puede reparar.', CHIP, CHIP.headline).ok, true);
  assert.equal(checkWording('Tu pie mide 10.5 pulgadas: talla 10.5 de hombre o 12 de mujer, más o menos EU 44.', SHOE, SHOE.headline).ok, true);
});

test('the public panel never shows raw upstream errors; a Spark timeout says why', async () => {
  const { friendlyError } = await import('../src/anything.js');
  assert.equal(stepDetail({ model: 'sam-3.1', step: 'outline', error: 'SAM 500: <html><body>Internal stack trace at x.y</body></html>' }), 'failed: Meta’s server had a hiccup (500)');
  assert.equal(friendlyError('SAM 429: {"error":"slow down"}'), 'Meta was busy (rate limited)');
  assert.equal(friendlyError('401 Incorrect API key provided: sk-abc'), 'Meta turned the request away');
  assert.equal(friendlyError('fetch failed'), 'couldn’t connect');
  assert.equal(friendlyError(new Error('Request timed out.')), 'timed out');
  assert.equal(friendlyError('something odd'), 'unexpected error');
  const slow = await run(() => new Promise(() => {}), { wordTimeoutMs: 300 });
  assert.equal(stepDetail(slow.pipeline.at(-1)), 'kept our template (no reply in 0.3 s)');
  const broken = await run(async () => { throw new Error('Meta 503: <html>upstream body</html>'); });
  assert.equal(stepDetail(broken.pipeline.at(-1)), 'kept our template (Meta’s server had a hiccup (503))');
});
