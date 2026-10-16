import { getCapture, listCaptures, deleteCapture } from '../lib/db.js';
import { encodeOffThread } from '../lib/encoder.js';
import { mountDevicePanel, renderInDevice } from '../lib/device.js';
import { getSettings, backgroundColour } from '../lib/settings.js';
import { toast, enhance, tablist, openDialog, fmtBytes, ago } from '../lib/ui.js';

const $ = (s) => document.querySelector(s);
const bg = $('#bg');
const fg = $('#fg');
const wrap = $('#wrap');
const stage = $('#stage');
const ta = $('#text-edit');
const bctx = bg.getContext('2d');
const fctx = fg.getContext('2d');
const mctx = new OffscreenCanvas(1, 1).getContext('2d'); // text measuring

const svg = (d) => `<svg class="i" viewBox="0 0 24 24">${d}</svg>`;
const TOOLS = [
  ['select', 'Select and move', 'v', svg('<path d="m5 3 14 8-6 2-2 6z"/>')],
  ['pan', 'Pan (or hold Space)', 'm', svg('<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>')],
  ['crop', 'Crop', 'c', svg('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>')],
  ['pen', 'Pen', 'p', svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>')],
  ['highlighter', 'Highlighter', 'h', svg('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>')],
  ['line', 'Line', 'l', svg('<path d="M5 19 19 5"/>')],
  ['arrow', 'Arrow', 'a', svg('<path d="M5 19 19 5"/><path d="M9 5h10v10"/>')],
  ['rect', 'Rectangle', 'r', svg('<rect x="3" y="5" width="18" height="14" rx="1"/>')],
  ['ellipse', 'Ellipse', 'e', svg('<ellipse cx="12" cy="12" rx="9" ry="7"/>')],
  ['text', 'Text', 't', svg('<path d="M4 7V4h16v3M9 20h6M12 4v16"/>')],
  ['step', 'Step number', 'n', svg('<circle cx="12" cy="12" r="9"/><path d="M10.5 9.5 12.5 8v8"/>')],
  ['redact', 'Blur or pixelate', 'b', svg('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="14" y="3" width="7" height="7" opacity=".4"/><rect x="3" y="14" width="7" height="7" opacity=".4"/>')],
];
const FONTS = [
  'system-ui', 'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Roboto',
  'Georgia', 'Times New Roman', 'Palatino', 'Garamond', 'Courier New', 'Menlo', 'Monaco',
  'Impact', 'Comic Sans MS', 'Brush Script MT', 'monospace', 'serif', 'cursive',
];
const SWATCHES = ['#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#0090ff', '#5b4bff', '#17171c', '#ffffff'];
const BACKDROPS = ['transparent', '#ffffff', '#ececf4', '#17171c', '#dbe4ff', '#ffe4e6', '#dcfce7', '#0f172a'];
const GROUPS = {
  pen: ['stroke'], highlighter: ['stroke'], line: ['stroke'], arrow: ['stroke'],
  rect: ['stroke', 'fill'], ellipse: ['stroke', 'fill'], text: ['text'], step: ['step'], redact: ['redact'], crop: ['crop'],
};
const NAMES = {
  pen: 'Pen', highlighter: 'Highlighter', line: 'Line', arrow: 'Arrow', rect: 'Rectangle',
  ellipse: 'Ellipse', text: 'Text', step: 'Step number', redact: 'Blur / pixelate', crop: 'Crop',
};

// ---------- state ----------

const defaults = {
  stroke: { color: '#e5484d', width: 4, opacity: 100 },
  hl: { color: '#ffd60a', width: 22, opacity: 40 },
  fill: { on: false, color: '#ffd60a' },
  text: { font: 'system-ui', size: 32, bold: true, italic: false, color: '#ffffff', bg: '#17171c' },
  redact: { mode: 'pixelate', strength: 12 },
  step: { color: '#e5484d', size: null }, // size null: scaled to the image
};
const frame = { padding: 0, bg: 'transparent', radius: 0, shadow: false }; // bg: a colour or 'transparent'

let base = null;     // OffscreenCanvas with the pixels being edited
let objects = [];    // annotations, in image coordinates
let selection = []; // selected annotations
let selected = null; // the selected annotation when exactly one is: it gets handles and the style panel
let tool = 'select';
let zoom = 1;
let crop = null;
let drag = null;
let editing = null;
let meta = {};
let device = null;
const history = [];
let dirty = false;   // edited since the last download or copy
let original = null; // the image as it was opened, for Undo all
let spacePan = false; // Space held down: pan with any tool
let panDrag = null;
let lastStep = null; // the step number placed last, which the next one follows
let stepStart = null; // a next step number the user typed in
let hIndex = -1;

// ---------- helpers ----------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const canvas = (w, h) => new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
const overlaps = (a, b) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
const norm = (o) => ({
  x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2),
  w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1),
});
const fullW = () => base.width + frame.padding * 2;
const fullH = () => base.height + frame.padding * 2;


function select(list) {
  selection = list.filter(Boolean);
  selected = selection.length === 1 ? selection[0] : null;
}
const isSelected = (o) => selection.includes(o);

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- history ----------

function snapshot() {
  const objs = objects.map(({ _editing, ...o }) => o);
  return { base, objects: structuredClone(objs), frame: { ...frame } };
}

// Undo keeps a reference to the image in each step, so crops and resizes each hold a
// full copy. Old steps go once those copies pass this budget (or 100 steps).
const HISTORY_BYTES = 768 * 2 ** 20;
const HISTORY_STEPS = 100;

function trimHistory() {
  while (history.length > 2) {
    const images = new Set(history.map((s) => s.base));
    if (original) images.add(original.base); // kept for Undo all anyway
    let bytes = 0;
    for (const im of images) bytes += im.width * im.height * 4;
    if (bytes <= HISTORY_BYTES && history.length <= HISTORY_STEPS) return;
    history.shift();
    hIndex--;
  }
}

function commit() {
  if (hIndex >= 0) dirty = true;
  history.splice(hIndex + 1);
  history.push(snapshot());
  hIndex = history.length - 1;
  trimHistory();
  updateButtons();
  refreshExport();
}
const commitSoon = debounce(commit, 400);

function restore(s) {
  base = s.base;
  objects = structuredClone(s.objects);
  Object.assign(frame, s.frame);
  select([]);
  crop = null;
  syncFrameUi();
  layout();
  syncStyleUi();
  updateButtons();
  refreshExport();
}

function undo() { if (hIndex > 0) restore(history[--hIndex]); }

/** Back to the image as it was opened. Itself undoable, so Undo brings the edits back. */
function undoAll() {
  if (!original || atOriginal()) return;
  if (editing) ta.blur();
  restore(original);
  commit();
  history[hIndex].reverted = true;
  updateButtons();
  toast('All changes undone', { action: { label: 'Undo', run: undo }, ms: 6000 });
}
const atOriginal = () => history[hIndex] === original || !!history[hIndex]?.reverted;
function redo() { if (hIndex < history.length - 1) restore(history[++hIndex]); }

function updateButtons() {
  $('#undo').disabled = hIndex <= 0;
  $('#redo').disabled = hIndex >= history.length - 1;
  $('#delete').disabled = !selection.length;
  $('#undo-all').disabled = !original || atOriginal();
}

// ---------- drawing ----------

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

const GENERIC = new Set(['system-ui', 'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy']);

function fontOf(o, size = o.size) {
  const family = GENERIC.has(o.font) ? o.font : JSON.stringify(o.font);
  return `${o.italic ? 'italic ' : ''}${o.bold ? '700' : '400'} ${size}px ${family}, system-ui, sans-serif`;
}

function textLayout(o) {
  mctx.font = fontOf(o);
  const lines = (o.text || ' ').split('\n');
  const lh = o.size * 1.25;
  const w = Math.max(o.size * 0.4, ...lines.map((l) => mctx.measureText(l).width));
  const pad = o.bg ? Math.round(o.size * 0.3) : 0;
  return { lines, lh, w, pad, bw: w + pad * 2, bh: lines.length * lh + pad * 2 };
}

function arrowHead(ctx, x1, y1, x2, y2, width) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const size = Math.max(10, width * 3.2);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(a - 0.45), y2 - size * Math.sin(a - 0.45));
  ctx.lineTo(x2 - size * Math.cos(a + 0.45), y2 - size * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
  return size;
}

const stepRing = (o) => Math.max(1.5, o.size * 0.06);

