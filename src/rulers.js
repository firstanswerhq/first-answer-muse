// "No ruler needed": find every object of known size in a photo, use the best one, and check the
// rest against it. Each candidate ruler gives a scale (millimeters per pixel) near the thing being
// measured; rulers that agree raise confidence, rulers that disagree are reported, and only a photo
// with nothing trustworthy asks the customer to add a soda can or a sheet of paper.

// Everything we can recognize, with its real size and how much we trust it.
// trust: 'exact' = manufactured to a standard; 'standard' = usually this size; 'varies' = needs a check.
export const CATALOG = {
  // things people add on purpose
  sheet_of_paper: { sizeMm: [279.4, 215.9], trust: 'exact', flat: true, samConcept: 'sheet of paper' },
  gift_card: { sizeMm: [85.6, 53.98], trust: 'exact', flat: true, samConcept: 'card' },
  dollar_bill: { sizeMm: [156.0, 66.3], trust: 'exact', flat: true, samConcept: 'dollar bill' },
  quarter: { sizeMm: [24.26], trust: 'exact', flat: true, samConcept: 'coin' },
  soda_can: { sizeMm: [122.7, 66.0], trust: 'exact', flat: false, samConcept: 'soda can' },
  // things already there
  license_plate: { sizeMm: [304.8, 152.4], trust: 'exact', flat: true, samConcept: 'license plate' },
  outlet_cover: { sizeMm: [114.3, 69.85], trust: 'standard', flat: true, samConcept: 'outlet cover' },
  light_switch_plate: { sizeMm: [114.3, 69.85], trust: 'standard', flat: true, samConcept: 'light switch' },
  interior_door: { sizeMm: [2032, 762], trust: 'standard', flat: true, samConcept: 'door' },
  front_door: { sizeMm: [2032, 914.4], trust: 'standard', flat: true, samConcept: 'front door' },
  double_garage_door: { sizeMm: [4877, 2134], trust: 'standard', flat: true, samConcept: 'garage door' },
  single_garage_door: { sizeMm: [2743, 2134], trust: 'standard', flat: true, samConcept: 'garage door' },
  floor_tile_12: { sizeMm: [304.8, 304.8], trust: 'varies', flat: true, samConcept: 'floor tile' },
  brick: { sizeMm: [193.7, 57.2], trust: 'varies', flat: true, samConcept: 'brick' },
  shingle_row: { sizeMm: [143], trust: 'varies', flat: true, samConcept: 'shingle' }, // 5 5/8 in exposure, product-dependent
  stud_spacing: { sizeMm: [406.4], trust: 'standard', flat: true, samConcept: 'stud' }, // 16 in on center
};

const TRUST_WEIGHT = { exact: 1, standard: 0.6, varies: 0.35 };

/**
 * Combine candidate rulers into one scale.
 * candidates: [{ kind, mmPerPx, distancePx (from the thing measured), samePlane (bool), confidence (0-1) }]
 * Returns { ok, mmPerPx, used, agreeing, disagreeing, confidence: 'good'|'fair'|'low', ask }.
 */
export function chooseScale(candidates) {
  const scored = candidates
    .filter((c) => CATALOG[c.kind] && Number.isFinite(c.mmPerPx) && c.mmPerPx > 0)
    .map((c) => {
      const t = TRUST_WEIGHT[CATALOG[c.kind].trust];
      const plane = c.samePlane === false ? 0.4 : 1;
      const near = 1 / (1 + (c.distancePx || 0) / 400);
      return { ...c, weight: t * plane * near * (c.confidence ?? 1) };
    })
    .sort((a, b) => b.weight - a.weight);
  if (!scored.length) return { ok: false, confidence: 'low', ask: 'Lay a sheet of paper or set a soda can right next to it and send one more photo.' };

  const best = scored[0];
  const agreeing = [], disagreeing = [];
  for (const c of scored.slice(1)) {
    const diff = Math.abs(c.mmPerPx - best.mmPerPx) / best.mmPerPx;
    (diff <= 0.08 ? agreeing : disagreeing).push({ kind: c.kind, offBy: Math.round(diff * 100) });
  }
  // Weighted average of the best ruler and the ones that agree with it.
  const pool = [best, ...scored.slice(1).filter((c) => Math.abs(c.mmPerPx - best.mmPerPx) / best.mmPerPx <= 0.08)];
  const wsum = pool.reduce((t, c) => t + c.weight, 0);
  const mmPerPx = pool.reduce((t, c) => t + c.mmPerPx * c.weight, 0) / wsum;

  let confidence = 'fair';
  if (agreeing.length >= 1 || (CATALOG[best.kind].trust === 'exact' && best.samePlane !== false)) confidence = 'good';
  if (CATALOG[best.kind].trust === 'varies' && !agreeing.length) confidence = 'low';
  if (disagreeing.length > agreeing.length && disagreeing.some((d) => d.offBy > 20)) confidence = confidence === 'good' ? 'fair' : 'low';
  const ask = confidence === 'low' ? 'For an exact number, lay a sheet of paper or set a soda can next to it and send one more photo.' : null;
  return { ok: true, mmPerPx, used: best.kind, agreeing, disagreeing, confidence, ask };
}
