// First Answer Sight ("See it. Size it. Solve it."): text one photo, get a measurement back.
// Muse Spark reads the photo, SAM 3.1 outlines the objects, our math turns
// pixels into inches using an everyday object in the shot as the ruler.

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
const WAIT_STEPS = [
  ['spark', 'Muse Spark', 'reading the photo and the question'],
  ['sam', 'SAM 3.1', 'outlining the objects'],
  ['math', 'Our geometry', 'measuring against the ruler'],
  ['spark', 'Muse Spark', 'checking SAM’s outlines and wording the answer'],
];
// Which waiting step a finished pipeline step completes (0-based index of the step that is done).
function stageOf(step) {
  const k = modelInfo(step.model)[0];
  if (/routed/.test(step.step || '')) return 0;
  if (k === 'spark') return /word/.test(step.step || '') ? 3 : 0;
  if (k === 'sam') return 1;
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

// ---------- staged photo ----------
let staged = null; // { blob, preview }
function stage(blob) {
  if (staged?.preview) URL.revokeObjectURL(staged.preview);
  staged = { blob, preview: URL.createObjectURL(blob) };
  $('stagedImg').src = staged.preview;
  $('staged').classList.remove('hidden');
  document.querySelector('.m-cam').classList.add('armed');
  textIn.focus();
}
function unstage() {
  if (staged?.preview) URL.revokeObjectURL(staged.preview);
  staged = null;
  $('staged').classList.add('hidden');
  document.querySelector('.m-cam').classList.remove('armed');
}
$('unstage').addEventListener('click', unstage);
$('photoIn').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) stage(f);
});

// ---------- waiting chips ----------
function working(dataUrl) {
  const el = bubble('them', `${dataUrl ? `<div class="scan"><img src="${dataUrl}" alt=""><span class="beam"></span></div>` : ''}<ol class="pipe">${WAIT_STEPS.map(([k, name, what]) => `<li><span class="spin"></span><span class="mtag ${k}">${name}</span>${what}</li>`).join('')}</ol>`, 'working');
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
  return { step: (s) => reached(stageOf(s)), done: () => el.remove() };
}

