// Locked-down endpoints: the credit-spending ones are rate limited per IP, the diag probes need a token,
// and the public owner board never shows phone numbers, addresses or voicemail text.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

delete process.env.MODEL_API_KEY;
process.env.DIAG_TOKEN = 'diag-secret-for-tests';
process.env.OWNER_TOKEN = 'owner-secret-for-tests';
const { app, measureLimit, photoLimit } = await import('../src/server.js');
const engine = await import('../src/engine.js');
const { clientIp, rateLimiter, tokenOk, redactSnapshot, redactLead, scrub, dailyCap, metaCalls } = await import('../src/guard.js');

const server = http.createServer(app);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const measure = (ip, extra = {}) => fetch(`${base}/api/measure`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip, ...extra }, body: JSON.stringify({ dataUrl: tiny, text: 'how big' }) });

test('client IP: the RIGHTMOST x-forwarded-for, then req.ip; Cloudflare headers only when TRUST_CLOUDFLARE=1', () => {
  // By default a caller-written cf-connecting-ip / true-client-ip is ignored.
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': '1.1.1.1', 'true-client-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' }, ip: '4.4.4.4' }), '3.3.3.3');
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': '1.1.1.1' }, ip: '4.4.4.4' }), '4.4.4.4');
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '3.3.3.3' }, ip: '4.4.4.4' }, { trustCloudflare: true }), '1.1.1.1');
  assert.equal(clientIp({ headers: { 'true-client-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' }, ip: '4.4.4.4' }, { trustCloudflare: true }), '2.2.2.2');
  // The caller can write anything on the left; Render appends the address it really saw.
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6, 3.3.3.3' }, ip: '4.4.4.4' }), '3.3.3.3');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '3.3.3.3 , ' }, ip: '4.4.4.4' }), '3.3.3.3');
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
  // Rotating a fake cf-connecting-ip does not get around the limit.
  for (let i = 0; i < 3; i++) assert.equal((await measure('9.9.9.9', { 'cf-connecting-ip': `10.0.0.${i}` })).status, 429);
  // Nor does writing addresses to the left of the one Render appends.
  assert.equal((await measure('7.7.7.7, 9.9.9.9')).status, 429);
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
  // A key in the URL query is ignored (URLs land in logs); only the header works.
  const viaQuery = await (await fetch(`${base}/api/owner/feed?key=owner-secret-for-tests`)).json();
  assert.equal(viaQuery.redacted, true);
  assert.doesNotMatch(JSON.stringify(viaQuery), /412 Oak/);
  const own = await (await fetch(`${base}/api/owner/feed`, { headers: { 'x-owner-key': 'owner-secret-for-tests' } })).json();
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

test('public leads are an allowlist: the hand-to-owner note and unknown fields never show', async () => {
  engine.reset();
  const lead = engine.addLead({ channel: 'text', phone: '615-555-0142', summary: 'driveway' });
  engine.updateLead(lead.id, { status: 'needs owner', note: 'Angry, lives at 412 Oak St, call 615-555-0142', address: '412 Oak St', secretField: 'x', photo: 'data:image/png;base64,AAAA' });
  const pub = await (await fetch(`${base}/api/owner/feed`)).json();
  const l = pub.leads[0];
  assert.equal(l.note, undefined);
  assert.equal(l.address, undefined);
  assert.equal(l.secretField, undefined);
  assert.equal(l.photo, undefined);
  assert.equal(l.status, 'needs owner');
  assert.doesNotMatch(JSON.stringify(pub), /412 Oak|555-0142|base64/);
  assert.deepEqual(Object.keys(redactLead({ id: 'x', anything: 1 })).includes('anything'), false);
});

test('/api/photo: 20 per 10 minutes per IP (it spends SAM and Muse Image)', async () => {
  photoLimit.reset();
  const post = () => fetch(`${base}/api/photo`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '7.7.7.7' }, body: JSON.stringify({}) });
  for (let i = 0; i < 20; i++) assert.equal((await post()).status, 400, `request ${i + 1}`);
  assert.equal((await post()).status, 429);
});

test('global daily cap on Meta calls: rotating IPs can’t get past it, and it resets each day', async () => {
  let now = Date.parse('2026-11-01T10:00:00Z');
  const cap = dailyCap({ max: 3, clock: () => now });
  assert.equal(cap.take(), true);
  assert.equal(cap.take(2), true);
  assert.equal(cap.take(), false);
  assert.equal(cap.remaining(), 0);
  now = Date.parse('2026-11-02T00:00:01Z');
  assert.equal(cap.remaining(), 3);
  assert.equal(metaCalls.max, 1500);

  // Live mode with the budget used up: /api/measure refuses before calling Meta, from any IP.
  process.env.MODEL_API_KEY = 'test-not-a-real-key';
  try {
    metaCalls.take(metaCalls.remaining());
    measureLimit.reset();
    for (const ip of ['1.0.0.1', '1.0.0.2']) {
      const r = await measure(ip);
      assert.equal(r.status, 429);
      const body = await r.json();
      assert.equal(body.dailyCap, true);
      assert.match(body.ask, /try again tomorrow/i);
    }
  } finally {
    delete process.env.MODEL_API_KEY;
    metaCalls.reset();
  }
});

test('Meta calls past the cap fail fast without touching the network', async () => {
  const muse = await import('../src/muse.js');
  metaCalls.take(metaCalls.remaining());
  try {
    await assert.rejects(muse.samSegment({ dataUrl: tiny, concept: 'chip' }), { name: 'MetaBudgetError' });
    const { measureErrorMessage } = await import('../src/server.js');
    assert.match(measureErrorMessage(new (await import('../src/guard.js')).MetaBudgetError()), /tomorrow/);
  } finally {
    metaCalls.reset();
  }
});

test('public board: no free text from customers or the agent; a generic label instead', async () => {
  engine.reset();
  const vm = engine.addLead({ channel: 'voicemail', phone: '615-555-0142', summary: 'Hi, Marcus here, gate code 4417, 88 Belmont Boulevard', transcript: 'Hi, Marcus here, gate code 4417' });
  engine.updateLead(vm.id, { durationS: 42, notes: 'Marcus Lee said the dog is out back, gate code 4417', name: 'Marcus Lee' });
  const tx = engine.addLead({ channel: 'text', summary: 'This is Priya, my side gate code is 0099' });
  const pub = await (await fetch(`${base}/api/owner/feed`)).json();
  const s = JSON.stringify(pub);
  assert.doesNotMatch(s, /Marcus|Priya|4417|0099|Belmont|dog/);
  assert.equal(pub.leads.find((l) => l.id === vm.id).summary, 'Voicemail lead · 0:42');
  assert.equal(pub.leads.find((l) => l.id === tx.id).summary, 'Text lead');
  const own = await (await fetch(`${base}/api/owner/feed`, { headers: { 'x-owner-key': 'owner-secret-for-tests' } })).json();
  assert.match(JSON.stringify(own), /gate code 4417/);
});

test('voicemail length comes from the WAV header', async () => {
  const { wavSeconds } = await import('../src/server.js');
  const h = Buffer.alloc(44 + 16000 * 2 * 3);
  h.write('RIFF', 0, 'ascii'); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt16LE(16, 34);
  assert.equal(wavSeconds(h), 3);
  assert.equal(wavSeconds(Buffer.from('nope')), null);
  assert.equal(wavSeconds(undefined), null);
});
