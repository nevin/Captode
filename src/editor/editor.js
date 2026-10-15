import { getCapture } from '../lib/db.js';
import { toPdf, toBmp, toPng8, toGif } from '../lib/formats.js';
import { mountDevicePanel, renderInDevice } from '../lib/device.js';
import { getSettings, backgroundColour } from '../lib/settings.js';

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
  ['crop', 'Crop', 'c', svg('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>')],
  ['pen', 'Pen', 'p', svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>')],
  ['highlighter', 'Highlighter', 'h', svg('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>')],
  ['line', 'Line', 'l', svg('<path d="M5 19 19 5"/>')],
  ['arrow', 'Arrow', 'a', svg('<path d="M5 19 19 5"/><path d="M9 5h10v10"/>')],
  ['rect', 'Rectangle', 'r', svg('<rect x="3" y="5" width="18" height="14" rx="1"/>')],
  ['ellipse', 'Ellipse', 'e', svg('<ellipse cx="12" cy="12" rx="9" ry="7"/>')],
  ['text', 'Text', 't', svg('<path d="M4 7V4h16v3M9 20h6M12 4v16"/>')],
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
  rect: ['stroke', 'fill'], ellipse: ['stroke', 'fill'], text: ['text'], redact: ['redact'], crop: ['crop'],
};
const NAMES = {
  pen: 'Pen', highlighter: 'Highlighter', line: 'Line', arrow: 'Arrow', rect: 'Rectangle',
  ellipse: 'Ellipse', text: 'Text', redact: 'Blur / pixelate', crop: 'Crop',
};

// ---------- state ----------

const defaults = {
  stroke: { color: '#e5484d', width: 4, opacity: 100 },
  hl: { color: '#ffd60a', width: 22, opacity: 40 },
  fill: { on: false, color: '#ffd60a' },
  text: { font: 'system-ui', size: 32, bold: true, italic: false, color: '#ffffff', bg: '#17171c' },
  redact: { mode: 'pixelate', strength: 12 },
};
const frame = { padding: 0, bg: 'transparent', radius: 0, shadow: false }; // bg: a colour or 'transparent'

let base = null;     // OffscreenCanvas with the pixels being edited
let objects = [];    // annotations, in image coordinates
let selected = null;
let tool = 'select';
let zoom = 1;
let crop = null;
let drag = null;
let editing = null;
let meta = {};
let device = null;
const history = [];
let hIndex = -1;

// ---------- helpers ----------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const canvas = (w, h) => new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
const norm = (o) => ({
  x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2),
  w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1),
});
const fullW = () => base.width + frame.padding * 2;
const fullH = () => base.height + frame.padding * 2;

function toast(msg, ms = 2400) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- history ----------

function snapshot() {
  const objs = objects.map(({ _editing, ...o }) => o);
  return { base, objects: structuredClone(objs), frame: { ...frame } };
}

function commit() {
  history.splice(hIndex + 1);
  history.push(snapshot());
  if (history.length > 80) history.shift();
  hIndex = history.length - 1;
  updateButtons();
  refreshExport();
}
const commitSoon = debounce(commit, 400);

function restore(s) {
  base = s.base;
  objects = structuredClone(s.objects);
  Object.assign(frame, s.frame);
  selected = null;
  crop = null;
  syncFrameUi();
  layout();
  syncStyleUi();
  updateButtons();
  refreshExport();
}

function undo() { if (hIndex > 0) restore(history[--hIndex]); }
function redo() { if (hIndex < history.length - 1) restore(history[++hIndex]); }

function updateButtons() {
  $('#undo').disabled = hIndex <= 0;
  $('#redo').disabled = hIndex >= history.length - 1;
  $('#delete').disabled = !selected;
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
      } else if (o.mode === 'blur') {
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.filter = `blur(${o.strength}px)`;
        const m = o.strength * 2;
        ctx.drawImage(base, x - m, y - m, w + m * 2, h + m * 2, x - m, y - m, w + m * 2, h + m * 2);
      } else {
        const b = o.strength;
        const tiny = canvas(Math.ceil(w / b), Math.ceil(h / b));
        tiny.getContext('2d').drawImage(base, x, y, w, h, 0, 0, tiny.width, tiny.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, x, y, w, h);
      }
      break;
    }
  }
  ctx.restore();
}

function paintImage(ctx) {
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
  ctx.drawImage(base, p, p);
  ctx.restore();
}

function paintObjects(ctx) {
  ctx.save();
  ctx.translate(frame.padding, frame.padding);
  for (const o of objects) drawObject(ctx, o);
  ctx.restore();
}

