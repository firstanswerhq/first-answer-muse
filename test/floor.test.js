// Whole floor from several photos: one sheet of paper stays on the floor, 2 to 4 photos from different
// doorways each see part of the floor, and the union on the paper's plane is the whole room. Rendered
// scenes with known answers, stand-ins for Muse Spark and SAM, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { measureAnything, checkWording, wordingFacts, stepDetail, checkBudgetMs, CHECK_TIMEOUT_MS, CHECK_EXTRA_MS, CHECK_BUDGET_MAX_MS } from '../src/anything.js';
import { floorOnPaper, combineFloors, invertH } from '../src/floor.js';
import { measureFlat } from '../src/flat.js';
import { camera, samSeg, rectShape } from './flatscene.js';

const R = (o) => ({ task: 'floor_tile', target: 'floor', second_target: '', ruler: 'paper_letter', item_width_in: 0, tile_w_in: 12, tile_l_in: 12, shoe_for: 'unknown', language: 'en', summary: '', ...o });
const EMPTY = { objects: [], frame: { w: 1280, h: 960 } };
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) / want <= tol, `${what}: got ${got}, want ${want} (±${tol * 100}%)`);
const sqftOf = (r) => parseFloat(r.numbers.find((n) => n.label === 'Area' || n.label === 'Floor to tile').value);
const feetOf = (s) => { const m = s.match(/(\d+) ft(?: (\d+) in)?/); return +m[1] + (+m[2] || 0) / 12; };

// A 10 × 12 ft room (x: 3048 mm, y: 3658 mm) with one sheet of paper on the floor, square to the walls.
// Three phone positions: the doorway in one end wall, the doorway in the other, and a corner. Each
// sees only part of the floor (the near strip and corners fall off the frame) but the whole paper.
const ROOM = rectShape(0, 0, 3048, 3658, 0);
const PAPER = rectShape(300, -200, 279.4, 215.9, 0);
const POSES = [
  { tiltDeg: 35, D: 3500, f: 1300, panDeg: 0, aim: [0, -121] },
  { tiltDeg: 35, D: 3500, f: 1300, panDeg: 180, aim: [0, 121] },
  { tiltDeg: 35, D: 3500, f: 1300, panDeg: 250, aim: [600, 300] },
];
// SAM stand-in per photo: dataUrl "p1", "p2", ... -> that pose's floor and paper (shapes may be swapped per photo).
function scene(poses = POSES, shapes = {}) {
  const segs = poses.map((pose, i) => {
    const cam = camera(pose);
    const floor = shapes.floor && i in shapes.floor ? shapes.floor[i] : ROOM, paper = shapes.paper && i in shapes.paper ? shapes.paper[i] : PAPER;
    return { floor: floor ? samSeg(cam, floor.inside, floor.boundary) : EMPTY, 'sheet of paper': paper ? samSeg(cam, paper.inside, paper.boundary) : EMPTY };
  });
  const urls = poses.map((_, i) => `p${i + 1}`);
  const deps = { read: async () => R({}), segment: async (d, concept) => segs[urls.indexOf(d)]?.[concept] || EMPTY };
  return { urls, segs, deps };
}

test('three partial photos of a 10 × 12 ft room combine to the whole room (area within 8%, sides within 5%)', async () => {
  const { urls, segs, deps } = scene();
  // Each photo alone under-measures (it sees only part of the floor).
  for (const s of segs) {
    const m = measureFlat({ target: s.floor.objects[0], ref: s['sheet of paper'].objects[0], refKind: 'paper_letter' });
    assert.ok(m.areaMm2 / 92903.04 < 120 * 0.95, `one photo alone saw ${m.areaMm2 / 92903.04} sq ft`);
  }
  const r = await measureAnything({ dataUrls: urls, text: 'how much 12x12 tile for this floor? paper on the floor, 3 photos', deps });
  assert.equal(r.ok, true, r.ask);
  near(sqftOf(r), 120, 0.08, 'area');
  const [w, l] = r.numbers.find((n) => n.label === 'Floor').value.split(' × ').map(feetOf);
  near(w, 10, 0.05, 'width'); near(l, 12, 0.05, 'length');
  assert.match(r.answer, /^Combined from 3 photos: the floor is about 1?\d ft(?: \d+ in)? by 1\d ft(?: \d+ in)? \([\d.]+ sq ft\)\. In 12 × 12 in tile .* buy \d+ tiles\. Send one more if a corner is still missing, or tap Send to the business\.$/);
  assert.equal(r.wantMore, true);
  assert.equal(r.numbers.find((n) => n.label === 'Photos').value, '3 photos');
  assert.equal(r.combined.photos, 3);
  assert.equal(r.combined.ok, true);
  assert.ok(r.combined.coverage.every((c) => c > 0.5 && c < 1), `coverage ${r.combined.coverage}`);
  assert.equal(r.overlays.length, 3);
  assert.ok(r.overlays.every((o) => o.outlines.length === 2 && o.frame.w === 1280));
  assert.equal(r.overlay, r.overlays[0]);
  assert.match(r.job.sqft.toString(), /^[\d.]+$/);
  assert.match(r.business.job, /^Tile a .+ floor: [\d.]+ sq ft \(from 3 photos\)$/);
  assert.match(r.ask, /Combined from 3 photos/);
  // The panel: one outline step per photo, one mapping step per photo, one combine step with coverage.
  const steps = r.pipeline.map((s) => s.step);
  for (let i = 1; i <= 3; i++) {
    assert.ok(steps.includes(`photo ${i} of 3: outline floor and sheet of paper`), steps.join(' | '));
    assert.ok(steps.includes(`photo ${i} of 3: map the floor onto the sheet of printer paper’s plane`), steps.join(' | '));
  }
  const combine = r.pipeline.find((s) => /^combine 3 photos/.test(s.step));
  assert.ok(combine, steps.join(' | '));
  assert.match(stepDetail(combine), /floor seen \(sq ft\): \d+ · width ft: [\d.]+ · length ft: [\d.]+ · fills a rectangle: \d+%; photos overlap \d+% · coverage: photo 1 \d+%, photo 2 \d+%, photo 3 \d+%/);
  // Our own template passes the wording check (so faithful Spark wording would be used), "3 photos" included.
  const facts = wordingFacts(r);
  assert.deepEqual(checkWording(r.answer, facts, r.headline, { task: r.task }), { ok: true });
  assert.match(checkWording(r.answer.replace('3 photos', '2 photos'), facts, r.headline, { task: r.task }).reason, /2/);
  assert.equal(r.lang, 'en');
});

