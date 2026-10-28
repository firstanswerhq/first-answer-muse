// The driveway photo path end to end, with Meta's API faked at the network layer:
// Muse Spark reads the photo, SAM outlines the driveway and the garage door, the math measures it,
// the price list prices it by the square foot, and the reply says what it measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scene } from './scene.js';

process.env.MODEL_API_KEY = 'test-not-a-real-key';
process.env.META_RELAY_URL = 'direct';
const s = scene({ drive: { x0: -9, x1: 9, z0: 16, z1: 40 }, door: { x0: -8, x1: 8, z: 40 } }); // 18 x 24 ft = 432 sq ft
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url instanceof Request ? url.url : url);
  const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  calls.push(u.replace(/^.*\/v1/, ''));
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/chat/completions')) {
    const read = { service: 'driveway', driveway_tier: 'medium', stories: 1, windows_estimate: 4, garage_door: 'double', notes: 'Oil stain by the garage.', summary: 'Two-car driveway, oil stains.' };
    return json({ id: 'x', object: 'chat.completion', created: 0, model: 'muse-spark-1.3', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(read) } }] });
  }
  if (u.endsWith('/responses')) {
    const concept = body.input[0].content.find((c) => c.type === 'input_text').text;
    const text = concept === 'driveway' ? s.driveText : concept === 'garage door' ? s.doorText : '';
    return json({ id: 'r', object: 'response', output_text: text, output: [] });
  }
  if (u.endsWith('/images/edits')) return json({ error: { message: 'not in this test' } }, 500);
  throw new Error(`unexpected call ${u}`);
};
test.after(() => { globalThis.fetch = realFetch; delete process.env.MODEL_API_KEY; });

const { quoteFromPhoto, photoReply } = await import('../src/photo.js');

test('a driveway photo is measured against the garage door and priced by the square foot', async () => {
  const r = await quoteFromPhoto({ dataUrl: 'data:image/jpeg;base64,AAAA' });
  assert.equal(r.ok, true);
  assert.equal(r.service, 'driveway');
  assert.ok(r.measure, 'measured');
  assert.equal(r.measure.confidence, 'good');
  assert.ok(Math.abs(r.measure.sqft - 432) / 432 < 0.12, `got ${r.measure.sqft}`);
  assert.equal(r.args.sqft, r.measure.sqft);
  assert.equal(r.quote.total, Math.max(139, Math.round(r.measure.sqft * 0.35)));
  assert.ok(r.outline?.path.startsWith('M'), 'driveway outline for the overlay');
  assert.ok(calls.filter((c) => c === '/responses').length === 2, 'SAM called for driveway and garage door');
  const reply = photoReply(r);
  assert.match(reply, /garage door as a ruler/);
  assert.match(reply, /18 by 24 ft/);
  assert.match(reply, /sq ft/);
  assert.match(reply, new RegExp(`\\$${r.quote.total} total`));
});