function renderBg() { paintImage(bctx); }

function renderFg() {
  if (!base) return;
  fctx.clearRect(0, 0, fg.width, fg.height);
  paintObjects(fctx);
  fctx.save();
  fctx.translate(frame.padding, frame.padding);
  const px = 1 / zoom;

  if (selected && !selected._editing) {
    const b = bounds(selected);
    fctx.setLineDash([5 * px, 4 * px]);
    fctx.lineWidth = px;
    fctx.strokeStyle = '#5b4bff';
    fctx.strokeRect(b.x - 4 * px, b.y - 4 * px, b.w + 8 * px, b.h + 8 * px);
    fctx.setLineDash([]);
    for (const [hx, hy] of handles(selected)) {
      fctx.beginPath();
      fctx.arc(hx, hy, 6 * px, 0, Math.PI * 2);
      fctx.fillStyle = '#fff';
      fctx.fill();
      fctx.lineWidth = 2 * px;
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
  const W = fullW(), H = fullH();
  for (const c of [bg, fg]) { c.width = W; c.height = H; }
  applyZoom();
  renderBg();
  renderFg();
  $('#rs-w').value = base.width;
  $('#rs-h').value = base.height;
  $('#doc-dims').textContent = `${base.width} × ${base.height} px`;
}

function applyZoom() {
  const W = fullW(), H = fullH();
  for (const c of [bg, fg]) {
    c.style.width = W * zoom + 'px';
    c.style.height = H * zoom + 'px';
  }
  $('#zoom-label').textContent = Math.round(zoom * 100) + '%';
  if (editing) placeTextEditor();
  renderFg();
}

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
  const r = norm(o);
  const h = (o.width || 0) / 2;
  return { x: r.x - h, y: r.y - h, w: r.w + h * 2, h: r.h + h * 2 };
}

function handles(o) {
  if (o.type === 'pen' || o.type === 'highlighter' || o.type === 'text') return [];
  return [[o.x1, o.y1], [o.x2, o.y2]];
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
  else if (o.type === 'text') { o.x += dx; o.y += dy; }
  else { o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; }
}

function scaleObj(o, sx, sy) {
  const s = (sx + sy) / 2;
  if (o.points) o.points = o.points.map(([x, y]) => [x * sx, y * sy]);
  else if (o.type === 'text') { o.x *= sx; o.y *= sy; o.size = Math.max(4, Math.round(o.size * sy)); }
  else { o.x1 *= sx; o.y1 *= sy; o.x2 *= sx; o.y2 *= sy; }
  if (o.width) o.width = Math.max(1, o.width * s);
}

function toImage(e) {
  const r = fg.getBoundingClientRect();
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
  const p = { ...defaults.stroke };
  if (type === 'rect' || type === 'ellipse') p.fill = defaults.fill.on ? defaults.fill.color : null;
  return p;
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
    if (selected === o) selected = null;
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
  if (!base || e.button !== 0) return;
  if (editing) { ta.blur(); return; }
  fg.setPointerCapture(e.pointerId);
  const pt = toImage(e);

  if (tool === 'select') {
    if (selected) {
      const h = handles(selected).findIndex(([hx, hy]) => Math.hypot(hx - pt.x, hy - pt.y) <= 8 / zoom);
      if (h >= 0) { drag = { kind: 'handle', h }; return; }
    }
    selected = topHit(pt);
    if (selected) showPane('annotate');
    syncStyleUi();
    if (selected) drag = { kind: 'move', last: pt, moved: false };
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
      selected = hit;
    } else {
      selected = { type: 'text', ...propsFor('text'), text: '', x: pt.x, y: pt.y - defaults.text.size * 0.6 };
      objects.push(selected);
    }
    syncStyleUi();
    editText(selected);
    return;
  }

  const o = newShape(tool, pt);
  objects.push(o);
  selected = o;
  drag = { kind: 'draw', o };
  renderFg();
});

fg.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const pt = toImage(e);
  if (drag.kind === 'handle') {
    const o = selected;
    if (drag.h === 0) { o.x1 = pt.x; o.y1 = pt.y; }
    else { const q = snapEnd(o, pt, e.shiftKey); o.x2 = q.x; o.y2 = q.y; }
  } else if (drag.kind === 'move') {
    moveObj(selected, pt.x - drag.last.x, pt.y - drag.last.y);
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
      const [lx, ly] = o.points[o.points.length - 1];
      if (Math.hypot(pt.x - lx, pt.y - ly) > 1.5 / zoom) o.points.push([pt.x, pt.y]);
    } else {
      const q = snapEnd(o, pt, e.shiftKey);
      o.x2 = q.x;
      o.y2 = q.y;
    }
  }
  renderFg();
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
      selected = null;
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
  if (hit?.type === 'text') { selected = hit; syncStyleUi(); editText(hit); }
});