// Review A's regression: the paper's long edge pointing at the camera is foreshortened, so pixel length
// alone picks the wrong side from about 40° on; the camera's focal length tells the two apart.
// Review A's regression: the paper's long edge pointing at the camera is foreshortened, so pixel length
// alone picks the wrong side from about 40° on; the camera's focal length tells the two apart. At a steep
// tilt the far sheet is under 55 px on its short side, where that choice is a coin toss (Review C's sweep),
// so those photos are asked for again instead of measured.
// A photo whose sheet is too small to read is dropped and asked for again; the other photos still answer
// (a partial "so far" when one is left), so the room never comes from a blown-up map.
const refusedSmallPaper = (r, k) => {
  assert.ok(r.dropped?.includes(k), `photo ${k} dropped: ${JSON.stringify(r.dropped)} ${r.ask}`);
  assert.match(r.ask, new RegExp(`Photo ${k}: Get closer to the sheet for that one and send it again\\.`));
  if (r.ok) { assert.ok(r.partial || r.combined?.ok === false || r.photos === 1, 'no combined room from the remaining photos'); assert.ok(!r.combined || r.combined.ok === false || !r.combined.turned, JSON.stringify(r.combined)); }
};
test('the paper turned 90° (long edge along the room, toward the doorways) still gives the room; a steep tilt with a small far sheet is a retake', async () => {
  const paper90 = rectShape(300, -200, 279.4, 215.9, 90);
  const { urls, deps } = scene(POSES, { paper: POSES.map(() => paper90) });
  const r = await measureAnything({ dataUrls: urls, text: 'tile', deps });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.combined.ok, true, r.note);
  near(sqftOf(r), 120, 0.08, 'area');
  const [w, l] = r.numbers.find((n) => n.label === 'Floor').value.split(' × ').map(feetOf);
  near(w, 10, 0.05, 'width'); near(l, 12, 0.05, 'length');
  assert.doesNotMatch(r.ask, /ruler shape/);
  const steep = [
    { tiltDeg: 58, D: 3000, f: 1300, panDeg: 0, aim: [0, -500] },
    { tiltDeg: 58, D: 3000, f: 1300, panDeg: 180, aim: [0, 500] },
    { tiltDeg: 55, D: 3000, f: 1300, panDeg: 250, aim: [500, 300] },
  ];
  for (const paper of [paper90, PAPER]) {
    const s = scene(steep, { paper: steep.map(() => paper) });
    refusedSmallPaper(await measureAnything({ dataUrls: s.urls, text: 'tile', deps: s.deps }), 1); // the sheet is 42 px tall from a 58° doorway
  }
});

test('Review A’s scene: an 8 × 14 ft room, paper 300 mm from a wall, two end-wall doorways: the far sheet (45 px) is a retake, not a blown-up floor', async () => {
  const room = rectShape(0, 0, 2438, 4267, 0);
  const paper = rectShape(-2438 / 2 + 300 + 108, -4267 / 2 + 600 + 140, 279.4, 215.9, 90);
  for (const tilt of [30, 35, 60]) {
    const poses = [{ tiltDeg: tilt, D: 3800, f: 1300, panDeg: 0, aim: [0, -700] }, { tiltDeg: tilt, D: 3800, f: 1300, panDeg: 180, aim: [0, 700] }];
    const { urls, deps } = scene(poses, { floor: [room, room], paper: [paper, paper] });
    const r = await measureAnything({ dataUrls: urls, text: 'tile', deps });
    refusedSmallPaper(r, tilt === 60 ? r.dropped[0] : 2); // never 186 or 189 sq ft for a 112 sq ft room (at 60° both sheets are marginal)
    if (r.ok) { assert.equal(r.partial, true); assert.ok(parseFloat(r.numbers[0].value) < 112, `so far ${r.numbers[0].value}`); }
    else assert.ok(r.pipeline.filter((s) => s.model === 'first-answer math').every((s) => stepDetail(s) === 'measured, but not sent: a photo needs a retake'));
  }
  // Closer doorways (the sheet 80 px and up in both): the room, within 5% a side.
  const poses = [{ tiltDeg: 40, D: 2600, f: 1300, panDeg: 0, aim: [-200, -900] }, { tiltDeg: 40, D: 2600, f: 1300, panDeg: 180, aim: [-200, -300] }];
  const { urls, deps } = scene(poses, { floor: [room, room], paper: [paper, paper] });
  const r = await measureAnything({ dataUrls: urls, text: 'tile', deps });
  if (r.ok && r.partial) {
    // Both doorway shots are aimed down the room and clip its two side ends: a "so far" that asks for more.
    assert.deepEqual(r.combined.openSides, ['x0', 'x1']);
    assert.ok(parseFloat(r.numbers[0].value) <= 112, `so far ${r.numbers[0].value}`);
  } else if (r.ok) {
    const [w, l] = r.numbers.find((n) => n.label === 'Floor').value.split(' × ').map(feetOf);
    near(w, 8, 0.05, 'width');
    assert.ok(l <= 14 * 1.05, `length ${l}`);
  } else refusedSmallPaper(r, r.dropped[0]);
  // The single-photo path gets the right sides too (before: 9.25 × 10.36 ft for a partial 8 × 12 view).
  const cam = camera({ tiltDeg: 50, D: 3000, f: 1300, panDeg: 90, aim: [-400, -1200] });
  const paperX = rectShape(-2438 / 2 + 300 + 140, -4267 / 2 + 600 + 108, 279.4, 215.9, 0);
  const m = measureFlat({ target: samSeg(cam, room.inside, room.boundary).objects[0], ref: samSeg(cam, paperX.inside, paperX.boundary).objects[0], refKind: 'paper_letter' });
  assert.ok(m.ok);
  near(m.rectWidthMm, 2438, 0.05, 'single-photo width');
  assert.ok(m.rectLengthMm < 4267 * 1.05, `single-photo length ${m.rectLengthMm} (sees part of the room)`);
});

