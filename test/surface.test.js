// The Driveway chip: driveways, patios and slabs go to the square-feet engine (src/measure.js) with the
// garage door as the ruler, never to the flat "size" path that would read the door as a sheet of paper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureAnything, guessFromText, sealerNeeded, SEALER } from '../src/anything.js';
import { parseSam } from '../src/muse.js';
import { scene } from './scene.js';

const R = (o) => ({ task: 'size', target: 'object', second_target: '', ruler: 'card', item_width_in: 0, tile_w_in: 0, tile_l_in: 0, shoe_for: 'unknown', summary: '', ...o });
const EMPTY = { objects: [], frame: { w: 900, h: 1200 } };
const driveway = (opts) => {
  const s = scene(opts);
  return { driveway: parseSam(s.driveText), 'garage door': parseSam(s.doorText) };
};
const deps = (read, byConcept, asked = []) => ({
  read: async () => read,
  segment: async (_d, concept) => { asked.push(concept); return byConcept[concept] || EMPTY; },
});
const TWO_CAR = { drive: { x0: -9, x1: 9, z0: 14, z1: 38 }, door: { x0: -8, x1: 8, z: 38 } }; // 18 x 24 ft = 432 sq ft

test('driveway, patio and sealer requests are read as square feet, tile floors are not', () => {
  for (const t of ['How big is my driveway? I need to know how much sealer to buy.', 'how many square feet is my patio', 'seal my concrete slab', 'how much asphalt sealer for the blacktop']) assert.equal(guessFromText(t).task, 'surface_area', t);
  assert.equal(guessFromText('how much tile for my concrete floor').task, 'floor_tile');
  assert.equal(guessFromText('what shoe size am I? my foot is on paper').task, 'shoe_size');
  assert.notEqual(guessFromText('how many square feet is this').task, 'shoe_size');
});

test('the Driveway chip: Spark says "size", the text says driveway: measured in sq ft against the garage door', async () => {
  const asked = [];
  const r = await measureAnything({
    dataUrl: 'x', text: 'How big is my driveway? I need to know how much sealer to buy.',
    deps: deps(R({ task: 'size', target: 'garage door', ruler: 'card' }), driveway(TWO_CAR), asked),
  });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.task, 'surface_area');
  assert.deepEqual(asked.sort(), ['driveway', 'garage door']);
  const sqft = parseFloat(r.headline.replace(/[^\d.]/g, ''));
  assert.ok(Math.abs(sqft - 432) / 432 < 0.12, `got ${r.headline}`);
  assert.equal(r.confidence, 'fair'); // never "Measured" for a driveway
  assert.ok(r.surface.low <= 432 && r.surface.high >= 432, 'range covers the truth');
  assert.match(r.numbers.find((n) => n.label === 'Range').value, /^\d[\d,]* – \d[\d,]* sq ft$/);
  // Sealer is bought for the high end of the range.
  const gallons = Math.ceil(r.surface.high / SEALER.concrete.perGallon);
  assert.equal(r.numbers.find((n) => n.label === 'Concrete sealer').value, `${gallons} gallons per coat`);
  assert.ok(r.shopping.some((s) => /Asphalt sealer: \d+ five-gallon pails/.test(s)));
  assert.equal(r.overlay.outlines.length, 2);
  assert.ok(r.overlay.outlines.some((o) => o.role === 'ruler' && /garage door/.test(o.label)));
});

test('Spark files it as surface_area directly; "asphalt" in the message gives pails only', async () => {
  const r = await measureAnything({
    dataUrl: 'x', text: 'how much sealer for my asphalt driveway',
    deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), driveway(TWO_CAR)),
  });
  assert.equal(r.ok, true, r.ask);
  assert.equal(r.surface.kind, 'asphalt');
  assert.ok(!r.numbers.some((n) => n.label === 'Concrete sealer'));
  assert.match(r.answer, /pails? of asphalt sealer/);
});

test('no garage door in the shot: asks for one instead of guessing', async () => {
  const s = driveway(TWO_CAR);
  const r = await measureAnything({
    dataUrl: 'x', text: 'how big is my driveway',
    deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), { driveway: s.driveway }),
  });
  assert.equal(r.ok, false);
  assert.match(r.ask, /garage door in the shot/);
});

test('a steep side angle is never a confident wrong driveway number', async () => {
  const r = await measureAnything({
    dataUrl: 'x', text: 'how big is my driveway',
    deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), driveway({ yawDeg: 25, camX: -8, drive: { x0: -9, x1: 9, z0: 16, z1: 40 }, door: { x0: -8, x1: 8, z: 40 } })),
  });
  if (r.ok) {
    const off = Math.abs(r.surface.sqft - 432) / 432;
    assert.ok(r.confidence === 'low' || off < 0.2, `${r.surface.sqft} marked good`);
    if (r.confidence === 'low') assert.match(r.ask, /straight on/);
  }
});