stage.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

// ---------- inspector tabs ----------

function showPane(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.pane === name);
  for (const p of document.querySelectorAll('.pane')) p.classList.toggle('hidden', p.dataset.pane !== name);
  if (name === 'export') refreshExport();
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
  if (t !== 'select' && selected && GROUPS[t] && selected.type !== t) selected = null;
  stage.dataset.tool = t;
  if (t !== 'select') showPane('annotate');
  for (const b of document.querySelectorAll('#tools .btn')) b.classList.toggle('active', b.dataset.tool === t);
  syncStyleUi();
  updateCropUi();
  renderFg();
}

const TOOL_GROUPS = [['select', 'crop'], ['pen', 'highlighter'], ['arrow', 'line', 'rect', 'ellipse'], ['text', 'redact']];
$('#tools').innerHTML = TOOL_GROUPS.map((g) => g.map((id) => {
  const [, title, key, icon] = TOOLS.find((t) => t[0] === id);
  return `<button class="btn ghost icon" data-tool="${id}" data-tip="${title}  ${key.toUpperCase()}" aria-label="${title}">${icon}</button>`;
}).join('')).join('<span class="tool-sep"></span>');
$('#tools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (b) setTool(b.dataset.tool);
});

function deleteSelected() {
  if (!selected) return;
  objects = objects.filter((o) => o !== selected);
  selected = null;
  syncStyleUi();
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
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); deleteSelected(); return; }
  if (e.key === 'Escape') { selected = null; crop = null; updateCropUi(); syncStyleUi(); renderFg(); return; }
  if (e.key === 'Enter' && tool === 'crop' && crop) { applyCrop(); return; }
  if (selected && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const s = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key];
    moveObj(selected, ...d);
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

function currentType() {
  if (selected) return selected.type;
  return GROUPS[tool] ? tool : null;
}

function syncStyleUi() {
  const type = currentType();
  const groups = GROUPS[type] || [];
  for (const g of document.querySelectorAll('[data-group]')) g.classList.toggle('hidden', !groups.includes(g.dataset.group));
  $('#style-hint').classList.toggle('hidden', !!type);
  $('#style-title').textContent = type ? (selected ? `Selected ${NAMES[type].toLowerCase()}` : NAMES[type]) : 'Annotate';
  if (!type || type === 'crop') return;
  const p = selected || propsFor(type);
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
  return p;
}