test('Review C’s 11 × 9 ft room with the sheet 200 mm from a corner: the truth lies inside the reported range (error propagated from the sheet’s corners)', async () => {
  const room = rectShape(0, 0, 3353, 2743, 0);
  const pc = [-3353 / 2 + 200 + 139.7, -2743 / 2 + 200 + 107.95];
  const paper = rectShape(pc[0], pc[1], 279.4, 215.9, 0);
  // The reviewer's poses (tilt 30/45/65, pans 0/120/240): the 65° photo's sheet is 37 px tall, a retake.
  const theirs = [{ tiltDeg: 30, D: 3600, f: 1300, panDeg: 0, aim: [-600, -300] }, { tiltDeg: 45, D: 3600, f: 1300, panDeg: 120, aim: [-500, -400] }, { tiltDeg: 65, D: 3600, f: 1300, panDeg: 240, aim: [-700, -500] }];
  const t = scene(theirs, { floor: theirs.map(() => room), paper: theirs.map(() => paper) });
  const tr = await measureAnything({ dataUrls: t.urls, text: 'tiles', deps: t.deps });
  assert.deepEqual(tr.dropped, [3]);
  assert.match(tr.ask, /^Photo 3: Get closer to the sheet for that one and send it again\./);
  // Three doorway shots that can all read the sheet: the number is within 8% and the range holds the truth.
  for (const [tilt, D] of [[50, 2600], [42, 3000], [42, 3400]]) {
    const poses = [20, 110, 200].map((pan) => ({ tiltDeg: tilt, D, f: 1300, panDeg: pan, aim: [pc[0] + 500, pc[1] + 400] }));
    const { urls, deps } = scene(poses, { floor: poses.map(() => room), paper: poses.map(() => paper) });
    const r = await measureAnything({ dataUrls: urls, text: 'tiles', deps });
    assert.equal(r.ok, true, `tilt ${tilt} D ${D}: ${r.ask}`);
    assert.equal(r.combined.ok, true, `tilt ${tilt} D ${D}: ${r.note}`);
    if (r.partial) {
      // No photo reached one wall: a "so far", at most the truth, asking for a photo from that end.
      assert.ok(r.combined.openSides.length, 'a side is open');
      assert.ok(parseFloat(r.numbers[0].value) <= 99 * 1.03, `so far ${r.numbers[0].value}`);
      continue;
    }
    near(sqftOf(r), 99, 0.08, `tilt ${tilt} D ${D} area`);
    const [lo, hi] = r.numbers.find((n) => n.label === 'Range').value.match(/\d+/g).map(Number);
    assert.ok(lo <= 99 && hi >= 99, `tilt ${tilt} D ${D}: range ${lo}–${hi} must hold 99`);
    assert.ok(hi - lo < 99, `tilt ${tilt} D ${D}: range ${lo}–${hi} is too wide to be useful`);
    const steps = r.pipeline.filter((s) => /map the floor/.test(s.step));
    assert.ok(steps.every((s) => s.result.farWallErrorIn > 0), 'each photo reports its far-wall error');
  }
});

// The first real run: a bathroom whose vanity and tub take bites out of the floor. Two doorway photos
// of a 3 × 2.2 m room with a 1.2 × 0.9 m vanity block in one corner: the union fills about 80% of the
// rectangle, so the floor to tile is the union's area, with the room's sides given for the layout.
test('a floor that is not a plain rectangle (a vanity takes a bite) combines, with the open floor as the tile area', async () => {
  const roomBox = rectShape(0, 0, 3000, 2200, 0), vanity = rectShape(-900, 650, 1200, 900, 0);
  const floor = { inside: (p) => roomBox.inside(p) && !vanity.inside(p), boundary: [...roomBox.boundary, ...vanity.boundary] };
  const paper = rectShape(400, -300, 279.4, 215.9, 0);
  const poses = [{ tiltDeg: 40, D: 2600, f: 1300, panDeg: 0, aim: [0, -200] }, { tiltDeg: 40, D: 2600, f: 1300, panDeg: 180, aim: [0, 200] }];
  const { urls, deps } = scene(poses, { floor: [floor, floor], paper: [paper, paper] });
  const r = await measureAnything({ dataUrls: urls, text: 'tile this bathroom floor', deps });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.combined.ok, true, r.note);
  assert.equal(r.combined.rectangle, false);
  assert.ok(r.combined.fill >= 0.55 && r.combined.fill < 0.9, `fill ${r.combined.fill}`);
  assert.equal(r.openFloor, true);
  const openSqft = (3000 * 2200 - 1200 * 900) / 92903.04; // 59.4 sq ft of floor around the vanity
  const sqft = parseFloat(r.numbers.find((n) => n.label === 'Floor to tile').value);
  near(sqft, openSqft, 0.1, 'open floor');
  assert.ok(sqft < 3000 * 2200 / 92903.04 * 0.95, 'less than the rectangle');
  assert.match(r.answer, /^Combined from 2 photos: the room is about 7 ft(?: \d+ in)? by 9 ft(?: \d+ in)?; the floor to tile is [\d.]+ sq ft \(the floor isn’t a plain rectangle: a vanity, tub or toilet takes up part of it\)\. In 12 × 12 in tile/);
  assert.ok(r.steps.some((x) => /cut list is for the open floor/.test(x)));
  // Tiles laid agree with the cut list: the plan's count (full tiles + one per cut piece) scaled by the open share.
  const laid = Number(r.answer.match(/that’s (\d+) tiles laid/)[1]);
  const pieces = r.steps.filter((x) => /^\d+ × /.test(x)).reduce((t, x) => t + Number(x.match(/^(\d+) ×/)[1]), 0);
  const roomSqft = (3000 * 2200) / 92903.04;
  assert.ok(laid >= Math.floor((Number(r.numbers.find((n) => n.label === 'Full tiles')?.value ?? 0) + pieces) * (sqft / roomSqft)) - 1, `laid ${laid} vs pieces ${pieces}`);
  assert.ok(laid < pieces + 70, `laid ${laid} should not exceed the rectangle's count`);
  // The order covers the high end of the range (capped at +25%), then the 15% for cuts.
  const buy = Number(r.answer.match(/buy (\d+) tiles/)[1]);
  const hiSqft = Number(r.answer.match(/high end of the range \((\d+) sq ft\)/)?.[1] ?? 0);
  const scale = hiSqft ? Math.min(Math.max(1, hiSqft / sqft), 1.25) : 1.25;
  assert.ok(buy >= Math.ceil(laid * scale * 1.15) - 2, `buy ${buy} should cover laid ${laid} x ${scale.toFixed(2)} x 1.15`);
  assert.ok(buy <= Math.ceil(laid * 1.25 * 1.15) + 2, `buy ${buy} must not exceed the 25% cap`);
  assert.ok(!r.numbers.some((n) => n.label === 'Full tiles'));
  assert.equal(r.job.sqft, sqft);
  assert.match(r.business.job, /not a plain rectangle/);
  const facts = wordingFacts(r);
  assert.deepEqual(checkWording(r.answer, facts, r.headline, { task: r.task }), { ok: true });
  // In Spanish too.
  const es = await measureAnything({ dataUrls: urls, text: 'baldosas para este baño', deps: { ...deps, read: async () => R({ language: 'es' }) } });
  assert.match(es.answer, /^Combinando 2 fotos: el cuarto mide unos .*; el piso a enlosar es de [\d.]+ pies cuadrados \(el piso no es un rectángulo simple/);
  assert.equal(es.numbers.find((n) => n.label === 'Piso a enlosar') != null, true);
});

