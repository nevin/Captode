// Edits to a recording: parts cut out, parts sped up, blurred areas, a crop, zooms,
// callouts, a background, and the sound's volume, fades and muted parts. Used by the
// video page's preview, the export worker and the in-page fallbacks alike, so what
// is previewed is what is exported.
//
// Times are seconds in the recording; places and sizes are fractions of the
// recording's picture (so they hold at any resolution).
//
// edits: {
//   cuts:     [{ id, from, to, silence? }]             parts left out (silence: found quiet)
//   speeds:   [{ id, from, to, rate }]                 parts played faster (silent)
//   blurs:    [{ id, from, to, whole, x, y, w, h, mode ('blur' | 'pixelate' | 'box'), strength (1–10) }]
//   crop:     { x, y, w, h } | null                    the part of the picture kept
//   zooms:    [{ id, from, to, x, y, scale }]          x, y: the centre, in the crop
//   callouts: [{ id, from, to, whole, kind ('arrow' | 'box' | 'text' | 'spot'), x1, y1, x2, y2, text, color, size (1–3) }]
//   background: { on, kind ('solid' | 'gradient'), c1, c2, padding (%), radius (%), shadow, aspect ('auto' | '16:9' | '1:1' | '9:16' | '4:3') }
//   audio:    { volume (0–2), fadeIn (s), fadeOut (s), mutes: [{ id, from, to }] }
//   rings:    { on, color, size (1–3) }                 a ring where each recorded click was
// }

export const RATES = [1.5, 2, 4, 8];
export const ZOOMS = [1.25, 1.5, 2, 3];
export const ASPECTS = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1, '9:16': 9 / 16 };
export const CALLOUT_COLOURS = ['#e5484d', '#f5a524', '#30a46c', '#0090ff', '#8e4ec6', '#ffffff', '#111111'];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const frac = (v, d = 0) => clamp(num(v, d), 0, 1);
const ease = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p * p * (3 - 2 * p));
let lastId = 0;
export const editId = () => `e${Date.now().toString(36)}${(++lastId).toString(36)}`;

export const DEFAULT_BACKGROUND = { on: false, kind: 'gradient', c1: '#5b4bff', c2: '#a855f7', padding: 6, radius: 2, shadow: true, aspect: 'auto' };
export const DEFAULT_AUDIO = { volume: 1, fadeIn: 0, fadeOut: 0, mutes: [] };
export const DEFAULT_RINGS = { on: false, color: '#f5a524', size: 2 };

/** Empty edits. */
export const noEdits = () => ({ cuts: [], speeds: [], blurs: [], crop: null, zooms: [], callouts: [], background: { ...DEFAULT_BACKGROUND }, audio: { ...DEFAULT_AUDIO, mutes: [] }, rings: { ...DEFAULT_RINGS } });

function range(r, i = 0) {
  const from = Math.max(0, num(r?.from, 0));
  return { id: typeof r?.id === 'string' ? r.id : `e${i}`, from, to: Math.max(from + 0.05, num(r?.to, from + 1)) };
}
const box = (r) => {
  const x = frac(r?.x), y = frac(r?.y);
  return { x, y, w: clamp(num(r?.w, 0.2), 0.01, 1 - x), h: clamp(num(r?.h, 0.2), 0.01, 1 - y) };
};
const colour = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);

