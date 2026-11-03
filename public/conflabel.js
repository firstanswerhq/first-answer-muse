// Which words the confidence badge shows. Kept apart from the page script so it can be tested without a browser.
// A surface estimate (driveway, stoop) carries a wide range, so its middle label is "Rough estimate", not "Close estimate".
export function confLabel(r, T) {
  if (!r || !T || !T.conf) return null;
  if (r.task === 'surface_area' && r.confidence === 'fair') return T.surfaceFair;
  return T.conf[r.confidence] || null;
}