// Review E's trap: a 6.6 × 14.1 ft room (93 sq ft) with the sheet near the room's center line, two photos
// from opposite ends, both aimed down the middle. The half turn is decided by contradiction (floor in one
// photo where another, looking right at the spot, saw a wall), which picks the right way round here; the
// real problem is that both photos' frames clip the same two side ends of the room, so the union is short
// (64 to 90 sq ft) and no range around it would be honest. No photo's frame reaches past the floor on those
// sides, so the answer stays a partial ("so far") and asks for a photo from the missing end.
test('two photos from opposite ends that both miss the room’s ends: a partial that asks for the missing end, never a short room', async () => {
  const room = rectShape(0, 0, 4300, 2000, 0), paper = rectShape(200, -150, 279.4, 215.9, 0);
  for (const [D, tilt] of [[2600, 45], [3200, 45], [3600, 40]]) {
    const poses = [{ tiltDeg: tilt, D, f: 1300, panDeg: 0, aim: [0, -100] }, { tiltDeg: tilt, D, f: 1300, panDeg: 180, aim: [0, 100] }];
    const { urls, deps } = scene(poses, { floor: [room, room], paper: [paper, paper] });
    const r = await measureAnything({ dataUrls: urls, text: 'tile', deps });
    assert.equal(r.ok, true, r.ask);
    assert.equal(r.partial, true, `D ${D}: ${r.answer}`);
    assert.equal(r.wantMore, true);
    assert.deepEqual(r.combined.openSides, ['x0', 'x1']);
    assert.deepEqual(r.combined.turned, [false, true]); // the right way round, by contradiction
    assert.match(r.answer, /^I can see about \d+ sq ft of the floor so far, combined from 2 photos, but no photo shows where the floor ends on every side\. Send a photo from the end of the room the others didn’t reach/);
    const seen = parseFloat(r.numbers.find((n) => n.label === 'Seen so far').value);
    assert.ok(seen <= 93, `seen ${seen} is at most the truth`);
    assert.equal(r.business, null);
    const comb = r.pipeline.find((x) => /^combine/.test(x.step));
    assert.match(stepDetail(comb), /no photo reaches the wall on 2 sides/);
  }
  // In Spanish.
  const poses = [{ tiltDeg: 45, D: 3200, f: 1300, panDeg: 0, aim: [0, -100] }, { tiltDeg: 45, D: 3200, f: 1300, panDeg: 180, aim: [0, 100] }];
  const sc = scene(poses, { floor: [room, room], paper: [paper, paper] });
  const es = await measureAnything({ dataUrls: sc.urls, text: 'baldosas', deps: { ...sc.deps, read: async () => R({ language: 'es' }) } });
  assert.match(es.answer, /^Veo unos \d+ pies cuadrados del piso por ahora, combinando 2 fotos, pero ninguna foto muestra dónde termina el piso por todos lados\. Manda una foto desde el extremo/);
  // The rooms whose walls every photo reaches are not flagged.
  const { urls, deps } = scene();
  const whole = await measureAnything({ dataUrls: urls, text: 'tile', deps });
  assert.deepEqual(whole.combined.openSides, []);
  assert.equal(whole.partial, undefined);
});

// The half turn as a guess: a 10 × 12 ft room with the sheet on its center line, two photos from the
// two end doorways. Both turns contradict the other photo about equally, so the range spans both readings.
test('the sheet on the room’s center line: both half turns fit, the range spans both readings and the note asks for a side photo', async () => {
  const room = rectShape(0, 0, 3048, 3658, 0), paper = rectShape(0, 0, 279.4, 215.9, 0);
  const poses = [{ tiltDeg: 35, D: 3500, f: 1300, panDeg: 0, aim: [0, -121] }, { tiltDeg: 35, D: 3500, f: 1300, panDeg: 180, aim: [0, 121] }];
  const { urls, deps } = scene(poses, { floor: [room, room], paper: [paper, paper] });
  const r = await measureAnything({ dataUrls: urls, text: 'tile', deps });
  assert.equal(r.ok, true, r.ask);
  if (r.partial) {
    // With the sheet dead center the two end shots also miss a side wall: a "so far", at most the truth.
    assert.ok(r.combined.openSides.length);
    assert.ok(parseFloat(r.numbers[0].value) <= 120 * 1.03);
  } else if (r.combined.ambiguous) {
    assert.equal(r.confidence, 'low');
    assert.match(r.ask, /Two photos from opposite ends can’t always tell which way is which; a third photo from a side wall settles it\./);
    const [lo, hi] = r.numbers.find((n) => n.label === 'Range').value.match(/\d+/g).map(Number);
    assert.ok(lo <= 120 && hi >= 120, `range ${lo}–${hi} must hold 120`);
    assert.match(stepDetail(r.pipeline.find((x) => /^combine/.test(x.step))), /the other half-turn reads/);
    const es = await measureAnything({ dataUrls: urls, text: 'baldosas', deps: { ...deps, read: async () => R({ language: 'es' }) } });
    assert.match(es.ask, /Dos fotos desde extremos opuestos no siempre distinguen cuál lado es cuál/);
  } else {
    // The contradiction told the turns apart even here: then the room must simply be right.
    near(sqftOf(r), 120, 0.08, 'area');
  }
});

test('the partial fallback at the 4-photo limit says so instead of asking for more', async () => {
  const elsewhere = rectShape(300, 3350, 1800, 700, 0);
  const poses = [POSES[0], { tiltDeg: 50, D: 5000, f: 1300, panDeg: 0, aim: [300, 1390] }, POSES[2], { tiltDeg: 35, D: 3500, f: 1300, panDeg: 70, aim: [-600, -300] }];
  const { urls, deps } = scene(poses, { floor: [ROOM, elsewhere, ROOM, ROOM] });
  const r = await measureAnything({ dataUrls: urls, text: 'tile', deps });
  if (r.ok && r.partial) {
    assert.equal(r.wantMore, false);
    assert.match(r.answer, /That’s the limit of 4 photos; tap Start over/);
    assert.doesNotMatch(r.answer, /Send one or two more/);
  } else assert.ok(r.ok, r.ask); // the far floor was dropped or refused some other way; either is fine here
});