/** Edits as saved or imported, checked and with every field present. */
export function normaliseEdits(raw = {}) {
  const e = noEdits();
  const list = (a) => (Array.isArray(a) ? a : []);
  e.cuts = list(raw.cuts).map((r, i) => (r?.silence ? { ...range(r, i), silence: true } : range(r, i)));
  e.speeds = list(raw.speeds).map((r, i) => ({ ...range(r, i), rate: RATES.includes(Number(r.rate)) ? Number(r.rate) : 2 }));
  e.blurs = list(raw.blurs).map((r, i) => ({
    ...range(r, i), ...box(r), whole: !!r.whole,
    mode: ['blur', 'pixelate', 'box'].includes(r.mode) ? r.mode : 'blur', strength: clamp(Math.round(num(r.strength, 5)), 1, 10),
  }));
  e.crop = raw.crop ? box(raw.crop) : null;
  if (e.crop && e.crop.w > 0.995 && e.crop.h > 0.995) e.crop = null;
  e.zooms = list(raw.zooms).map((r, i) => ({ ...range(r, i), x: frac(r.x, 0.5), y: frac(r.y, 0.5), scale: clamp(num(r.scale, 2), 1.1, 4), auto: !!r.auto }));
  e.callouts = list(raw.callouts).map((r, i) => ({
    ...range(r, i), whole: !!r.whole,
    kind: ['arrow', 'box', 'text', 'spot'].includes(r.kind) ? r.kind : 'arrow',
    x1: frac(r.x1, 0.3), y1: frac(r.y1, 0.3), x2: frac(r.x2, 0.5), y2: frac(r.y2, 0.5),
    text: String(r.text ?? '').slice(0, 200), color: colour(r.color, CALLOUT_COLOURS[0]), size: clamp(Math.round(num(r.size, 2)), 1, 3),
  }));
  const b = raw.background || {};
  e.background = {
    on: !!b.on, kind: b.kind === 'solid' ? 'solid' : 'gradient',
    c1: colour(b.c1, DEFAULT_BACKGROUND.c1), c2: colour(b.c2, DEFAULT_BACKGROUND.c2),
    padding: clamp(num(b.padding, DEFAULT_BACKGROUND.padding), 0, 20), radius: clamp(num(b.radius, DEFAULT_BACKGROUND.radius), 0, 10),
    shadow: b.shadow !== false, aspect: b.aspect in ASPECTS ? b.aspect : 'auto',
  };
  const a = raw.audio || {};
  e.audio = {
    volume: clamp(num(a.volume, 1), 0, 2), fadeIn: clamp(num(a.fadeIn, 0), 0, 10), fadeOut: clamp(num(a.fadeOut, 0), 0, 10),
    mutes: list(a.mutes).map(range),
  };
  const g = raw.rings || {};
  e.rings = { on: !!g.on, color: colour(g.color, DEFAULT_RINGS.color), size: clamp(Math.round(num(g.size, 2)), 1, 3) };
  return e;
}

/** Whether the edits change anything at all. */
export function hasEdits(e) {
  return !!(e && (e.cuts.length || e.speeds.length || hasSpatial(e) || touchesAudio(e)));
}

// ---------- time ----------

/**
 * How the kept part [start, end] of the recording plays in the output (before any
 * inserted slides): `parts`, in order, each { from, to, rate, out } (out: when it
 * starts in the output), `length` (s), `outOf(t)`, when recording time t shows in
 * the output (in a cut part: where the cut is), and `sourceAt(o)`, the recording's
 * time on screen at output time o.
 */