// ---------- annotated photo ----------
function annotatedShot(dataUrl, overlay) {
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
  const pin = (cls, text, x, y) => {
    const p = document.createElement('span');
    p.className = `pin ${cls}`;
    p.textContent = text;
    Object.assign(p.style, pct(x, y));
    if (y / frame.h < 0.07) p.classList.add('below');
    wrap.appendChild(p);
  };

  // Rulers first so targets draw on top.
  const outlines = [...(overlay.outlines || [])].sort((a, b) => (a.role === 'ruler' ? -1 : 0) - (b.role === 'ruler' ? -1 : 0));
  outlines.forEach((o, i) => {
    const b = o.box;
    if (!b) return;
    const isRuler = o.role === 'ruler';
    if (o.path && o.w && o.h) {
      // Same as drawBoxes() in app.js: the path is in mask pixels (w x h); place it in the box.
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', o.path);
      p.setAttribute('transform', `translate(${b.x1} ${b.y1}) scale(${(b.x2 - b.x1 + 1) / o.w} ${(b.y2 - b.y1 + 1) / o.h})`);
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      p.setAttribute('class', isRuler ? 'o-ruler' : 'o-target');
      p.setAttribute('pathLength', '1');
      p.style.animationDelay = `${500 + i * 160}ms`;
      svg.appendChild(p);
    } else {
      const r = document.createElementNS(SVGNS, 'rect');
      Object.entries({ x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1, rx: 4 }).forEach(([k, v]) => r.setAttribute(k, v));
      r.setAttribute('vector-effect', 'non-scaling-stroke');
      r.setAttribute('class', isRuler ? 'o-ruler' : 'o-target');
      r.setAttribute('pathLength', '1');
      svg.appendChild(r);
    }
    const label = o.label || (isRuler ? 'reference' : 'target');
    const conf = o.conf != null ? ` · ${Number(o.conf).toFixed(2)}` : '';
    // Rulers are small and often sit inside a target: tag them under the box.
    if (isRuler) pin('ruler below', `ruler: ${label}${conf}`, b.x1, Math.min(b.y2, frame.h * 0.92));
    else pin('target', `${label}${conf}`, b.x1, b.y1);
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
function shotKey(r) {
  const outlines = r.overlay?.outlines || [];
  if (!outlines.length) return null;
  const el = document.createElement('div');
  el.className = 'shot-key';
  const item = (o) => `<span class="k ${o.role === 'ruler' ? 'ruler' : 'target'}"><i></i>${esc(o.role === 'ruler' ? `ruler: ${o.label}` : o.label)}${o.conf != null ? ` <em>${Number(o.conf).toFixed(2)}</em>` : ''}</span>`;
  const check = { agreed: ['ok', 'Muse Spark checked these outlines and agrees'], disagreed: ['bad', 'Muse Spark checked these outlines and disagreed, so nothing was measured'], skipped: ['skip', 'Muse Spark’s check didn’t come back in time, so this was measured without it'] }[r.checked];
  el.innerHTML = `<div class="k-row"><span class="mtag sam">SAM 3.1 masks</span>${outlines.map(item).join('')}</div>${check ? `<div class="k-check ${check[0]}"><span class="mtag spark">Muse Spark</span>${esc(check[1])}</div>` : ''}`;
  return el;
}

// ---------- reply ----------
function list(items, ordered) {
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${items.map((s) => `<li>${esc(s)}</li>`).join('')}</${tag}>`;
}

function renderReply(r, dataUrl) {
  const el = bubble('them', '', 'reply');
  const hasOverlay = r.overlay?.frame && ((r.overlay.outlines || []).length || (r.overlay.lines || []).length);
  if (hasOverlay) {
    el.appendChild(annotatedShot(dataUrl, r.overlay));
    const key = shotKey(r);
    if (key) el.appendChild(key);
  }

  const body = document.createElement('div');
  body.className = 'r-body';
  const conf = CONF[r.confidence];
  const nums = (r.numbers || []).filter((n) => n && (n.label || n.value != null));
  const shopping = (r.shopping || []).filter(Boolean);
  const steps = (r.steps || []).filter(Boolean);
  let html = '';
  if (r.ok === false) {
    // Not measured, but SAM's outlines are shown so the customer can see what went wrong.
    html += `<div class="r-top"><h3 class="r-head r-none">${r.refused ? 'Retake needed' : 'Not measured yet'}</h3></div><div class="r-tip"><b>Tip</b><span>${esc(r.ask || FALLBACK_ERR)}</span></div>`;
  } else if (r.headline || conf) {
    html += `<div class="r-top">${r.headline ? `<h3 class="r-head">${esc(r.headline)}</h3>` : '<span></span>'}${conf ? `<span class="conf ${conf[0]}">${conf[1]}</span>` : ''}</div>`;
  }
  if (r.answer && r.ok !== false) {
    html += `<p class="r-answer"${r.language === 'es' ? ' lang="es"' : ''}>${esc(r.answer).replace(/\n/g, '<br>')}</p>`;
    html += `<p class="r-src">${r.wording === 'spark' ? `<span class="mtag spark">Spark wording${r.language === 'es' ? ' · en español' : ''}</span> · numbers from geometry, checked` : '<span class="mtag math">Numbers from geometry</span>'}</p>`;
  }
  if (r.measuredAgainst && r.ok !== false) html += `<p class="r-against"><span>Measured against:</span> ${esc(r.measuredAgainst)}</p>`;
  if (nums.length) html += `<div class="r-nums">${nums.map((n) => `<div class="r-num"><span>${esc(n.label)}</span><b>${esc(n.value)}</b></div>`).join('')}</div>`;
  if (shopping.length) html += `<div class="r-sec"><h4>What to buy</h4>${list(shopping, false)}</div>`;
  if (steps.length) html += `<div class="r-sec"><h4>Steps</h4>${list(steps, true)}</div>`;
  if (r.ask && r.ok !== false) html += `<div class="r-tip"><b>Tip</b><span>${esc(r.ask)}</span></div>`;
  if (r.note) html += `<p class="r-note">${esc(r.note)}</p>`;
  const biz = r.business;
  if (biz && biz.job) {
    const mats = (biz.materials || []).filter(Boolean);
    const to = r.handoff?.to || 'the business';
    html += `<div class="r-biz"><h4>${r.handoff ? `For ${esc(to)}` : 'What the business would get'}</h4><dl>
      <div><dt>Job size</dt><dd>${esc(biz.job)}</dd></div>
      ${mats.length ? `<div><dt>Materials</dt><dd>${mats.map(esc).join('<br>')}</dd></div>` : ''}
      <div><dt>Quote</dt><dd>${esc(biz.quote)}</dd></div>
    </dl><p>${biz.priced ? `Demo price from ${esc(to)}’s own price list (a demo business).` : `Not on ${esc(to)}’s price list, so the owner prices it.`} First Answer never makes prices up.</p>
    ${r.handoff ? `<form class="r-send"><input type="tel" inputmode="tel" autocomplete="tel" placeholder="Your phone (optional)" aria-label="Your phone number, optional, so they can text you back"><button type="submit">Send this to ${esc(to)}</button></form><p class="r-sent" role="status" hidden></p>` : ''}</div>`;
  }
  body.innerHTML = html || `<p class="r-answer">${esc(FALLBACK_ERR)}</p>`;
  el.appendChild(body);
  const sendForm = body.querySelector('.r-send');
  if (sendForm) sendForm.addEventListener('submit', (e) => { e.preventDefault(); sendToBusiness(r.handoff, sendForm, body.querySelector('.r-sent')); });

  const pipe = (r.pipeline || []).filter((p) => p && p.step);
  if (pipe.length) {
    const sec = document.createElement('div');
    sec.className = 'r-pipe';
    const secs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
    const total = pipe.reduce((t, p) => t + (p.ms || 0), 0);
    sec.innerHTML = `<h4>How Meta's models measured it${total ? ` <small>${secs(total)}</small>` : ''}</h4><ol>${pipe.map((p) => {
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
async function sendToBusiness(handoff, form, out) {
  const btn = form.querySelector('button');
  const phone = form.querySelector('input').value.trim();
  btn.disabled = true;
  btn.textContent = 'Sending…';
  let r = null;
  try {
    const res = await fetch('/api/measure/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: handoff.id, phone }) });
    r = await res.json().catch(() => null);
  } catch {}
  out.hidden = false;
  if (r?.ok) {
    form.remove();
    out.className = 'r-sent ok';
    out.innerHTML = `${esc(r.message)} <a href="${esc(r.board || '/owner.html')}" target="_blank" rel="noopener">See ${esc(r.owner || 'the owner')}’s board</a>`;
  } else {
    btn.disabled = false;
    btn.textContent = `Send this to ${handoff.to}`;
    out.className = 'r-sent bad';
    out.textContent = r?.ask || r?.error || 'Couldn’t send it just now. Try again in a moment.';
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
async function send(blob, text, { again = false } = {}) {
  if (busy) return;
  busy = true;
  $('sendBtn').disabled = true;
  let wait = null;
  try {
    const [dataUrl, exifB64] = await Promise.all([toDataUrl(blob), headB64(blob).catch(() => null)]);
    if (!again) {
      bubble('me', `<img src="${dataUrl}" alt="Photo sent">`, 'photo');
      if (text) bubble('me', esc(text));
    }
    wait = working(dataUrl);
    let r;
    try {
      r = await postMeasure({ dataUrl, text, exifB64 }, (s) => wait.step(s));
    } finally {
      wait.done();
    }
    if (r && r.ok !== false && (r.headline || r.answer)) renderReply(r, dataUrl);
    // Not measured, but SAM outlined something: show the photo with the outlines and the tip.
    else if (r && r.ok === false && !r.retry && r.overlay?.frame && (r.overlay.outlines || []).length) renderReply(r, dataUrl);
    else errorBubble(r, () => send(blob, text, { again: true }));
  } catch {
    errorBubble({ ask: FALLBACK_ERR, retry: true }, () => send(blob, text, { again: true }));
  } finally {
    busy = false;
    $('sendBtn').disabled = false;
  }
}

$('compose').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textIn.value.trim();
  if (!staged) {
    if (!text) return;
    bubble('me', esc(text));
    textIn.value = '';
    bubble('them', 'Send a photo with that. Tap the camera, and put a gift card, quarter, or sheet of paper in the shot so I have a ruler.');
    return;
  }
  const { blob } = staged;
  textIn.value = '';
  unstage();
  send(blob, text);
});

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
        const res = await fetch(srv.url).catch(() => null);
        if (!res?.ok) { textIn.value = text; textIn.focus(); return; }
        const blob = await res.blob();
        textIn.value = '';
        unstage();
        send(blob, text);
      } else {
        textIn.value = text;
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

bubble('note', 'Text one photo and a question. Put a gift card, quarter, sheet of paper, soda can, or a door in the shot and it becomes the ruler.');