test('Spark’s checks on several photos share one budget and run two at a time; a slow Spark is skipped, not timed out one by one', async () => {
  const { urls, deps } = scene();
  let running = 0, peak = 0;
  const slow = (ms) => async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, ms)); running--; return { outlines: [{ color: 'MAGENTA', ok: true, seen: 'floor' }, { color: 'ORANGE', ok: true, seen: 'paper' }], problem: '', retake_tip: '' }; };
  const t0 = Date.now();
  const r = await measureAnything({ dataUrls: urls, text: 'tile', deps: { ...deps, check: slow(150) }, checkTimeoutMs: 1500 });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.checked, 'agreed');
  assert.ok(peak <= 2, `at most two checks at once, saw ${peak}`);
  assert.ok(Date.now() - t0 < 6000);
  // Spark never answers: every check is skipped within the shared budget, and the answer still goes out, marked unchecked.
  const never = await measureAnything({ dataUrls: urls, text: 'tile', deps: { ...deps, check: () => new Promise(() => {}) }, checkTimeoutMs: 400 });
  assert.equal(never.ok, true);
  assert.equal(never.checked, 'skipped');
  assert.ok(never.pipeline.filter((s) => /check SAM/.test(s.step)).every((s) => /check skipped \(no reply in [\d.]+ s\)/.test(stepDetail(s))));
  assert.equal(checkBudgetMs(1), CHECK_TIMEOUT_MS);
  assert.equal(checkBudgetMs(3), CHECK_TIMEOUT_MS + 2 * CHECK_EXTRA_MS);
  assert.equal(checkBudgetMs(9), CHECK_BUDGET_MAX_MS);
});

test('Spark returns no text for the wording: the panel says so', async () => {
  const { urls, deps } = scene();
  const r = await measureAnything({ dataUrls: urls, text: 'tile', deps: { ...deps, word: async () => '' } });
  assert.equal(r.ok, true);
  assert.equal(r.wording, 'template');
  assert.equal(stepDetail(r.pipeline.find((s) => /word the answer/.test(s.step))), 'kept our template (Spark returned no text)');
  const budget = await measureAnything({ dataUrls: urls, text: 'tile', deps: { ...deps, word: async () => { throw new Error('Spark returned no text: it used its whole token budget thinking'); } } });
  assert.equal(stepDetail(budget.pipeline.find((s) => /word the answer/.test(s.step))), 'kept our template (Spark returned no text (its whole token budget went to thinking))');
});

test('Review B’s fourth pose (pan 70, sees the paper’s long edge foreshortened) joins the three and the room stays 10 × 12', async () => {
  const poses = [...POSES, { tiltDeg: 35, D: 3500, f: 1300, panDeg: 70, aim: [-600, -300] }];
  const { urls, deps } = scene(poses);
  const r = await measureAnything({ dataUrls: urls, text: 'tile', deps });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.combined.ok, true, r.note);
  near(sqftOf(r), 120, 0.08, 'area');
  const [w, l] = r.numbers.find((n) => n.label === 'Floor').value.split(' × ').map(feetOf);
  near(w, 10, 0.05, 'width'); near(l, 12, 0.05, 'length');
  assert.ok(r.combined.fill >= 0.9, `fill ${r.combined.fill}`);
});

test('a photo with the paper too small or too far is a retake of that photo, never a blown-up floor', async () => {
  // Review A's probe: tilt 28 from the far doorway puts the paper at about 60 px; its map blew a 8 × 14 ft room up to 4e43 mm².
  const room = rectShape(0, 0, 2438, 4267, 0);
  const paper = rectShape(-2438 / 2 + 300 + 108, -4267 / 2 + 600 + 140, 279.4, 215.9, 90);
  const poses = [{ tiltDeg: 28, D: 3800, f: 1300, panDeg: 0, aim: [0, -700] }, { tiltDeg: 28, D: 3800, f: 1300, panDeg: 180, aim: [0, 700] }];
  const { urls, deps } = scene(poses, { floor: [room, room], paper: [paper, paper] });
  const r = await measureAnything({ dataUrls: urls, text: 'tile', deps });
  // Photo 2 is dropped; photo 1 answers alone, as a partial, and the tip asks for photo 2 again.
  assert.deepEqual(r.dropped, [2]);
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.partial, true);
  assert.match(r.ask, /^Photo 2: Get closer to the sheet for that one and send it again\./);
  assert.ok(parseFloat(r.numbers[0].value) < 112);
});

