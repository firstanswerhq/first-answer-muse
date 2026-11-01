// First Answer Sight ("See it. Size it. Solve it."): text one photo, get a measurement back.
// Muse Spark reads the photo, SAM 3.1 outlines the objects, our math turns
// pixels into inches using an everyday object in the shot as the ruler.
// A floor can be sent as 2 to 4 photos from different doorways with one sheet of paper left in place;
// the server combines them on the paper's plane and the reply shows every photo with SAM's masks.

const $ = (id) => document.getElementById(id);
const thread = $('thread');
const textIn = $('textIn');
const SVGNS = 'http://www.w3.org/2000/svg';
const FALLBACK_ERR = "Couldn't measure that one — try again with a gift card, quarter, or sheet of paper in the shot.";

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// One chip per demo business. A real photo for a chip goes in public/samples/<id>.jpg with <id>.txt
// (label line, then the message). Face is off unless the server turns it on (SIGHT_FACE=1) and lists a
// face sample; then it comes last.
const SAMPLES = [
  { id: 'tile', label: 'Tile floor', text: 'How much tile do I need for this floor? There is a sheet of paper on it for scale.' },
  { id: 'windshield', label: 'Windshield chip', text: 'Repair or replace this chip? I put a quarter next to it.' },
  { id: 'shoe', label: 'Shoe size', text: 'What shoe size am I? My foot is on a sheet of paper.' },
  { id: 'shed', label: 'Shed fit', text: 'Will a 12 ft wide shed fit between my fence and the house?' },
  { id: 'driveway', label: 'Driveway', text: 'How big is my driveway? I need to know how much sealer to buy.' },
];
const FACE = { id: 'face', label: 'Face', text: 'Gift card flat on my forehead. Measure my eye spacing.' };

// The waiting steps light up as the server reports each one finished (streamed), not on a timer.
// With several photos of a floor there is one more: combining them on the paper's plane.
const waitSteps = (n) => [
  ['spark', 'Muse Spark', 'reading the photo and the question'],
  ['sam', 'SAM 3.1', n > 1 ? `outlining the floor and the paper in ${n} photos` : 'outlining the objects'],
  ['math', 'Our geometry', n > 1 ? 'mapping each floor onto the paper’s plane' : 'measuring against the ruler'],
  ...(n > 1 ? [['math', 'Our geometry', `combining ${n} photos into one floor`]] : []),
  ['spark', 'Muse Spark', n > 1 ? 'checking SAM’s outlines in every photo and wording the answer' : 'checking SAM’s outlines and wording the answer'],
];
// Which waiting step a finished pipeline step completes (0-based index of the step that is done).
function stageOf(step, n = 1) {
  const k = modelInfo(step.model)[0], what = step.step || '';
  const last = n > 1 ? 4 : 3;
  if (/routed/.test(what)) return 0;
  if (k === 'spark') return /word/.test(what) ? last : 0;
  if (k === 'sam') return 1;
  if (n > 1 && /^combine|tile layout/.test(what)) return 3;
  return 2;
}

const CONF = {
  good: ['good', 'Measured'],
  fair: ['fair', 'Close estimate'],
  low: ['low', 'Rough — see tip'],
};

// ---------- chat helpers ----------
function bubble(who, html, extra = '') {
  const el = document.createElement('div');
  el.className = `msg ${who} ${extra}`.trim();
  el.innerHTML = html;
  thread.appendChild(el);
  scrollDown();
  return el;
}
function scrollDown() {
  requestAnimationFrame(() => (thread.scrollTop = thread.scrollHeight));
}

function modelInfo(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('spark')) return ['spark', 'Muse Spark'];
  if (m.includes('sam')) return ['sam', 'SAM 3.1'];
  if (m.includes('image')) return ['spark', 'Muse Image'];
  if (!m || m === 'engine' || m.includes('math') || m.includes('measure')) return ['math', 'Our geometry'];
  return ['math', model];
}

// ---------- image prep ----------
async function toDataUrl(blob, max = 1600) {
  const img = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(blob));
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  img.close?.();
  return c.toDataURL('image/jpeg', 0.9);
}

