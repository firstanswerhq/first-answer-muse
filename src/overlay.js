// Pictures for Muse Spark's check of SAM's work: the customer's photo with SAM's outlines drawn on
// it (magenta = what we measure, orange = the ruler, blue = the other side of a gap), plus a close-up
// crop of each outline, and a small copy for the owner board. Pure JS (jpeg-js), no native image
// libraries. The page always sends JPEG of at most 1600 px; a PNG or WebP, or a JPEG over MAX_PIXELS,
// returns null, and the check then sends the plain photo with SAM's boxes written out as pixel
// coordinates in the prompt (checkPrompt). Decoding runs in a worker thread (checkImagesAsync), so a
// big photo never blocks the server, and the caller's timeout covers it.

import jpeg from 'jpeg-js';
import { Worker } from 'node:worker_threads';
import { decodeMaskToRaster } from '@meta-sam/parser';

export const MAX_PIXELS = 2_500_000; // about 2.5 MP: what jpeg-js can decode inside 64 MB; the page sends at most 1600 × 1200
export const MAX_MEMORY_MB = 64;

// Width and height from a JPEG's frame header (SOFn), without decoding it. null if not a JPEG.
export function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (m === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

export const COLORS = { target: [255, 40, 210], ruler: [255, 150, 20], other: [40, 120, 255] };
export const COLOR_NAMES = { target: 'MAGENTA', ruler: 'ORANGE', other: 'BLUE' };

export function decodeDataUrl(dataUrl) {
  const m = /^data:image\/jpe?g;base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  try {
    const buf = Buffer.from(m[1], 'base64');
    const size = jpegSize(buf);
    if (!size || size.width * size.height > MAX_PIXELS) return null; // too big to decode here: skip the overlay
    const img = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: MAX_MEMORY_MB });
    return { width: img.width, height: img.height, data: img.data };
  } catch {
    return null;
  }
}

const toDataUrl = (img, quality = 85) => `data:image/jpeg;base64,${Buffer.from(jpeg.encode(img, quality).data).toString('base64')}`;

// Nearest-neighbor resample of a region [x0, y0, x1, y1) to fit within max px on the long side.
function resample(img, x0, y0, x1, y1, max) {
  const sw = x1 - x0, sh = y1 - y0;
  const s = Math.min(1, max / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y0 + (y + 0.5) / s));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x0 + (x + 0.5) / s));
      const i = (sy * img.width + sx) * 4, o = (y * w + x) * 4;
      out[o] = img.data[i]; out[o + 1] = img.data[i + 1]; out[o + 2] = img.data[i + 2]; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out, scale: s, x0, y0 };
}

// Is photo pixel (px, py) inside the object's mask (or its box when SAM sent no mask)?
function insideTest(obj) {
  const { box, mask } = obj;
  if (!mask) return (px, py) => px >= box.x1 && px <= box.x2 && py >= box.y1 && py <= box.y2;
  const r = decodeMaskToRaster(mask);
  const sx = mask.width / (box.x2 - box.x1 + 1), sy = mask.height / (box.y2 - box.y1 + 1);
  return (px, py) => {
    const c = Math.floor((px - box.x1) * sx), rr = Math.floor((py - box.y1) * sy);
    return c >= 0 && rr >= 0 && c < mask.width && rr < mask.height && r[rr * mask.width + c] === 1;
  };
}