test('fill bands and alignment: a cross of misaligned floors is refused; an L-shaped floor combines with the union as the area; a plain rectangle fills its rectangle', () => {
  const L = 279.4, S = 215.9;
  const rect = (x0, x1, y0, y1) => ({ ok: true, paper: { long: L, short: S }, plusMinusPct: 0.03, confidence: 'good', notes: [], areaMm2: (x1 - x0) * (y1 - y0), bounds: { x0, x1, y0, y1 }, sample: (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1 });
  // Two floors that share only the sheet's corner of the room (27% of the smaller): they did not line up.
  const across = rect(-1500, 1500, -400, 400), along = rect(-400, 400, -1500, 1500);
  const c = combineFloors([across, along]);
  assert.equal(c.ok, false);
  assert.equal(c.refused, null);
  assert.deepEqual(c.misaligned, [0, 1]);
  assert.ok(c.pairOverlap < 0.4, `overlap ${c.pairOverlap}`);
  // An L: a 3.2 × 2 m room with a 1.5 × 1 m bite in one corner, seen from two doorways that both see the sheet.
  const a = rect(-200, 1500, -800, 1200), b = rect(-200, 3000, -800, 200);
  const l = combineFloors([a, b]);
  assert.equal(l.ok, true, JSON.stringify(l));
  assert.equal(l.rectangle, false);
  near(l.fill, (3.4 + 3.2 - 1.7) / 6.4, 0.03, 'fill');
  near(l.areaMm2, 4.9e6, 0.03, 'union area');
  near(l.widthMm, 2000, 0.02, 'width'); near(l.lengthMm, 3200, 0.02, 'length');
  assert.ok(l.pairOverlap >= 0.4, `overlap ${l.pairOverlap}`);
  // A plain rectangle from two overlapping halves.
  const ok = combineFloors([rect(-200, 2000, -800, 1200), rect(-200, 3000, -800, 1200)]);
  assert.equal(ok.ok, true);
  assert.equal(ok.rectangle, true);
  assert.ok(ok.fill >= 0.98, `fill ${ok.fill}`);
});

test('the 180° ambiguity: a photo whose paper frame comes out turned around is put back by overlap', () => {
  // Two halves of a 3200 × 2000 mm floor on the paper's plane (paper at the origin, long edge along x),
  // both seeing the sheet. Photo B's frame is handed over turned 180° about the paper, as a second camera
  // from the far doorway would give it; combineFloors must turn it back, or the union would be a cross.
  const L = 279.4, S = 215.9;
  const rect = (x0, x1, y0, y1) => ({ ok: true, paper: { long: L, short: S }, plusMinusPct: 0.03, confidence: 'good', notes: [], areaMm2: (x1 - x0) * (y1 - y0), bounds: { x0, x1, y0, y1 }, sample: (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1 });
  const turn = (p) => ({ ...p, bounds: { x0: L - p.bounds.x1, x1: L - p.bounds.x0, y0: S - p.bounds.y1, y1: S - p.bounds.y0 }, sample: (x, y) => p.sample(L - x, S - y) });
  const left = rect(-200, 2000, -800, 1200), right = rect(-200, 3000, -800, 1200);
  const straight = combineFloors([left, right]);
  const turned = combineFloors([left, turn(right)]);
  assert.equal(straight.photos[1].flipped, false);
  assert.equal(turned.photos[1].flipped, true);
  for (const c of [straight, turned]) {
    assert.equal(c.ok, true, JSON.stringify(c));
    near(c.areaMm2, 3200 * 2000, 0.02, 'area');
    near(c.lengthMm, 3200, 0.02, 'length'); near(c.widthMm, 2000, 0.02, 'width');
  }
  assert.ok(turned.photos[1].overlapCells > 0);
  // The inverse homography really inverts.
  const H = [1.2, 0.1, 30, -0.2, 0.9, 12, 0.0004, -0.0002, 1];
  const Hi = invertH(H);
  const mul = (A, B) => Array.from({ length: 9 }, (_, k) => [0, 1, 2].reduce((t, m) => t + A[Math.floor(k / 3) * 3 + m] * B[m * 3 + (k % 3)], 0));
  const I = mul(H, Hi);
  for (let k = 0; k < 9; k++) assert.ok(Math.abs(I[k] - (k % 4 === 0 ? 1 : 0)) < 1e-9, `identity[${k}] = ${I[k]}`);
});

test('in the rendered room the second doorway’s photo really does come out turned, and is put back', async () => {
  const { urls, deps } = scene();
  const r = await measureAnything({ dataUrls: urls, text: 'tile', deps });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.combined.turned[0], false);
  assert.ok(r.combined.turned.some(Boolean), `turned: ${r.combined.turned}`);
});

test('no paper in photo 2: that photo is dropped and asked for again; the other photos still answer', async () => {
  const { urls, deps } = scene(POSES, { paper: [PAPER, null, PAPER] });
  const r = await measureAnything({ dataUrls: urls, text: 'tile for this floor', deps });
  assert.equal(r.ok, true, r.ask);
  assert.deepEqual(r.dropped, [2]);
  assert.match(r.ask, /^Photo 2: I can’t line that one up without the paper\. Send it again with the whole sheet in the shot \(and leave the sheet where it is\)\. (?:Two photos from opposite ends .*? )?Combined from 2 photos — check one wall/);
  assert.equal(r.combined.photos, 2);
  assert.match(r.answer, /^Combined from 2 photos:/);
  assert.equal(r.overlays.length, 3); // every photo's outlines, the dropped one too
  // The dropped photo gets no Spark check and no number.
  assert.ok(!r.pipeline.some((s) => /photo 2 of 3: map/.test(s.step)));
  // Photo 1 alone with a paperless photo 2: photo 1's partial answer plus the request.
  const two = scene(POSES.slice(0, 2), { paper: [PAPER, null] });
  const r2 = await measureAnything({ dataUrls: two.urls, text: 'tile', deps: two.deps });
  assert.equal(r2.ok, true, r2.ask);
  assert.equal(r2.partial, true);
  assert.deepEqual(r2.dropped, [2]);
  assert.match(r2.ask, /^Photo 2: I can’t line that one up without the paper\./);
  // No floor in photo 3 says so too.
  const r3 = await measureAnything({ dataUrls: urls, text: 'tile', deps: scene(POSES, { floor: [ROOM, ROOM, null] }).deps });
  assert.deepEqual(r3.dropped, [3]);
  assert.match(r3.ask, /^Photo 3: I couldn’t find the floor in that one\. Send it again with more of the floor and the whole sheet in the shot\./);
  // Nothing usable at all: the request fails and the panel withholds every number.
  const none = scene(POSES.slice(0, 2), { paper: [null, null] });
  const r0 = await measureAnything({ dataUrls: none.urls, text: 'tile', deps: none.deps });
  assert.equal(r0.ok, false);
  assert.deepEqual(r0.dropped, [1, 2]);
  assert.match(r0.ask, /^Photo 1: I can’t line that one up without the paper\..* Photo 2: I can’t line that one up/);
  assert.ok(!r0.pipeline.some((s) => s.model === 'first-answer math' && s.result && !s.result.withheld));
});

test('a photo of a different floor (or a moved paper) is refused: the best single photo answers, with a note', async () => {
  // Photo 2 (a steeper, farther shot from the first doorway) sees the paper and, past the far wall, a
  // floor that starts more than a meter beyond this room: another room, or the paper was moved.
  const elsewhere = rectShape(300, 3350, 1800, 700, 0);
  const poses = [POSES[0], { tiltDeg: 50, D: 5000, f: 1300, panDeg: 0, aim: [300, 1390] }, POSES[2]];
  const { urls, deps } = scene(poses, { floor: [ROOM, elsewhere, ROOM] });
  const r = await measureAnything({ dataUrls: urls, text: 'tile for this floor', deps });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.combined.ok, false);
  assert.match(r.note, /^The photos weren’t combined: photo 2 doesn’t touch the floor seen in the others, so it may be a different floor, or the paper moved\. This answer is from photo [13] alone\. Leave the sheet of paper/);
  assert.doesNotMatch(r.answer, /combined from/);
  assert.ok(!r.numbers.some((n) => n.label === 'Photos'));
  assert.ok([1, 3].includes(r.combined.from), `from photo ${r.combined.from}`);
  // The chosen photo shows only part of the floor, so the fallback is the partial, never the room.
  assert.equal(r.partial, true);
  assert.match(r.headline, /^About \d+ sq ft so far$/);
  assert.match(r.numbers.find((n) => n.label === 'Range').value, /\(±6%\)$/);
  const combine = r.pipeline.find((s) => /^combine 3 photos/.test(s.step));
  assert.match(stepDetail(combine), /^not combined: photo 2 does not touch the floor in the other photos \([\d.]+ ft away\); best single photo used$/);
  assert.equal(r.overlays.length, 3);
});