// First 128 KB of the original file, base64, so the server can read EXIF lens info.
async function headB64(blob) {
  const buf = new Uint8Array(await blob.slice(0, 128 * 1024).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- staged photos ----------
// One photo for anything; up to MAX_PHOTOS of one floor (the Tile floor chip, or a message about a floor),
// with the same sheet of paper left in place in every shot.
const MAX_PHOTOS = 4;
let staged = []; // [{ blob, preview }]
let floorChip = false; // the Tile floor chip was tapped for this message
const FLOOR_WORDS = /\b(?:tiles?|tiling|floor|flooring|piso|baldosas?|azulejos?|losetas?)\b/i;
const floorMode = () => floorChip || FLOOR_WORDS.test(textIn.value);
function renderStaged() {
  const box = $('stagedThumbs');
  box.innerHTML = staged.map((s, i) => `<span class="m-thumb"><img src="${s.preview}" alt="Photo ${i + 1} ready to send">${staged.length > 1 ? `<i>${i + 1}</i><button type="button" data-remove="${i}" aria-label="Remove photo ${i + 1}">&times;</button>` : ''}</span>`).join('');
  const n = staged.length;
  $('stagedMsg').textContent = n > 1 ? `${n} photos of the floor ready. Add a question and tap Send.` : keptFirst ? 'Only the first photo is kept: several photos are for a floor. Add a question and tap Send.' : 'Photo ready. Add a question and tap Send.';
  keptFirst = false;
  const canAdd = n > 0 && n < MAX_PHOTOS && floorMode();
  $('addPhoto').classList.toggle('hidden', !canAdd);
  $('addPhoto').textContent = n > 1 ? `Add another photo of the same floor (${n} of ${MAX_PHOTOS})` : 'Add another photo of the same floor';
  $('addTip').classList.toggle('hidden', !(n > 0 && floorMode()));
  $('staged').classList.toggle('hidden', n === 0);
  document.querySelector('.m-cam').classList.toggle('armed', n > 0);
}
function stage(blob, { add = false } = {}) {
  // In floor mode a new photo joins the others; at 4 it replaces the last one (never wipes the set).
  // Outside floor mode it replaces the staged photo.
  if (!add || !floorMode()) { for (const s of staged) URL.revokeObjectURL(s.preview); staged = []; }
  else if (staged.length >= MAX_PHOTOS) { URL.revokeObjectURL(staged[MAX_PHOTOS - 1].preview); staged.length = MAX_PHOTOS - 1; }
  staged.push({ blob, preview: URL.createObjectURL(blob) });
  renderStaged();
  textIn.focus();
}
function unstage() {
  for (const s of staged) URL.revokeObjectURL(s.preview);
  staged = [];
  floorChip = false;
  renderStaged();
}
function removeStaged(i) {
  if (!staged[i]) return;
  URL.revokeObjectURL(staged[i].preview);
  staged.splice(i, 1);
  if (!staged.length) floorChip = false;
  renderStaged();
}
$('unstage').addEventListener('click', unstage);
$('stagedThumbs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-remove]');
  if (b) removeStaged(Number(b.dataset.remove));
});
// Leaving floor mode (the message no longer says floor or tile, or another chip was tapped) keeps only
// the first photo: everything else is measured from one photo.
let keptFirst = false; // say so once, on the staged bar
function keepFirstUnlessFloor() {
  if (staged.length > 1 && !floorMode()) { for (const s of staged.slice(1)) URL.revokeObjectURL(s.preview); staged.length = 1; keptFirst = true; }
}
let adding = false;
$('addPhoto').addEventListener('click', () => { adding = true; $('photoIn').click(); });
$('photoIn').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  const add = adding || (staged.length > 0 && floorMode());
  adding = false;
  if (f) stage(f, { add });
});
// Typing "floor" or "tile" turns on the add-another-photo control for the staged photo; dropping those
// words keeps only the first photo.
textIn.addEventListener('input', () => { if (staged.length) { keepFirstUnlessFloor(); renderStaged(); } });

// ---------- waiting chips ----------
function working(dataUrl, n = 1) {
  const el = bubble('them', `${dataUrl ? `<div class="scan"><img src="${dataUrl}" alt=""><span class="beam"></span></div>` : ''}<ol class="pipe">${waitSteps(n).map(([k, name, what]) => `<li><span class="spin"></span><span class="mtag ${k}">${name}</span>${what}</li>`).join('')}</ol>`, 'working');
  const items = [...el.querySelectorAll('li')];
  let at = 0;
  items[0].classList.add('on');
  // Step n finished: everything up to n is done, the next one is working.
  const reached = (n) => {
    if (n < at - 1) return;
    items.forEach((li, j) => {
      li.classList.toggle('done', j <= n);
      li.classList.toggle('on', j === n + 1);
    });
    at = n + 1;
  };
  // With several photos the SAM line counts them off as each photo's outlines come back.
  let outlined = 0;
  const count = (s) => {
    if (n > 1 && modelInfo(s.model)[0] === 'sam' && /^photo \d+ of \d+: outline/.test(s.step || '')) {
      outlined++;
      const li = items[1];
      li.lastChild.textContent = `outlining the floor and the paper in ${n} photos (${outlined} of ${n} done)`;
    }
  };
  return { step: (s) => { count(s); reached(stageOf(s, n)); }, done: () => el.remove() };
}

