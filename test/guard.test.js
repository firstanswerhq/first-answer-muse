// Locked-down endpoints: the credit-spending ones are rate limited per IP, the diag probes need a token,
// and the public owner board never shows phone numbers, addresses or voicemail text.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

delete process.env.MODEL_API_KEY;
process.env.DIAG_TOKEN = 'diag-secret-for-tests';
process.env.OWNER_TOKEN = 'owner-secret-for-tests';
const { app, measureLimit } = await import('../src/server.js');
const engine = await import('../src/engine.js');
const { clientIp, rateLimiter, tokenOk, redactSnapshot, scrub } = await import('../src/guard.js');

const server = http.createServer(app);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const measure = (ip) => fetch(`${base}/api/measure`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ dataUrl: tiny, text: 'how big' }) });

test('client IP: cf-connecting-ip, then true-client-ip, then the first x-forwarded-for, then req.ip', () => {
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': '1.1.1.1', 'true-client-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' }, ip: '4.4.4.4' }), '1.1.1.1');
  assert.equal(clientIp({ headers: { 'true-client-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' }, ip: '4.4.4.4' }), '2.2.2.2');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '3.3.3.3, 10.0.0.1' }, ip: '4.4.4.4' }), '3.3.3.3');
  assert.equal(clientIp({ headers: {}, ip: '4.4.4.4' }), '4.4.4.4');
});

test('/api/measure: 20 photos per 10 minutes per IP, then a friendly 429', async () => {
  measureLimit.reset();
  for (let i = 0; i < 20; i++) assert.notEqual((await measure('9.9.9.9')).status, 429, `request ${i + 1}`);
  const r = await measure('9.9.9.9');
  assert.equal(r.status, 429);
  const body = await r.json();
  assert.match(body.ask, /try again/i);
  assert.ok(r.headers.get('retry-after'));
  // Someone else is not blocked.
  assert.notEqual((await measure('8.8.8.8')).status, 429);
});

test('the limit window slides', () => {
  const lim = rateLimiter({ max: 2, windowMs: 1000 });
  assert.equal(lim.check('a', 0).ok, true);
  assert.equal(lim.check('a', 10).ok, true);
  assert.equal(lim.check('a', 20).ok, false);
  assert.equal(lim.check('a', 1015).ok, true);
});

test('/api/diag: basic health only without the token', async () => {
  const r = await (await fetch(`${base}/api/diag?probe=1`)).json();
  assert.equal(r.ok, true);
  assert.equal(r.probes, undefined);
  assert.equal(r.models, undefined);
  const wrong = await (await fetch(`${base}/api/diag?probe=1&token=nope`)).json();
  assert.equal(wrong.probes, undefined);
  // With the token (no key in tests, so it reports demo mode instead of probing).
  const ok = await (await fetch(`${base}/api/diag?probe=1`, { headers: { 'x-diag-token': 'diag-secret-for-tests' } })).json();
  assert.equal(ok.mode, 'demo');
  assert.equal(ok.detail, undefined);
});

test('tokens: no token configured means nobody gets in', () => {
  assert.equal(tokenOk('x', ''), false);
  assert.equal(tokenOk('', 'x'), false);
  assert.equal(tokenOk('abc', 'abc'), true);
});

test('owner feed: public view hides phone, address, name and voicemail; the owner key shows them', async () => {
  engine.reset();
  const lead = engine.addLead({ channel: 'voicemail', phone: '615-555-0142', name: 'Sarah Kim', summary: 'Call me at 615-555-0142, 412 Oak St', transcript: 'Hi this is Sarah at 412 Oak Street' });
  const bk = engine.book({ slot: engine.openTimes({ hours: 2, limit: 1 })[0].slot, service: 'driveway', tier: 'medium', customer: 'Sarah Kim', phone: '615-555-0142', address: '412 Oak St, Nashville' });
  assert.equal(bk.ok, true, bk.error);
  const pub = await (await fetch(`${base}/api/owner/feed`)).json();
  const text = JSON.stringify(pub);
  assert.equal(pub.redacted, true);
  assert.doesNotMatch(text, /555-0142|412 Oak|Kim|Hi this is/);
  assert.equal(pub.leads[0].id, lead.id);
  const own = await (await fetch(`${base}/api/owner/feed?key=owner-secret-for-tests`)).json();
  assert.equal(own.redacted, false);
  assert.equal(pub.bookings[0].quoteTotal, 189);
  assert.equal(own.bookings[0].address, '412 Oak St, Nashville');
  assert.match(JSON.stringify(own), /412 Oak/);
});

test('the event stream carries no customer details', async () => {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctl.signal });
  const reader = res.body.getReader();
  const { value } = await reader.read();
  ctl.abort();
  const s = new TextDecoder().decode(value);
  assert.match(s, /event: hello/);
  assert.doesNotMatch(s, /phone|address|transcript/);
});

test('scrub blanks phone numbers and street addresses', () => {
  assert.equal(scrub('text 615-555-0100 or (615) 555 0100'), 'text ••• or •••');
  assert.match(scrub('I live at 412 Oak St in Nashville'), /\(address\)/);
  assert.equal(scrub('two-car driveway, 3 windows'), 'two-car driveway, 3 windows');
  assert.ok(redactSnapshot({ leads: [], bookings: [] }));
});

test('sample photos are listed by URL (served as static files), not inlined as base64', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { listSamples } = await import('../src/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'samples-'));
  fs.writeFileSync(path.join(dir, 'driveway.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  fs.writeFileSync(path.join(dir, 'driveway.txt'), 'Driveway\nHow big is my driveway? I need sealer.');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'ignored');
  const list = listSamples(dir);
  assert.deepEqual(list, [{ id: 'driveway', label: 'Driveway', text: 'How big is my driveway? I need sealer.', url: '/samples/driveway.jpg' }]);
  assert.deepEqual(listSamples(path.join(dir, 'missing')), []);
  const r = await (await fetch(`${base}/api/measure/samples`)).json();
  assert.ok(Array.isArray(r));
  assert.ok(r.every((x) => x.url && !x.dataUrl));
});
