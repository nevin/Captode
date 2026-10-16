// Compare: two images (captures or files) in one view, to check a build against its
// design or a page before and after a change. B is drawn in A's space (scaled to A's
// width if asked, and moved by an offset), so every view lines the two up the same way.
import { getCapture, listCaptures } from '../lib/db.js';
import { enhance, toast } from '../lib/ui.js';
import { tagPng } from '../lib/srgb.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const sides = { a: null, b: null }; // { bitmap, title }
let mode = 'slider';
let W = 0, H = 0; // A's size: the view's size in image pixels
let diffRun = 0;
let diffDone = null; // the last difference: { changed, total, box }

// ---------- choosing images ----------

async function fill() {
  const items = (await listCaptures(30)).filter((it) => it.kind === 'image');
  const options = '<option value="">Choose a capture…</option>' + items.map((it) => {
    const t = (it.meta.title || 'Screenshot').replace(/</g, '&lt;');
    return `<option value="${it.id}">${t} · ${new Date(it.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</option>`;
  }).join('');
  for (const s of ['a', 'b']) $(`#sel-${s}`).innerHTML = options;
  return items;
}

/** A capture's image as it is now: with its crop or resize, if it has one. */
async function captureImage(id) {
  const rec = await getCapture(id);
  if (!rec) return null;
  const blob = rec.edits?.base || rec.blob;
  return { bitmap: await createImageBitmap(blob), title: rec.meta?.title || 'Screenshot' };
}

async function setSide(s, img) {
  sides[s] = img;
  await redraw();
}

for (const s of ['a', 'b']) {
  $(`#sel-${s}`).addEventListener('change', async (e) => {
    if (!e.target.value) return;
    await setSide(s, await captureImage(e.target.value));
  });
  $(`#file-${s}`).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      await setSide(s, { bitmap: await createImageBitmap(f), title: f.name });
      $(`#sel-${s}`).value = '';
    } catch {
      toast(`${f.name} couldn't be opened as an image`, { kind: 'error' });
    }
  });
}
$('#swap').addEventListener('click', async () => {
  [sides.a, sides.b] = [sides.b, sides.a];
  const [va, vb] = [$('#sel-a').value, $('#sel-b').value];
  $('#sel-a').value = vb;
  $('#sel-b').value = va;
  await redraw();
});

// ---------- drawing ----------

/** B's placement in A's space. */
function placeB() {
  const b = sides.b.bitmap;
  const s = $('#match').checked ? W / b.width : 1;
  return { x: Number($('#dx').value) || 0, y: Number($('#dy').value) || 0, w: b.width * s, h: b.height * s, s };
}

function viewScale() {
  const z = $('#zoom').value;
  if (z !== 'fit') return Number(z);
  const stage = $('#stage');
  const avail = stage.clientWidth - 48;
  return Math.min(1, (mode === 'side' ? (avail - 12) / 2 : avail) / W);
}

async function redraw() {
  const ready = sides.a && sides.b;
  $('#view').classList.toggle('hidden', !ready);
  $('#empty').classList.toggle('hidden', !!ready);
  $('#dl-diff').disabled = !ready;
  if (!ready) return;
  const a = sides.a.bitmap;
  W = a.width;
  H = a.height;
  const ca = $('#can-a');
  ca.width = W; ca.height = H;
  ca.getContext('2d').drawImage(a, 0, 0);
  const cb = $('#can-b');
  cb.width = W; cb.height = H;
  const bctx = cb.getContext('2d');
  bctx.clearRect(0, 0, W, H);
  const p = placeB();
  // A whole-number scale (a 1× design against a 2× capture) copies pixels exactly;
  // smoothing would blur every edge into a difference.
  const whole = Math.abs(p.s - Math.round(p.s)) < 1e-6 || Math.abs(1 / p.s - Math.round(1 / p.s)) < 1e-6;
  bctx.imageSmoothingEnabled = !whole;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(sides.b.bitmap, p.x, p.y, p.w, p.h);
  const b = sides.b.bitmap;
  $('#match-note').textContent = b.width === W ? 'Both are the same width' : `Scale B to A's width (×${(W / b.width).toFixed(2)})`;
  $('#info').textContent = `A: ${sides.a.title} (${W} × ${H}) · B: ${sides.b.title} (${b.width} × ${b.height})`;
  layoutView();
  if (mode === 'diff') await computeDiff();
}