// Paint outlines (a thick edge plus a light tint inside) onto a resampled view.
function paint(view, items, frameScale) {
  const { width: w, height: h, data, scale, x0, y0 } = view;
  const k = scale * frameScale; // view px per SAM frame px
  for (const it of items) {
    const inside = insideTest(it.obj);
    const col = COLORS[it.role] || COLORS.target;
    const at = (x, y) => inside(x0 / frameScale + (x + 0.5) / k, y0 / frameScale + (y + 0.5) / k);
    const b = it.obj.box;
    const vx0 = Math.max(0, Math.floor((b.x1 - x0 / frameScale) * k) - 4), vx1 = Math.min(w - 1, Math.ceil((b.x2 - x0 / frameScale) * k) + 4);
    const vy0 = Math.max(0, Math.floor((b.y1 - y0 / frameScale) * k) - 4), vy1 = Math.min(h - 1, Math.ceil((b.y2 - y0 / frameScale) * k) + 4);
    if (vx1 < vx0 || vy1 < vy0) continue;
    const bw = vx1 - vx0 + 1;
    const m = new Uint8Array(bw * (vy1 - vy0 + 1));
    for (let y = vy0; y <= vy1; y++) for (let x = vx0; x <= vx1; x++) m[(y - vy0) * bw + (x - vx0)] = at(x, y) ? 1 : 0;
    const t = Math.max(2, Math.round(Math.max(w, h) / 300)); // edge thickness
    const get = (x, y) => (x < vx0 || y < vy0 || x > vx1 || y > vy1 ? 0 : m[(y - vy0) * bw + (x - vx0)]);
    for (let y = vy0; y <= vy1; y++) {
      for (let x = vx0; x <= vx1; x++) {
        const v = get(x, y);
        let edge = false;
        for (let d = 1; d <= t && !edge; d++) if (get(x - d, y) !== v || get(x + d, y) !== v || get(x, y - d) !== v || get(x, y + d) !== v) edge = true;
        const o = (y * w + x) * 4;
        if (edge && v) { data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; }
        else if (v) { data[o] = (data[o] * 3 + col[0]) >> 2; data[o + 1] = (data[o + 1] * 3 + col[1]) >> 2; data[o + 2] = (data[o + 2] * 3 + col[2]) >> 2; }
      }
    }
  }
}

/**
 * checkImages(dataUrl, items, frame) -> { overlay, crops: [{ role, url }], thumb } or null
 *   items: [{ role: 'target' | 'ruler' | 'other', obj }]  (SAM objects with box and mask, in SAM frame pixels)
 *   thumb: a small copy of the overlay (thumbMax px) for the owner board.
 */
export function checkImages(dataUrl, items, frame, { overlayMax = 1024, cropMax = 448, thumbMax = 480 } = {}) {
  const img = decodeDataUrl(dataUrl);
  if (!img || !items.length) return null;
  // SAM's frame can differ from the decoded photo size (it reports its own w/h): scale between them.
  const fs = frame?.w ? img.width / frame.w : 1;
  const full = resample(img, 0, 0, img.width, img.height, overlayMax);
  paint(full, items, fs);
  const crops = [];
  for (const it of items) {
    const b = it.obj.box;
    const bw = (b.x2 - b.x1 + 1) * fs, bh = (b.y2 - b.y1 + 1) * fs;
    const pad = Math.max(bw, bh) * 0.35 + 8;
    const x0 = Math.max(0, Math.floor(b.x1 * fs - pad)), y0 = Math.max(0, Math.floor(b.y1 * fs - pad));
    const x1 = Math.min(img.width, Math.ceil((b.x2 + 1) * fs + pad)), y1 = Math.min(img.height, Math.ceil((b.y2 + 1) * fs + pad));
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    const v = resample(img, x0, y0, x1, y1, cropMax);
    paint(v, [it], fs);
    crops.push({ role: it.role, url: toDataUrl(v) });
  }
  const t = resample(full, 0, 0, full.width, full.height, thumbMax);
  return { overlay: toDataUrl(full), crops, thumb: toDataUrl(t, 72) };
}

// The same, in a worker thread: the event loop stays free, and past timeoutMs the worker is stopped
// and this resolves null (the check then goes on with the plain photo).
export function checkImagesAsync(dataUrl, items, frame, { timeoutMs = 4000, ...opts } = {}) {
  return new Promise((resolve) => {
    let w;
    try {
      w = new Worker(new URL('./overlay-worker.js', import.meta.url), { workerData: { dataUrl, items, frame, opts }, resourceLimits: { maxOldGenerationSizeMb: 192 } });
    } catch { return resolve(null); }
    const done = (v) => { clearTimeout(timer); w.terminate().catch(() => {}); resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    w.once('message', (m) => done(m?.ok ? m.out : null));
    w.once('error', () => done(null));
    w.once('exit', () => done(null));
  });
}
