// Whole floor from several photos: one sheet of paper stays on the floor, 2 to 4 photos from different
// doorways each see part of the floor, and the union on the paper's plane is the whole room. Rendered
// scenes with known answers, stand-ins for Muse Spark and SAM, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { measureAnything, checkWording, wordingFacts, stepDetail } from '../src/anything.js';
import { floorOnPaper, combineFloors, invertH } from '../src/floor.js';
import { measureFlat } from '../src/flat.js';
import { camera, samSeg, rectShape } from './flatscene.js';

const R = (o) => ({ task: 'floor_tile', target: 'floor', second_target: '', ruler: 'paper_letter', item_width_in: 0, tile_w_in: 12, tile_l_in: 12, shoe_for: 'unknown', language: 'en', summary: '', ...o });
const EMPTY = { objects: [], frame: { w: 1280, h: 960 } };
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) / want <= tol, `${what}: got ${got}, want ${want} (±${tol * 100}%)`);
const sqftOf = (r) => parseFloat(r.numbers.find((n) => n.label === 'Area').value);
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
  assert.match(r.answer, /^The floor is about 1?\d ft(?: \d+ in)? by 1\d ft(?: \d+ in)? \([\d.]+ sq ft\), combined from 3 photos on the paper’s plane\./);
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
  assert.match(stepDetail(combine), /floor seen \(sq ft\): \d+ · width ft: [\d.]+ · length ft: [\d.]+ · coverage: photo 1 \d+%, photo 2 \d+%, photo 3 \d+%/);
  // Our own template passes the wording check (so faithful Spark wording would be used), "3 photos" included.
  const facts = wordingFacts(r);
  assert.deepEqual(checkWording(r.answer, facts, r.headline, { task: r.task }), { ok: true });
  assert.match(checkWording(r.answer.replace('3 photos', '2 photos'), facts, r.headline, { task: r.task }).reason, /2/);
  assert.equal(r.lang, 'en');
});

test('the 180° ambiguity: a photo whose paper frame comes out turned around is put back by overlap', () => {
  // Two halves of a 3000 × 2000 mm floor on the paper's plane (paper at the origin, long edge along x).
  // Photo B's frame is handed over turned 180° about the paper, as a second camera from the far doorway
  // would give it; combineFloors must turn it back, or the union would be twice the room.
  const L = 279.4, S = 215.9;
  const rect = (x0, x1, y0, y1) => ({ ok: true, paper: { long: L, short: S }, plusMinusPct: 0.03, confidence: 'good', notes: [], areaMm2: (x1 - x0) * (y1 - y0), bounds: { x0, x1, y0, y1 }, sample: (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1 });
  const turn = (p) => ({ ...p, bounds: { x0: L - p.bounds.x1, x1: L - p.bounds.x0, y0: S - p.bounds.y1, y1: S - p.bounds.y0 }, sample: (x, y) => p.sample(L - x, S - y) });
  // The paper sits near the left end of the room, so only one of the two turns of the right half fits.
  const left = rect(-200, 1500, -800, 1200), right = rect(1300, 3000, -800, 1200);
  const straight = combineFloors([left, right]);
  const turned = combineFloors([left, turn(right)]);
  assert.equal(straight.photos[1].flipped, false);
  assert.equal(turned.photos[1].flipped, true);
  for (const c of [straight, turned]) {
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

test('no paper in photo 2: it names the photo and asks for that one again', async () => {
  const { urls, deps } = scene(POSES, { paper: [PAPER, null, PAPER] });
  const r = await measureAnything({ dataUrls: urls, text: 'tile for this floor', deps });
  assert.equal(r.ok, false);
  assert.equal(r.photo, 2);
  assert.match(r.ask, /^I couldn’t find the sheet of printer paper in photo 2 of 3\. Leave the sheet of paper where it is and shoot the floor from another doorway or corner\. Retake that one with the whole sheet of printer paper in the shot\.$/);
  assert.equal(r.overlays.length, 2); // photos 1 and 2 were outlined before it stopped
  assert.ok(!r.numbers.length && !r.headline);
  // No floor in photo 3 says so too.
  const r3 = await measureAnything({ dataUrls: urls, text: 'tile', deps: scene(POSES, { floor: [ROOM, ROOM, null] }).deps });
  assert.equal(r3.ok, false);
  assert.match(r3.ask, /^I couldn’t find the floor in photo 3 of 3\./);
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
  assert.ok(r.numbers.some((n) => n.label === 'Floor') && /^Buy \d+ tiles$/.test(r.headline));
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
  assert.deepEqual(ok.pipeline.filter((s) => /check SAM/.test(s.step)).map((s) => s.step).sort(), [1, 2, 3].map((i) => `photo ${i} of 3: check SAM’s outlines on the photo`)); // the checks run in parallel
});

test('a Spanish question gets the combined card in Spanish', async () => {
  const { urls, deps } = scene();
  const r = await measureAnything({ dataUrls: urls, text: '¿Cuántas baldosas necesito para este piso? Hay una hoja de papel en el piso.', deps: { ...deps, read: async () => R({ language: 'es' }) } });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.lang, 'es');
  assert.match(r.answer, /^El piso mide unos .+ \([\d.]+ pies cuadrados\), combinando 3 fotos sobre el plano de la hoja de papel\./);
  assert.equal(r.numbers.find((n) => n.label === 'Fotos').value, '3 fotos');
  assert.match(r.ask, /Combinado de 3 fotos/);
  assert.ok(r.overlays.every((o) => o.outlines.some((x) => x.label === 'hoja de papel')));
  const missing = await measureAnything({ dataUrls: urls, text: 'baldosas', deps: { ...scene(POSES, { paper: [PAPER, null, PAPER] }).deps, read: async () => R({ language: 'es' }) } });
  assert.match(missing.ask, /^No encontré la hoja de papel en la foto 2 de 3\. Deja la hoja de papel donde está/);
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
  srv.measureDeps.current = { read: async () => R({}), segment: async (d, c) => segs[urls.indexOf(d)]?.[c] || EMPTY };
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
    assert.match(r.answer, /combined from 2 photos/);
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
    srv.measureDeps.current = null;
  }
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
  // Four photos in one request use four of the 20 per 10 minutes.
  srv.measureLimit.reset();
  await post({ dataUrls: Array(4).fill(TINY), text: 'tile' }, { 'x-forwarded-for': '9.9.9.9' });
  assert.equal(srv.measureLimit.check('9.9.9.9').remaining, 20 - 4 - 1);
  srv.measureLimit.reset();
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
