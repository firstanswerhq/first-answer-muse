// The daily cap counts every HTTP attempt to Meta, retries included (review pass 2: the SDK's own
// retries were uncounted).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let hits = 0, mode = 500;
const srv = http.createServer((q, r) => {
  hits++; q.resume();
  r.setHeader('content-type', 'application/json');
  if (mode === 'ok') return r.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"a":1}' } }] }));
  r.statusCode = mode; r.end('{"error":"x"}');
});
await new Promise((ok) => srv.listen(0, ok));
test.after(() => srv.close());
process.env.MODEL_API_KEY = 'fake';
process.env.META_RELAY_URL = 'direct';
process.env.MODEL_API_BASE_URL = `http://127.0.0.1:${srv.address().port}/v1`;
const { sparkReadPhoto, sparkChat, sparkWrite, counted } = await import('../src/muse.js');
const { metaCalls } = await import('../src/guard.js');

test('a read that keeps failing with 500: 3 HTTP attempts, 3 counted', async () => {
  metaCalls.reset(); hits = 0; mode = 500;
  await assert.rejects(sparkReadPhoto({ dataUrl: 'data:image/jpeg;base64,AA', prompt: 'x', schema: {} }));
  assert.equal(hits, 3);
  assert.equal(metaCalls.used(), 3);
});

test('a chat that fails with 400 is not retried: 1 attempt, 1 counted', async () => {
  metaCalls.reset(); hits = 0; mode = 400;
  await assert.rejects(sparkChat({ messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(hits, 1);
  assert.equal(metaCalls.used(), 1);
});

test('wording never retries; success counts one', async () => {
  metaCalls.reset(); hits = 0; mode = 503;
  await assert.rejects(sparkWrite({ system: 's', facts: {} }));
  assert.equal(hits, 1);
  mode = 'ok'; hits = 0;
  await sparkWrite({ system: 's', facts: {} });
  assert.equal(hits, 1);
  assert.equal(metaCalls.used(), 2);
});

test('retries stop when the daily cap runs out mid-way', async () => {
  metaCalls.reset();
  while (metaCalls.remaining() > 1) metaCalls.take(1);
  let n = 0;
  await assert.rejects(counted(async () => { n++; const e = new Error('x'); e.status = 500; throw e; }, { retries: 2, backoffMs: 1 }), /daily limit/);
  assert.equal(n, 1);
  metaCalls.reset();
});
