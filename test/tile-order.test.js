// The tile order: sized on the high end of the shown area range, capped at +25%, then +15% for cuts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tileAnswer } from '../src/anything.js';
import { es } from '../src/es.js';

const answer = (pm) => tileAnswer({ read: { tile_w_in: 12, tile_l_in: 12, language: 'en' }, roomW: 150, roomL: 200, plusMinusPct: pm, confidence: 'good', photos: 1, pipeline: { add() {} }, task: 'floor_tile', measuredAgainst: 'x' });
const nums = (r) => ({ laid: Number(r.answer.match(/that’s (\d+) tiles laid/)[1]), buy: Number(r.headline.match(/Buy (\d+) tiles/)[1]) });

test('a narrow range: the order covers the high end of the range, then 15% for cuts', () => {
  const r = answer(0.03);
  const { laid, buy } = nums(r);
  const hi = Number(r.answer.match(/high end of the range \((\d+) sq ft\)/)[1]);
  const sqft = 150 * 200 / 144;
  assert.equal(buy, Math.ceil(Math.ceil(laid * (hi / sqft)) * 1.15));
  assert.ok(buy > Math.ceil(laid * 1.15), 'more than the old order, which ignored the range');
  assert.doesNotMatch(r.answer, /25% more/);
  assert.match(r.answer, new RegExp(`buy ${buy} tiles`));
  assert.ok(r.shopping[0].startsWith(`${buy} tiles`));
});

test('a wide range: the order is capped at 25% over the measured area, then 15% for cuts', () => {
  const r = answer(0.2); // range ±40%: far above the cap
  const { laid, buy } = nums(r);
  assert.equal(buy, Math.ceil(Math.ceil(laid * 1.25) * 1.15));
  assert.match(r.answer, /covers 25% more than the measured area, plus 15% extra/);
  assert.doesNotMatch(r.answer, /high end of the range/);
  assert.equal(r.numbers.find((n) => n.label === 'Buy').value, `${buy} tiles (+15% for cuts)`);
});

test('both wordings translate to Spanish with no English left', () => {
  const narrow = es(answer(0.03).answer), wide = es(answer(0.2).answer);
  assert.match(narrow, /Por seguridad, el pedido cubre el extremo alto del rango \(\d+ pies cuadrados\), más 15% extra para cortes y errores: compra \d+ baldosas\./);
  assert.match(wide, /Por seguridad, el pedido cubre un 25% más que el área medida, más 15% extra para cortes y errores: compra \d+ baldosas\./);
  for (const t of [narrow, wide]) assert.doesNotMatch(t, /\b(order|covers|tiles|measured|laid)\b/);
});