/** Relative luminance of a #rrggbb colour, 0 (black) to 1 (white). */
function luminance(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

// Blurred or pixelated areas, worked out once and reused until they move or change:
// recomputing them on every frame made dragging stutter on large captures.
const redactCache = new WeakMap();

function redactLayer(o, x, y, w, h) {
  const key = `${x},${y},${w},${h},${o.mode},${o.strength}`;
  const hit = redactCache.get(o);
  if (hit && hit.key === key && hit.base === base) return hit.layer;
  const layer = canvas(w, h);
  const lx = layer.getContext('2d');
  if (o.mode === 'blur') {
    lx.filter = `blur(${o.strength}px)`;
    const m = o.strength * 2;
    lx.drawImage(base, x - m, y - m, w + m * 2, h + m * 2, -m, -m, w + m * 2, h + m * 2);
  } else {
    const b = o.strength;
    const tiny = canvas(Math.ceil(w / b), Math.ceil(h / b));
    tiny.getContext('2d').drawImage(base, x, y, w, h, 0, 0, tiny.width, tiny.height);
    lx.imageSmoothingEnabled = false;
    lx.drawImage(tiny, 0, 0, tiny.width, tiny.height, 0, 0, w, h);
  }
  redactCache.set(o, { key, base, layer });
  return layer;
}

function drawObject(ctx, o) {
  ctx.save();
  ctx.globalAlpha = (o.opacity ?? 100) / 100;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  ctx.lineWidth = o.width;

  switch (o.type) {
    case 'pen':
    case 'highlighter': {
      const p = o.points;
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      if (p.length === 1) ctx.lineTo(p[0][0] + 0.01, p[0][1]);
      for (let i = 1; i < p.length - 1; i++) {
        const mx = (p[i][0] + p[i + 1][0]) / 2;
        const my = (p[i][1] + p[i + 1][1]) / 2;
        ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
      }
      if (p.length > 1) ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
      ctx.stroke();
      break;
    }
    case 'rect': {
      const r = norm(o);
      if (o.fill) { ctx.fillStyle = o.fill; ctx.fillRect(r.x, r.y, r.w, r.h); }
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'ellipse': {
      const r = norm(o);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
      ctx.stroke();
      break;
    }
    case 'line':
      ctx.beginPath();
      ctx.moveTo(o.x1, o.y1);
      ctx.lineTo(o.x2, o.y2);
      ctx.stroke();
      break;
    case 'arrow': {
      const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
      const size = arrowHead(ctx, o.x1, o.y1, o.x2, o.y2, o.width);
      const k = len ? Math.max(0, len - size * 0.7) / len : 0;
      ctx.beginPath();
      ctx.moveTo(o.x1, o.y1);
      ctx.lineTo(o.x1 + (o.x2 - o.x1) * k, o.y1 + (o.y2 - o.y1) * k);
      ctx.stroke();
      break;
    }
    case 'text': {
      if (o._editing) break;
      const L = textLayout(o);
      if (o.bg) {
        ctx.fillStyle = o.bg;
        roundRect(ctx, o.x, o.y, L.bw, L.bh, L.pad * 0.8);
        ctx.fill();
      }
      ctx.font = fontOf(o);
      ctx.fillStyle = o.color;
      ctx.textBaseline = 'middle';
      L.lines.forEach((line, i) => ctx.fillText(line, o.x + L.pad, o.y + L.pad + i * L.lh + L.lh / 2));
      break;
    }
    case 'step': {
      const r = o.size / 2;
      ctx.globalAlpha = 1;
      ctx.shadowColor = 'rgba(0,0,0,0.28)';
      ctx.shadowBlur = r * 0.35;
      ctx.shadowOffsetY = r * 0.1;
      ctx.beginPath();
      ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = stepRing(o);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      const label = String(o.n);
      const fs = r * (label.length >= 3 ? 0.78 : label.length === 2 ? 0.95 : 1.1);
      ctx.font = `700 ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = luminance(o.color) > 0.55 ? '#17171c' : '#ffffff';
      ctx.fillText(label, o.x, o.y + fs * 0.04);
      break;
    }
    case 'redact': {
      const r = norm(o);
      const x = clamp(Math.round(r.x), 0, base.width);
      const y = clamp(Math.round(r.y), 0, base.height);
      const w = clamp(Math.round(r.x + r.w), 0, base.width) - x;
      const h = clamp(Math.round(r.y + r.h), 0, base.height) - y;
      if (w < 1 || h < 1) break;
      ctx.globalAlpha = 1;
      if (o.mode === 'solid') {
        ctx.fillStyle = '#111';
        ctx.fillRect(x, y, w, h);
      } else {
        ctx.imageSmoothingEnabled = o.mode === 'blur';
        ctx.drawImage(redactLayer(o, x, y, w, h), x, y);
      }
      break;
    }
  }
  ctx.restore();
}

function paintImage(ctx, vis = null) {
  const p = frame.padding;
  const W = fullW(), H = fullH();
  const r = frame.radius;
  ctx.clearRect(0, 0, W, H);
  if (p > 0) {
    if (frame.bg !== 'transparent') {
      ctx.fillStyle = frame.bg;
      ctx.fillRect(0, 0, W, H);
    }
    if (frame.shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = Math.min(p, 48);
      ctx.shadowOffsetY = Math.min(p / 3, 16);
      ctx.fillStyle = '#000';
      roundRect(ctx, p, p, base.width, base.height, r);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.save();
  if (r > 0) { roundRect(ctx, p, p, base.width, base.height, r); ctx.clip(); }
  if (vis) {
    // Only the part of the image in view: a long capture can be tens of thousands of
    // pixels tall.
    const sx = clamp(Math.floor(vis.x - p), 0, base.width), sy = clamp(Math.floor(vis.y - p), 0, base.height);
    const sw = clamp(Math.ceil(vis.x + vis.w - p), 0, base.width) - sx;
    const sh = clamp(Math.ceil(vis.y + vis.h - p), 0, base.height) - sy;
    if (sw > 0 && sh > 0) ctx.drawImage(base, sx, sy, sw, sh, sx + p, sy + p, sw, sh);
  } else {
    ctx.drawImage(base, p, p);
  }
  ctx.restore();
}

/** Draws the annotations; with `vis` (in image-with-padding coordinates), only those in view. */
function paintObjects(ctx, vis = null) {
  ctx.save();
  ctx.translate(frame.padding, frame.padding);
  for (const o of objects) {
    if (vis) {
      const b = bounds(o);
      const m = (o.width || 0) * 4 + 8; // arrow heads and shadows reach past the bounds
      const vx = vis.x - frame.padding, vy = vis.y - frame.padding;
      if (b.x - m > vx + vis.w || b.x + b.w + m < vx || b.y - m > vy + vis.h || b.y + b.h + m < vy) continue;
    }
    drawObject(ctx, o);
  }
  ctx.restore();
}

// ---------- the view ----------
// The editor draws only what is on screen: two canvases the size of the visible part
// of the image sit inside #wrap, which has the full zoomed size so the stage scrolls
// as if the whole image were there.

let view = { x: 0, y: 0, w: 0, h: 0, dpr: 1 }; // the visible part of #wrap, in CSS px
let rafId = 0;
let bgDirty = false;

function updateView() {
  const W = fullW() * zoom, H = fullH() * zoom;
  const sr = stage.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  const x0 = Math.floor(clamp(sr.left - wr.left, 0, W)), y0 = Math.floor(clamp(sr.top - wr.top, 0, H));
  const x1 = Math.ceil(clamp(sr.right - wr.left, 0, W)), y1 = Math.ceil(clamp(sr.bottom - wr.top, 0, H));
  const dpr = devicePixelRatio || 1;
  view = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0), dpr };
  const cw = Math.max(1, Math.round(view.w * dpr)), ch = Math.max(1, Math.round(view.h * dpr));
  for (const c of [bg, fg]) {
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    c.style.left = view.x + 'px';
    c.style.top = view.y + 'px';
    c.style.width = view.w + 'px';
    c.style.height = view.h + 'px';
  }
}

/** The visible area, in image-with-padding coordinates. */
const visible = () => ({ x: view.x / zoom, y: view.y / zoom, w: view.w / zoom, h: view.h / zoom });

/** Sets ctx up to draw in image-with-padding coordinates at the current zoom and scroll. */
function viewTransform(ctx) {
  const k = zoom * view.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(k, 0, 0, k, -view.x * view.dpr, -view.y * view.dpr);
  ctx.imageSmoothingEnabled = zoom < 2; // show pixels crisply when zoomed in
}

function renderBg() {
  if (!base) return;
  viewTransform(bctx);
  paintImage(bctx, visible());
}

/** Redraws on the next frame: many pointer events can arrive per frame. */
function requestRender(withImage = false) {
  bgDirty ||= withImage;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (!base) return;
    updateView();
    if (bgDirty) renderBg();
    bgDirty = false;
    renderFg();
  });
}

function renderFg() {
  if (!base) return;
  viewTransform(fctx);
  paintObjects(fctx, visible());
  fctx.save();
  fctx.translate(frame.padding, frame.padding);
  const px = 1 / zoom;

  fctx.strokeStyle = '#5b4bff';
  for (const o of selection) {
    if (o._editing) continue;
    const b = bounds(o);
    fctx.setLineDash([5 * px, 4 * px]);
    fctx.lineWidth = px;
    fctx.strokeRect(b.x - 4 * px, b.y - 4 * px, b.w + 8 * px, b.h + 8 * px);
    fctx.setLineDash([]);
  }
  if (drag?.kind === 'marquee') {
    const m = rectOf(drag.start, drag.end);
    fctx.fillStyle = 'rgba(91,75,255,0.08)';
    fctx.fillRect(m.x, m.y, m.w, m.h);
    fctx.lineWidth = px;
    fctx.strokeRect(m.x, m.y, m.w, m.h);
  }
  if (selected && !selected._editing) {
    for (const h of handles(selected)) {
      fctx.beginPath();
      if (h.id === 'p1' || h.id === 'p2') fctx.arc(h.x, h.y, 6 * px, 0, Math.PI * 2);
      else fctx.rect(h.x - 5 * px, h.y - 5 * px, 10 * px, 10 * px);
      fctx.fillStyle = '#fff';
      fctx.fill();
      fctx.lineWidth = 1.5 * px;
      fctx.stroke();
    }
  }

  if (tool === 'crop' && crop && crop.w > 0 && crop.h > 0) {
    fctx.fillStyle = 'rgba(10,10,20,0.55)';
    fctx.beginPath();
    fctx.rect(0, 0, base.width, base.height);
    fctx.rect(crop.x, crop.y, crop.w, crop.h);
    fctx.fill('evenodd');
    fctx.strokeStyle = '#fff';
    fctx.lineWidth = 2 * px;
    fctx.strokeRect(crop.x, crop.y, crop.w, crop.h);
    fctx.strokeStyle = 'rgba(255,255,255,0.5)';
    fctx.lineWidth = px;
    for (let i = 1; i < 3; i++) {
      fctx.beginPath();
      fctx.moveTo(crop.x + (crop.w * i) / 3, crop.y);
      fctx.lineTo(crop.x + (crop.w * i) / 3, crop.y + crop.h);
      fctx.moveTo(crop.x, crop.y + (crop.h * i) / 3);
      fctx.lineTo(crop.x + crop.w, crop.y + (crop.h * i) / 3);
      fctx.stroke();
    }
  }
  fctx.restore();
  updateButtons();
}

function layout() {
  if (!base) return;
  applyZoom();
  $('#rs-w').value = base.width;
  $('#rs-h').value = base.height;
  $('#doc-dims').textContent = `${base.width} × ${base.height} px`;
}

function applyZoom() {
  if (!base) return;
  wrap.style.width = fullW() * zoom + 'px';
  wrap.style.height = fullH() * zoom + 'px';
  $('#zoom-label').textContent = Math.round(zoom * 100) + '%';
  if (editing) placeTextEditor();
  updateView();
  renderBg();
  renderFg();
}
stage.addEventListener('scroll', () => requestRender(true), { passive: true });
new ResizeObserver(() => requestRender(true)).observe(stage);

function setZoom(z) {
  zoom = clamp(z, 0.05, 8);
  applyZoom();
}

function fitZoom() {
  if (!base) return;
  const W = fullW(), H = fullH();
  const sw = stage.clientWidth - 48;
  const sh = stage.clientHeight - 48;
  let z = Math.min(1, sw / W);
  if (H < W * 2.5) z = Math.min(z, sh / H);
  setZoom(z);
}

// ---------- geometry ----------

function bounds(o) {
  if (o.type === 'pen' || o.type === 'highlighter') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of o.points) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const h = o.width / 2;
    return { x: x0 - h, y: y0 - h, w: x1 - x0 + o.width, h: y1 - y0 + o.width };
  }
  if (o.type === 'text') {
    const L = textLayout(o);
    return { x: o.x, y: o.y, w: L.bw, h: L.bh };
  }
  if (o.type === 'step') {
    const r = o.size / 2 + stepRing(o) / 2;
    return { x: o.x - r, y: o.y - r, w: r * 2, h: r * 2 };
  }
  const r = norm(o);
  const h = (o.width || 0) / 2;
  return { x: r.x - h, y: r.y - h, w: r.w + h * 2, h: r.h + h * 2 };
}

// Handles for resizing: the two ends of a line or arrow; corners and edge midpoints of
// boxes; corners only for things that keep their proportions (text, steps).
const UNIFORM = new Set(['text', 'step']);
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', p1: 'move', p2: 'move' };

/** The box a shape is resized by (without stroke width). */
function shapeBox(o) {
  if (o.points) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of o.points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  if (o.type === 'text' || o.type === 'step') return bounds(o);
  return norm(o);
}

function handles(o) {
  if (o.type === 'line' || o.type === 'arrow') return [{ id: 'p1', x: o.x1, y: o.y1 }, { id: 'p2', x: o.x2, y: o.y2 }];
  const b = shapeBox(o);
  const xs = { w: b.x, c: b.x + b.w / 2, e: b.x + b.w }, ys = { n: b.y, c: b.y + b.h / 2, s: b.y + b.h };
  const all = [['nw', 'w', 'n'], ['ne', 'e', 'n'], ['se', 'e', 's'], ['sw', 'w', 's'], ['n', 'c', 'n'], ['e', 'e', 'c'], ['s', 'c', 's'], ['w', 'w', 'c']];
  const list = UNIFORM.has(o.type) || (o.points && (b.w < 4 || b.h < 4)) ? all.slice(0, 4) : all;
  return list.map(([id, hx, hy]) => ({ id, x: xs[hx], y: ys[hy] }));
}

const handleAt = (o, pt) => handles(o).find((h) => Math.hypot(h.x - pt.x, h.y - pt.y) <= 9 / zoom) || null;

/** The box after dragging handle `id` of box `b` to `pt`. */
function resizedBox(b, id, pt, keepRatio) {
  let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
  if (id.includes('w')) x0 = pt.x;
  if (id.includes('e')) x1 = pt.x;
  if (id.includes('n')) y0 = pt.y;
  if (id.includes('s')) y1 = pt.y;
  if (keepRatio && id.length === 2 && b.w > 0 && b.h > 0) {
    // Scale about the opposite corner by whichever direction moved further.
    const s = Math.max(Math.abs(x1 - x0) / b.w, Math.abs(y1 - y0) / b.h, 0.05);
    const ax = id.includes('w') ? b.x + b.w : b.x, ay = id.includes('n') ? b.y + b.h : b.y;
    const w = b.w * s, h = b.h * s;
    x0 = id.includes('w') ? ax - w : ax; x1 = x0 + w;
    y0 = id.includes('n') ? ay - h : ay; y1 = y0 + h;
  }
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** Fits `o` to box `nb`, starting from `from` (the shape when the drag began) with box `ob`. */
function applyBox(o, from, ob, nb) {
  const sx = ob.w ? nb.w / ob.w : 1, sy = ob.h ? nb.h / ob.h : 1;
  if (o.points) {
    o.points = from.points.map(([x, y]) => [nb.x + (x - ob.x) * sx, nb.y + (y - ob.y) * sy]);
  } else if (o.type === 'text') {
    o.size = clamp(Math.round(from.size * sy), 6, 400);
    o.x = nb.x; o.y = nb.y;
  } else if (o.type === 'step') {
    o.size = clamp(Math.round(from.size * sx), 12, 400);
    o.x = nb.x + nb.w / 2; o.y = nb.y + nb.h / 2;
  } else {
    Object.assign(o, { x1: nb.x, y1: nb.y, x2: nb.x + nb.w, y2: nb.y + nb.h });
  }
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((px - x1) * dx + (py - y1) * dy) / len, 0, 1) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hits(o, pt) {
  const tol = 6 / zoom;
  if (o.type === 'line' || o.type === 'arrow') {
    return segDist(pt.x, pt.y, o.x1, o.y1, o.x2, o.y2) <= o.width / 2 + tol;
  }
  if (o.type === 'pen' || o.type === 'highlighter') {
    const p = o.points;
    if (p.length === 1) return Math.hypot(pt.x - p[0][0], pt.y - p[0][1]) <= o.width / 2 + tol;
    for (let i = 1; i < p.length; i++) {
      if (segDist(pt.x, pt.y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= o.width / 2 + tol) return true;
    }
    return false;
  }
  const b = bounds(o);
  return pt.x >= b.x - tol && pt.x <= b.x + b.w + tol && pt.y >= b.y - tol && pt.y <= b.y + b.h + tol;
}

const topHit = (pt) => [...objects].reverse().find((o) => hits(o, pt)) || null;

function moveObj(o, dx, dy) {
  if (o.points) o.points = o.points.map(([x, y]) => [x + dx, y + dy]);
  else if (o.type === 'text' || o.type === 'step') { o.x += dx; o.y += dy; }
  else { o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; }
}

function scaleObj(o, sx, sy) {
  const s = (sx + sy) / 2;
  if (o.points) o.points = o.points.map(([x, y]) => [x * sx, y * sy]);
  else if (o.type === 'text') { o.x *= sx; o.y *= sy; o.size = Math.max(4, Math.round(o.size * sy)); }
  else if (o.type === 'step') { o.x *= sx; o.y *= sy; o.size = Math.max(8, Math.round(o.size * s)); }
  else { o.x1 *= sx; o.y1 *= sy; o.x2 *= sx; o.y2 *= sy; }
  if (o.width) o.width = Math.max(1, o.width * s);
}

function toImage(e) {
  const r = wrap.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / zoom - frame.padding,
    y: (e.clientY - r.top) / zoom - frame.padding,
  };
}

function snapEnd(o, pt, shift) {
  if (!shift) return pt;
  const dx = pt.x - o.x1, dy = pt.y - o.y1;
  if (o.type === 'line' || o.type === 'arrow') {
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return { x: o.x1 + Math.cos(a) * len, y: o.y1 + Math.sin(a) * len };
  }
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: o.x1 + Math.sign(dx || 1) * m, y: o.y1 + Math.sign(dy || 1) * m };
}

// ---------- creating objects ----------

function propsFor(type) {
  if (type === 'highlighter') return { ...defaults.hl };
  if (type === 'text') return { ...defaults.text };
  if (type === 'redact') return { ...defaults.redact };
  if (type === 'step') return { color: defaults.step.color, size: defaults.step.size || autoStepSize() };
  const p = { ...defaults.stroke };
  if (type === 'rect' || type === 'ellipse') p.fill = defaults.fill.on ? defaults.fill.color : null;
  return p;
}

/** A step size that reads well on this image: about 4% of its shorter side. */
const autoStepSize = () => (base ? Math.round(clamp(Math.min(base.width, base.height) * 0.04, 28, 96)) : 40);

/** The number the next step gets: one more than the last placed, or than the highest. */
function nextStep() {
  if (stepStart !== null) return stepStart;
  if (lastStep && objects.includes(lastStep)) return lastStep.n + 1;
  return Math.max(0, ...objects.filter((o) => o.type === 'step').map((o) => o.n)) + 1;
}

function newShape(type, pt) {
  const o = { type, ...propsFor(type) };
  if (type === 'pen' || type === 'highlighter') o.points = [[pt.x, pt.y]];
  else Object.assign(o, { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
  return o;
}

// ---------- text editing ----------

function placeTextEditor() {
  const o = editing;
  const L = textLayout({ ...o, text: ta.value });
  const p = frame.padding;
  Object.assign(ta.style, {
    left: (o.x + p + L.pad) * zoom + 'px',
    top: (o.y + p + L.pad) * zoom + 'px',
    width: (L.w + o.size) * zoom + 'px',
    height: L.lines.length * L.lh * zoom + 'px',
    font: fontOf(o, o.size * zoom),
    lineHeight: L.lh * zoom + 'px',
    color: o.color,
    background: o.bg || 'transparent',
    boxShadow: o.bg ? `0 0 0 ${L.pad * zoom}px ${o.bg}` : 'none',
    borderRadius: L.pad * 0.8 * zoom + 'px',
  });
}

function editText(o) {
  editing = o;
  o._editing = true;
  ta.value = o.text || '';
  ta.classList.remove('hidden');
  placeTextEditor();
  renderFg();
  setTimeout(() => { ta.focus(); ta.select(); });
}

function finishText() {
  if (!editing) return;
  const o = editing;
  editing = null;
  o.text = ta.value.replace(/\s+$/, '');
  delete o._editing;
  ta.classList.add('hidden');
  if (!o.text) {
    objects = objects.filter((x) => x !== o);
    select(selection.filter((x) => x !== o));
  }
  renderFg();
  commit();
}

ta.addEventListener('input', placeTextEditor);
ta.addEventListener('blur', finishText);
ta.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    ta.blur();
  }
});

// ---------- pointer ----------

fg.addEventListener('pointerdown', (e) => {
  if (!base || e.button !== 0 || tool === 'pan' || spacePan) return; // panning: the stage handles it
  if (editing) { ta.blur(); return; }
  fg.setPointerCapture(e.pointerId);
  const pt = toImage(e);

  if (tool === 'select') {
    if (selected) {
      const h = handleAt(selected, pt);
      if (h) {
        const { _editing, ...from } = selected;
        drag = { kind: 'handle', h: h.id, from: structuredClone(from), box: shapeBox(selected) };
        return;
      }
    }
    const hit = topHit(pt);
    if (e.shiftKey) {
      // Shift-click adds to or removes from the selection; Shift-drag adds a box's worth.
      if (hit) select(isSelected(hit) ? selection.filter((x) => x !== hit) : [...selection, hit]);
      else drag = { kind: 'marquee', start: pt, end: pt, add: [...selection] };
    } else if (hit) {
      if (!isSelected(hit)) select([hit]);
      drag = { kind: 'move', last: pt, moved: false };
    } else {
      select([]);
      drag = { kind: 'marquee', start: pt, end: pt, add: [] };
    }
    if (selection.length) showPane('annotate');
    syncStyleUi();
    renderFg();
    return;
  }

  if (tool === 'crop') {
    if (crop && pt.x > crop.x && pt.x < crop.x + crop.w && pt.y > crop.y && pt.y < crop.y + crop.h) {
      drag = { kind: 'crop-move', last: pt };
    } else {
      crop = { x: pt.x, y: pt.y, w: 0, h: 0 };
      drag = { kind: 'crop', start: pt };
    }
    return;
  }

  if (tool === 'text') {
    const hit = topHit(pt);
    if (hit && hit.type === 'text') {
      select([hit]);
    } else {
      select([{ type: 'text', ...propsFor('text'), text: '', x: pt.x, y: pt.y - defaults.text.size * 0.6 }]);
      objects.push(selected);
    }
    syncStyleUi();
    editText(selected);
    return;
  }

  if (tool === 'step') {
    const hit = topHit(pt);
    if (hit?.type === 'step') {
      select([hit]);
      drag = { kind: 'move', last: pt, moved: false };
    } else {
      select([{ type: 'step', ...propsFor('step'), n: nextStep(), x: pt.x, y: pt.y }]);
      objects.push(selected);
      lastStep = selected;
      stepStart = null;
      drag = { kind: 'move', last: pt, moved: true }; // drag to place it exactly
    }
    syncStyleUi();
    renderFg();
    return;
  }

  const o = newShape(tool, pt);
  objects.push(o);
  select([o]);
  drag = { kind: 'draw', o };
  renderFg();
});

fg.addEventListener('pointermove', (e) => {
  if (!drag) {
    // Hovering: resize cursors over handles, a move cursor over the selection.
    let cursor = '';
    if (tool === 'select' && selected && base && !spacePan) {
      const p = toImage(e);
      const h = handleAt(selected, p);
      cursor = h ? CURSORS[h.id] : hits(selected, p) ? 'move' : '';
    }
    if (fg.style.cursor !== cursor) fg.style.cursor = cursor;
    return;
  }
  const pt = toImage(e);
  if (drag.kind === 'handle') {
    const o = selected;
    if (drag.h === 'p1') { o.x1 = pt.x; o.y1 = pt.y; }
    else if (drag.h === 'p2') { const q = snapEnd(o, pt, e.shiftKey); o.x2 = q.x; o.y2 = q.y; }
    else applyBox(o, drag.from, drag.box, resizedBox(drag.box, drag.h, pt, UNIFORM.has(o.type) || e.shiftKey));
  } else if (drag.kind === 'marquee') {
    drag.end = pt;
    const m = rectOf(drag.start, pt);
    const inBox = m.w > 2 || m.h > 2 ? objects.filter((o) => overlaps(bounds(o), m)) : [];
    select([...new Set([...drag.add, ...inBox])]);
    syncStyleUi();
  } else if (drag.kind === 'move') {
    for (const o of selection) moveObj(o, pt.x - drag.last.x, pt.y - drag.last.y);
    drag.last = pt;
    drag.moved = true;
  } else if (drag.kind === 'crop') {
    const s = drag.start;
    let w = pt.x - s.x;
    let h = pt.y - s.y;
    const ratio = Number($('#c-ratio').value);
    if (ratio) h = (Math.sign(h) || 1) * Math.abs(w) / ratio;
    const x0 = clamp(Math.min(s.x, s.x + w), 0, base.width);
    const y0 = clamp(Math.min(s.y, s.y + h), 0, base.height);
    const x1 = clamp(Math.max(s.x, s.x + w), 0, base.width);
    const y1 = clamp(Math.max(s.y, s.y + h), 0, base.height);
    crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    updateCropUi();
  } else if (drag.kind === 'crop-move') {
    crop.x = clamp(crop.x + pt.x - drag.last.x, 0, base.width - crop.w);
    crop.y = clamp(crop.y + pt.y - drag.last.y, 0, base.height - crop.h);
    drag.last = pt;
  } else if (drag.kind === 'draw') {
    const o = drag.o;
    if (o.points) {
      // Every position the pointer passed through, not just one per event, for smooth lines.
      for (const ce of e.getCoalescedEvents?.() || [e]) {
        const q = toImage(ce);
        const [lx, ly] = o.points[o.points.length - 1];
        if (Math.hypot(q.x - lx, q.y - ly) > 1.5 / zoom) o.points.push([q.x, q.y]);
      }
    } else {
      const q = snapEnd(o, pt, e.shiftKey);
      o.x2 = q.x;
      o.y2 = q.y;
    }
  }
  requestRender();
});

function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === 'draw') {
    const o = d.o;
    const tiny = !o.points && Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 3;
    if (tiny) {
      objects = objects.filter((x) => x !== o);
      select([]);
    } else commit();
    syncStyleUi();
  } else if (d.kind === 'handle' || (d.kind === 'move' && d.moved)) {
    commit();
  } else if (d.kind === 'crop' || d.kind === 'crop-move') {
    if (crop && (crop.w < 2 || crop.h < 2)) crop = null;
    updateCropUi();
  }
  renderFg();
}
fg.addEventListener('pointerup', endDrag);
fg.addEventListener('pointercancel', endDrag);

fg.addEventListener('dblclick', (e) => {
  const hit = topHit(toImage(e));
  if (hit?.type === 'text') { select([hit]); syncStyleUi(); editText(hit); }
});

// ---------- panning ----------
// With the Pan tool, while Space is held, or with the middle mouse button: drag to
// scroll around a zoomed-in or long image.

stage.addEventListener('pointerdown', (e) => {
  if (!base || !((e.button === 0 && (tool === 'pan' || spacePan)) || e.button === 1)) return;
  if (e.target.closest('.toolbar, .zoombar, .export-preview, .empty, textarea')) return;
  e.preventDefault();
  stage.setPointerCapture(e.pointerId);
  panDrag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
  stage.classList.add('panning');
});
stage.addEventListener('pointermove', (e) => {
  if (!panDrag) return;
  stage.scrollLeft = panDrag.left - (e.clientX - panDrag.x);
  stage.scrollTop = panDrag.top - (e.clientY - panDrag.y);
});
for (const ev of ['pointerup', 'pointercancel']) {
  stage.addEventListener(ev, () => { panDrag = null; stage.classList.remove('panning'); });
}
function setSpacePan(on) {
  spacePan = on;
  stage.toggleAttribute('data-pan', on);
}
document.addEventListener('keyup', (e) => { if (e.key === ' ') setSpacePan(false); });
addEventListener('blur', () => setSpacePan(false));

stage.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

// ---------- inspector tabs ----------

const selectTab = tablist(document.querySelector('.tabs'), (t) => showPane(t.dataset.pane));

function showPane(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.pane === name);
  for (const p of document.querySelectorAll('.pane')) p.classList.toggle('hidden', p.dataset.pane !== name);
  selectTab(document.querySelector(`.tabs [data-pane="${name}"]`));
  document.body.dataset.pane = name;
  if (name === 'export') refreshExport();
  else updateDevicePreview();
}
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-pane]');
  if (b) showPane(b.dataset.pane);
});

// ---------- tools ----------

function setTool(t) {
  if (editing) ta.blur();
  tool = t;
  if (t !== 'crop') crop = null;
  if (t !== 'select' && selection.length && GROUPS[t] && selection.some((o) => o.type !== t)) select([]);
  stage.dataset.tool = t;
  if (t !== 'select') showPane('annotate');
  for (const b of document.querySelectorAll('#tools .btn')) b.classList.toggle('active', b.dataset.tool === t);
  syncStyleUi();
  updateCropUi();
  renderFg();
}

const TOOL_GROUPS = [['select', 'pan', 'crop'], ['pen', 'highlighter'], ['arrow', 'line', 'rect', 'ellipse'], ['text', 'step', 'redact']];
$('#tools').innerHTML = TOOL_GROUPS.map((g) => g.map((id) => {
  const [, title, key, icon] = TOOLS.find((t) => t[0] === id);
  return `<button class="btn ghost icon" data-tool="${id}" data-tip="${title}  ${key.toUpperCase()}" aria-label="${title}">${icon}</button>`;
}).join('')).join('<span class="tool-sep"></span>');
$('#tools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (b) setTool(b.dataset.tool);
});

function deleteSelected() {
  if (!selection.length) return;
  objects = objects.filter((o) => !isSelected(o));
  select([]);
  syncStyleUi();
  renderFg();
  commit();
}

const cloneObj = ({ _editing, ...o }) => structuredClone(o);

/** Adds copies of `list`, offset so they don't hide the originals, and selects them. */
function addCopies(list, offset) {
  const copies = list.map(cloneObj);
  for (const o of copies) moveObj(o, offset, offset);
  objects.push(...copies);
  select(copies);
  syncStyleUi();
  renderFg();
  commit();
}
const duplicateSelected = () => selection.length && addCopies(objects.filter(isSelected), 16 / Math.max(zoom, 0.25));

// Copied annotations go on the system clipboard as text, so they paste into this or
// another editor tab, and an image copied since then isn't mistaken for them.
const CLIP_TAG = 'captode-annotations';
let pasteCount = 0;
async function copySelected() {
  const items = objects.filter(isSelected).map(cloneObj);
  if (!items.length) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify({ [CLIP_TAG]: 1, items }));
    pasteCount = 0;
    toast(`Copied ${items.length === 1 ? 'the annotation' : `${items.length} annotations`}`, { kind: 'success', ms: 1600 });
  } catch (e) {
    toast('Could not copy: ' + e.message, { kind: 'error' });
  }
}
function pasteAnnotations(text) {
  try {
    const data = JSON.parse(text);
    if (!data?.[CLIP_TAG] || !Array.isArray(data.items)) return false;
    pasteCount++;
    addCopies(data.items, (16 * pasteCount) / Math.max(zoom, 0.25));
    return true;
  } catch { return false; }
}

/** Moves the selection to the front (top of the stack) or the back. */
function arrange(toFront) {
  if (!selection.length) return;
  const picked = objects.filter(isSelected), rest = objects.filter((o) => !isSelected(o));
  objects = toFront ? [...rest, ...picked] : [...picked, ...rest];
  renderFg();
  commit();
}

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); download(); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); copyImage(); return; }
  if (typing) return;
  if (e.key === ' ') { e.preventDefault(); if (!e.repeat && base) setSpacePan(true); return; }
  if (mod && e.key.toLowerCase() === 'a' && base) { e.preventDefault(); setTool('select'); select([...objects]); syncStyleUi(); renderFg(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'c' && selection.length) { e.preventDefault(); copySelected(); return; }
  if (mod && (e.key === ']' || e.key === '[')) { e.preventDefault(); arrange(e.key === ']'); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length) { e.preventDefault(); deleteSelected(); return; }
  if (e.key === 'Escape') { select([]); crop = null; updateCropUi(); syncStyleUi(); renderFg(); return; }
  if (e.key === 'Enter' && tool === 'crop' && crop) { applyCrop(); return; }
  if (selection.length && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const s = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key];
    for (const o of selection) moveObj(o, ...d);
    renderFg();
    commitSoon();
    return;
  }
  if (mod) return;
  const t = TOOLS.find(([, , key]) => key === e.key.toLowerCase());
  if (t) setTool(t[0]);
  if (e.key === '+' || e.key === '=') setZoom(zoom * 1.25);
  if (e.key === '-') setZoom(zoom / 1.25);
  if (e.key === '0') fitZoom();
});

// ---------- style panel ----------

for (const box of document.querySelectorAll('.swatches')) {
  const input = $('#' + box.dataset.for);
  const colours = box.dataset.set === 'backdrop' ? BACKDROPS : SWATCHES;
  box.innerHTML = colours.map((c) => `<button style="background:${c}" data-c="${c}" title="${c}"></button>`).join('');
  box.addEventListener('click', (e) => {
    const c = e.target.dataset.c;
    if (!c) return;
    if (c === 'transparent') { setBackdrop('transparent'); return; }
    input.value = c;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
$('#t-font').innerHTML = FONTS.map((f) => `<option style="font-family:${JSON.stringify(f).replaceAll('"', "'")}">${f}</option>`).join('');

/** The kind of annotation the style panel is for: the selection's, if all one kind, or the tool's. */
function currentType() {
  if (selection.length) return selection.every((o) => o.type === selection[0].type) ? selection[0].type : 'mixed';
  return GROUPS[tool] ? tool : null;
}

function syncStyleUi() {
  const type = currentType();
  const groups = GROUPS[type] || [];
  for (const g of document.querySelectorAll('[data-group]')) g.classList.toggle('hidden', !groups.includes(g.dataset.group));
  $('#style-hint').classList.toggle('hidden', !!type);
  $('#arrange').classList.toggle('hidden', !selection.length);
  const n = selection.length;
  $('#style-title').textContent = !type ? 'Annotate'
    : type === 'mixed' ? `${n} items selected`
    : n > 1 ? `${n} × ${NAMES[type].toLowerCase()}`
    : n ? `Selected ${NAMES[type].toLowerCase()}` : NAMES[type];
  if (!type || type === 'crop' || type === 'mixed') return;
  const p = selection[0] || propsFor(type);
  if (groups.includes('stroke')) {
    $('#s-color').value = p.color;
    $('#s-width').value = p.width;
    $('#s-opacity').value = p.opacity;
    $('#s-width-v').textContent = Math.round(p.width) + ' px';
    $('#s-opacity-v').textContent = p.opacity + '%';
  }
  if (groups.includes('fill')) {
    $('#s-fill-on').checked = !!p.fill;
    $('#s-fill').value = p.fill || defaults.fill.color;
  }
  if (type === 'text') {
    if (![...$('#t-font').options].some((o) => o.value === p.font)) $('#t-font').add(new Option(p.font));
    $('#t-font').value = p.font;
    $('#t-size').value = p.size;
    $('#t-bold').classList.toggle('on', p.bold);
    $('#t-italic').classList.toggle('on', p.italic);
    $('#t-color').value = p.color;
    $('#t-bg-on').checked = !!p.bg;
    $('#t-bg').value = p.bg || defaults.text.bg;
  }
  if (type === 'redact') {
    $('#r-mode').value = p.mode;
    $('#r-strength').value = p.strength;
  }
  if (type === 'step') {
    $('#st-color').value = p.color;
    $('#st-size').value = p.size;
    $('#st-size-v').textContent = Math.round(p.size) + ' px';
    $('#st-n-label').textContent = selected ? 'Number' : 'Next number';
    if (document.activeElement !== $('#st-n')) $('#st-n').value = selected ? p.n : nextStep();
  }
}

function readStyleUi(type) {
  const groups = GROUPS[type] || [];
  const p = {};
  if (groups.includes('stroke')) {
    Object.assign(p, { color: $('#s-color').value, width: Number($('#s-width').value), opacity: Number($('#s-opacity').value) });
  }
  if (groups.includes('fill')) p.fill = $('#s-fill-on').checked ? $('#s-fill').value : null;
  if (type === 'text') {
    Object.assign(p, {
      font: $('#t-font').value,
      size: clamp(Number($('#t-size').value) || 32, 6, 400),
      bold: $('#t-bold').classList.contains('on'),
      italic: $('#t-italic').classList.contains('on'),
      color: $('#t-color').value,
      bg: $('#t-bg-on').checked ? $('#t-bg').value : null,
    });
  }
  if (type === 'redact') Object.assign(p, { mode: $('#r-mode').value, strength: Number($('#r-strength').value) });
  if (type === 'step') Object.assign(p, { color: $('#st-color').value, size: Number($('#st-size').value) });
  return p;
}

function onStyleChange() {
  const type = currentType();
  if (!type || type === 'crop' || type === 'mixed') return;
  const p = readStyleUi(type);
  if (selection.length) {
    for (const o of selection) Object.assign(o, p);
    if (editing) placeTextEditor();
    renderFg();
    commitSoon();
  }
  if (type === 'highlighter') defaults.hl = { color: p.color, width: p.width, opacity: p.opacity };
  else if (type === 'text') defaults.text = p;
  else if (type === 'redact') defaults.redact = p;
  else if (type === 'step') { defaults.step = p; $('#st-size-v').textContent = p.size + ' px'; }
  else {
    defaults.stroke = { color: p.color, width: p.width, opacity: p.opacity };
    if ('fill' in p) defaults.fill = { on: !!p.fill, color: p.fill || $('#s-fill').value };
  }
  $('#s-width-v').textContent = Math.round(Number($('#s-width').value)) + ' px';
  $('#s-opacity-v').textContent = $('#s-opacity').value + '%';
  chrome.storage?.local.set({ editorDefaults: defaults });
}
$('#style-panel').addEventListener('input', (e) => { if (e.target.id !== 'c-ratio' && e.target.id !== 'st-n') onStyleChange(); });
// A step's number: the selected step's, or the one the next step will get.
$('#st-n').addEventListener('input', () => {
  const v = Math.round(Number($('#st-n').value));
  if (!Number.isFinite(v) || v < 0 || v > 999 || $('#st-n').value === '') return;
  if (selected?.type === 'step') {
    selected.n = v;
    renderFg();
    commitSoon();
  } else {
    stepStart = v;
  }
});
$('#st-n').addEventListener('change', () => syncStyleUi());
// Enter or Esc leaves the box, back to placing steps.
$('#st-n').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); $('#st-n').blur(); } });
for (const id of ['t-bold', 't-italic']) {
  $('#' + id).addEventListener('mousedown', (e) => e.preventDefault()); // keep the text editor focused
  $('#' + id).addEventListener('click', () => { $('#' + id).classList.toggle('on'); onStyleChange(); });
}
for (const [id, d] of [['t-smaller', -1], ['t-bigger', 1]]) {
  $('#' + id).addEventListener('mousedown', (e) => e.preventDefault());
  $('#' + id).addEventListener('click', () => {
    const v = Number($('#t-size').value) || 32;
    $('#t-size').value = clamp(Math.round(v + d * Math.max(2, v * 0.15)), 6, 400);
    onStyleChange();
  });
}

$('#t-fonts').addEventListener('click', async () => {
  if (!window.queryLocalFonts) { toast('This browser cannot list installed fonts.', { kind: 'error' }); return; }
  try {
    const fonts = await window.queryLocalFonts();
    const have = new Set([...$('#t-font').options].map((o) => o.value));
    const families = [...new Set(fonts.map((f) => f.family))].filter((f) => !have.has(f)).sort();
    for (const f of families) $('#t-font').add(new Option(f));
    toast(`Added ${families.length} installed fonts`, { kind: 'success' });
  } catch {
    toast('Font access was not allowed.', { kind: 'error' });
  }
});

// ---------- crop ----------

function updateCropUi() {
  const ok = tool === 'crop' && crop && crop.w >= 2 && crop.h >= 2;
  $('#c-apply').disabled = !ok;
  $('#c-size').textContent = ok
    ? `${Math.round(crop.w)} × ${Math.round(crop.h)} px — drag inside to move it, Enter to apply.`
    : 'Drag on the image to choose the area to keep.';
}

function applyCrop() {
  if (!crop || crop.w < 2 || crop.h < 2) return;
  const x = Math.round(crop.x), y = Math.round(crop.y);
  const w = Math.round(crop.w), h = Math.round(crop.h);
  const c = canvas(w, h);
  c.getContext('2d').drawImage(base, x, y, w, h, 0, 0, w, h);
  base = c;
  for (const o of objects) moveObj(o, -x, -y);
  crop = null;
  layout();
  fitZoom();
  setTool('select');
  commit();
}
$('#c-apply').addEventListener('click', applyCrop);
$('#c-cancel').addEventListener('click', () => { crop = null; setTool('select'); });

// ---------- image panel ----------

const ratio = () => base.height / base.width;
$('#rs-w').addEventListener('input', () => {
  if ($('#rs-lock').checked && base) $('#rs-h').value = Math.max(1, Math.round(Number($('#rs-w').value) * ratio()));
});
$('#rs-h').addEventListener('input', () => {
  if ($('#rs-lock').checked && base) $('#rs-w').value = Math.max(1, Math.round(Number($('#rs-h').value) / ratio()));
});
$('#rs-lock-btn').addEventListener('click', () => {
  const on = !$('#rs-lock').checked;
  $('#rs-lock').checked = on;
  $('#rs-lock-btn').classList.toggle('on', on);
  $('#rs-lock-btn').dataset.tip = on ? 'Keep proportions' : 'Proportions unlocked';
});
for (const b of document.querySelectorAll('[data-pct]')) {
  b.addEventListener('click', () => {
    if (!base) return;
    $('#rs-w').value = Math.max(1, Math.round(base.width * Number(b.dataset.pct)));
    $('#rs-h').value = Math.max(1, Math.round(base.height * Number(b.dataset.pct)));
  });
}
$('#rs-apply').addEventListener('click', async () => {
  if (!base) return;
  const w = clamp(Math.round(Number($('#rs-w').value)), 1, 16000);
  const h = clamp(Math.round(Number($('#rs-h').value)), 1, 16000);
  if (w === base.width && h === base.height) return;
  const bmp = await createImageBitmap(base, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  const c = canvas(w, h);
  c.getContext('2d').drawImage(bmp, 0, 0);
  const sx = w / base.width, sy = h / base.height;
  for (const o of objects) scaleObj(o, sx, sy);
  base = c;
  layout();
  fitZoom();
  commit();
  toast(`Resized to ${w} × ${h}`, { kind: 'success' });
});

function setBackdrop(bg) {
  frame.bg = bg;
  syncFrameUi();
  if (base) layout();
  commitSoon();
}

function syncFrameUi() {
  $('#f-pad').value = frame.padding;
  $('#f-pad-v').textContent = frame.padding + ' px';
  if (frame.bg !== 'transparent') $('#f-bg').value = frame.bg;
  for (const b of document.querySelectorAll('[data-set="backdrop"] button')) {
    b.classList.toggle('picked', b.dataset.c === frame.bg);
  }
  $('#f-radius').value = frame.radius;
  $('#f-radius-v').textContent = frame.radius + ' px';
  $('#f-shadow').checked = frame.shadow;
  wrap.classList.toggle('checker', frame.radius > 0 || (frame.padding > 0 && frame.bg === 'transparent'));
}
for (const id of ['f-pad', 'f-bg', 'f-radius', 'f-shadow']) {
  $('#' + id).addEventListener('input', () => {
    frame.padding = Number($('#f-pad').value);
    if (id === 'f-bg') frame.bg = $('#f-bg').value;
    frame.radius = Number($('#f-radius').value);
    frame.shadow = $('#f-shadow').checked;
    syncFrameUi();
    if (base) layout();
    commitSoon();
  });
}

// ---------- zoom & toolbar ----------

$('#zoom-in').addEventListener('click', () => setZoom(zoom * 1.25));
$('#zoom-out').addEventListener('click', () => setZoom(zoom / 1.25));
$('#zoom-label').addEventListener('click', () => (zoom === 1 ? fitZoom() : setZoom(1)));
$('#undo-all').addEventListener('click', undoAll);
$('#a-front').addEventListener('click', () => arrange(true));
$('#a-back').addEventListener('click', () => arrange(false));
$('#a-dup').addEventListener('click', duplicateSelected);
$('#a-del').addEventListener('click', deleteSelected);
$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);
$('#delete').addEventListener('click', deleteSelected);

// ---------- export ----------

const EXT = { png: 'png', png8: 'png', jpeg: 'jpg', webp: 'webp', avif: 'avif', gif: 'gif', bmp: 'bmp', pdf: 'pdf' };

const FORMAT_INFO = {
  png: ['PNG', 'Lossless, sharp text, keeps transparency.'],
  png8: ['PNG-8', 'Compressed PNG with up to 256 colours. Often 60–80% smaller.'],
  jpeg: ['JPEG', 'Small files, best for photos. No transparency.'],
  webp: ['WebP', 'Smaller than PNG and JPEG, keeps transparency.'],
  avif: ['AVIF', 'The smallest files, for modern browsers.'],
  gif: ['GIF', 'Up to 256 colours. Opens everywhere.'],
  bmp: ['BMP', 'Uncompressed, for older software.'],
  pdf: ['PDF', 'For sharing and printing. Long pages can span several pages.'],
};

function renderFormatTiles() {
  $('#formats').innerHTML = [...$('#x-format').options].filter((o) => !o.hidden)
    .map((o) => `<button data-f="${o.value}" title="${FORMAT_INFO[o.value][1]}">${FORMAT_INFO[o.value][0]}</button>`).join('');
}
$('#formats').addEventListener('click', (e) => {
  const f = e.target.dataset.f;
  if (!f) return;
  $('#x-format').value = f;
  $('#x-format').dispatchEvent(new Event('input', { bubbles: true }));
  $('#x-format').dispatchEvent(new Event('change', { bubbles: true }));
});

function syncExportUi() {
  const f = $('#x-format').value;
  for (const b of document.querySelectorAll('#formats button')) b.classList.toggle('on', b.dataset.f === f);
  $('#x-note').textContent = FORMAT_INFO[f][1];
  document.querySelector('[data-x="quality"]').classList.toggle('hidden', !['jpeg', 'webp', 'avif', 'pdf'].includes(f));
  document.querySelector('[data-x="colors"]').classList.toggle('hidden', !['png8', 'gif'].includes(f));
  document.querySelector('[data-x="pdf"]').classList.toggle('hidden', f !== 'pdf');
  document.querySelector('[data-x="lossy"]').classList.toggle('hidden', f !== 'gif');
  $('#x-lossy-v').textContent = Number($('#x-lossy').value) ? $('#x-lossy').value : 'Off';
  $('#x-quality-v').textContent = $('#x-quality').value + '%';
  const label = `Download ${FORMAT_INFO[f][0]}`;
  for (const id of ['download', 'download2']) $('#' + id).lastChild.textContent = label;
}

async function finalCanvas({ scaled = true } = {}) {
  let c = canvas(fullW(), fullH());
  const ctx = c.getContext('2d');
  paintImage(ctx);
  paintObjects(ctx);
  const d = device?.get();
  if (d?.enabled) c = renderInDevice(d, c);
  const s = Number($('#x-scale').value);
  if (scaled && s !== 1) {
    const w = Math.max(1, Math.round(c.width * s));
    const h = Math.max(1, Math.round(c.height * s));
    const bmp = await createImageBitmap(c, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    c = canvas(w, h);
    c.getContext('2d').drawImage(bmp, 0, 0);
  }
  return c;
}

function encodeOptions() {
  return {
    quality: Number($('#x-quality').value) / 100,
    colors: $('#x-colors').value === 'auto' ? 'auto' : Number($('#x-colors').value),
    dither: $('#x-dither').checked,
    lossy: Number($('#x-lossy').value),
    page: $('#x-page').value,
    split: $('#x-split').checked,
  };
}

/**
 * Encodes in a worker, within the size limit if one is set. `lane` lets a newer
 * estimate cancel an older one. Resolves to `{ blob, width, height, fitted }`.
 */
function encode(c, lane = 'export') {
  return encodeOffThread(c, $('#x-format').value, encodeOptions(), lane, Number($('#x-limit').value) * 1024);
}

/** Says what was changed to fit the size limit, if anything. */
function fittedNote(f) {
  if (!f) return '';
  if (f.tooBig) return "Can't get under the size limit; this is as small as it goes.";
  const parts = [];
  if (f.quality !== undefined) parts.push(`quality ${Math.round(f.quality * 100)}%`);
  if (f.lossy) parts.push(`lossy ${f.lossy}`);
  if (f.colors) parts.push(`${f.colors} colours`);
  if (f.scale) parts.push(`${Math.round(f.scale * 100)}% size`);
  return `To fit the limit: ${parts.join(', ')}.`;
}

let estimateRun = 0;
const refreshExport = debounce(async () => {
  if (!base) return;
  const run = ++estimateRun;
  $('#x-estimate').innerHTML = '<span>Working out the file size…</span>';
  try {
    const c = await finalCanvas();
    const r = await encode(c, 'estimate');
    if (run !== estimateRun) return;
    $('#x-estimate').innerHTML = `<span>${r.width} × ${r.height} px</span><b>${fmtBytes(r.blob.size)}</b>`;
    $('#x-fitted').textContent = fittedNote(r.fitted);
    $('#x-fitted').classList.toggle('hidden', !r.fitted);
    $('#x-fitted').classList.toggle('warn', !!r.fitted?.tooBig);
  } catch (e) {
    if (e.superseded) return;
    if (run === estimateRun) $('#x-estimate').textContent = 'Could not encode: ' + e.message;
  }
  updateDevicePreview();
}, 450);

// With a device frame on, the Export tab shows the finished image on the stage
// in place of the editable canvas, so what you see is what downloads.
let previewRun = 0;
async function updateDevicePreview() {
  const run = ++previewRun;
  const d = device?.get();
  const show = Boolean(d?.enabled && base && document.body.dataset.pane === 'export');
  stage.classList.toggle('previewing', show);
  $('#export-preview').classList.toggle('hidden', !show);
  if (!show) return;
  const c = await finalCanvas({ scaled: false });
  if (run !== previewRun) return;
  const prev = $('#device-preview');
  prev.width = c.width;
  prev.height = c.height;
  prev.getContext('2d').drawImage(c, 0, 0);
}
$('#preview-edit').addEventListener('click', () => showPane('annotate'));

function fileName() {
  const n = ($('#x-name').value || 'captode').trim().replace(/[\\/:*?"<>|]+/g, '-');
  return `${n}.${EXT[$('#x-format').value]}`;
}

async function download() {
  if (!base) return;
  if (editing) ta.blur();
  const btns = [$('#download'), $('#download2')];
  btns.forEach((b) => { b.disabled = true; });
  try {
    const { blob } = await encode(await finalCanvas());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    dirty = false;
    toast(`Saved ${a.download} · ${fmtBytes(blob.size)}`, { kind: 'success' });
  } catch (e) {
    toast('Export failed: ' + e.message, { kind: 'error', ms: 5000 });
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

$('#download').addEventListener('click', download);
$('#download2').addEventListener('click', download);
async function copyImage({ auto = false } = {}) {
  if (!base) return false;
  try {
    const c = await finalCanvas();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': c.convertToBlob({ type: 'image/png' }) })]);
    dirty = false;
    toast(auto ? 'Screenshot copied to the clipboard' : 'Copied to the clipboard', { kind: 'success' });
    return true;
  } catch (e) {
    if (!auto) toast('Could not copy: ' + e.message, { kind: 'error', ms: 4000 });
    return false;
  }
}

/**
 * Copies a new screenshot as it opens (Settings → Copy screenshots to the clipboard).
 * The clipboard needs the page focused; if it isn't yet, copy once it is, or on the
 * first click or key press.
 */
async function autoCopy() {
  if (document.hasFocus() && await copyImage({ auto: true })) return;
  const events = ['focus', 'pointerdown', 'keydown'];
  const once = async () => {
    if (!document.hasFocus() || !(await copyImage({ auto: true }))) return; // try again on the next one
    for (const ev of events) removeEventListener(ev, once, true);
  };
  for (const ev of events) addEventListener(ev, once, true);
}
$('#copy').addEventListener('click', () => copyImage());
$('#copy2').addEventListener('click', () => copyImage());
for (const id of ['x-format', 'x-scale', 'x-limit', 'x-quality', 'x-colors', 'x-dither', 'x-lossy', 'x-page', 'x-split']) {
  $('#' + id).addEventListener('input', () => { syncExportUi(); refreshExport(); });
}

// ---------- loading ----------

async function loadBlob(blob, info = {}) {
  const bmp = await createImageBitmap(blob);
  const c = canvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  base = c;
  objects = [];
  select([]);
  crop = null;
  meta = info;
  history.length = 0;
  hIndex = -1;
  dirty = false;
  document.body.classList.remove('no-image');
  $('#empty').classList.add('hidden');
  wrap.classList.remove('hidden');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const slug = (info.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  $('#x-name').value = ['captode', slug, stamp].filter(Boolean).join('-');
  if (info.title) document.title = `${info.title} — Captode`;
  $('#doc-name').textContent = info.title || 'Screenshot';
  $('#doc-name').title = info.url || info.title || '';
  layout();
  fitZoom();
  commit();
  original = history[0];
  updateButtons();
}

function showEmpty() {
  document.body.classList.add('no-image');
  $('#empty').classList.remove('hidden');
  wrap.classList.add('hidden');
  renderRecent();
}

// Captures from the last day, so a closed tab isn't a lost screenshot.
async function renderRecent() {
  if (!globalThis.chrome?.runtime) return;
  const items = await listCaptures(12);
  $('#recent').classList.toggle('hidden', !items.length);
  $('#recent-list').innerHTML = '';
  for (const it of items) {
    const a = document.createElement('a');
    a.className = 'recent-item';
    a.href = it.kind === 'video' ? `../video/video.html?id=${it.id}` : `?id=${it.id}&reopen=1`;
    const thumb = document.createElement(it.kind === 'video' ? 'video' : 'img');
    thumb.src = URL.createObjectURL(it.blob) + (it.kind === 'video' ? '#t=0.1' : '');
    if (it.kind === 'video') { thumb.muted = true; thumb.preload = 'metadata'; }
    thumb.alt = '';
    const title = it.meta.title || (it.kind === 'video' ? 'Recording' : 'Screenshot');
    a.innerHTML = `<span class="thumb"></span><span class="meta"><b></b><small></small></span>
      <button class="btn ghost icon remove" data-tip="Remove" aria-label="Remove ${title.replace(/"/g, '')}"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    a.querySelector('.thumb').append(thumb);
    if (it.kind === 'video') a.querySelector('.thumb').insertAdjacentHTML('beforeend', '<span class="badge">Video</span>');
    a.querySelector('b').textContent = title;
    a.querySelector('small').textContent = `${ago(it.created)} · ${fmtBytes(it.size)}`;
    a.querySelector('.remove').addEventListener('click', async (e) => {
      e.preventDefault();
      await deleteCapture(it.id);
      renderRecent();
    });
    $('#recent-list').append(a);
  }
}

async function openFile(file) {
  if (file && file.type.startsWith('image/')) await loadBlob(file, { title: file.name.replace(/\.[^.]+$/, '') });
}
$('#open').addEventListener('change', (e) => openFile(e.target.files[0]));
$('#open2').addEventListener('change', (e) => openFile(e.target.files[0]));
document.addEventListener('paste', (e) => {
  if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
  if (item) { openFile(item.getAsFile()); return; }
  const text = e.clipboardData.getData('text/plain');
  if (base && text && pasteAnnotations(text)) e.preventDefault();
});
stage.addEventListener('dragover', (e) => e.preventDefault());
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  openFile(e.dataTransfer.files[0]);
});
window.addEventListener('resize', debounce(() => base && applyZoom(), 150));
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