// ---------- annotated photo ----------
function annotatedShot(dataUrl, overlay, T = UI.en) {
  const wrap = document.createElement('div');
  wrap.className = 'shot';
  const img = new Image();
  img.alt = 'Your photo, measured';
  img.src = dataUrl;
  wrap.appendChild(img);
  const frame = overlay?.frame;
  if (!frame?.w || !frame?.h) return wrap;

  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${frame.w} ${frame.h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const pct = (x, y) => ({ left: `${(x / frame.w) * 100}%`, top: `${(y / frame.h) * 100}%` });
  const pin = (cls, text, x, y, x2 = x) => {
    const p = document.createElement('span');
    p.className = `pin ${cls}`;
    p.textContent = text;
    Object.assign(p.style, pct(x, y));
    // A box right of center hangs its pin from its right edge, so the text never runs past the photo.
    if (x / frame.w > 0.4) { p.style.left = 'auto'; p.style.right = `${100 - (Math.min(x2, frame.w) / frame.w) * 100}%`; }
    if (y / frame.h < 0.07) p.classList.add('below');
    wrap.appendChild(p);
  };

  // Rulers first so targets draw on top.
  const outlines = [...(overlay.outlines || [])].sort((a, b) => (a.role === 'ruler' ? -1 : 0) - (b.role === 'ruler' ? -1 : 0));
  outlines.forEach((o, i) => {
    const b = o.box;
    if (!b) return;
    const isRuler = o.role === 'ruler';
    const cls = o.role === 'rejected' ? 'o-rejected' : isRuler ? 'o-ruler' : 'o-target';
    if (o.path && o.w && o.h) {
      // Same as drawBoxes() in app.js: the path is in mask pixels (w x h); place it in the box.
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', o.path);
      p.setAttribute('transform', `translate(${b.x1} ${b.y1}) scale(${(b.x2 - b.x1 + 1) / o.w} ${(b.y2 - b.y1 + 1) / o.h})`);
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      p.setAttribute('class', cls);
      p.setAttribute('pathLength', '1');
      p.style.animationDelay = `${500 + i * 160}ms`;
      svg.appendChild(p);
    } else {
      const r = document.createElementNS(SVGNS, 'rect');
      Object.entries({ x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1, rx: 4 }).forEach(([k, v]) => r.setAttribute(k, v));
      r.setAttribute('vector-effect', 'non-scaling-stroke');
      r.setAttribute('class', cls);
      r.setAttribute('pathLength', '1');
      svg.appendChild(r);
    }
    if (o.role === 'rejected') return; // SAM's first try: drawn dashed, named in the key, no pin
    const label = o.label || (isRuler ? 'reference' : 'target');
    const conf = o.conf != null ? ` · ${Number(o.conf).toFixed(2)}` : '';
    // Rulers are small and often sit inside a target: tag them under the box.
    if (isRuler) pin('ruler below', `${T.ruler}: ${label}${conf}`, b.x1, Math.min(b.y2, frame.h * 0.92), b.x2);
    else pin('target', `${label}${conf}`, b.x1, b.y1, b.x2);
  });

  // Measurement lines with end ticks and a label pill in the middle.
  const tick = Math.max(frame.w, frame.h) * 0.012;
  for (const l of overlay.lines || []) {
    if (!l?.from || !l?.to) continue;
    const [x1, y1] = l.from;
    const [x2, y2] = l.to;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = (-(y2 - y1) / len) * tick;
    const ny = ((x2 - x1) / len) * tick;
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', `M${x1} ${y1}L${x2} ${y2}`);
    p.setAttribute('pathLength', '1');
    p.setAttribute('vector-effect', 'non-scaling-stroke');
    p.setAttribute('class', 'm-line');
    svg.appendChild(p);
    // Graduations along the line, like a tape: end caps, a tall tick every quarter, short ones between.
    const N = 16;
    let td = `M${x1 - nx * 1.4} ${y1 - ny * 1.4}L${x1 + nx * 1.4} ${y1 + ny * 1.4}M${x2 - nx * 1.4} ${y2 - ny * 1.4}L${x2 + nx * 1.4} ${y2 + ny * 1.4}`;
    for (let k = 1; k < N; k++) {
      const f = k / N, h = k % 4 === 0 ? 0.9 : 0.45;
      const cx = x1 + (x2 - x1) * f, cy = y1 + (y2 - y1) * f;
      td += `M${cx} ${cy}L${cx + nx * h} ${cy + ny * h}`;
    }
    const t2 = document.createElementNS(SVGNS, 'path');
    t2.setAttribute('d', td);
    t2.setAttribute('vector-effect', 'non-scaling-stroke');
    t2.setAttribute('class', 'm-ticks');
    svg.appendChild(t2);
    if (l.label) {
      const t = document.createElement('span');
      t.className = 'len';
      t.textContent = l.label;
      Object.assign(t.style, pct((x1 + x2) / 2, (y1 + y2) / 2));
      wrap.appendChild(t);
    }
  }
  wrap.insertBefore(svg, img.nextSibling);
  return wrap;
}

// The key under the photo: these are Meta SAM 3.1's real masks (with its confidence), and what Muse
// Spark said when it checked them.
function shotKey(r, { verdict = true } = {}) {
  const outlines = r.overlay?.outlines || [];
  if (!outlines.length) return null;
  const el = document.createElement('div');
  el.className = 'shot-key';
  const T = L(r);
  const item = (o) => `<span class="k ${o.role === 'ruler' ? 'ruler' : o.role === 'rejected' ? 'rejected' : 'target'}"><i></i>${esc(o.role === 'ruler' ? `${T.ruler}: ${o.label}` : o.label)}${o.conf != null && o.role !== 'rejected' ? ` <em>${Number(o.conf).toFixed(2)}</em>` : ''}</span>`;
  const check = !verdict ? null : r.corrected && r.checked === 'agreed' ? ['ok', T.corrected] : { agreed: ['ok', T.agreed], disagreed: ['bad', r.corrected ? T.correctedBad : T.disagreed], skipped: ['skip', T.skipped] }[r.checked];
  el.innerHTML = `<div class="k-row"><span class="mtag sam">SAM 3.1 masks</span>${outlines.map(item).join('')}</div>${check ? `<div class="k-check ${check[0]}"><span class="mtag spark">Muse Spark</span>${esc(check[1])}</div>` : ''}`;
  return el;
}

// ---------- words on the card (English; Spanish for Spanish questions) ----------
const UI = {
  en: {
    ruler: 'ruler', agreed: 'Muse Spark checked these outlines and agrees', disagreed: 'Muse Spark checked these outlines and disagreed, so nothing was measured', skipped: 'Muse Spark’s check didn’t come back in time, so this was measured without it', corrected: 'Muse Spark disagreed with SAM’s first outline, told SAM what to look for, and agrees with the new one (re-measured)', correctedBad: 'Muse Spark corrected SAM once and still disagreed, so nothing was measured',
    retake: 'Retake needed', notYet: 'Not measured yet', tip: 'Tip', against: 'Measured against:', buy: 'What to buy', steps: 'Steps',
    sparkWords: 'Spark wording', checkedNums: 'numbers from geometry, checked', geomNums: 'Numbers from geometry',
    forBiz: (to) => `For ${to}`, wouldGet: 'What the business would get', job: 'Job size', mats: 'Materials', quote: 'Quote',
    priced: (to) => `Demo price from ${to}’s own price list (a demo business).`, unpriced: (to) => `Not on ${to}’s price list, so the owner prices it.`, never: 'First Answer never makes prices up.', ownerEnglish: '',
    phone: 'Your phone (optional)', phoneLabel: 'Your phone number, optional, so they can text you back', send: (to) => `Send this to ${to}`, sending: 'Sending…', seeBoard: (o) => `See ${o}’s board`, sendFail: 'Couldn’t send it just now. Try again in a moment.',
    panel: 'How Meta’s models measured it', fixed: ['corrected SAM’s outline →', 'outlined it again → re-measured'], photo: 'Photo',
    photosIn: (n) => `${n} photo${n === 1 ? '' : 's'} of this floor so far.`, noPhotos: 'No usable photo of this floor yet.', nextPhoto: 'Tap the camera for the next one; it joins these.', nextSample: 'Send the next sample photo', startOver: 'Start over', startedOver: 'Started over: the next photo begins a new floor.', notUsed: 'not used', atLimit: 'That’s the limit of 4 photos; tap Send to the business, or Start over.',
    conf: { good: 'Measured', fair: 'Close estimate', low: 'Rough — see tip' },
  },
  es: {
    ruler: 'referencia', agreed: 'Muse Spark revisó estos contornos y está de acuerdo', disagreed: 'Muse Spark revisó estos contornos y no estuvo de acuerdo, así que no se midió nada', skipped: 'La revisión de Muse Spark no llegó a tiempo, así que se midió sin ella', corrected: 'Muse Spark no estuvo de acuerdo con el primer contorno de SAM, le dijo qué buscar y está de acuerdo con el nuevo (medido otra vez)', correctedBad: 'Muse Spark corrigió a SAM una vez y siguió sin estar de acuerdo, así que no se midió nada',
    retake: 'Hay que tomar otra foto', notYet: 'Todavía sin medir', tip: 'Consejo', against: 'Referencia:', buy: 'Qué comprar', steps: 'Pasos',
    sparkWords: 'Redacción de Spark', checkedNums: 'números de la geometría, revisados', geomNums: 'Números de la geometría',
    forBiz: (to) => `Para ${to}`, wouldGet: 'Lo que recibiría el negocio', job: 'Trabajo', mats: 'Materiales', quote: 'Cotización',
    priced: (to) => `Precio de demostración de la lista de ${to} (un negocio de demostración).`, unpriced: (to) => `No está en la lista de precios de ${to}; el dueño le pone precio.`, never: 'First Answer nunca inventa precios.', ownerEnglish: 'El negocio lo recibe en inglés.',
    phone: 'Tu teléfono (opcional)', phoneLabel: 'Tu número de teléfono, opcional, para que te escriban', send: (to) => `Enviar a ${to}`, sending: 'Enviando…', seeBoard: (o) => `Ver el tablero de ${o}`, sendFail: 'No se pudo enviar. Inténtalo de nuevo en un momento.',
    panel: 'Cómo lo midieron los modelos de Meta', fixed: ['corrigió el contorno de SAM →', 'lo marcó otra vez → medido de nuevo'], photo: 'Foto',
    photosIn: (n) => `${n} foto${n === 1 ? '' : 's'} de este piso por ahora.`, noPhotos: 'Todavía no hay una foto útil de este piso.', nextPhoto: 'Toca la cámara para la siguiente; se suma a estas.', nextSample: 'Mandar la siguiente foto de muestra', startOver: 'Empezar de nuevo', startedOver: 'Empezamos de nuevo: la siguiente foto empieza otro piso.', notUsed: 'no se usó', atLimit: 'Ese es el límite de 4 fotos; toca Enviar al negocio, o Empezar de nuevo.',
    conf: { good: 'Medido', fair: 'Estimado cercano', low: 'Aproximado: ve el consejo' },
  },
};
const L = (r) => UI[r?.lang === 'es' ? 'es' : 'en'];

// ---------- reply ----------
function list(items, ordered) {
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${items.map((s) => `<li>${esc(s)}</li>`).join('')}</${tag}>`;
}

function renderReply(r, dataUrl, dataUrls = [dataUrl]) {
  const el = bubble('them', '', 'reply');
  const hasOverlay = r.overlay?.frame && ((r.overlay.outlines || []).length || (r.overlay.lines || []).length);
  const dropped = new Set(r.dropped || []);
  // A photo the server could not use (no sheet, sheet too small) is shown dimmed with a "not used" badge.
  const markDropped = (shot, k) => { if (!dropped.has(k)) return; shot.classList.add('dropped'); const d = document.createElement('span'); d.className = 'shot-drop'; d.textContent = L(r).notUsed; shot.appendChild(d); };
  if (hasOverlay) {
    const main = annotatedShot(dataUrl, r.overlay, L(r));
    markDropped(main, 1);
    el.appendChild(main);
    // A floor from several photos: the other photos, small, each with SAM's masks for that photo.
    const more = (r.overlays || []).slice(1).filter((o, i) => o?.frame && dataUrls[i + 1]);
    if (more.length) {
      const row = document.createElement('div');
      row.className = 'shots-more';
      more.forEach((o, i) => {
        const shot = annotatedShot(dataUrls[i + 1], o, L(r));
        const n = document.createElement('span');
        n.className = 'shot-n';
        n.textContent = `${L(r).photo} ${o.photo || i + 2}`;
        shot.appendChild(n);
        markDropped(shot, o.photo || i + 2);
        row.appendChild(shot);
      });
      el.appendChild(row);
    }
    // Spark's verdict is about the photos it checked; a dropped photo 1 was never checked.
    const key = shotKey(r, { verdict: !dropped.has(1) });
    if (key) el.appendChild(key);
  }

  const body = document.createElement('div');
  body.className = 'r-body';
  const T = L(r);
  const conf = CONF[r.confidence] && [CONF[r.confidence][0], T.conf[r.confidence]];
  const nums = (r.numbers || []).filter((n) => n && (n.label || n.value != null));
  const shopping = (r.shopping || []).filter(Boolean);
  const steps = (r.steps || []).filter(Boolean);
  let html = '';
  if (r.ok === false) {
    // Not measured, but SAM's outlines are shown so the customer can see what went wrong.
    html += `<div class="r-top"><h3 class="r-head r-none">${r.refused ? T.retake : T.notYet}</h3></div><div class="r-tip"><b>${T.tip}</b><span>${esc(r.ask || FALLBACK_ERR)}</span></div>`;
  } else if (r.headline || conf) {
    html += `<div class="r-top">${r.headline ? `<h3 class="r-head">${esc(r.headline)}</h3>` : '<span></span>'}${conf ? `<span class="conf ${conf[0]}">${conf[1]}</span>` : ''}</div>`;
  }
  if (r.answer && r.ok !== false) {
    html += `<p class="r-answer"${r.language === 'es' ? ' lang="es"' : ''}>${esc(r.answer).replace(/\n/g, '<br>')}</p>`;
    if (r.asks?.length) html += `<p class="r-drop">${r.asks.map(esc).join('<br>')}</p>`;
    // "en español" only when the server found Spark's text really is Spanish.
    html += `<p class="r-src">${r.wording === 'spark' ? `<span class="mtag spark">${T.sparkWords}${r.language === 'es' ? ' · en español' : ''}</span> · ${T.checkedNums}` : `<span class="mtag math">${T.geomNums}</span>`}</p>`;
  }
  if (r.measuredAgainst && r.ok !== false) html += `<p class="r-against"><span>${T.against}</span> ${esc(r.measuredAgainst)}</p>`;
  if (nums.length) html += `<div class="r-nums">${nums.map((n) => `<div class="r-num"><span>${esc(n.label)}</span><b>${esc(n.value)}</b></div>`).join('')}</div>`;
  if (shopping.length) html += `<div class="r-sec"><h4>${T.buy}</h4>${list(shopping, false)}</div>`;
  if (steps.length) html += `<div class="r-sec"><h4>${T.steps}</h4>${list(steps, true)}</div>`;
  const tip = r.asks?.length && r.ok !== false ? r.askTail : r.ask;
  if (tip && r.ok !== false) html += `<div class="r-tip"><b>${T.tip}</b><span>${esc(tip)}</span></div>`;
  if (r.note) html += `<p class="r-note">${esc(r.note)}</p>`;
  const biz = r.business;
  if (biz && biz.job) {
    const mats = (biz.materials || []).filter(Boolean);
    const to = r.handoff?.to || 'the business';
    html += `<div class="r-biz"><h4>${r.handoff ? esc(T.forBiz(to)) : T.wouldGet}</h4><dl>
      <div><dt>${T.job}</dt><dd lang="en">${esc(biz.job)}</dd></div>
      ${mats.length ? `<div><dt>${T.mats}</dt><dd lang="en">${mats.map(esc).join('<br>')}</dd></div>` : ''}
      <div><dt>${T.quote}</dt><dd lang="en">${esc(biz.quote)}</dd></div>
    </dl><p>${esc(biz.priced ? T.priced(to) : T.unpriced(to))} ${T.never}${T.ownerEnglish ? ` ${T.ownerEnglish}` : ''}</p>
    ${r.handoff ? `<form class="r-send"><input type="tel" inputmode="tel" autocomplete="tel" placeholder="${esc(T.phone)}" aria-label="${esc(T.phoneLabel)}"><button type="submit">${esc(T.send(to))}</button></form><p class="r-sent" role="status" hidden></p>` : ''}</div>`;
  }
  body.innerHTML = html || `<p class="r-answer">${esc(FALLBACK_ERR)}</p>`;
  el.appendChild(body);
  const sendForm = body.querySelector('.r-send');
  if (sendForm) sendForm.addEventListener('submit', (e) => { e.preventDefault(); sendToBusiness(r.handoff, sendForm, body.querySelector('.r-sent'), r.lang); });
  // A floor conversation: how many photos are in, the next sample photo (demo) and Start over.
  if (r.task === 'floor_tile' && (r.ok !== false || r.dropped)) {
    const kept = r.combined?.photos ?? r.photos ?? (r.ok !== false ? 1 : 0);
    const row = document.createElement('div');
    row.className = 'r-next';
    const more = kept < MAX_PHOTOS && (r.wantMore || r.dropped);
    row.innerHTML = `<span>${esc(kept ? T.photosIn(kept) : T.noPhotos)}${more ? ` ${T.nextPhoto}` : ''}</span>${pendingSamples.length && more ? `<button type="button" class="r-sample">${esc(T.nextSample)}</button>` : ''}<button type="button" class="r-reset">${esc(T.startOver)}</button>`;
    body.appendChild(row);
    row.querySelector('.r-sample')?.addEventListener('click', async (e) => {
      if (busy) return;
      e.target.disabled = true;
      const url = pendingSamples.shift();
      const res = await fetch(url).catch(() => null);
      if (res?.ok) send(await res.blob(), floorText || textIn.value.trim());
    });
    row.querySelector('.r-reset').addEventListener('click', () => { resetFloor(); row.innerHTML = `<span>${esc(T.startedOver)}</span>`; });
  }

  const pipe = (r.pipeline || []).filter((p) => p && p.step);
  if (pipe.length) {
    const sec = document.createElement('div');
    sec.className = 'r-pipe';
    const secs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
    const total = pipe.reduce((t, p) => t + (p.ms || 0), 0);
    sec.innerHTML = `<h4>${T.panel}${total ? ` <small>${secs(total)}</small>` : ''}</h4>${r.corrected && r.ok !== false ? `<p class="r-fixed"><span class="mtag spark">Muse Spark</span> ${T.fixed[0]} <span class="mtag sam">SAM 3.1</span> ${T.fixed[1]}</p>` : ''}<ol>${pipe.map((p) => {
      const [k, name] = modelInfo(p.model);
      return `<li class="${p.failed ? 'failed' : ''}"><span class="mtag ${k}">${esc(name)}</span><span class="what">${esc(p.step || '')}${p.detail ? ` <em>· ${esc(p.detail)}</em>` : ''}</span><span class="ms">${esc(secs(p.ms))}</span></li>`;
    }).join('')}</ol>`;
    el.appendChild(sec);
  }
  // The readout counts up to the measured number once the photo has been traced.
  const head = el.querySelector('.r-head');
  const m = head && head.textContent.match(/\d[\d,]*(?:\.\d+)?/);
  if (m && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const full = head.textContent, target = parseFloat(m[0].replace(/,/g, '')), dec = (m[0].split('.')[1] || '').length;
    const fmtN = (x) => (m[0].includes(',') ? Math.round(x).toLocaleString('en-US') : x.toFixed(dec));
    const before = full.slice(0, m.index), after = full.slice(m.index + m[0].length);
    const t0 = performance.now() + (hasOverlay ? 1300 : 0), dur = 900;
    head.textContent = before + fmtN(0) + after;
    const tickFn = (now) => {
      const k = Math.min(1, Math.max(0, (now - t0) / dur));
      const e = 1 - Math.pow(1 - k, 3);
      head.textContent = before + fmtN(target * e) + after;
      if (k < 1) requestAnimationFrame(tickFn); else head.textContent = full;
    };
    requestAnimationFrame(tickFn);
  }
  // Land on the top of the reply so the measured photo is in view.
  const toReply = () => {
    thread.scrollTop += el.getBoundingClientRect().top - thread.getBoundingClientRect().top - 8;
  };
  const shotImg = el.querySelector('.shot img');
  if (shotImg && !shotImg.complete) shotImg.addEventListener('load', toReply);
  requestAnimationFrame(toReply);
}

// ---------- the hand-off to the business ----------
// Posts only the answer's id (and the optional phone); the server makes the lead from what it measured.
async function sendToBusiness(handoff, form, out, lang) {
  const T = UI[lang === 'es' ? 'es' : 'en'];
  const btn = form.querySelector('button');
  const phone = form.querySelector('input').value.trim();
  btn.disabled = true;
  btn.textContent = T.sending;
  let r = null;
  try {
    const res = await fetch('/api/measure/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: handoff.id, phone, lang }) });
    r = await res.json().catch(() => null);
  } catch {}
  out.hidden = false;
  if (r?.ok) {
    resetFloor();
    form.remove();
    out.className = 'r-sent ok';
    out.innerHTML = `${esc(r.message)} <a href="${esc(r.board || '/owner.html')}" target="_blank" rel="noopener">${esc(T.seeBoard(r.owner || 'the owner'))}</a>`;
  } else {
    btn.disabled = false;
    btn.textContent = T.send(handoff.to);
    out.className = 'r-sent bad';
    out.textContent = r?.ask || r?.error || T.sendFail;
  }
}

// ---------- send ----------
// Reads the server's progress lines (NDJSON) as they arrive; the last line is the result or an error.
async function postMeasure(body, onStep) {
  let res;
  try {
    res = await fetch('/api/measure', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, retry: true, ask: 'Couldn’t reach First Answer. Check your connection and tap Retry.' };
  }
  const type = res.headers.get('content-type') || '';
  if (!type.includes('ndjson') || !res.body) {
    const r = await res.json().catch(() => null);
    if (r) return r;
    return { ok: false, retry: res.status >= 500, ask: res.status >= 500 ? 'Couldn’t reach the Meta models; tap Retry.' : FALLBACK_ERR };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', last = null;
  const take = (ln) => {
    if (!ln.trim()) return;
    let o;
    try { o = JSON.parse(ln); } catch { return; }
    if (o.type === 'step') onStep(o);
    else if (o.type === 'result' || o.type === 'error') last = o;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    take(buf);
  } catch {
    return { ok: false, retry: true, ask: 'The connection dropped while measuring; tap Retry.' };
  }
  return last || { ok: false, retry: true, ask: 'Couldn’t reach the Meta models; tap Retry.' };
}

function errorBubble(r, retry) {
  const el = bubble('them', `<span>${esc(r?.ask || FALLBACK_ERR)}</span>`, 'err');
  if (r?.retry && retry) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'm-retry';
    b.textContent = 'Retry';
    b.addEventListener('click', () => {
      if (busy) return;
      b.disabled = true;
      retry();
    });
    el.appendChild(b);
  }
}

let busy = false;

// ---------- the floor conversation ----------
// A floor is measured the way texting works: one photo gets what it shows ("so far") and a request for
// more; each later photo in the same conversation is combined with the earlier ones. The page keeps the
// floor photos of the current conversation (data URLs) and posts all of them each time, so the server
// stays stateless. The set resets when the customer moves to another task, taps Start over, or sends
// the combined job to the business.
let floorSet = []; // data URLs of this conversation's floor photos, in order
let floorText = '';
let floorLang = 'en';
let pendingSamples = []; // the Tile floor chip's remaining sample photos (URLs), sent one at a time
function resetFloor() { floorSet = []; floorText = ''; floorLang = 'en'; pendingSamples = []; }

// blobs: the new photo(s). In a floor conversation the earlier floor photos go along with them.
async function send(blobs, text, { again = false, extraUrls = null, join = null } = {}) {
  if (busy) return;
  blobs = Array.isArray(blobs) ? blobs : [blobs];
  busy = true;
  $('sendBtn').disabled = true;
  let wait = null;
  try {
    const [fresh, exifB64] = await Promise.all([Promise.all(blobs.map((b) => toDataUrl(b))), headB64(blobs[0]).catch(() => null)]);
    // Earlier floor photos first, then the new ones (at most 4 in all).
    const earlier = extraUrls || ((join ?? (floorSet.length && (floorMode() || FLOOR_WORDS.test(text)))) ? floorSet : []);
    const dataUrls = [...earlier, ...fresh].slice(0, MAX_PHOTOS);
    const dataUrl = dataUrls[0];
    if (!again) {
      bubble('me', `<img src="${fresh[0]}" alt="Photo sent">${fresh.length > 1 ? `<div class="more">${fresh.slice(1).map((u, i) => `<img src="${u}" alt="Photo ${i + 2} sent">`).join('')}</div>` : ''}`, 'photo');
      if (text) bubble('me', esc(text));
    }
    wait = working(fresh[0], dataUrls.length);
    let r;
    try {
      r = await postMeasure({ dataUrl, ...(dataUrls.length > 1 ? { dataUrls } : {}), text, exifB64 }, (s) => wait.step(s));
    } finally {
      wait.done();
    }
    if (r && r.ok !== false && (r.headline || r.answer)) renderReply(r, dataUrl, dataUrls);
    // Not measured, but SAM outlined something: show the photo with the outlines and the tip.
    else if (r && r.ok === false && !r.retry && r.overlay?.frame && (r.overlay.outlines || []).length) renderReply(r, dataUrl, dataUrls);
    else errorBubble(r, () => send(blobs, text, { again: true, extraUrls: earlier }));
    // Remember the floor photos that were usable; a photo the server dropped (no sheet, sheet too small) is left out.
    if (r && r.task === 'floor_tile' && (r.ok !== false || r.dropped)) {
      const dropped = new Set(r.dropped || []);
      floorSet = dataUrls.filter((_, i) => !dropped.has(i + 1));
      floorText = text;
      floorLang = r.lang === 'es' ? 'es' : 'en';
    } else if (r && r.task && r.task !== 'floor_tile') resetFloor();
  } catch {
    errorBubble({ ask: FALLBACK_ERR, retry: true }, () => send(blobs, text, { again: true, extraUrls: earlier }));
  } finally {
    busy = false;
    $('sendBtn').disabled = false;
  }
}

$('compose').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textIn.value.trim();
  if (!staged.length) {
    if (!text) return;
    bubble('me', esc(text));
    textIn.value = '';
    bubble('them', 'Send a photo with that. Tap the camera, and put a gift card, quarter, or sheet of paper in the shot so I have a ruler.');
    return;
  }
  const blobs = staged.map((s) => s.blob);
  // In a floor conversation a new camera photo joins the floor unless the message clearly asks for another
  // task (the server's read of the photo is the real decision; a non-floor answer resets the set).
  const join = floorSet.length > 0 && (floorMode() || !text || !OTHER_TASK_WORDS.test(text));
  if (!join) resetFloor();
  textIn.value = '';
  unstage();
  if (join && floorSet.length >= MAX_PHOTOS) {
    // At the limit nothing is posted (the same four would just be measured again).
    bubble('me', `<img src="${URL.createObjectURL(blobs[0])}" alt="Photo">`, 'photo');
    bubble('them', esc(L({ lang: floorLang }).atLimit));
    return;
  }
  send(blobs, text, { join });
});
const OTHER_TASK_WORDS = /\b(?:driveway|patio|sealer|seal|concrete|asphalt|walkway|slab|shoe|windshield|chip|crack|glass|shed|fence|gap|how tall|height|how far|distance|face|eyes?|pd|zapato|parabrisas|entrada|cobertizo|cerca)\b/i;

// ---------- sample chips ----------
let serverSamples = [];
function findSample(s) {
  const key = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  return serverSamples.find((x) => key(x.id) === key(s.id));
}
function renderChips() {
  $('samples').innerHTML = '';
  const chips = serverSamples.some((x) => x.id === 'face') ? [...SAMPLES, FACE] : SAMPLES;
  for (const s of chips) {
    const srv = findSample(s);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `m-chip${srv?.url ? ' has-photo' : ''}`;
    b.innerHTML = `<i></i>${esc(s.label)}`;
    b.title = srv?.url ? 'Send this sample photo' : 'Fill in a sample question';
    b.addEventListener('click', async () => {
      const text = srv?.text || s.text;
      if (srv?.url) {
        if (busy) return;
        // A chip may have several photos (tile.jpg, tile-2.jpg ...): all of them, in order.
        const urls = Array.isArray(srv.urls) && srv.urls.length ? srv.urls.slice(0, MAX_PHOTOS) : [srv.url];
        const blobs = [];
        const res = await fetch(urls[0]).catch(() => null);
        if (res?.ok) blobs.push(await res.blob());
        if (!blobs.length) { textIn.value = text; textIn.focus(); return; }
        unstage();
        resetFloor();
        if (s.id === 'tile') {
          // The floor chip plays the conversation: the first sample photo goes now, the reply asks for
          // more, and a "Send the next sample photo" button sends the next one into the same floor.
          floorChip = true;
          pendingSamples = urls.slice(1);
          textIn.value = '';
          send(blobs[0], text);
          return;
        }
        textIn.value = '';
        send(blobs[0], text);
      } else {
        floorChip = s.id === 'tile';
        if (!floorChip) resetFloor();
        textIn.value = text;
        if (staged.length) { keepFirstUnlessFloor(); renderStaged(); }
        textIn.focus();
      }
    });
    $('samples').appendChild(b);
  }
}
renderChips();
fetch('/api/measure/samples')
  .then((r) => (r.ok ? r.json() : []))
  .then((list) => {
    serverSamples = Array.isArray(list) ? list : list?.samples || [];
    renderChips();
  })
  .catch(() => {});

// The privacy line names the route photos really take (direct to Meta, or through the relay).
fetch('/api/health').then((r) => r.json()).then((h) => {
  if (h.relay === 'direct') $('privacyRoute').textContent = 'Your photo(s) and message go from our server straight to Meta’s Muse Spark and SAM 3.1';
}).catch(() => {});

bubble('note', 'Text one photo and a question. Put a gift card, quarter, sheet of paper, soda can, or a door in the shot and it becomes the ruler. For a whole floor, leave one sheet of paper on it, send a photo from one doorway, then more from other doorways as asked (up to 4): each one is combined with the earlier ones.');
