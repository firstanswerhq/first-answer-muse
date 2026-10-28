// Distance from one photo, checked against scenes with known answers (a side yard between a fence
// and a house wall, with a door on the house), including sloppy photos: tilted, turned, no lens info.
import test from 'node:test';
import assert from 'node:assert/strict';
import { camera3d, render } from './scene3d.js';
import { calibrate, gapBetween, heightOf, distanceTo, contactPoints, fitCheck, ftIn, focalPx, readExif, makeCamera } from '../src/distance.js';

// Side yard: fence on the left at X = -6, house wall on the right at X = +7.5 (13.5 ft gap),
// both running from 8 ft to 60 ft ahead. A door (6 ft 8 in) on the back fence, facing the camera.
const GAP = 13.5;
const yard = ({ door = true } = {}) => [
  { name: 'fence', axis: 'x', at: -6, from: 8, to: 60, top: 6 },
  { name: 'house', axis: 'x', at: 7.5, from: 8, to: 60, top: 10 },
  ...(door ? [{ name: 'door', axis: 'z', at: 40, from: -1.5, to: 1.5, top: 80 / 12 }] : []),
];

function measureYard(camOpts, { door = true, focal35 = null } = {}) {
  const cam = camera3d(camOpts);
  const { frame, objects } = render(cam, yard({ door }));
  const cal = calibrate({
    frame,
    focal35,
    ref: door ? objects.door : null,
    refKind: door ? 'interior_door' : null,
    groundLines: [contactPoints(objects.fence, frame), contactPoints(objects.house, frame)],
  });
  return { cal, gap: cal.ok ? gapBetween(objects.fence, objects.house, cal, frame) : null, objects, frame };
}

const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) / want <= tol, `${what}: got ${got?.toFixed?.(2)}, want ${want}`);

test('side yard straight on: the gap within 4%, and the range holds the truth', () => {
  const { cal, gap } = measureYard({ pitchDeg: 12 });
  assert.equal(cal.ok, true);
  assert.equal(cal.confidence, 'fair'); // no lens info in the photo
  assert.equal(gap.ok, true);
  near(gap.typical.ft, GAP, 0.04, 'gap');
  assert.ok(gap.typical.low <= GAP * 1.02 && gap.typical.high >= GAP * 0.98, `range ${gap.typical.low}-${gap.typical.high}`);
});

test('with the lens from the photo, it is good and tight', () => {
  // 69 degrees on the long side of a 3:4 photo equals this 35 mm-equivalent focal length
  const { fPx } = focalPx({ w: 720, h: 960 });
  const focal35 = (fPx * 43.27) / Math.hypot(720, 960);
  const { cal, gap } = measureYard({ pitchDeg: 12 }, { focal35 });
  assert.equal(cal.confidence, 'good');
  near(gap.typical.ft, GAP, 0.03, 'gap');
});

test('a sloppy photo: tilted 5 degrees, turned 10, held low', () => {
  const { cal, gap } = measureYard({ pitchDeg: 8, rollDeg: 5, yawDeg: 10, camH: 4.2, camX: 1 });
  assert.equal(cal.ok, true);
  near(gap.typical.ft, GAP, 0.06, 'gap');
});

test('no door in the picture: still answers, but low confidence and a wider range', () => {
  const { cal, gap } = measureYard({ pitchDeg: 12, camH: 5 }, { door: false });
  assert.equal(cal.confidence, 'low');
  assert.ok(gap.typical.high - gap.typical.low > 1, 'range should be wide');
  assert.ok(gap.typical.low <= GAP && gap.typical.high >= GAP);
});

test('the door is 6 ft 8 in tall and 40 ft away', () => {
  const cam = camera3d({ pitchDeg: 12 });
  const { frame, objects } = render(cam, yard());
  const cal = calibrate({ frame, ref: objects.door, refKind: 'interior_door', groundLines: [contactPoints(objects.fence, frame), contactPoints(objects.house, frame)] });
  near(heightOf(objects.door, cal).ft, 80 / 12, 0.02, 'height');
  near(distanceTo(objects.door, cal).ft, 40, 0.05, 'distance');
});

test('a shed fit check reads like an answer', () => {
  const fit = fitCheck({ gap: { ft: 13.4, low: 13.0, high: 13.8 }, itemFt: 12 });
  assert.equal(fit.verdict, 'fits');
  assert.match(fit.text, /13 ft 5 in/);
  assert.equal(fitCheck({ gap: { ft: 12.2, low: 11.8, high: 12.6 }, itemFt: 12 }).verdict, 'too close to call from the photo');
  assert.equal(fitCheck({ gap: { ft: 10, low: 9.5, high: 10.5 }, itemFt: 12 }).verdict, 'won’t fit');
  assert.equal(ftIn(13.4), '13 ft 5 in');
});

test('camera math: a ground point projects back to itself', () => {
  const c = makeCamera({ w: 720, h: 960, fPx: 700, pitch: 0.2, height: 5, roll: 0.05 });
  const p = c.project(3, 0, 20);
  const g = c.groundPoint(p[0], p[1]);
  assert.ok(Math.abs(g.X - 3) < 1e-6 && Math.abs(g.Z - 20) < 1e-6);
});

test('the photo’s camera info is read when present, ignored when not', () => {
  assert.deepEqual(readExif(Buffer.from([0x89, 0x50])), {});
  // A minimal JPEG with an Exif block: FocalLengthIn35mmFilm = 26
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 12 + 4);
  tiff.write('II', 0); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); // IFD0: one entry, the Exif pointer
  tiff.writeUInt16LE(0x8769, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(1, 26); // Exif IFD
  tiff.writeUInt16LE(0xa405, 28); tiff.writeUInt16LE(3, 30); tiff.writeUInt32LE(1, 32); tiff.writeUInt16LE(26, 36);
  tiff.writeUInt32LE(0, 40);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xd9])]);
  assert.equal(readExif(jpg).focal35, 26);
});