test('sealer math rounds up', () => {
  assert.deepEqual(sealerNeeded(401, 'concrete').map((x) => x.qty), [3]);
  assert.deepEqual(sealerNeeded(600, 'asphalt').map((x) => x.qty), [2]);
  assert.equal(sealerNeeded(100).length, 2);
});

test('every answer for a business carries job size, materials and a quote line with no invented price', async () => {
  const r = await measureAnything({
    dataUrl: 'x', text: 'how big is my driveway',
    deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), driveway(TWO_CAR)),
  });
  assert.match(r.business.job, /^Driveway: roughly [\d,]+ sq ft/);
  assert.ok(r.business.materials.length >= 1);
  assert.match(r.business.quote, /\$X per sq ft \(set by the business\)/);
  assert.doesNotMatch(JSON.stringify(r.business), /\$\d/);
});

test('the "driveway" outline lands on a garage door: refused, never measured as a driveway', async () => {
  const s = scene(TWO_CAR);
  const door = parseSam(s.doorText);
  const r = await measureAnything({
    dataUrl: 'x', text: 'How big is my driveway? I need to know how much sealer to buy.',
    deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), { driveway: door, 'garage door': door }),
  });
  assert.equal(r.refused ?? r.ok === false, r.refused ?? true);
  assert.notEqual(r.ok, true);
  assert.match(r.ask, /ended up on the garage door instead of the ground, so I held off on a number\. Step back so the ground in front of the garage door/);
  assert.ok(!r.numbers?.length, 'no panel numbers on a refused answer');
});

test('boxInside: how much of one box lies inside another', async () => {
  const { boxInside } = await import('../src/anything.js');
  assert.equal(boxInside({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 0, y1: 0, x2: 20, y2: 20 }), 1);
  assert.equal(boxInside({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 5, y1: 0, x2: 20, y2: 10 }), 0.5);
  assert.equal(boxInside({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 30, y1: 30, x2: 40, y2: 40 }), 0);
});

test('the two-sealer sentence has correct singular and plural wording', async () => {
  const r = await measureAnything({
    dataUrl: 'x', text: 'How big is my driveway? I need to know how much sealer to buy.',
    deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), driveway(TWO_CAR)),
  });
  assert.equal(r.ok, true, r.ask);
  assert.match(r.answer, /That’s \d+ gallons? of concrete sealer or \d+ five-gallon pails? of asphalt sealer per coat\./);
});

test('a faint extra "door" outline that happens to cover the ground does not cause a refusal', async () => {
  const d = driveway(TWO_CAR);
  const gd = d['garage door'];
  const faint = { c: 0.1, box: { x1: -1e6, y1: -1e6, x2: 1e6, y2: 1e6 }, mask: null };
  d['garage door'] = { ...gd, objects: [...(gd.objects || []), faint] };
  const r = await measureAnything({
    dataUrl: 'x', text: 'How big is my driveway? I need to know how much sealer to buy.',
    deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), d),
  });
  assert.equal(r.ok, true, r.ask);
});

test('the door-overlap refusal is translated for a Spanish customer', async () => {
  const s = scene(TWO_CAR);
  const door = parseSam(s.doorText);
  const r = await measureAnything({
    dataUrl: 'x', text: '¿Qué tan grande es mi entrada? Necesito saber cuánto sellador comprar.',
    deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door', language: 'es' }), { driveway: door, 'garage door': door }),
  });
  assert.notEqual(r.ok, true);
  assert.match(r.ask, /Mi contorno de la entrada quedó sobre la puerta del garaje en vez del suelo/);
  assert.doesNotMatch(r.ask, /ended up on/);
});

// Real tape results (Nov 3, 2026): "stoop" got SAM 0 outlines while "concrete slab in front of the door" worked.
test('stoop, porch, steps and landing are asked of SAM as "concrete slab" (surface jobs only); the person\'s word stays', async () => {
  for (const word of ['stoop', 'porch', 'steps', 'landing']) {
    const asked = [];
    const r = await measureAnything({
      dataUrl: 'x', text: `How big is my ${word}?`,
      deps: deps(R({ task: 'surface_area', target: word, ruler: 'double_garage_door' }), { 'concrete slab': driveway(TWO_CAR).driveway, 'front door': driveway(TWO_CAR)['garage door'] }, asked),
    });
    assert.equal(r.ok, true, `${word}: ${r.ask}`);
    assert.ok(asked.includes('front door') && asked.includes('concrete slab') && !asked.includes(word), `${word}: asked ${asked}`);
    assert.match(r.answer, new RegExp(`^Your ${word} is about`), word);
  }
  assert.equal(guessFromText('how big is my front stoop, for sealer').task, 'surface_area');
  assert.equal(guessFromText('how big is my porch').task, 'surface_area');
  assert.equal(guessFromText('how many sq ft is the landing').task, 'surface_area');
  assert.equal(guessFromText('how much sealer for the front steps').task, 'surface_area');
  assert.notEqual(guessFromText('the cat stooped by the door, how big is this').task, 'surface_area');
});

