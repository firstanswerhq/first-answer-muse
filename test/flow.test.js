// End-to-end over HTTP in demo mode (no API key): text, photo and voicemail all reach a booking.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

delete process.env.MODEL_API_KEY;
const { app, attachLive } = await import('../src/server.js');
const engine = await import('../src/engine.js');

const server = http.createServer(app);
attachLive(server);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('health reports demo mode without a key', async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.mode, 'demo');
});

test('a text conversation ends in a booking with the price-list total', async () => {
  engine.reset();
  const id = 'flow-text';
  let r = await post('/api/message', { threadId: id, text: 'How much to wash a 2-car driveway?', phone: '615-555-0100' });
  assert.match(r.body.reply, /\$189/);
  assert.deepEqual(r.body.tools.map((t) => t.name), ['quote_job', 'open_times']);
  r = await post('/api/message', { threadId: id, text: '1' });
  r = await post('/api/message', { threadId: id, text: 'Sarah Kim, 412 Oak St, Nashville' });
  assert.match(r.body.reply, /Booked/);
  const feed = await (await fetch(`${base}/api/owner/feed`)).json();
  assert.equal(feed.bookings.length, 1);
  assert.equal(feed.bookings[0].quoteTotal, 189);
  assert.equal(feed.leads[0].status, 'booked');
});

test('a photo gets a counted quote, then the times', async () => {
  const id = 'flow-photo';
  const tiny = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  let r = await post('/api/photo', { threadId: id, dataUrl: tiny });
  assert.equal(r.status, 200);
  assert.match(r.body.reply, /windows/);
  r = await post('/api/message', { threadId: id, text: 'yes please' });
  assert.match(r.body.reply, /1\) /);
});

test('a voicemail is transcribed and texted back with a quote', async () => {
  const fd = new FormData();
  fd.append('threadId', 'flow-vm');
  fd.append('phone', '615-555-0111');
  const res = await fetch(`${base}/api/voicemail`, { method: 'POST', body: fd });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.match(body.transcript, /driveway/);
  assert.match(body.reply, /\$189/);
});

test('bad input is refused politely', async () => {
  assert.equal((await post('/api/message', { text: 'hi' })).status, 400);
  assert.equal((await post('/api/photo', { threadId: 'x', dataUrl: 'not-an-image' })).status, 400);
});