test('Spark disagrees with SAM in one photo: refused, the tip names that photo, every photo’s outlines stay', async () => {
  const { urls, deps } = scene();
  const check = async (images) => (images[0] === 'p2'
    ? { outlines: [{ color: 'MAGENTA', ok: true, seen: 'tile floor' }, { color: 'ORANGE', ok: false, seen: 'a white rug' }], problem: 'The orange outline is a rug.', retake_tip: '' }
    : { outlines: [{ color: 'MAGENTA', ok: true, seen: 'tile floor' }, { color: 'ORANGE', ok: true, seen: 'sheet of paper' }], problem: '', retake_tip: '' });
  const r = await measureAnything({ dataUrls: urls, text: 'tile', deps: { ...deps, check } });
  assert.equal(r.ok, false);
  assert.equal(r.refused, 'spark-check');
  assert.match(r.ask, /^I didn’t measure this one: in photo 2 of 3, Muse Spark checked SAM’s outline of the ruler and saw a white rug, not a sheet of printer paper\. Retake that one with/);
  assert.equal(r.overlays.length, 3);
  assert.ok(r.overlays.every((o) => o.lines.length === 0));
  assert.equal(r.pipeline.filter((s) => /check SAM’s outlines/.test(s.step)).length, 3);
  assert.ok(r.pipeline.filter((s) => s.model === 'first-answer math').every((s) => s.result?.withheld));
  // All agree: checked, one check step per photo.
  const ok = await measureAnything({ dataUrls: urls, text: 'tile', deps: { ...deps, check: async () => ({ outlines: [{ color: 'MAGENTA', ok: true, seen: 'floor' }, { color: 'ORANGE', ok: true, seen: 'paper' }], problem: '', retake_tip: '' }) } });
  assert.equal(ok.ok, true);
  assert.equal(ok.checked, 'agreed');
  assert.deepEqual(ok.pipeline.filter((s) => /check SAM/.test(s.step)).map((s) => s.step), [1, 2, 3].map((i) => `photo ${i} of 3: check SAM’s outlines on the photo`)); // the checks run in parallel; the panel lists them by photo
});

test('a Spanish question gets the combined card in Spanish', async () => {
  const { urls, deps } = scene();
  const r = await measureAnything({ dataUrls: urls, text: '¿Cuántas baldosas necesito para este piso? Hay una hoja de papel en el piso.', deps: { ...deps, read: async () => R({ language: 'es' }) } });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.lang, 'es');
  assert.match(r.answer, /^Combinando 3 fotos: el piso mide unos .+ \([\d.]+ pies cuadrados\)\. Con baldosas .* compra \d+ baldosas\. Manda una más si todavía falta una esquina, o toca Enviar al negocio\.$/);
  assert.equal(r.numbers.find((n) => n.label === 'Fotos').value, '3 fotos');
  assert.match(r.answer, /Por seguridad, el pedido cubre (?:el extremo alto del rango \([\d,.]+ pies cuadrados\)|un \d+% más que el área medida), más 15% extra para cortes y errores/);
  assert.match(r.ask, /Combinado de 3 fotos/);
  assert.ok(r.overlays.every((o) => o.outlines.some((x) => x.label === 'hoja de papel')));
  const missing = await measureAnything({ dataUrls: urls, text: 'baldosas', deps: { ...scene(POSES, { paper: [PAPER, null, PAPER] }).deps, read: async () => R({ language: 'es' }) } });
  assert.match(missing.ask, /^Foto 2: No puedo alinear esa sin la hoja\. Mándala otra vez con la hoja completa en la foto \(y deja la hoja donde está\)\. (?:Dos fotos desde extremos opuestos .*? )?Combinado de 2 fotos: revisa una pared/);
  assert.equal(missing.lang, 'es');
});

test('several photos with a task that is not a floor: the first photo is measured and the note says so', async () => {
  const cam = camera({ tiltDeg: 15, D: 900, f: 1100 });
  const paper = rectShape(0, 0, 279.4, 215.9, 90), foot = { inside: ([x, y]) => (x / 50) ** 2 + (y / 132) ** 2 <= 1, boundary: Array.from({ length: 36 }, (_, k) => [50 * Math.cos((k * Math.PI) / 18), 132 * Math.sin((k * Math.PI) / 18)]) };
  const by = { foot: samSeg(cam, foot.inside, foot.boundary), 'sheet of paper': samSeg(cam, paper.inside, paper.boundary) };
  const r = await measureAnything({ dataUrls: ['a', 'b'], text: 'shoe size', deps: { read: async () => R({ task: 'shoe_size', target: 'foot', shoe_for: 'men' }), segment: async (_d, c) => by[c] || EMPTY } });
  assert.equal(r.ok, true, r.ask);
  assert.match(r.headline, /^Size/);
  assert.match(r.note, /Only the first photo was measured/);
  assert.equal(r.overlays, undefined);
});

// ---- the server: 1 to 4 photos, per-photo progress, per-photo limits ----
delete process.env.MODEL_API_KEY;
const srv = await import('../src/server.js');
const guard = await import('../src/guard.js');
const server = http.createServer(srv.app);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const post = (body, headers = {}) => fetch(`${base}/api/measure`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...headers }, body: JSON.stringify(body) });