test('porch, landing and steps never hijack a fit, gap, height, windshield or shoe question', async () => {
  for (const [t, want] of [
    ['Will a 6 ft shed fit between my porch and the fence?', 'gap_fit'],
    ['What is the gap between the landing and the wall?', 'gap_fit'],
    ['how tall is the porch roof', 'height'],
    ['what shoe size am I? my foot is on the porch', 'shoe_size'],
    ['can this windshield chip be repaired? the car is parked by the porch', 'windshield_chip'],
    ['how far is the porch from the street', 'distance'],
    ['Will a bench fit by the stoop?', 'gap_fit'],
  ]) assert.equal(guessFromText(t).task, want, t);
  // the model said "size" with a porch target but the message is a fit question: not rerouted to square feet
  const r = await measureAnything({ dataUrl: 'x', text: 'Will a 6 ft shed fit between my porch and the fence?', deps: deps(R({ task: 'size', target: 'porch', ruler: 'card' }), {}) });
  assert.notEqual(r.task, 'surface_area');
});

test('a stairs mention in a driveway question does not swap the garage door for the front door', async () => {
  const asked = [];
  await measureAnything({ dataUrl: 'x', text: 'How big is my driveway? 3 steps lead up to the porch', deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), driveway(TWO_CAR), asked) });
  assert.deepEqual(asked.sort(), ['driveway', 'garage door']);
});

test('a stoop with no outline for "concrete slab" tries the alternates one at a time, then gives up cleanly', async () => {
  const asked = [];
  const s = driveway(TWO_CAR);
  const r = await measureAnything({
    dataUrl: 'x', text: 'how big is my stoop',
    deps: deps(R({ task: 'surface_area', target: 'stoop', ruler: 'double_garage_door' }), { 'concrete pad': s.driveway, 'front door': s['garage door'] }, asked),
  });
  assert.equal(r.ok, true, r.ask);
  assert.deepEqual(asked.filter((c) => c !== 'front door'), ['concrete slab', 'concrete pad']);
  const none = []; // nothing found by any wording: a plain retake, not a number
  const r2 = await measureAnything({ dataUrl: 'x', text: 'how big is my stoop', deps: deps(R({ task: 'surface_area', target: 'stoop', ruler: 'double_garage_door' }), { 'front door': s['garage door'] }, none) });
  assert.equal(r2.ok, false);
  assert.deepEqual(none.filter((c) => c !== 'front door'), ['concrete slab', 'concrete pad', 'concrete step', 'porch floor']);
  // the alternates are for surface jobs only: a windshield "crack" never becomes a concrete slab
  assert.ok(!none.includes('stoop'));
});

test('the surface range is wide enough to hold both real driveway results (one read 15-20% low, one 32% high) and says so', async () => {
  const r = await measureAnything({
    dataUrl: 'x', text: 'How big is my driveway? I need to know how much sealer to buy.',
    deps: deps(R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), driveway(TWO_CAR)),
  });
  const { sqft, low, high } = r.surface;
  assert.ok(low <= sqft * 0.68 && high >= sqft * 1.32, `range ${low}-${high} around ${sqft}`);
  assert.ok(sqft / 1.32 >= low, 'holds a number that read 32% high'); // 340 vs 257.9
  assert.ok(sqft / 0.8 <= high, 'holds a number that read 20% low');
  assert.equal(r.confidence, 'fair');
  assert.match(r.answer, /^Your driveway is about [\d,]+ sq ft/);
  assert.match(r.answer, /A single photo can be off by up to a third, so plan on somewhere between [\d,]+ and [\d,]+ sq ft until you tape it\. \(Measured against the/);
  assert.match(r.headline, /^Roughly /);
  assert.doesNotMatch(r.answer, /\bexactly\b|\bmeasured to\b/i);
  // sealer is still bought for the high end only
  assert.equal(r.numbers.find((n) => n.label === 'Concrete sealer').value, `${Math.ceil(high / SEALER.concrete.perGallon)} gallons per coat`);
  assert.ok(r.steps[0].startsWith('Tape the width and length once'));
});

test('the page labels a surface estimate "Rough estimate" (English and Spanish), not "Close estimate"', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../public/measure.js', import.meta.url), 'utf8');
  assert.match(js, /surfaceFair: 'Rough estimate'/);
  assert.match(js, /surfaceFair: 'Estimado aproximado'/);
  assert.match(js, /r\.task === 'surface_area' && r\.confidence === 'fair' \? T\.surfaceFair/);
});
