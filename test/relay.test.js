// The Supabase relay switch: with META_RELAY_URL + META_RELAY_KEY set, REST calls go to the relay
// with an x-relay-key header and the Meta key still in Authorization; realtime voice stays direct.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MODEL_API_KEY = 'test-not-a-real-key';
process.env.META_RELAY_URL = 'https://example.supabase.co/functions/v1/meta-relay';
process.env.META_RELAY_KEY = 'anon-test';
const seen = [];
globalThis.fetch = async (url, init = {}) => {
  seen.push({ url: String(url), headers: new Headers(init.headers) });
  return new Response('{"object":"response","output_text":""}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const muse = await import('../src/muse.js');

test('relay settings route REST calls through the relay', async () => {
  assert.equal(muse.BASE_URL, 'https://example.supabase.co/functions/v1/meta-relay');
  assert.equal(muse.DIRECT_URL, 'https://api.meta.ai/v1');
  await muse.samSegment({ dataUrl: 'data:image/jpeg;base64,AAAA', concept: 'driveway' });
  const call = seen.at(-1);
  assert.equal(call.url, 'https://example.supabase.co/functions/v1/meta-relay/responses');
  assert.equal(call.headers.get('x-relay-key'), 'anon-test');
  assert.equal(call.headers.get('authorization'), 'Bearer test-not-a-real-key');
});