function layoutView() {
  const view = $('#view');
  view.dataset.mode = mode;
  const s = viewScale();
  if (mode === 'side') {
    view.style.width = `${Math.round(W * s * 2 + 12)}px`;
    view.style.height = '';
    for (const c of ['#can-a', '#can-b']) { $(c).style.width = `${Math.round(W * s)}px`; $(c).style.height = `${Math.round(H * s)}px`; }
  } else {
    view.style.width = `${Math.round(W * s)}px`;
    view.style.height = `${Math.round(H * s)}px`;
    for (const c of ['#can-a', '#can-b']) { $(c).style.width = ''; $(c).style.height = ''; }
  }
  $('#can-d').classList.toggle('hidden', mode !== 'diff');
  for (const el of document.querySelectorAll('.mode-opt')) el.classList.toggle('hidden', el.dataset.for !== mode);
}

/**
 * Marks the pixels that differ by more than the tolerance in any channel: changed
 * pixels in pink over a faded A. Worked through in bands, so the page stays responsive.
 */
async function computeDiff() {
  const run = ++diffRun;
  const tol = Number($('#tol').value);
  const da = $('#can-a').getContext('2d', { willReadFrequently: true });
  const db = $('#can-b').getContext('2d', { willReadFrequently: true });
  const cd = $('#can-d');
  cd.width = W; cd.height = H;
  const dctx = cd.getContext('2d');
  $('#stats').textContent = 'Comparing…';
  let changed = 0;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  const band = Math.max(1, Math.floor(2e6 / W));
  for (let y = 0; y < H; y += band) {
    const h = Math.min(band, H - y);
    const pa = da.getImageData(0, y, W, h).data;
    const pb = db.getImageData(0, y, W, h).data;
    const out = dctx.createImageData(W, h);
    const o = out.data;
    for (let i = 0; i < pa.length; i += 4) {
      // Where B has no pixels (outside it), it counts as different.
      const d = pb[i + 3] === 0 ? 255 : Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
      if (d > tol) {
        o[i] = 255; o[i + 1] = 45; o[i + 2] = 135; o[i + 3] = 255;
        changed++;
        const p = i / 4, px = p % W, py = y + Math.floor(p / W);
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      } else {
        // A, faded towards white.
        const g = 0.299 * pa[i] + 0.587 * pa[i + 1] + 0.114 * pa[i + 2];
        o[i] = o[i + 1] = o[i + 2] = Math.round(255 - (255 - g) * 0.25);
        o[i + 3] = 255;
      }
    }
    dctx.putImageData(out, 0, y);
    await new Promise((r) => setTimeout(r));
    if (run !== diffRun) return;
  }
  const pct = (changed / (W * H)) * 100;
  diffDone = { changed, total: W * H, box: x1 >= 0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null };
  if (diffDone.box) {
    // Outline where the changes are.
    dctx.strokeStyle = 'rgba(255,45,135,.9)';
    dctx.lineWidth = Math.max(2, W / 600);
    dctx.setLineDash([dctx.lineWidth * 4, dctx.lineWidth * 3]);
    dctx.strokeRect(x0 - 4, y0 - 4, x1 - x0 + 9, y1 - y0 + 9);
  }
  $('#stats').innerHTML = changed
    ? `<b>${pct < 0.01 ? '<0.01' : pct.toFixed(2)}%</b> of pixels differ (${changed.toLocaleString()})<br>Changes within ${diffDone.box.w} × ${diffDone.box.h} px at ${x0}, ${y0}`
    : '<b>No differences</b> at this tolerance';
}

