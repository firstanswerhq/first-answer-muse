// A tiny ray tracer for test scenes: flat ground plus upright rectangles (fences, walls, doors,
// posts). Draws what SAM 3.1 would return for each named object, in SAM's own wire format.
// Units: feet. World: X right, Y up, Z ahead. The camera can be tipped down, tilted and turned.
import { encodeSegmentationMask } from '../node_modules/@meta-sam/parser/dist/mask-codec.js';
import { parseSam } from '../src/muse.js';

const DEG = Math.PI / 180;

export function camera3d({ W = 720, H = 960, hfov = 69, camH = 5, camX = 0, camZ = 0, pitchDeg = 10, rollDeg = 0, yawDeg = 0 }) {
  const f = (0.5 * Math.max(W, H)) / Math.tan((hfov * DEG) / 2);
  const p = pitchDeg * DEG, r = rollDeg * DEG, y = yawDeg * DEG;
  const fwd0 = [0, -Math.sin(p), Math.cos(p)];
  const right0 = [1, 0, 0], down0 = [0, -Math.cos(p), -Math.sin(p)];
  const right1 = right0.map((v, k) => v * Math.cos(r) + down0[k] * Math.sin(r));
  const down1 = down0.map((v, k) => v * Math.cos(r) - right0[k] * Math.sin(r));
  const yawv = ([a, b, c]) => [a * Math.cos(y) + c * Math.sin(y), b, -a * Math.sin(y) + c * Math.cos(y)];
  const fwd = yawv(fwd0), right = yawv(right1), down = yawv(down1);
  const C = [camX, camH, camZ];
  const ray = (u, v) => { const a = (u - W / 2) / f, b = (v - H / 2) / f; return [0, 1, 2].map((k) => fwd[k] + a * right[k] + b * down[k]); };
  return { W, H, f, C, ray };
}

// Upright rectangle: { name, axis: 'x'|'z', at, from, to, bottom = 0, top }.
//   axis 'x': a wall facing sideways at X = at, spanning Z from..to (a fence or house wall along the yard).
//   axis 'z': a wall facing the camera at Z = at, spanning X from..to (a door, the back fence).
function hitRect(o, C, d) {
  const k = o.axis === 'x' ? 0 : 2, j = o.axis === 'x' ? 2 : 0;
  if (Math.abs(d[k]) < 1e-12) return null;
  const t = (o.at - C[k]) / d[k];
  if (t <= 0) return null;
  const Y = C[1] + t * d[1], s = C[j] + t * d[j];
  if (Y < (o.bottom ?? 0) || Y > o.top || s < o.from || s > o.to) return null;
  return t;
}

/** Render; returns { frame, objects: { name: parsed SAM object } }. Objects listed later win ties (drawn in front). */
export function render(cam, rects, { step = 1 } = {}) {
  const { W, H, C, ray } = cam;
  const label = new Int16Array(W * H).fill(-1);
  for (let v = 0; v < H; v += step) {
    for (let u = 0; u < W; u += step) {
      const d = ray(u + 0.5, v + 0.5);
      let best = Infinity, who = -1;
      rects.forEach((o, i) => { const t = hitRect(o, C, d); if (t != null && t <= best + 1e-6) { best = t; who = i; } });
      // the ground hides anything behind where it is hit? No: walls stand on the ground, so a wall hit is always in front of the ground behind it.
      label[v * W + u] = who;
    }
  }
  const objects = {};
  rects.forEach((o, i) => {
    let x1 = W, y1 = H, x2 = -1, y2 = -1;
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) if (label[v * W + u] === i) { if (u < x1) x1 = u; if (u > x2) x2 = u; if (v < y1) y1 = v; if (v > y2) y2 = v; }
    if (x2 < 0) return;
    const mw = x2 - x1 + 1, mh = y2 - y1 + 1, r = new Uint8Array(mw * mh);
    for (let v = 0; v < mh; v++) for (let u = 0; u < mw; u++) r[v * mw + u] = label[(y1 + v) * W + x1 + u] === i ? 1 : 0;
    const m = encodeSegmentationMask(r, mw, mh);
    const text = `<0f>0<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${W};h=${H};c=0.94|><|mask;x=0;y=0;c=0.94;data=${m.height},${m.width},${m.payload}|>`;
    objects[o.name] = parseSam(text).objects[0];
  });
  return { frame: { w: W, h: H }, objects };
}
