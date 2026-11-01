// Spanish questions get the whole card in Spanish: headline, template answer, number labels, shopping
// list, steps, tips and retake tips (static translations of our template strings). The "en español"
// label is only shown when Spark's text really is Spanish.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureAnything } from '../src/anything.js';
import { es, detectLanguage } from '../src/es.js';
import { parseSam } from '../src/muse.js';
import { camera, samSeg, rectShape, ellipseShape } from './flatscene.js';
import { camera3d, render } from './scene3d.js';
import { scene } from './scene.js';

const R = (o) => ({ task: 'size', target: 'object', second_target: '', ruler: 'card', item_width_in: 0, tile_w_in: 0, tile_l_in: 0, shoe_for: 'unknown', language: 'es', summary: '', ...o });
const EMPTY = { objects: [], frame: { w: 1280, h: 960 } };
const run = (read, by, text = '¿cuánto mide?', word) => measureAnything({ dataUrl: 'x', text, deps: { read: async () => read, segment: async (_d, c) => by[c] || EMPTY, word } });

// English words that must not be left on a Spanish card (outside Spark's text and the business block).
const ENGLISH = /\b(?:the|and|your|buy|about|tiles?|gallons?|pails?|feet|inches|sq ft|wide|long|size|fits?|repair|replace|range|narrowest|floor|start|cut each|measure|before|sealer|per coat)\b/i;
function noEnglish(r) {
  const fields = [r.headline, r.answer, r.ask, r.measuredAgainst, ...r.numbers.flatMap((n) => [n.label, n.value]), ...r.shopping, ...r.steps].filter(Boolean);
  for (const f of fields) assert.doesNotMatch(f, ENGLISH, f);
}

function scenes() {
  const c = camera({ tiltDeg: 25, D: 300, f: 1500 });
  const coin = ellipseShape(-25, 0, 12.13, 12.13), chip = ellipseShape(8, 3, 7, 6);
  const cS = camera({ tiltDeg: 15, D: 900, f: 1100 });
  const paper = rectShape(0, 0, 279.4, 215.9, 90), foot = ellipseShape(0, 0, 50, 132);
  const cT = camera({ tiltDeg: 35, D: 4500, f: 1100, panDeg: 5 });
  const floor = rectShape(0, 0, 3658, 3048, 0), paperT = rectShape(300, 200, 279.4, 215.9, 20);
  const c3 = camera3d({ pitchDeg: 12 });
  const { objects } = render(c3, [{ name: 'fence', axis: 'x', at: -6, from: 8, to: 60, top: 6 }, { name: 'house', axis: 'x', at: 7.5, from: 8, to: 60, top: 10 }, { name: 'door', axis: 'z', at: 40, from: -1.5, to: 1.5, top: 80 / 12 }]);
  const seg = (o) => ({ objects: [o], frame: { w: c3.W, h: c3.H } });
  const d = scene({ drive: { x0: -9, x1: 9, z0: 14, z1: 38 }, door: { x0: -8, x1: 8, z: 38 } });
  return {
    chip: [R({ task: 'windshield_chip', target: 'chip', ruler: 'quarter' }), { chip: samSeg(c, chip.inside, chip.boundary), coin: samSeg(c, coin.inside, coin.boundary) }],
    shoe: [R({ task: 'shoe_size', target: 'foot', ruler: 'paper_letter', shoe_for: 'men' }), { foot: samSeg(cS, foot.inside, foot.boundary), 'sheet of paper': samSeg(cS, paper.inside, paper.boundary) }],
    tile: [R({ task: 'floor_tile', target: 'floor', ruler: 'paper_letter', tile_w_in: 12, tile_l_in: 12 }), { floor: samSeg(cT, floor.inside, floor.boundary), 'sheet of paper': samSeg(cT, paperT.inside, paperT.boundary) }],
    shed: [R({ task: 'gap_fit', target: 'fence', second_target: 'house wall', ruler: 'interior_door', item_width_in: 144 }), { fence: seg(objects.fence), 'house wall': seg(objects.house), door: seg(objects.door) }],
    driveway: [R({ task: 'surface_area', target: 'driveway', ruler: 'double_garage_door' }), { driveway: parseSam(d.driveText), 'garage door': parseSam(d.doorText) }],
  };
}

