// Flat test scenes: a tilted camera over a flat surface, and what SAM would return for shapes on it.
import { parseSam } from '../src/muse.js';
import { encodeSegmentationMask } from '../node_modules/@meta-sam/parser/dist/mask-codec.js';

// Camera over the plane z=0 (units: mm). Tilt in degrees around the x axis, distance D from the
// center of view, focal length f in pixels, photo W x H.
export function camera({ tiltDeg = 30, D = 380, f = 1400, W = 1280, H = 960, panDeg = 10 }) {
  const t = (tiltDeg * Math.PI) / 180, p = (panDeg * Math.PI) / 180;
  // camera axes in world coords: looks toward the plane from above and to the side
  const fwd = [Math.sin(t) * Math.sin(p), Math.sin(t) * Math.cos(p), -Math.cos(t)];
  const C = fwd.map((v) => -v * D); // camera center
  const up0 = [0, 0, 1];
  const right = norm(cross(fwd, up0).every((v) => Math.abs(v) < 1e-9) ? [1, 0, 0] : cross(fwd, up0));
  const down = norm(cross(fwd, right));
  const project = ([X, Y]) => {
    const d = [X - C[0], Y - C[1], 0 - C[2]];
    const z = dot(d, fwd), x = dot(d, right), y = dot(d, down);
    return [W / 2 + (f * x) / z, H / 2 + (f * y) / z];
  };
  const unproject = ([u, v]) => {
    const dir = add(add(fwd, scale(right, (u - W / 2) / f)), scale(down, (v - H / 2) / f));
    const s = -C[2] / dir[2];
    return [C[0] + s * dir[0], C[1] + s * dir[1]];
  };
  return { project, unproject, W, H };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map((v) => v * s);

// A SAM record for a shape on the plane, given by an inside() test and some boundary points.
export function samSeg(cam, inside, boundary) {
  const img = boundary.map(cam.project);
  let x1 = Math.floor(Math.min(...img.map((p) => p[0]))) - 2, x2 = Math.ceil(Math.max(...img.map((p) => p[0]))) + 2;
  let y1 = Math.floor(Math.min(...img.map((p) => p[1]))) - 2, y2 = Math.ceil(Math.max(...img.map((p) => p[1]))) + 2;
  x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(cam.W - 1, x2); y2 = Math.min(cam.H - 1, y2);
  const w = x2 - x1 + 1, h = y2 - y1 + 1;
  const r = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) r[j * w + i] = inside(cam.unproject([x1 + i + 0.5, y1 + j + 0.5])) ? 1 : 0;
  const m = encodeSegmentationMask(r, w, h);
  const text = `<0f>0<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${cam.W};h=${cam.H};c=0.95|><|mask;x=0;y=0;c=0.95;data=${m.height},${m.width},${m.payload}|>`;
  return parseSam(text);
}

export const rectShape = (cx, cy, L, S, rotDeg) => {
  const a = (rotDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const inside = ([x, y]) => { const dx = x - cx, dy = y - cy; const u = dx * c + dy * s, v = -dx * s + dy * c; return Math.abs(u) <= L / 2 && Math.abs(v) <= S / 2; };
  const boundary = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [cx + (i * L / 2) * c - (j * S / 2) * s, cy + (i * L / 2) * s + (j * S / 2) * c]);
  return { inside, boundary };
};
export const ellipseShape = (cx, cy, a, b) => ({
  inside: ([x, y]) => ((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 <= 1,
  boundary: Array.from({ length: 36 }, (_, k) => [cx + a * Math.cos((k * Math.PI) / 18), cy + b * Math.sin((k * Math.PI) / 18)]),
});