$('#help').addEventListener('click', () => openDialog($('#shortcuts')));
document.addEventListener('keydown', (e) => {
  if (e.key === '?' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) openDialog($('#shortcuts'));
});

// ---------- start ----------

(async () => {
  if (await new OffscreenCanvas(1, 1).convertToBlob({ type: 'image/avif' }).then((b) => b.type === 'image/avif', () => false)) {
    $('#x-format').querySelector('[value="avif"]').hidden = false;
  }
  renderFormatTiles();
  let settings = {};
  if (globalThis.chrome?.storage) {
    const { editorDefaults } = await chrome.storage.local.get('editorDefaults');
    if (editorDefaults) Object.assign(defaults, editorDefaults);
    settings = await getSettings();
    frame.bg = backgroundColour(settings) || 'transparent';
    const fmt = $('#x-format').querySelector(`option[value="${settings.imageFormat}"]`);
    if (fmt && !fmt.hidden) $('#x-format').value = settings.imageFormat;
    device = await mountDevicePanel($('#device-panel'), () => refreshExport());
  } else {
    $('#device-panel').textContent = 'Available when running as the extension.';
  }
  syncExportUi();
  syncFrameUi();
  setTool('select');
  enhance();

  const id = new URLSearchParams(location.search).get('id');
  const rec = id && globalThis.chrome?.runtime ? await getCapture(id) : null;
  if (rec) {
    await loadBlob(rec.blob, rec.meta);
    if (rec.meta?.truncated) toast('This page is very long, so only its top part was captured.', { ms: 6000 });
    // Only a capture that has just been taken, not one reopened from Recent captures.
    if (settings.autoCopy && !new URLSearchParams(location.search).has('reopen')) {
      window.history.replaceState(null, '', `?id=${id}&reopen=1`); // not again on reload (`history` here is the undo stack)
      autoCopy();
    }
  } else {
    showEmpty();
  }
})();

// Read-only access for the automated tests: the on-screen canvases only hold the
// visible part of the image.
globalThis.captodeEditor = {
  size: () => (base ? [base.width, base.height] : null),
  pixels: () => base.getContext('2d').getImageData(0, 0, base.width, base.height),
  objects: () => objects.map(({ _editing, ...o }) => structuredClone(o)),
  history: () => ({ steps: history.length, index: hIndex }),
  render: async () => { const c = await finalCanvas({ scaled: false }); return c.getContext('2d').getImageData(0, 0, c.width, c.height); },
};