test('/api/measure takes two photos and streams one progress line per photo, then a combined result the board can take', async () => {
  const { segs } = scene(POSES.slice(0, 2));
  const urls = [`${TINY}1`, `${TINY}2`]; // two distinct, still image data URLs
  srv._testDeps.current = { read: async () => R({}), segment: async (d, c) => segs[urls.indexOf(d)]?.[c] || EMPTY };
  try {
    const res = await post({ dataUrls: urls, text: 'how much tile? paper on the floor', photos: 2 });
    assert.match(res.headers.get('content-type'), /ndjson/);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'start');
    const steps = lines.filter((l) => l.type === 'step').map((l) => l.step);
    assert.ok(steps.includes('photo 1 of 2: outline floor and sheet of paper'), steps.join(' | '));
    assert.ok(steps.includes('photo 2 of 2: outline floor and sheet of paper'), steps.join(' | '));
    assert.ok(steps.includes('photo 2 of 2: map the floor onto the sheet of printer paper’s plane'), steps.join(' | '));
    assert.ok(steps.some((s) => /^combine 2 photos/.test(s)), steps.join(' | '));
    assert.ok(lines.filter((l) => l.type === 'step').every((l) => l.detail === undefined), 'progress lines carry no step details');
    const r = lines.at(-1);
    assert.equal(r.type, 'result');
    assert.equal(r.ok, true, r.ask);
    assert.equal(r.overlays.length, 2);
    assert.match(r.answer, /^Combined from 2 photos:/);
    assert.ok(r.handoff?.id);
    assert.match(r.business.job, /sq ft \(from 2 photos\)/);
    assert.match(r.business.quote, /sq ft × \$8\.50 per sq ft/);
    // The hand-off carries the combined job like any other.
    const sent = await (await fetch(`${base}/api/measure/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: r.handoff.id }) })).json();
    assert.equal(sent.ok, true);
    const feed = await (await fetch(`${base}/api/owner/feed`)).json();
    const lead = feed.leads.find((l) => l.id === sent.leadId);
    assert.match(lead.sight.job, /from 2 photos/);
    assert.equal(lead.sight.task, 'floor_tile');
    assert.ok(lead.quote.total >= 600);
  } finally {
    srv._testDeps.current = null;
  }
});

test('the conversation: photo 1 alone is a partial that asks for more; photos 1+2 combine; a paperless photo 2 keeps photo 1 and asks again', async () => {
  const { segs } = scene(POSES.slice(0, 2));
  const noPaper = scene(POSES.slice(0, 2), { paper: [PAPER, null] }).segs;
  const urls = [`${TINY}1`, `${TINY}2`, `${TINY}3`]; // photo 3 is photo 2 shot without the paper
  srv._testDeps.current = { read: async () => R({}), segment: async (d, c) => { const i = urls.indexOf(d); return (i === 2 ? noPaper[1] : segs[i])?.[c] || EMPTY; } };
  const go = async (dataUrls) => (await (await post(dataUrls.length > 1 ? { dataUrls, text: 'tile this floor, paper on it' } : { dataUrl: dataUrls[0], text: 'tile this floor, paper on it' })).text()).trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  try {
    // 1. One photo from the doorway: part of the floor, so far, and a request for more. No job yet.
    const one = await go([urls[0]]);
    assert.equal(one.ok, true, one.ask);
    assert.equal(one.partial, true);
    assert.equal(one.wantMore, true);
    assert.match(one.answer, /^I can see part of the floor: about \d+ sq ft so far\. Send one or two more photos/);
    assert.equal(one.handoff, null);
    assert.equal(one.business, null);
    // 2. The page sends photo 1 again with photo 2: combined, with a job the board can take.
    const two = await go([urls[0], urls[1]]);
    assert.equal(two.ok, true, two.ask);
    assert.match(two.answer, /^Combined from 2 photos: the floor is about .* Send one more if a corner is still missing, or tap Send to the business\.$/);
    assert.ok(two.handoff?.id);
    assert.equal(two.dropped, undefined);
    near(parseFloat(two.numbers.find((n) => n.label === 'Area').value), 120, 0.08, 'area');
    // 3. Photo 1 with a photo that has no sheet: photo 1's partial again, the bad one named and dropped.
    const bad = await go([urls[0], urls[2]]);
    assert.equal(bad.ok, true, bad.ask);
    assert.equal(bad.partial, true);
    assert.deepEqual(bad.dropped, [2]);
    assert.match(bad.ask, /^Photo 2: I can’t line that one up without the paper\. Send it again with the whole sheet in the shot \(and leave the sheet where it is\)\./);
    assert.equal(bad.handoff, null);
  } finally {
    srv._testDeps.current = null;
  }
});

test('a body too big for four photos gets a plain JSON answer, not an HTML error page', async () => {
  const res = await fetch(`${base}/api/measure`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"dataUrls":["${'x'.repeat(17 * 1024 * 1024)}"]}` });
  assert.equal(res.status, 413);
  assert.match(res.headers.get('content-type'), /json/);
  assert.match((await res.json()).ask, /too big to send together/);
});

test('/api/measure: one photo still works the old way; five photos are refused; every photo counts against the limit', async () => {
  const one = await post({ dataUrl: TINY, text: 'how big' });
  const last = (await one.text()).trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(last.type, 'result');
  assert.equal(last.ok, false); // no key in tests
  assert.match(last.ask, /Meta models/);
  const five = await post({ dataUrls: Array(5).fill(TINY), text: 'tile' });
  assert.equal(five.status, 400);
  assert.match((await five.json()).ask, /up to 4 photos/);
  const bad = await post({ dataUrls: [TINY, 'not-an-image'], text: 'tile' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).ask, /Every photo/);
  // Four different photos in one request use four of the 20 per 10 minutes; a malformed request uses none (refused first).
  const ip = { 'x-forwarded-for': '9.9.9.9' };
  const fresh = () => { srv.measureLimit.reset(); srv.photosSeen.reset(); };
  const left = () => { const r = srv.measureLimit.check('9.9.9.9'); return r.remaining + 1; }; // check() itself takes one
  const P = [1, 2, 3, 4, 5].map((i) => `${TINY}${i}`);
  fresh();
  await post({ dataUrls: P.slice(0, 4), text: 'tile' }, ip);
  assert.equal(left(), 20 - 4);
  fresh();
  await post({ dataUrls: [P[0], 'nope', P[1], P[2]], text: 'tile' }, ip);
  assert.equal(left(), 20);
  // A floor conversation: photo 1, then 1+2, then 1+2+3, then 1+2+3+4 cost 4 in all; re-sending the same
  // set costs nothing new; one more new photo costs 1.
  fresh();
  for (let n = 1; n <= 4; n++) await post(n === 1 ? { dataUrl: P[0], text: 'tile' } : { dataUrls: P.slice(0, n), text: 'tile' }, ip);
  assert.equal(left(), 20 - 4);
  await post({ dataUrls: P.slice(0, 4), text: 'tile' }, ip);
  assert.equal(left(), 20 - 4 - 1); // the check above took one; the re-send took none
  await post({ dataUrls: [P[1], P[2], P[3], P[4]], text: 'tile' }, ip);
  assert.equal(left(), 20 - 4 - 1 - 1 - 1); // two checks so far, one new photo
  fresh();
});

test('a chip can list several photos: tile.jpg, tile-2.jpg ... are one sample, in order', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'samples-'));
  for (const f of ['tile-2.jpg', 'tile.jpg', 'tile-10.jpg', 'driveway.jpg']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.writeFileSync(path.join(dir, 'tile.txt'), 'Tile floor\nhow much tile? two photos, paper on the floor');
  const list = srv.listSamples(dir);
  assert.deepEqual(list.map((x) => x.id), ['driveway', 'tile']);
  const tile = list.find((x) => x.id === 'tile');
  assert.deepEqual(tile.urls, ['/samples/tile.jpg', '/samples/tile-2.jpg', '/samples/tile-10.jpg']);
  assert.equal(tile.url, '/samples/tile.jpg');
  assert.equal(tile.label, 'Tile floor');
  assert.deepEqual(list.find((x) => x.id === 'driveway').urls, ['/samples/driveway.jpg']);
});

test('/api/measure reserves 12 Meta calls per photo against the daily cap', async () => {
  process.env.MODEL_API_KEY = 'test-not-a-real-key';
  try {
    guard.metaCalls.reset();
    guard.metaCalls.take(guard.metaCalls.remaining() - 20); // room for one photo, not two
    const two = await post({ dataUrls: [TINY, `${TINY}2`], text: 'tile' });
    assert.equal(two.status, 429);
    assert.equal((await two.json()).dailyCap, true);
  } finally {
    delete process.env.MODEL_API_KEY;
    guard.metaCalls.reset();
  }
});