function onStyleChange() {
  const type = currentType();
  if (!type || type === 'crop') return;
  const p = readStyleUi(type);
  if (selected) {
    Object.assign(selected, p);
    if (editing) placeTextEditor();
    renderFg();
    commitSoon();
  }
  if (type === 'highlighter') defaults.hl = { color: p.color, width: p.width, opacity: p.opacity };
  else if (type === 'text') defaults.text = p;
  else if (type === 'redact') defaults.redact = p;
  else {
    defaults.stroke = { color: p.color, width: p.width, opacity: p.opacity };
    if ('fill' in p) defaults.fill = { on: !!p.fill, color: p.fill || $('#s-fill').value };
  }
  $('#s-width-v').textContent = Math.round(Number($('#s-width').value)) + ' px';
  $('#s-opacity-v').textContent = $('#s-opacity').value + '%';
  chrome.storage?.local.set({ editorDefaults: defaults });
}
$('#style-panel').addEventListener('input', (e) => { if (e.target.id !== 'c-ratio') onStyleChange(); });
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
  if (!window.queryLocalFonts) { toast('This browser cannot list installed fonts.'); return; }
  try {
    const fonts = await window.queryLocalFonts();
    const have = new Set([...$('#t-font').options].map((o) => o.value));
    const families = [...new Set(fonts.map((f) => f.family))].filter((f) => !have.has(f)).sort();
    for (const f of families) $('#t-font').add(new Option(f));
    toast(`Added ${families.length} installed fonts`);
  } catch {
    toast('Font access was not allowed.');
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
  toast(`Resized to ${w} × ${h}`);
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
  $('#x-quality-v').textContent = $('#x-quality').value + '%';
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

async function encode(c) {
  const f = $('#x-format').value;
  const q = Number($('#x-quality').value) / 100;
  const colors = Number($('#x-colors').value);
  const dither = $('#x-dither').checked;
  switch (f) {
    case 'png': return c.convertToBlob({ type: 'image/png' });
    case 'png8': return toPng8(c, { colors, dither });
    case 'jpeg': {
      const flat = canvas(c.width, c.height);
      const fctx2 = flat.getContext('2d');
      fctx2.fillStyle = '#fff';
      fctx2.fillRect(0, 0, c.width, c.height);
      fctx2.drawImage(c, 0, 0);
      return flat.convertToBlob({ type: 'image/jpeg', quality: q });
    }
    case 'webp': return c.convertToBlob({ type: 'image/webp', quality: q });
    case 'avif': return c.convertToBlob({ type: 'image/avif', quality: q });
    case 'gif': return toGif(c, { colors, dither });
    case 'bmp': return toBmp(c);
    case 'pdf': return toPdf(c, { page: $('#x-page').value, split: $('#x-split').checked, quality: q });
  }
}

let estimateRun = 0;
const refreshExport = debounce(async () => {
  if (!base) return;
  const run = ++estimateRun;
  $('#x-estimate').innerHTML = '<span>Working out the file size…</span>';
  try {
    const c = await finalCanvas();
    const blob = await encode(c);
    if (run !== estimateRun) return;
    $('#x-estimate').innerHTML = `<span>${c.width} × ${c.height} px</span><b>${fmtBytes(blob.size)}</b>`;
  } catch (e) {
    if (run === estimateRun) $('#x-estimate').textContent = 'Could not encode: ' + e.message;
  }
  updateDevicePreview();
}, 450);

async function updateDevicePreview() {
  const prev = $('#device-preview');
  const d = device?.get();
  prev.classList.toggle('hidden', !d?.enabled);
  if (!d?.enabled || !base) return;
  const c = await finalCanvas({ scaled: false });
  const w = 540;
  prev.width = w;
  prev.height = Math.round((c.height / c.width) * w);
  const ctx = prev.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, 0, 0, prev.width, prev.height);
}

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
    const blob = await encode(await finalCanvas());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast(`Saved ${a.download} · ${fmtBytes(blob.size)}`);
  } catch (e) {
    toast('Export failed: ' + e.message, 4000);
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

$('#download').addEventListener('click', download);
$('#download2').addEventListener('click', download);
async function copyImage() {
  if (!base) return;
  try {
    const c = await finalCanvas();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': c.convertToBlob({ type: 'image/png' }) })]);
    toast('Copied to the clipboard');
  } catch (e) {
    toast('Could not copy: ' + e.message);
  }
}
$('#copy').addEventListener('click', copyImage);
for (const id of ['x-format', 'x-scale', 'x-quality', 'x-colors', 'x-dither', 'x-page', 'x-split']) {
  $('#' + id).addEventListener('input', () => { syncExportUi(); refreshExport(); });
}

// ---------- loading ----------

async function loadBlob(blob, info = {}) {
  const bmp = await createImageBitmap(blob);
  const c = canvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  base = c;
  objects = [];
  selected = null;
  crop = null;
  meta = info;
  history.length = 0;
  hIndex = -1;
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
}

function showEmpty() {
  document.body.classList.add('no-image');
  $('#empty').classList.remove('hidden');
  wrap.classList.add('hidden');
}

async function openFile(file) {
  if (file && file.type.startsWith('image/')) await loadBlob(file, { title: file.name.replace(/\.[^.]+$/, '') });
}
$('#open').addEventListener('change', (e) => openFile(e.target.files[0]));
$('#open2').addEventListener('change', (e) => openFile(e.target.files[0]));
document.addEventListener('paste', (e) => {
  if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
  if (item) openFile(item.getAsFile());
});
stage.addEventListener('dragover', (e) => e.preventDefault());
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  openFile(e.dataTransfer.files[0]);
});
window.addEventListener('resize', debounce(() => base && applyZoom(), 150));

// ---------- start ----------

(async () => {
  if (await new OffscreenCanvas(1, 1).convertToBlob({ type: 'image/avif' }).then((b) => b.type === 'image/avif', () => false)) {
    $('#x-format').querySelector('[value="avif"]').hidden = false;
  }
  renderFormatTiles();
  if (globalThis.chrome?.storage) {
    const { editorDefaults } = await chrome.storage.local.get('editorDefaults');
    if (editorDefaults) Object.assign(defaults, editorDefaults);
    const settings = await getSettings();
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

  const id = new URLSearchParams(location.search).get('id');
  const rec = id && globalThis.chrome?.runtime ? await getCapture(id) : null;
  if (rec) {
    await loadBlob(rec.blob, rec.meta);
    if (rec.meta?.truncated) toast('This page is very long, so only its top part was captured.', 5000);
  } else {
    showEmpty();
  }
})();
