// The Sight page in a real browser (headless Chromium through Playwright, when it is installed on the
// machine; otherwise this file is skipped): the floor conversation from the customer's side. The server
// runs with stand-in models; the browser is driven at a phone's width.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { camera, samSeg, rectShape } from './flatscene.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {}
let browser = null;
if (chromium) { try { browser = await chromium.launch(); } catch { browser = null; } }

delete process.env.MODEL_API_KEY;
const srv = await import('../src/server.js');
const ROOM = rectShape(0, 0, 3048, 3658, 0), PAPER = rectShape(300, -200, 279.4, 215.9, 0);
const POSES = [{ tiltDeg: 35, D: 3500, f: 1300, panDeg: 0, aim: [0, -121] }, { tiltDeg: 35, D: 3500, f: 1300, panDeg: 180, aim: [0, 121] }];
const segs = POSES.map((p) => { const cam = camera(p); return { floor: samSeg(cam, ROOM.inside, ROOM.boundary), 'sheet of paper': samSeg(cam, PAPER.inside, PAPER.boundary) }; });
const EMPTY = { objects: [], frame: { w: 1280, h: 960 } };
// Photos are told apart by content, in the order first seen: 1st -> doorway pose, 2nd -> far doorway, 3rd -> no sheet.
const seen = new Map();
const slot = (d) => { if (!seen.has(d)) seen.set(d, seen.size); return seen.get(d); };
srv._testDeps.current = {
  read: async () => ({ task: 'floor_tile', target: 'floor', second_target: '', ruler: 'paper_letter', item_width_in: 0, tile_w_in: 12, tile_l_in: 12, shoe_for: 'unknown', language: 'en', summary: '' }),
  segment: async (d, c) => { const k = slot(d); if (k >= 2) return c === 'floor' ? segs[1][c] : EMPTY; return segs[k][c]; },
};
const server = http.createServer(srv.app);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { server.close(); srv._testDeps.current = null; await browser?.close(); });

// Three distinct tiny PNGs (solid colors), written to temp files for the file input.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
function png(rgb) {
  const w = 4, h = 4;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill(rgb).flat())])));
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-page-'));
const files = [[200, 60, 60], [60, 200, 60], [60, 60, 200]].map((rgb, i) => { const f = path.join(dir, `p${i + 1}.png`); fs.writeFileSync(f, png(rgb)); return f; });

test('the floor conversation on a phone: a camera photo sent with an EMPTY text box joins the floor; a paperless one is dropped and badged; Start over begins a new floor', { skip: !browser && 'Playwright with Chromium is not installed here' }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const posts = [], errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (r.url().endsWith('/api/measure') && r.method() === 'POST') { const j = JSON.parse(r.postData()); posts.push((j.dataUrls || [j.dataUrl]).length); } });
  const done = async () => { await page.waitForSelector('.msg.working', { timeout: 5000 }).catch(() => {}); await page.waitForFunction(() => !document.querySelector('.msg.working'), null, { timeout: 60000 }); await page.waitForTimeout(300); };
  const last = () => page.locator('.msg.reply').last();
  await page.goto(`${base}/measure.html`);
  // 1. A floor photo with a floor question: a partial that asks for more.
  await page.fill('#textIn', 'how much tile for this floor?');
  await page.setInputFiles('#photoIn', files[0]);
  await page.click('#sendBtn'); await done();
  assert.deepEqual(posts, [1]);
  assert.match(await last().locator('.r-answer').textContent(), /^I can see part of the floor: about \d+ sq ft so far\./);
  assert.equal(await last().locator('.r-biz').count(), 0);
  // 2. The next camera photo with NOTHING typed: it joins the floor (2 photos posted).
  await page.setInputFiles('#photoIn', files[1]);
  assert.equal(await page.inputValue('#textIn'), '');
  await page.click('#sendBtn'); await done();
  assert.deepEqual(posts, [1, 2]);
  assert.match(await last().locator('.r-answer').textContent(), /^Combined from 2 photos:/);
  assert.equal(await last().locator('.r-biz').count(), 1);
  // 3. A photo without the sheet, nothing typed: dropped, named right under the answer, badged on the photo; the two good ones stay.
  await page.setInputFiles('#photoIn', files[2]);
  await page.click('#sendBtn'); await done();
  assert.deepEqual(posts, [1, 2, 3]);
  assert.match(await last().locator('.r-drop').textContent(), /^Photo 3: I can’t line that one up without the paper\./);
  assert.deepEqual(await last().locator('.shot.dropped .shot-drop').allTextContents(), ['not used']);
  assert.match(await last().locator('.r-next span').textContent(), /^2 photos of this floor so far\./);
  // 4. Start over, then a photo with another task's words does not join.
  await last().locator('.r-reset').click();
  await page.fill('#textIn', 'how much tile for this floor?');
  await page.setInputFiles('#photoIn', files[0]);
  await page.click('#sendBtn'); await done();
  assert.equal(posts.at(-1), 1);
  assert.deepEqual(errors, []);
  await page.close();
});