// ---------- controls ----------

$('#modes').addEventListener('click', async (e) => {
  const m = e.target.closest('[data-mode]')?.dataset.mode;
  if (!m) return;
  mode = m;
  for (const b of document.querySelectorAll('#modes button')) {
    b.classList.toggle('on', b.dataset.mode === m);
    b.setAttribute('aria-checked', String(b.dataset.mode === m));
  }
  layoutView();
  if (m === 'diff' && sides.a && sides.b) await computeDiff();
});
$('#opacity').addEventListener('input', (e) => {
  $('#view').style.setProperty('--opacity', e.target.value / 100);
  $('#opacity-v').textContent = `${e.target.value}%`;
});
$('#tol').addEventListener('input', (e) => {
  $('#tol-v').textContent = e.target.value;
  if (mode === 'diff') computeDiff();
});
$('#zoom').addEventListener('input', layoutView);
for (const id of ['match', 'dx', 'dy']) $('#' + id).addEventListener('input', () => redraw());
addEventListener('resize', () => { if (sides.a && sides.b) layoutView(); });

// The divider: drag it, or use the arrow keys when it has focus.
function setSplit(pct) {
  pct = Math.max(0, Math.min(100, pct));
  $('#view').style.setProperty('--split', `${pct}%`);
  $('#divider').setAttribute('aria-valuenow', String(Math.round(pct)));
}
$('#divider').addEventListener('pointerdown', (e) => {
  const div = $('#divider');
  div.setPointerCapture(e.pointerId);
  const move = (ev) => { const r = $('#view').getBoundingClientRect(); setSplit(((ev.clientX - r.left) / r.width) * 100); };
  const up = () => { div.removeEventListener('pointermove', move); div.removeEventListener('pointerup', up); };
  div.addEventListener('pointermove', move);
  div.addEventListener('pointerup', up);
});
$('#view').addEventListener('pointerdown', (e) => {
  // A click anywhere in slider mode moves the divider there.
  if (mode !== 'slider' || e.target.closest('#divider')) return;
  const r = $('#view').getBoundingClientRect();
  setSplit(((e.clientX - r.left) / r.width) * 100);
});
$('#divider').addEventListener('keydown', (e) => {
  const now = Number($('#divider').getAttribute('aria-valuenow'));
  const step = e.shiftKey ? 10 : 1;
  const next = { ArrowLeft: now - step, ArrowRight: now + step, Home: 0, End: 100 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  setSplit(next);
});
// Alt + arrows: nudge B.
document.addEventListener('keydown', (e) => {
  if (!e.altKey || !e.key.startsWith('Arrow') || !sides.b || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  e.preventDefault();
  const s = e.shiftKey ? 10 : 1;
  const [dx, dy] = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key];
  $('#dx').value = Number($('#dx').value) + dx;
  $('#dy').value = Number($('#dy').value) + dy;
  redraw();
});

$('#dl-diff').addEventListener('click', async () => {
  if (mode !== 'diff' || !diffDone) {
    mode = 'diff';
    $('#modes [data-mode="diff"]').click();
    await computeDiff();
  }
  const blob = await new Promise((r) => $('#can-d').toBlob(r, 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([tagPng(new Uint8Array(await blob.arrayBuffer()))], { type: 'image/png' }));
  a.download = `captode-difference-${Date.now()}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
});

// ---------- start ----------

(async () => {
  enhance();
  const items = await fill();
  // ?a= and ?b= pick captures; with only A, B is the most recent other capture.
  const a = params.get('a');
  let b = params.get('b');
  if (a && !b) b = items.find((it) => it.id !== a)?.id;
  if (a) { $('#sel-a').value = a; sides.a = await captureImage(a); }
  if (b) { $('#sel-b').value = b; sides.b = await captureImage(b); }
  await redraw();
})();

// For the automated tests.
globalThis.captodeCompare = { stats: () => diffDone, size: () => [W, H] };