test('all five chips: the card is in Spanish, no English left', async () => {
  for (const [name, [read, by]] of Object.entries(scenes())) {
    const r = await run(read, by);
    assert.equal(r.ok, true, `${name}: ${r.ask}`);
    assert.equal(r.lang, 'es');
    noEnglish(r);
  }
});

test('spot checks of the Spanish wording', async () => {
  const s = scenes();
  const chip = await run(...s.chip);
  assert.equal(chip.headline, 'Se puede reparar');
  assert.match(chip.answer, /^Ese impacto mide 0\.\d+ pulg\.: más pequeño que una moneda de un cuarto de dólar/);
  assert.match(chip.measuredAgainst, /^moneda de un cuarto de dólar \(24\.26 mm\)$/);
  const drive = await run(...s.driveway);
  assert.match(drive.headline, /^Unos [\d,]+ pies cuadrados$/);
  assert.match(drive.answer, /^Tu entrada mide unos [\d,]+ pies cuadrados/);
  const shoe = await run(...s.shoe);
  assert.match(shoe.headline, /^Talla [\d.]+ de hombre$/);
  assert.ok(shoe.steps.some((x) => /Nike/.test(x) && /talla más/.test(x)));
  const shed = await run(...s.shed);
  assert.equal(shed.headline, 'Cabe');
  const tile = await run(...s.tile);
  assert.match(tile.headline, /^Compra \d+ baldosas$/);
  assert.ok(tile.steps.some((x) => /^Empieza en el centro del cuarto/.test(x)));
});

test('the "en español" label is true: an English reply to a Spanish question keeps the Spanish template', async () => {
  const s = scenes();
  const english = await run(...s.driveway, '¿cuánto mide mi entrada?', async (_s, f) => JSON.parse(f).template_answer);
  assert.equal(english.wording, 'template');
  assert.match(english.answer, /^Tu entrada mide/);
  assert.match(english.pipeline.at(-1).result.fellBack, /written in English, not Spanish/);
  const spanish = await run(...s.driveway, '¿cuánto mide mi entrada?', async (_s, f) => {
    const n = JSON.parse(f).numbers; const area = n[0].split(': ')[1].replace(' sq ft', '');
    return `Tu entrada mide unos ${area} pies cuadrados. Lávala a presión primero y deja que se seque.`;
  });
  assert.equal(spanish.wording, 'spark');
  assert.equal(spanish.language, 'es');
  assert.equal(detectLanguage('Your driveway is about 420 sq ft.'), 'en');
  assert.equal(detectLanguage('Tu entrada mide unos 420 pies cuadrados.'), 'es');
});

test('retake tips and refusals are translated too; unknown strings stay whole', async () => {
  assert.match(es('I didn’t measure this one: Muse Spark checked SAM’s outline of the thing to measure and saw a water spot, not the chip. Wipe the glass.'), /^No lo medí: Muse Spark revisó el contorno de SAM de lo que hay que medir y vio “a water spot”, no el impacto\. Vuelve a tomar la foto/);
  assert.match(es('Muse Spark says the coin looks like a dime, not a quarter, so I didn’t measure. If it is, send the photo again and say “it’s a dime”.'), /escribe “es un dime”/);
  assert.match(es('Sorry, measuring faces isn’t available here. Sight measures jobs.'), /^Lo siento, aquí no se miden caras/);
  assert.equal(es('Something we never wrote a rule for.'), 'Something we never wrote a rule for.');
  const s = scenes();
  const noRuler = await run(R({ task: 'windshield_chip', target: 'chip', ruler: 'quarter' }), { chip: s.chip[1].chip });
  assert.match(noRuler.ask, /^Necesito algo de tamaño conocido al lado: pon una moneda de un cuarto de dólar/);
});

test('our own English template passes the wording check on every chip (so faithful Spark wording is used)', async () => {
  const { checkWording, wordingFacts } = await import('../src/anything.js');
  for (const [name, [read, by]] of Object.entries(scenes())) {
    const r = await run({ ...read, language: 'en' }, by, 'how big');
    const f = wordingFacts(r);
    const text = r.verdictSentence ? 'Book a visit this week.' : r.answer;
    assert.deepEqual(checkWording(text, f, r.headline, { task: r.task }), { ok: true }, `${name}: ${text}`);
  }
});
