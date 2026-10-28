// Tile planner: from a measured floor, the layout, the cut list and the shopping list.
// The floor's size comes from a photo (a sheet of paper or one existing tile lying on the floor
// is the ruler, so the whole floor maps to true inches). Everything here is plain arithmetic.
//
// Rules used (Tile Shoppes, "The 10% waste rule for flooring"):
//  - extra tile: 10% straight lay (+5% for a first-timer), 15-20% diagonal or herringbone,
//    15% for large format (12x24 in or bigger);
//  - no slivers: an edge cut under 2 in is avoided; the layout is centered and shifted so both
//    walls get the same, wide-as-possible cut (pros aim for at least half a tile).

const r8 = (x) => Math.round(x * 16) / 16; // to the nearest 1/16 inch, how cuts are marked
// 11.9375 -> "11 15/16": how a tape measure reads.
export function inchFrac(x) {
  const sixteenths = Math.round(x * 16);
  const whole = Math.floor(sixteenths / 16);
  let n = sixteenths - whole * 16, d = 16;
  while (n && n % 2 === 0) { n /= 2; d /= 2; }
  return n ? (whole ? `${whole} ${n}/${d}` : `${n}/${d}`) : `${whole}`;
}

// One direction (across the width or along the length): how many full tiles, and the two edge cuts.
export function axisLayout(room, tile, joint) {
  const pitch = tile + joint;
  const fit = (room + joint) / pitch; // tiles that fit with joints between them
  let full = Math.floor(fit);
  let edge = (room - full * pitch + joint) / 2 - joint; // leftover split between both walls, less a joint at each wall
  // If the edge pieces would be narrow, drop one full tile so both edges grow by half a tile.
  if (edge < tile / 2 && full >= 1) {
    full -= 1;
    edge += pitch / 2;
  }
  if (edge < 0.0001) edge = 0;
  return { full, edge: r8(edge), sliver: edge > 0 && edge < 2 };
}

/**
 * plan({ roomW, roomL, tileW, tileL, joint = 0.125, pattern = 'straight', diy = true, tilesPerBox, sqftPerBox })
 * All sizes in inches. Returns the layout, the cut list and how many tiles and boxes to buy.
 */
export function plan({ roomW, roomL, tileW, tileL, joint = 0.125, pattern = 'straight', diy = true, tilesPerBox, sqftPerBox }) {
  if (![roomW, roomL, tileW, tileL].every((v) => Number.isFinite(v) && v > 0)) return { ok: false, error: 'need room and tile sizes in inches' };
  const across = axisLayout(roomW, tileW, joint);
  const along = axisLayout(roomL, tileL, joint);
  const edgesX = across.edge > 0 ? 2 : 0;
  const edgesY = along.edge > 0 ? 2 : 0;

  const cuts = [];
  if (edgesX) cuts.push({ what: `edge pieces along the two side walls`, count: 2 * along.full, size: `${inchFrac(across.edge)} x ${inchFrac(tileL)} in`, cut: `cut each tile to ${inchFrac(across.edge)} in wide (trim ${inchFrac(tileW - across.edge)} in)` });
  if (edgesY) cuts.push({ what: `edge pieces along the two end walls`, count: 2 * across.full, size: `${inchFrac(tileW)} x ${inchFrac(along.edge)} in`, cut: `cut each tile to ${inchFrac(along.edge)} in long (trim ${inchFrac(tileL - along.edge)} in)` });
  if (edgesX && edgesY) cuts.push({ what: 'corner pieces', count: 4, size: `${inchFrac(across.edge)} x ${inchFrac(along.edge)} in`, cut: 'two cuts each' });

  const fullTiles = across.full * along.full;
  const cutTiles = cuts.reduce((t, c) => t + c.count, 0); // one tile per cut piece (offcuts are usually too small to reuse)
  const base = fullTiles + cutTiles;
  const large = Math.max(tileW, tileL) >= 24 && Math.min(tileW, tileL) >= 12;
  let extraPct = pattern === 'straight' ? 10 : 15;
  if (large) extraPct = Math.max(extraPct, 15);
  if (pattern !== 'straight' && large) extraPct = 20;
  if (diy) extraPct += 5;
  const buyTiles = Math.ceil(base * (1 + extraPct / 100));
  const tileSqft = (tileW * tileL) / 144;
  const perBox = tilesPerBox || (sqftPerBox ? Math.max(1, Math.round(sqftPerBox / tileSqft)) : null);
  const boxes = perBox ? Math.ceil(buyTiles / perBox) : null;

  const notes = [];
  if (across.sliver || along.sliver) notes.push('an edge cut is under 2 in; consider a different tile size or orientation');
  if (pattern !== 'straight') notes.push('diagonal and herringbone cut lists are longer; this list is for straight lay');
  notes.push('measured from a photo: tape-check one wall before the first cut');

  return {
    ok: true,
    room: { widthIn: roomW, lengthIn: roomL, sqft: Math.round(((roomW * roomL) / 144) * 10) / 10 },
    tile: { widthIn: tileW, lengthIn: tileL, jointIn: joint },
    layout: {
      across: `${across.full} full tiles${edgesX ? ` + a ${inchFrac(across.edge)} in cut at each side wall` : ''}`,
      along: `${along.full} full tiles${edgesY ? ` + a ${inchFrac(along.edge)} in cut at each end wall` : ''}`,
      start: 'start at the center of the room and work out, so both walls get the same cut',
    },
    fullTiles,
    cuts,
    tilesForFloor: base,
    extraPct,
    buyTiles,
    boxes,
    perBox,
    notes,
  };
}
