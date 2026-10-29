// "Send this to <business>" is real: one tap puts the measured job on the owner board as a lead,
// priced from the business's own price list when the job is on it. Redaction rules still apply.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

delete process.env.MODEL_API_KEY;
process.env.OWNER_TOKEN = 'owner-secret-for-handoff';
const { app, rememberHandoff } = await import('../src/server.js');
const engine = await import('../src/engine.js');
const { business } = await import('../src/business.js');

const server = http.createServer(app);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
const send = (body) => fetch(`${base}/api/measure/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const DRIVE = { ok: true, task: 'surface_area', headline: 'About 420 sq ft', measuredAgainst: 'double garage door (16 × 7 ft)', confidence: 'good', surface: { sqft: 420, low: 370, high: 470 }, business: { job: 'Driveway: about 420 sq ft (370 – 470)', materials: ['3 gallons of concrete sealer per coat'], quote: '420 sq ft × $X per sq ft (set by the business)' } };
const CHIP = { ok: true, task: 'windshield_chip', headline: 'Repair it', measuredAgainst: 'quarter (24.26 mm)', confidence: 'good', business: { job: 'Windshield chip repair: 0.5 in chip', materials: ['Resin repair kit'], quote: '$X per chip repair (set by the business)' } };

test('driveway: the quote line comes from the business price list, with the arithmetic', () => {
  const q = engine.sightQuote({ task: 'surface_area', sqft: 1000 });
  assert.equal(q.total, Math.round(1000 * business.sight.surface_area.perSqft));
  assert.match(q.line, /1,000 sq ft × \$0\.30 per sq ft = \$300 \(Brightside Exterior Care price list\)/);
  const small = engine.sightQuote({ task: 'surface_area', sqft: 420 });
  assert.equal(small.total, business.sight.surface_area.minimum);
  assert.match(small.line, /job minimum \$199/);
  assert.equal(engine.sightQuote({ task: 'windshield_chip' }), null);
  const h = rememberHandoff(DRIVE);
  assert.equal(h.block.priced, true);
  assert.match(h.block.quote, /420 sq ft × \$0\.30/);
  assert.equal(h.to, business.name);
  assert.equal(rememberHandoff({ ok: false }), null);
  assert.equal(rememberHandoff({ ok: true, task: 'face', business: null }), null);
});

test('tapping Send creates one lead on the owner board, redacted in public', async () => {
  engine.reset();
  const h = rememberHandoff(DRIVE);
  const r = await (await send({ id: h.id, phone: '(615) 555-0199' })).json();
  assert.equal(r.ok, true);
  assert.match(r.message, /Sent to Brightside Exterior Care\. It’s on Dana’s board now, and they’ll text you at •••-•••-0199/);
  const again = await (await send({ id: h.id })).json();
  assert.equal(again.leadId, r.leadId, 'a second tap does not make a second lead');
  const pub = await (await fetch(`${base}/api/owner/feed`)).json();
  assert.equal(pub.leads.length, 1);
  const l = pub.leads[0];
  assert.equal(l.channel, 'sight');
  assert.equal(l.status, 'new');
  assert.match(l.sight.job, /420 sq ft/);
  assert.deepEqual(l.sight.materials, ['3 gallons of concrete sealer per coat']);
  assert.match(l.sight.quote, /\$0\.30 per sq ft/);
  assert.equal(l.quote.total, 199);
  assert.doesNotMatch(JSON.stringify(pub), /555-0199|6155550199/);
  const own = await (await fetch(`${base}/api/owner/feed`, { headers: { 'x-owner-key': 'owner-secret-for-handoff' } })).json();
  assert.equal(own.leads[0].phone, '6155550199');
});

test('a job not on the price list still goes over, marked for the owner to price', async () => {
  engine.reset();
  const h = rememberHandoff(CHIP);
  assert.equal(h.block.priced, false);
  assert.match(h.block.quote, /set by the business/);
  const r = await (await send({ id: h.id })).json();
  assert.match(r.message, /add your number/);
  const l = (await (await fetch(`${base}/api/owner/feed`)).json()).leads[0];
  assert.equal(l.quote, null);
  assert.equal(l.sight.task, 'windshield_chip');
});

test('only a real, recent answer can be sent; nothing typed into the request reaches the board', async () => {
  engine.reset();
  assert.equal((await send({ id: 'made-up' })).status, 404);
  assert.equal((await send({ job: 'FREE MONEY call 555-0000' })).status, 404);
  const h = rememberHandoff(CHIP);
  assert.equal((await send({ id: h.id, phone: '12' })).status, 400);
  await send({ id: h.id, summary: 'injected', job: 'injected' });
  assert.doesNotMatch(JSON.stringify(engine.snapshot()), /injected/);
});

test('the phone is checked (US, 10 or 11 digits, a string) and locked once set', async () => {
  engine.reset();
  const h = rememberHandoff(CHIP);
  assert.equal((await send({ id: h.id, phone: ['6155550199', '6155550100'] })).status, 400);
  assert.equal((await send({ id: h.id, phone: { a: 1 } })).status, 400);
  assert.equal((await send({ id: h.id, phone: '615-555-019' })).status, 400);
  assert.equal((await send({ id: h.id, phone: '+44 20 7946 0958 12' })).status, 400);
  assert.equal((await send({ id: h.id, phone: '2 615 555 0199' })).status, 400);
  const first = await (await send({ id: h.id })).json();
  assert.equal(first.ok, true);
  // No number on the first tap: one can be added once, then it is locked.
  assert.equal((await send({ id: h.id, phone: '1 (615) 555-0199' })).status, 200);
  assert.equal((await send({ id: h.id, phone: '615-555-0100' })).status, 409);
  const own = await (await fetch(`${base}/api/owner/feed`, { headers: { 'x-owner-key': 'owner-secret-for-handoff' } })).json();
  assert.equal(own.leads[0].phone, '6155550199');
});

test('live answers are not evicted early; expired ones are dropped', async () => {
  const old = rememberHandoff(CHIP, Date.now() - 2 * 3600e3 - 1000);
  const first = rememberHandoff(CHIP);
  for (let i = 0; i < 700; i++) rememberHandoff(CHIP);
  assert.equal((await send({ id: first.id })).status, 200);
  assert.equal((await send({ id: old.id })).status, 404);
});

test('when Spark’s check was skipped, the lead is marked unchecked (public and owner views)', async () => {
  engine.reset();
  const skipped = rememberHandoff({ ...DRIVE, checked: 'skipped' });
  await send({ id: skipped.id });
  const agreed = rememberHandoff({ ...DRIVE, checked: 'agreed' });
  await send({ id: agreed.id });
  const pub = await (await fetch(`${base}/api/owner/feed`)).json();
  assert.deepEqual(pub.leads.map((l) => l.sight.checked), ['skipped', 'agreed']);
});
