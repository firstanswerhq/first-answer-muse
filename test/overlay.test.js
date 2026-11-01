// Drawing SAM's outlines for Spark's check: the photo size is read from the JPEG header first, big
// photos skip the overlay, decoding runs in a worker (the server never stalls), and a PNG or WebP gets
// a prompt that says what was really sent: the plain photo plus SAM's boxes as pixel coordinates.
import test from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { jpegSize, decodeDataUrl, checkImagesAsync, MAX_PIXELS } from '../src/overlay.js';
import { checkPrompt } from '../src/anything.js';

const jpg = (W, H) => Buffer.from(jpeg.encode({ width: W, height: H, data: Buffer.alloc(W * H * 4, 120) }, 85).data);
const url = (b) => `data:image/jpeg;base64,${b.toString('base64')}`;
const items = (W, H) => [{ role: 'target', obj: { box: { x1: 10, y1: 10, x2: W / 2, y2: H / 2 } } }, { role: 'ruler', obj: { box: { x1: W / 2, y1: H / 2, x2: W - 10, y2: H - 10 } } }];

test('the JPEG size comes from the header, without decoding', () => {
  assert.deepEqual(jpegSize(jpg(640, 480)), { width: 640, height: 480 });
  assert.equal(jpegSize(Buffer.from('not a jpeg')), null);
});

test('a photo over the pixel cap is not decoded (the overlay is skipped)', () => {
  const big = jpg(2048, 1536);
  assert.ok(2048 * 1536 > MAX_PIXELS);
  assert.equal(decodeDataUrl(url(big)), null);
  assert.ok(decodeDataUrl(url(jpg(1600, 1200))));
});

test('the overlay is drawn in a worker: the server keeps serving, and a small copy comes back for the owner board', async () => {
  let maxGap = 0, last = performance.now();
  const iv = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 5);
  const out = await checkImagesAsync(url(jpg(1600, 1200)), items(1600, 1200), { w: 1600, h: 1200 }, { timeoutMs: 8000 });
  clearInterval(iv);
  assert.ok(out?.overlay && out.crops.length === 2 && out.thumb);
  assert.ok(maxGap < 250, `event loop stalled ${Math.round(maxGap)} ms`);
  const t = decodeDataUrl(out.thumb);
  assert.ok(Math.max(t.width, t.height) <= 480);
});

test('the timeout covers drawing: a slow draw gives up and returns null', async () => {
  const t0 = Date.now();
  const out = await checkImagesAsync(url(jpg(1600, 1200)), items(1600, 1200), { w: 1600, h: 1200 }, { timeoutMs: 5 });
  assert.equal(out, null);
  assert.ok(Date.now() - t0 < 1000);
});

test('PNG / WebP: the prompt says nothing is drawn and gives the boxes in pixels', () => {
  const its = items(900, 1200).map((it) => ({ ...it, expect: it.role === 'target' ? 'the driveway' : 'a garage door' }));
  const p = checkPrompt(its, false, { drawn: false, frame: { w: 900, h: 1200 } });
  assert.match(p, /nothing drawn on it/);
  assert.doesNotMatch(p, /outlines drawn on it/);
  assert.match(p, /MAGENTA box: x 10 to 450, y 10 to 600/);
  assert.match(p, /900 × 1200 grid/);
  assert.match(checkPrompt(its, true), /Image 1 is the photo with the outlines drawn on it\. The next images are close-ups/);
});