export function clipMap(edits, start, end) {
  const cuts = (edits?.cuts || []).map((c) => [Math.max(start, c.from), Math.min(end, c.to)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  // The kept pieces: [start, end] without the cuts.
  const kept = [];
  let at = start;
  for (const [a, b] of cuts) {
    if (a > at) kept.push([at, a]);
    at = Math.max(at, b);
  }
  if (end > at) kept.push([at, end]);
  // Split by the speeds (where they overlap, the later one in the list wins).
  const speeds = (edits?.speeds || []).filter((s) => s.to > s.from);
  const parts = [];
  let out = 0;
  for (const [a, b] of kept) {
    const marks = new Set([a, b]);
    for (const s of speeds) for (const x of [s.from, s.to]) if (x > a && x < b) marks.add(x);
    const cutsAt = [...marks].sort((x, y) => x - y);
    for (let i = 0; i < cutsAt.length - 1; i++) {
      const from = cutsAt[i], to = cutsAt[i + 1];
      const mid = (from + to) / 2;
      const rate = speeds.reduce((r, s) => (mid >= s.from && mid < s.to ? s.rate : r), 1);
      const last = parts.at(-1);
      if (last && last.rate === rate && Math.abs(last.to - from) < 1e-9) { out -= (last.to - last.from) / rate; last.to = to; out += (to - last.from) / rate; continue; }
      parts.push({ from, to, rate, out });
      out += (to - from) / rate;
    }
  }
  const length = out;
  const outOf = (t) => {
    if (!parts.length) return 0;
    if (t <= parts[0].from) return 0;
    for (const p of parts) {
      if (t < p.from) return p.out; // in a cut before this part
      if (t <= p.to) return p.out + (t - p.from) / p.rate;
    }
    return length;
  };
  const sourceAt = (o) => {
    if (!parts.length) return start;
    for (const p of parts) {
      const len = (p.to - p.from) / p.rate;
      if (o < p.out + len) return p.from + Math.max(0, o - p.out) * p.rate;
    }
    return parts.at(-1).to;
  };
  /** The part playing at recording time t, or null if t is cut. */
  const partAt = (t) => parts.find((p) => t >= p.from - 1e-9 && t < p.to) || null;
  return { parts, length, outOf, sourceAt, partAt, start, end, plain: parts.length === 1 && parts[0].rate === 1 && parts[0].from === start && parts[0].to === end };
}

/** The output frames of the kept part at `fps`, at least one. */
export const clipFrames = (map, fps) => Math.max(1, Math.round(map.length * fps));

// ---------- the picture ----------

/** Whether the edits change the picture. */
export function hasSpatial(e) {
  return !!(e && (e.crop || e.blurs.length || e.zooms.length || e.callouts.length || e.background.on || e.rings?.on));
}

/** The size of the picture after the crop. */
export function croppedSize(e, w, h) {
  const c = e?.crop;
  return c ? [Math.max(2, Math.round(c.w * w)), Math.max(2, Math.round(c.h * h))] : [w, h];
}

/** How far a zoom is in at output time o: 0 (not) to 1 (fully), easing in and out. */
function zoomAmount(z, map, o) {
  const o0 = map.outOf(z.from), o1 = map.outOf(z.to);
  if (o < o0 || o >= o1) return 0;
  const ramp = Math.min(0.6, (o1 - o0) / 3);
  if (ramp <= 0) return 1;
  return ease((o - o0) / ramp) * ease((o1 - o) / ramp);
}

/** The part of the cropped picture on screen at output time o: { x, y, w, h } as fractions of it. */
export function viewAt(e, map, o) {
  let best = null, amount = 0;
  for (const z of e.zooms) {
    const a = zoomAmount(z, map, o);
    if (a > amount) { amount = a; best = z; }
  }
  if (!best) return { x: 0, y: 0, w: 1, h: 1 };
  const s = 1 + (best.scale - 1) * amount;
  const w = 1 / s, h = 1 / s;
  const cx = 0.5 + (best.x - 0.5) * amount, cy = 0.5 + (best.y - 0.5) * amount;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

const active = (r, t) => r.whole || (t >= r.from && t < r.to);
/** A callout's opacity at recording time t: fading in and out over 0.2 s. */
function calloutAlpha(c, map, o) {
  if (c.whole) return 1;
  const o0 = map.outOf(c.from), o1 = map.outOf(c.to);
  const f = Math.min(0.2, (o1 - o0) / 3);
  if (f <= 0) return 1;
  return clamp(Math.min((o - o0) / f, (o1 - o) / f), 0, 1);
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

let scratch = null;
const scratchCanvas = (w, h) => {
  if (!scratch) scratch = new OffscreenCanvas(w, h);
  if (scratch.width < w || scratch.height < h) { scratch.width = Math.max(scratch.width, w); scratch.height = Math.max(scratch.height, h); }
  return scratch;
};

/** Blurs, pixelates or covers a box of the canvas, in place. Pixelate and blur work without canvas filters, so they look the same everywhere. */
export function redactBox(ctx, b, x, y, w, h, unit) {
  x = Math.floor(x); y = Math.floor(y); w = Math.ceil(w); h = Math.ceil(h);
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const x0 = clamp(x, 0, W), y0 = clamp(y, 0, H), x1 = clamp(x + w, 0, W), y1 = clamp(y + h, 0, H);
  if (x1 - x0 < 1 || y1 - y0 < 1) return;
  if (b.mode === 'box') {
    ctx.fillStyle = '#111';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    return;
  }
  const block = Math.max(2, unit * b.strength * (b.mode === 'blur' ? 1.6 : 1));
  const tw = Math.max(1, Math.round((x1 - x0) / block)), th = Math.max(1, Math.round((y1 - y0) / block));
  const tiny = scratchCanvas(tw, th);
  const tx = tiny.getContext('2d');
  tx.clearRect(0, 0, tw, th);
  tx.imageSmoothingEnabled = true;
  tx.imageSmoothingQuality = 'high';
  tx.drawImage(ctx.canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, tw, th);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.imageSmoothingEnabled = b.mode === 'blur';
  if (b.mode === 'blur') {
    ctx.imageSmoothingQuality = 'high';
    // Drawn a little larger than the box, so its edges are soft like its middle.
    const gx = (x1 - x0) / tw, gy = (y1 - y0) / th;
    ctx.drawImage(tiny, 0, 0, tw, th, x0 - gx / 2, y0 - gy / 2, x1 - x0 + gx, y1 - y0 + gy);
  } else {
    ctx.drawImage(tiny, 0, 0, tw, th, x0, y0, x1 - x0, y1 - y0);
  }
  ctx.restore();
}

/** Draws one callout, its points already in canvas pixels; `unit` is the line width at size 1. */
export function drawCallout(ctx, c, p, unit) {
  const lw = unit * (1 + c.size);
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = c.color;
  ctx.lineWidth = lw;
  ctx.lineCap = ctx.lineJoin = 'round';
  const shadow = () => { ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = lw * 1.5; ctx.shadowOffsetY = lw * 0.3; };
  if (c.kind === 'spot') {
    const x = Math.min(p.x1, p.x2), y = Math.min(p.y1, p.y2), w = Math.abs(p.x2 - p.x1), h = Math.abs(p.y2 - p.y1);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
    roundRect(ctx, x, y, w, h, lw * 3);
    ctx.fill('evenodd');
  } else if (c.kind === 'box') {
    shadow();
    roundRect(ctx, Math.min(p.x1, p.x2), Math.min(p.y1, p.y2), Math.abs(p.x2 - p.x1), Math.abs(p.y2 - p.y1), lw * 2);
    ctx.stroke();
  } else if (c.kind === 'arrow') {
    shadow();
    const a = Math.atan2(p.y2 - p.y1, p.x2 - p.x1);
    const head = lw * 4.5;
    const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
    const back = Math.max(0, len - head * 0.8);
    ctx.beginPath();
    ctx.moveTo(p.x1, p.y1);
    ctx.lineTo(p.x1 + Math.cos(a) * back, p.y1 + Math.sin(a) * back);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x2, p.y2);
    ctx.lineTo(p.x2 - head * Math.cos(a - 0.45), p.y2 - head * Math.sin(a - 0.45));
    ctx.lineTo(p.x2 - head * Math.cos(a + 0.45), p.y2 - head * Math.sin(a + 0.45));
    ctx.closePath();
    ctx.fill();
  } else {
    // A label: the words on a rounded bubble of the colour, at the first point.
    const text = c.text.trim() || ' ';
    const fs = unit * (6 + c.size * 3);
    ctx.font = `600 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const lines = text.split('\n').slice(0, 4);
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const pad = fs * 0.55, lh = fs * 1.25;
    const w = tw + pad * 2, h = lines.length * lh + pad * 1.2;
    const x = clamp(p.x1, 0, Math.max(0, ctx.canvas.width - w)), y = clamp(p.y1, 0, Math.max(0, ctx.canvas.height - h));
    shadow();
    roundRect(ctx, x, y, w, h, fs * 0.45);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    const light = parseInt(c.color.slice(1, 3), 16) * 0.299 + parseInt(c.color.slice(3, 5), 16) * 0.587 + parseInt(c.color.slice(5, 7), 16) * 0.114 > 160;
    ctx.fillStyle = light ? '#111' : '#fff';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad * 0.6 + lh * (i + 0.5)));
  }
  ctx.restore();
}

/** A callout's box in recording fractions (for hit tests and handles). */
export function calloutBox(c) {
  return { x: Math.min(c.x1, c.x2), y: Math.min(c.y1, c.y2), w: Math.abs(c.x2 - c.x1), h: Math.abs(c.y2 - c.y1) };
}

const RING_TIME = 0.7; // seconds a click's ring shows

/** A click's ring, at canvas point (x, y), `p` (0–1) of the way through. */
export function drawRing(ctx, rings, x, y, p, unit) {
  const s = 0.6 + rings.size * 0.4;
  const grow = 1 - (1 - p) ** 3;
  ctx.save();
  ctx.globalAlpha = 1 - p;
  ctx.fillStyle = ctx.strokeStyle = rings.color;
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = unit * 3;
  ctx.lineWidth = unit * 2.5 * s;
  ctx.beginPath();
  ctx.arc(x, y, unit * s * (8 + 24 * grow), 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = (1 - p) * 0.45;
  ctx.beginPath();
  ctx.arc(x, y, unit * s * 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Draws the edited picture for one moment: `draw(ctx, source, t, o)` puts the
 * recording's frame `source` with the crop, zoom, blurs, callouts and click rings
 * for recording time t (output time o) on a canvas of `width` × `height` (the
 * cropped size). The background, if on, is drawn by `backgroundRenderer` around
 * it. `clicks`: [{ t, x, y }] where the recording was clicked (recording fractions).
 */
export function composer(edits, map, srcW, srcH, clicks = []) {
  const e = edits;
  const crop = e.crop || { x: 0, y: 0, w: 1, h: 1 };
  const [width, height] = croppedSize(e, srcW, srcH);
  const unit = Math.max(1, Math.min(width, height) / 400);
  // Each click in a part kept, at its time in the output.
  const rings = e.rings?.on ? (clicks || []).filter((c) => map.partAt(c.t)).map((c) => ({ x: c.x, y: c.y, o: map.outOf(c.t) })) : [];
  const draw = (ctx, source, t, o) => {
    const v = viewAt(e, map, o);
    // The recording's pixels on screen, in recording fractions.
    const vx = crop.x + v.x * crop.w, vy = crop.y + v.y * crop.h, vw = v.w * crop.w, vh = v.h * crop.h;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, vx * srcW, vy * srcH, vw * srcW, vh * srcH, 0, 0, width, height);
    // Recording fractions to canvas pixels.
    const X = (fx) => ((fx - vx) / vw) * width, Y = (fy) => ((fy - vy) / vh) * height;
    const zoom = 1 / v.w;
    for (const b of e.blurs) if (active(b, t)) redactBox(ctx, b, X(b.x), Y(b.y), (b.w / vw) * width, (b.h / vh) * height, unit * zoom);
    for (const c of e.callouts) {
      if (!active(c, t)) continue;
      const a = calloutAlpha(c, map, o);
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      drawCallout(ctx, c, { x1: X(c.x1), y1: Y(c.y1), x2: X(c.x2), y2: Y(c.y2) }, unit * zoom);
      ctx.globalAlpha = 1;
    }
    for (const r of rings) {
      const p = (o - r.o) / RING_TIME;
      if (p >= 0 && p < 1) drawRing(ctx, e.rings, X(r.x), Y(r.y), p, unit * zoom);
    }
  };
  return { width, height, draw };
}

/**
 * The background around the picture, as a renderer like a device frame's (see
 * lib/device.js): `render(ctx, source)` draws the whole picture, `source` (w × h)
 * on it with padding, rounded corners and a shadow.
 */
export function backgroundRenderer(bg, w, h) {
  const pad = Math.round((Math.min(w, h) * bg.padding) / 100);
  let W = w + pad * 2, H = h + pad * 2;
  const want = ASPECTS[bg.aspect];
  if (want) {
    if (W / H < want) W = Math.round(H * want); else H = Math.round(W / want);
  }
  W = Math.round(W / 2) * 2; H = Math.round(H / 2) * 2;
  const x = Math.round((W - w) / 2), y = Math.round((H - h) / 2);
  const r = (Math.min(w, h) * bg.radius) / 100;
  const under = new OffscreenCanvas(W, H);
  const u = under.getContext('2d');
  if (bg.kind === 'gradient') {
    const g = u.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, bg.c1);
    g.addColorStop(1, bg.c2);
    u.fillStyle = g;
  } else u.fillStyle = bg.c1;
  u.fillRect(0, 0, W, H);
  if (bg.shadow && pad > 0) {
    u.save();
    u.shadowColor = 'rgba(0,0,0,0.35)';
    u.shadowBlur = Math.max(4, pad * 0.6);
    u.shadowOffsetY = Math.max(2, pad * 0.15);
    u.fillStyle = '#000';
    roundRect(u, x, y, w, h, r);
    u.fill();
    u.restore();
  }
  return {
    width: W,
    height: H,
    transparent: false,
    info: { background: true },
    render(ctx, source) {
      ctx.drawImage(under, 0, 0);
      ctx.save();
      roundRect(ctx, x, y, w, h, r);
      ctx.clip();
      ctx.drawImage(source, x, y, w, h);
      ctx.restore();
    },
  };
}

// ---------- the sound ----------

/** Whether the edits change the sound (beyond leaving parts out). */
export function touchesAudio(e) {
  return !!(e && (e.audio.volume !== 1 || e.audio.fadeIn || e.audio.fadeOut || e.audio.mutes.length));
}

/**
 * The sound's loudness at recording time t, played at output time u of `total`
 * (seconds, with slides): the volume, the fades at the ends, muted parts, and short
 * ramps where a part was cut or sped up, so the joins don't click.
 */
export function audioGain(e, map, total) {
  const { volume, fadeIn, fadeOut, mutes } = e.audio;
  const R = 0.012; // ramp at joins (s)
  const M = 0.02; // ramp into a muted part (s)
  return (t, u, part) => {
    let g = volume;
    if (fadeIn > 0) g *= Math.min(1, u / fadeIn);
    if (fadeOut > 0) g *= Math.min(1, Math.max(0, (total - u) / fadeOut));
    if (part) g *= Math.min(1, (t - part.from) / R, (part.to - t) / R);
    for (const m of mutes) {
      if (t > m.from - M && t < m.to + M) g *= clamp(Math.max(m.from - t, t - m.to) / M, 0, 1);
    }
    return Math.max(0, g);
  };
}
