// 3D test head for face measuring. Units: mm. The camera sits at the origin looking down +Z.
// The head's front plane (where the card sits) is at Z = D; each feature is a flat shape centered
// at (u, v) in face coordinates, d mm behind (+) or in front (−) of that plane, optionally sloped
// back by `slopeDeg` (top farther away, like a forehead). The head turns (yaw), nods (pitch) and
// tilts (roll) about its center, ~90 mm behind the forehead.
import { encodeSegmentationMask } from '../node_modules/@meta-sam/parser/dist/mask-codec.js';
import { parseSam } from '../src/muse.js';

const DEG = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function headScene({ D = 400, yawDeg = 0, pitchDeg = 0, rollDeg = 0, W = 1080, H = 1440, hfov = 69, features }) {
  const f = (0.5 * Math.max(W, H)) / Math.tan((hfov * DEG) / 2);
  const cx = W / 2, cy = H / 2;
  const C = [0, 0, D + 90];
  const ry = yawDeg * DEG, rx = pitchDeg * DEG, rz = rollDeg * DEG;
  const rot = ([x, y, z]) => {
    let p = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz), z];
    p = [p[0], p[1] * Math.cos(rx) - p[2] * Math.sin(rx), p[1] * Math.sin(rx) + p[2] * Math.cos(rx)];
    return [p[0] * Math.cos(ry) + p[2] * Math.sin(ry), p[1], -p[0] * Math.sin(ry) + p[2] * Math.cos(ry)];
  };
  // face (u, v, depth) -> world; v is up, depth is away from the camera
  const toWorld = (u, v, d) => { const r = rot([u, v, d - 90]); return [C[0] + r[0], C[1] + r[1], C[2] + r[2]]; };
  const project = ([x, y, z]) => [cx + (f * x) / z, cy - (f * y) / z];
  const out = {};
  for (const [name, list] of Object.entries(features)) {
    const objs = [];
    for (const ft of [].concat(list)) {
      const s = (ft.slopeDeg || 0) * DEG;
      const O = toWorld(ft.u, ft.v, ft.d || 0);
      const ex = rot([1, 0, 0]);
      const ey = rot([0, Math.cos(s), Math.sin(s)]); // up the feature, leaning back by the slope
      const n = cross(ex, ey);
      const at = (x, y) => [O[0] + ex[0] * x + ey[0] * y, O[1] + ex[1] * x + ey[1] * y, O[2] + ex[2] * x + ey[2] * y];
      const outline = ft.shape === 'rect'
        ? [[-ft.a, -ft.b], [ft.a, -ft.b], [ft.a, ft.b], [-ft.a, ft.b]]
        : Array.from({ length: 64 }, (_, k) => [ft.a * Math.cos((k / 64) * 2 * Math.PI), ft.b * Math.sin((k / 64) * 2 * Math.PI)]);
      const px = outline.map(([x, y]) => project(at(x, y)));
      const xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
      const x1 = Math.max(0, Math.floor(Math.min(...xs)) - 2), x2 = Math.min(W - 1, Math.ceil(Math.max(...xs)) + 2);
      const y1 = Math.max(0, Math.floor(Math.min(...ys)) - 2), y2 = Math.min(H - 1, Math.ceil(Math.max(...ys)) + 2);
      const mw = x2 - x1 + 1, mh = y2 - y1 + 1, r = new Uint8Array(mw * mh);
      let any = 0;
      for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) {
        const dir = [(x1 + i + 0.5 - cx) / f, -(y1 + j + 0.5 - cy) / f, 1];
        const den = dot(dir, n);
        if (Math.abs(den) < 1e-9) continue;
        const t = dot(O, n) / den;
        const P = [dir[0] * t - O[0], dir[1] * t - O[1], dir[2] * t - O[2]];
        const du = dot(P, ex), dv = dot(P, ey);
        const inside = ft.shape === 'rect'
          ? Math.abs(du) <= ft.a && Math.abs(dv) <= ft.b && !(ft.hole && ft.hole(du, dv))
          : (du / ft.a) ** 2 + (dv / ft.b) ** 2 <= 1;
        if (inside) { r[j * mw + i] = 1; any++; }
      }
      if (!any) continue;
      const m = encodeSegmentationMask(r, mw, mh);
      objs.push(parseSam(`<0f>0<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${W};h=${H};c=${ft.c ?? 0.9}|><|mask;x=0;y=0;c=0.9;data=${m.height},${m.width},${m.payload}|>`).objects[0]);
    }
    out[name] = objs;
  }
  return { objects: out, frame: { w: W, h: H }, f };
}

// A typical adult head, true sizes (mm): eye centers 63 apart, eyes 30 wide, nose 34, mouth 50.
// Depths are behind the forehead plane where the card sits; the nose tip sticks out in front.
export function typicalFace(over = {}) {
  return {
    card: [{ shape: 'rect', u: 0, v: 55, a: 42.8, b: 26.99, d: 0, ...(over.card || {}) }],
    eye: over.eye || [{ u: -31.5, v: 0, a: 15, b: 6, d: 12 }, { u: 31.5, v: 0, a: 15, b: 6, d: 12 }],
    nose: over.nose || [{ u: over.noseU || 0, v: -28, a: 17, b: 12, d: over.noseD ?? 8 }],
    mouth: [{ u: 0, v: -58, a: 25, b: 8, d: 20 }],
  };
}
