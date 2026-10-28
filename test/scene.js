// Draws what SAM 3.1 would return for a pinhole-camera photo of a driveway with a garage door at the far end.
// Used by the tests; boxes and masks are in SAM's own wire format.
import { encodeSegmentationMask } from '../node_modules/@meta-sam/parser/dist/mask-codec.js';

// Render one scene. Units: feet. Camera at (camX, camH, 0) looking down +Z, pitched down by pitchDeg.
export function scene({ W = 900, H = 1200, hfov = 69, camH = 5, camX = 2, pitchDeg = 8, yawDeg = 0, drive, door }) {
  const f = (0.5 * Math.max(W, H)) / Math.tan((hfov * Math.PI) / 360);
  const cx = W / 2, cy = H / 2;
  const p = (pitchDeg * Math.PI) / 180;
  const yw = (yawDeg * Math.PI) / 180; // camera turned right by yawDeg
  // pixel -> ray -> where it hits the ground (Y = 0)
  const ground = (x, y) => {
    const dx = (x - cx) / f, dy = (y - cy) / f; // camera coords, y down
    // rotate by pitch (looking down): world dir
    const wy = -dy * Math.cos(p) - Math.sin(p);
    const wz = -dy * Math.sin(p) * -1 + Math.cos(p); // = dy*sin(p) + cos(p)
    if (wy >= 0) return null;
    const t = camH / -wy;
    const lx = dx * t, lz = wz * t; // in the camera's heading
    return { X: camX + lx * Math.cos(yw) + lz * Math.sin(yw), Z: -lx * Math.sin(yw) + lz * Math.cos(yw) };
  };
  const project = (Xw, Y, Zw) => {
    const ax = Xw - camX;
    const X = camX + ax * Math.cos(yw) - Zw * Math.sin(yw);
    const Z = ax * Math.sin(yw) + Zw * Math.cos(yw);
    const xc = X - camX, yc = Y - camH;
    const zc = Z * Math.cos(p) - yc * Math.sin(p);
    const ycam = Z * Math.sin(p) + yc * Math.cos(p);
    return { x: cx + (f * xc) / zc, y: cy - (f * ycam) / zc };
  };
  const inDrive = (x, y) => {
    const g = ground(x, y);
    return g && g.X >= drive.x0 && g.X <= drive.x1 && g.Z >= drive.z0 && g.Z <= drive.z1;
  };
  const dc = [project(door.x0, 0, door.z), project(door.x1, 0, door.z), project(door.x0, 7, door.z), project(door.x1, 7, door.z)];
  const doorBox = { x1: Math.round(Math.min(...dc.map((c) => c.x))), x2: Math.round(Math.max(...dc.map((c) => c.x))), y1: Math.round(Math.min(...dc.map((c) => c.y))), y2: Math.round(Math.max(...dc.map((c) => c.y))) };
  // driveway bounding box by scanning
  let x1 = W, x2 = -1, y1 = H, y2 = -1;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (inDrive(x, y)) { x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y); }
  x1 = Math.max(0, x1 - 2); y1 = Math.max(0, y1 - 2); x2 = Math.min(W - 1, x2 + 2); y2 = Math.min(H - 1, y2 + 2);
  const mw = x2 - x1 + 1, mh = y2 - y1 + 1;
  const raster = new Uint8Array(mw * mh);
  for (let r = 0; r < mh; r++) for (let c = 0; c < mw; c++) raster[r * mw + c] = inDrive(x1 + c + 0.5, y1 + r + 0.5) ? 1 : 0;
  const dm = encodeSegmentationMask(raster, mw, mh);
  const doorRaster = new Uint8Array((doorBox.x2 - doorBox.x1 + 1) * (doorBox.y2 - doorBox.y1 + 1)).fill(1);
  const dd = encodeSegmentationMask(doorRaster, doorBox.x2 - doorBox.x1 + 1, doorBox.y2 - doorBox.y1 + 1);
  const tok = (b, m, c) => `<|box;x1=${b.x1};y1=${b.y1};x2=${b.x2};y2=${b.y2};w=${W};h=${H};c=${c}|><|mask;x=0;y=0;c=${c};data=${m.height},${m.width},${m.payload}|>`;
  return {
    driveText: `<0f>0${tok({ x1, y1, x2, y2 }, dm, 0.95)}`,
    doorText: `<0f>0${tok(doorBox, dd, 0.93)}`,
    frame: { w: W, h: H },
  };
}

