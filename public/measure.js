// Measure Anything: text one photo, get a measurement back.
// Muse Spark reads the photo, SAM 3.1 outlines the objects, our math turns
// pixels into inches using an everyday object in the shot as the ruler.

const $ = (id) => document.getElementById(id);
const thread = $('thread');
const textIn = $('textIn');
const SVGNS = 'http://www.w3.org/2000/svg';
const FALLBACK_ERR = "Couldn't measure that one — try again with a gift card, quarter, or sheet of paper in the shot.";

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SAMPLES = [
  { id: 'face', label: 'Face', text: 'Gift card flat on my forehead. Measure my eye spacing.' },
  { id: 'tile', label: 'Tile floor', text: 'How much tile do I need for this floor? There is a sheet of paper on it for scale.' },
  { id: 'windshield', label: 'Windshield chip', text: 'Repair or replace this chip? I put a quarter next to it.' },
  { id: 'shoe', label: 'Shoe size', text: 'What shoe size am I? My foot is on a sheet of paper.' },
  { id: 'shed', label: 'Shed fit', text: 'Will a 12 ft wide shed fit between my fence and the house?' },
  { id: 'driveway', label: 'Driveway', text: 'How big is my driveway? I need to know how much sealer to buy.' },
];

const WAIT_STEPS = [
  ['spark', 'Muse Spark', 'reading the photo'],
  ['sam', 'SAM 3.1', 'outlining the objects'],
  ['math', 'Our math', 'measuring against the ruler'],
  ['spark', 'Muse Spark', 'writing the answer'],
];

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
  if (!m || m === 'engine' || m === 'math' || m.includes('measure')) return ['math', 'Our math'];
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
  let i = 0;
  items[0].classList.add('on');
  const timer = setInterval(() => {
    if (i >= items.length - 1) return;
    items[i].classList.replace('on', 'done');
    i += 1;
    items[i].classList.add('on');
  }, 1400);
  return { done: () => { clearInterval(timer); el.remove(); } };
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
    // Rulers are small and often sit inside a target: tag them under the box.
    if (isRuler) pin('ruler below', `ruler: ${label}`, b.x1, Math.min(b.y2, frame.h * 0.92));
    else pin('target', label, b.x1, b.y1);
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

// ---------- reply ----------
function list(items, ordered) {
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${items.map((s) => `<li>${esc(s)}</li>`).join('')}</${tag}>`;
}

function renderReply(r, dataUrl) {
  const el = bubble('them', '', 'reply');
  const hasOverlay = r.overlay?.frame && ((r.overlay.outlines || []).length || (r.overlay.lines || []).length);
  if (hasOverlay) el.appendChild(annotatedShot(dataUrl, r.overlay));

  const body = document.createElement('div');
  body.className = 'r-body';
  const conf = CONF[r.confidence];
  const nums = (r.numbers || []).filter((n) => n && (n.label || n.value != null));
  const shopping = (r.shopping || []).filter(Boolean);
  const steps = (r.steps || []).filter(Boolean);
  let html = '';
  if (r.headline || conf) {
    html += `<div class="r-top">${r.headline ? `<h3 class="r-head">${esc(r.headline)}</h3>` : '<span></span>'}${conf ? `<span class="conf ${conf[0]}">${conf[1]}</span>` : ''}</div>`;
  }
  if (r.answer) html += `<p class="r-answer">${esc(r.answer).replace(/\n/g, '<br>')}</p>`;
  if (nums.length) html += `<div class="r-nums">${nums.map((n) => `<div class="r-num"><span>${esc(n.label)}</span><b>${esc(n.value)}</b></div>`).join('')}</div>`;
  if (shopping.length) html += `<div class="r-sec"><h4>What to buy</h4>${list(shopping, false)}</div>`;
  if (steps.length) html += `<div class="r-sec"><h4>Steps</h4>${list(steps, true)}</div>`;
  if (r.ask) html += `<div class="r-tip"><b>Tip</b><span>${esc(r.ask)}</span></div>`;
  if (r.note) html += `<p class="r-note">${esc(r.note)}</p>`;
  body.innerHTML = html || `<p class="r-answer">${esc(FALLBACK_ERR)}</p>`;
  el.appendChild(body);

  const pipe = (r.pipeline || []).filter((p) => p && (p.step || p.result));
  if (pipe.length) {
    const sec = document.createElement('div');
    sec.className = 'r-pipe';
    sec.innerHTML = `<h4>How Meta's models measured it</h4><ol>${pipe.map((p) => {
      const [k, name] = modelInfo(p.model);
      return `<li><span class="mtag ${k}">${esc(name)}</span><span>${esc(p.step || '')}${p.result ? ` <em>· ${esc(p.result)}</em>` : ''}</span></li>`;
    }).join('')}</ol>`;
    el.appendChild(sec);
  }
  // The readout counts up to the measured number once the photo has been traced.
  const head = el.querySelector('.r-head');
  const m = head && head.textContent.match(/\d+(?:\.\d+)?/);
  if (m && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const full = head.textContent, target = parseFloat(m[0]), dec = (m[0].split('.')[1] || '').length;
    const before = full.slice(0, m.index), after = full.slice(m.index + m[0].length);
    const t0 = performance.now() + (hasOverlay ? 1300 : 0), dur = 900;
    head.textContent = before + (0).toFixed(dec) + after;
    const tickFn = (now) => {
      const k = Math.min(1, Math.max(0, (now - t0) / dur));
      const e = 1 - Math.pow(1 - k, 3);
      head.textContent = before + (target * e).toFixed(dec) + after;
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

// ---------- send ----------
let busy = false;
async function send(blob, text) {
  if (busy) return;
  busy = true;
  $('sendBtn').disabled = true;
  let wait = null;
  try {
    const [dataUrl, exifB64] = await Promise.all([toDataUrl(blob), headB64(blob).catch(() => null)]);
    bubble('me', `<img src="${dataUrl}" alt="Photo sent">`, 'photo');
    if (text) bubble('me', esc(text));
    wait = working(dataUrl);
    let r = null;
    try {
      const res = await fetch('/api/measure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, text, exifB64 }),
      });
      r = await res.json().catch(() => null);
      if (!res.ok || !r || r.ok === false) throw Object.assign(new Error('measure failed'), { ask: r?.ask });
    } finally {
      wait.done();
    }
    renderReply(r, dataUrl);
  } catch (e) {
    bubble('them', esc(e.ask || FALLBACK_ERR), 'err');
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
  return serverSamples.find((x) => key(x.id) === key(s.id) || key(x.label) === key(s.label) || key(x.label).startsWith(key(s.label).slice(0, 4)));
}
function renderChips() {
  $('samples').innerHTML = '';
  for (const s of SAMPLES) {
    const srv = findSample(s);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `m-chip${srv?.dataUrl ? ' has-photo' : ''}`;
    b.innerHTML = `<i></i>${esc(s.label)}`;
    b.title = srv?.dataUrl ? 'Send this sample photo' : 'Fill in a sample question';
    b.addEventListener('click', async () => {
      const text = srv?.text || s.text;
      if (srv?.dataUrl) {
        if (busy) return;
        const blob = await (await fetch(srv.dataUrl)).blob();
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
