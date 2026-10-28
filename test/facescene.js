// 3D test head for face measuring. Units: mm. The camera sits at the origin looking down +Z.
// The head's front plane (where the card sits) is at Z = D; features sit at their own depth behind
// (+) or in front (−) of that plane. The head can turn (yaw), nod (pitch) and tilt (roll) about its
// center, ~90 mm behind the forehead. Each feature is a flat shape in a plane parallel to the face.
import { encodeSegmentationMask } from '../node_modules/@meta-sam/parser/dist/mask-codec.js';
import { parseSam } from '../src/muse.js';

const DEG = Math.PI / 180;

export function headScene({ D = 400, yawDeg = 0, pitchDeg = 0, rollDeg = 0, W = 1080, H = 1440, hfov = 69, features }) {
  const f = (0.5 * Math.max(W, H)) / Math.tan((hfov * DEG) / 2);
  const cx = W / 2, cy = H / 2;
  const C = [0, 0, D + 90]; // head center
  const ry = yawDeg * DEG, rx = pitchDeg * DEG, rz = rollDeg * DEG;
  // rotation: roll (z), then pitch (x), then yaw (y)
  const rot = ([x, y, z]) => {
    let p = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz), z];
    p = [p[0], p[1] * Math.cos(rx) - p[2] * Math.sin(rx), p[1] * Math.sin(rx) + p[2] * Math.cos(rx)];
    return [p[0] * Math.cos(ry) + p[2] * Math.sin(ry), p[1], -p[0] * Math.sin(ry) + p[2] * Math.cos(ry)];
  };
  const unrot = ([x, y, z]) => {
    let p = [x * Math.cos(-ry) + z * Math.sin(-ry), y, -x * Math.sin(-ry) + z * Math.cos(-ry)];
    p = [p[0], p[1] * Math.cos(-rx) - p[2] * Math.sin(-rx), p[1] * Math.sin(-rx) + p[2] * Math.cos(-rx)];
    return [p[0] * Math.cos(-rz) - p[1] * Math.sin(-rz), p[0] * Math.sin(-rz) + p[1] * Math.cos(-rz), p[2]];
  };
  // face coordinates (u right, v up, depth d behind the front plane) -> world
  const toWorld = (u, v, d) => { const r = rot([u, v, d - 90]); return [C[0] + r[0], C[1] + r[1], C[2] + r[2]]; };
  const normal = rot([0, 0, 1]);
  // pixel -> face (u, v) on the plane at depth d
  const hitPlane = (px, py, d) => {
    const dir = [(px - cx) / f, -(py - cy) / f, 1];
    const P0 = toWorld(0, 0, d);
    const den = dir[0] * normal[0] + dir[1] * normal[1] + dir[2] * normal[2];
    if (Math.abs(den) < 1e-9) return null;
    const t = (P0[0] * normal[0] + P0[1] * normal[1] + P0[2] * normal[2]) / den;
    const local = unrot([dir[0] * t - C[0], dir[1] * t - C[1], dir[2] * t - C[2]]);
    return [local[0], local[1]];
  };
  const out = {};
  for (const [name, list] of Object.entries(features)) {
    const objs = [];
    for (const ft of [].concat(list)) {
      const pts = [];
      for (let k = 0; k < 64; k++) { const a = (k / 64) * 2 * Math.PI; pts.push(project(toWorld(ft.u + ft.a * Math.cos(a) * 1.05, ft.v + ft.b * Math.sin(a) * 1.05, ft.d || 0))); }
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const x1 = Math.max(0, Math.floor(Math.min(...xs)) - 2), x2 = Math.min(W - 1, Math.ceil(Math.max(...xs)) + 2);
      const y1 = Math.max(0, Math.floor(Math.min(...ys)) - 2), y2 = Math.min(H - 1, Math.ceil(Math.max(...ys)) + 2);
      const mw = x2 - x1 + 1, mh = y2 - y1 + 1, r = new Uint8Array(mw * mh);
      let any = 0;
      for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) {
        const q = hitPlane(x1 + i + 0.5, y1 + j + 0.5, ft.d || 0);
        if (!q) continue;
        const du = q[0] - ft.u, dv = q[1] - ft.v;
        const inside = ft.shape === 'rect' ? Math.abs(du) <= ft.a && Math.abs(dv) <= ft.b && !(ft.hole && ft.hole(du, dv)) : (du / ft.a) ** 2 + (dv / ft.b) ** 2 <= 1;
        if (inside) { r[j * mw + i] = 1; any++; }
      }
      if (!any) continue;
      const m = encodeSegmentationMask(r, mw, mh);
      objs.push(parseSam(`<0f>0<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${W};h=${H};c=${ft.c ?? 0.9}|><|mask;x=0;y=0;c=0.9;data=${m.height},${m.width},${m.payload}|>`).objects[0]);
    }
    out[name] = objs;
  }
  function project([x, y, z]) { return [cx + (f * x) / z, cy - (f * y) / z]; }
  return { objects: out, frame: { w: W, h: H }, f };
}

// A typical adult head, true sizes (mm): eye centers 63 apart, eyes 30 wide, nose 34, mouth 50.
// Depths are behind the forehead plane where the card sits.
export function typicalFace(over = {}) {
  return {
    card: [{ shape: 'rect', u: 0, v: 55, a: 42.8, b: 26.99, d: 0, ...(over.card || {}) }],
    face: [{ u: 0, v: 5, a: 72, b: 105, d: 40 }],
    eye: over.eye || [{ u: -31.5, v: 0, a: 15, b: 6, d: 12 }, { u: 31.5, v: 0, a: 15, b: 6, d: 12 }],
    nose: over.nose || [{ u: over.noseU || 0, v: -28, a: 17, b: 12, d: 8 }],
    mouth: [{ u: 0, v: -58, a: 25, b: 8, d: 20 }],
  };
}
