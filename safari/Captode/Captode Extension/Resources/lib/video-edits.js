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
//   speeds:   [{ id, from, to, rate, ease }]           parts played faster (silent); ease: speeding up and slowing down gradually
//   blurs:    [{ id, from, to, whole, x, y, w, h, mode ('blur' | 'pixelate' | 'box'), strength (1–10) }]
//   crop:     { x, y, w, h } | null                    the part of the picture kept
//   zooms:    [{ id, from, to, x, y, scale }]          x, y: the centre, in the crop
//   callouts: [{ id, from, to, whole, kind ('arrow' | 'box' | 'ellipse' | 'step' | 'text' | 'spot'), x1, y1, x2, y2, text, color, size (1–3) }]
//             (a step's text is its number or letter)
//   background: { on, kind ('solid' | 'gradient'), c1, c2, padding (%), radius (%), shadow, aspect ('auto' | '16:9' | '1:1' | '9:16' | '4:3') }
//   audio:    { volume (0–2), fadeIn (s), fadeOut (s), mutes: [{ id, from, to }], clean (background
//             noise lowered between words), level (loudness evened out) }
//   rings:    { on, color, size (1–3) }                 a ring where each recorded click was
//   captions: [{ id, from, to, text, size (1–3) }]     words along the bottom (also as subtitles)
//   captionStyle: { font, color, band ('dark' | 'light' | 'none' | 'outline'), place ('bottom' | 'top' | 'middle'),
//             highlight (each word lit up as it is said), hcolor }   how every caption looks
//   layers:   [{ id, from, to, src, offset, pos ('br' | 'bl' | 'tr' | 'tl' | 'c' | 'free'), x, y, size (0.1–1), shape ('rect' | 'circle'), aspect, sound, volume (0–2) }]
//             another video over the picture: `src` names its file (kept beside the
//             edits), `offset` is where in it the layer starts (s), `size` its width
//             as a fraction of the output's, `aspect` its width / height; with pos
//             'free', x and y are its centre (output fractions). `sound`: its video has
//             sound, mixed in at `volume` (0: none, as layers made before it had);
//             `opacity` (0.1–1), `shadow`, `border` (a colour, or 'none'), and `fade` (s)
//             in and out, picture and sound. `kind`: 'video' (the default), 'image'
//             (src names a picture), 'sound' (a voiceover: src is sound alone, nothing
//             shown) or 'text' (no src: `text` in `color` on `bg`
//             ('none' | 'dark' | 'light')). `move`: it glides from where it starts (pos, x,
//             y, size) to x2, y2 (its centre) at size2 by its end
//   music:    { src, name, volume (0–2), fadeIn, fadeOut (s), duck, loop, offset (s) } | null
//             a sound under the whole output: its file kept beside the edits as `src`;
//             duck: quieter while the recording (or a layer) is heard
//   chapters: [{ id, at, title }]                       sections, at recording times
//   subtitleTracks: [{ id, lang, texts: { [caption id]: text } }]   the captions in more
//             languages, timed by the captions themselves; with captionStyle.embed they
//             go into MP4 and WebM files as subtitles viewers can turn on, as do the captions
//             (in captionStyle.lang). captionStyle.burn false: captions aren't drawn on the picture
// }

import { PALETTE, roundRect, drawArrow, drawEllipse, drawStep } from './shapes.js';
import { drawLogo } from './brand.js';

export const RATES = [1.5, 2, 4, 8];
export const ZOOMS = [1.25, 1.5, 2, 3];
export const ASPECTS = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1, '9:16': 9 / 16 };
export const CALLOUT_COLOURS = PALETTE; // the editor's, so both offer the same colours
export const CALLOUT_KINDS = ['arrow', 'box', 'ellipse', 'step', 'text', 'spot'];
export const LAYER_POSITIONS = ['tl', 'tr', 'c', 'bl', 'br', 'free'];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const frac = (v, d = 0) => clamp(num(v, d), 0, 1);
const ease = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p * p * (3 - 2 * p));
let lastId = 0;
export const editId = () => `e${Date.now().toString(36)}${(++lastId).toString(36)}`;

export const DEFAULT_BACKGROUND = { on: false, kind: 'gradient', c1: '#5b4bff', c2: '#a855f7', padding: 6, radius: 2, shadow: true, aspect: 'auto' };
export const DEFAULT_AUDIO = { volume: 1, fadeIn: 0, fadeOut: 0, mutes: [], clean: false, level: false };
export const DEFAULT_RINGS = { on: false, color: '#f5a524', size: 2 };
export const CAPTION_FONTS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", Nunito, "Arial Rounded MT Bold", system-ui, sans-serif',
  serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
// As captions always looked: white on a dark band along the bottom.
export const DEFAULT_CAPTION_STYLE = { font: 'sans', color: '#ffffff', band: 'dark', place: 'bottom', highlight: false, hcolor: '#ffd60a', burn: true, embed: false, lang: '' };

/** Empty edits. */
export const noEdits = () => ({ cuts: [], speeds: [], blurs: [], crop: null, zooms: [], callouts: [], background: { ...DEFAULT_BACKGROUND }, audio: { ...DEFAULT_AUDIO, mutes: [] }, rings: { ...DEFAULT_RINGS }, captions: [], captionStyle: { ...DEFAULT_CAPTION_STYLE }, layers: [], music: null, chapters: [], subtitleTracks: [] });

/** An edit's id as saved, if it is a plain one (ids go into the page's markup and selectors), else `fallback`. */
const plainId = (v, fallback) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : fallback);

function range(r, i = 0) {
  const from = Math.max(0, num(r?.from, 0));
  return { id: plainId(r?.id, `e${i}`), from, to: Math.max(from + 0.05, num(r?.to, from + 1)) };
}
const box = (r) => {
  const x = frac(r?.x), y = frac(r?.y);
  return { x, y, w: clamp(num(r?.w, 0.2), 0.01, 1 - x), h: clamp(num(r?.h, 0.2), 0.01, 1 - y) };
};
/** A language tag such as 'en' or 'zh-Hant', or '' when it isn't one. */
const langTag = (v) => (typeof v === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v) ? v : '');
const colour = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);

/** Edits as saved or imported, checked and with every field present. */
export function normaliseEdits(raw = {}) {
  const e = noEdits();
  const list = (a) => (Array.isArray(a) ? a : []);
  e.cuts = list(raw.cuts).map((r, i) => (r?.silence ? { ...range(r, i), silence: true } : range(r, i)));
  e.speeds = list(raw.speeds).map((r, i) => ({ ...range(r, i), rate: RATES.includes(Number(r.rate)) ? Number(r.rate) : 2, ease: !!r?.ease }));
  e.blurs = list(raw.blurs).map((r, i) => ({
    ...range(r, i), ...box(r), whole: !!r.whole,
    mode: ['blur', 'pixelate', 'box'].includes(r.mode) ? r.mode : 'blur', strength: clamp(Math.round(num(r.strength, 5)), 1, 10),
  }));
  e.crop = raw.crop ? box(raw.crop) : null;
  if (e.crop && e.crop.w > 0.995 && e.crop.h > 0.995) e.crop = null;
  e.zooms = list(raw.zooms).map((r, i) => ({ ...range(r, i), x: frac(r.x, 0.5), y: frac(r.y, 0.5), scale: clamp(num(r.scale, 2), 1.1, 4), auto: !!r.auto, ...(r.follow ? { follow: true } : {}) }));
  e.callouts = list(raw.callouts).map((r, i) => ({
    ...range(r, i), whole: !!r.whole,
    kind: CALLOUT_KINDS.includes(r.kind) ? r.kind : 'arrow',
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
    mutes: list(a.mutes).map(range), clean: !!a.clean, level: !!a.level,
  };
  const g = raw.rings || {};
  e.rings = { on: !!g.on, color: colour(g.color, DEFAULT_RINGS.color), size: clamp(Math.round(num(g.size, 2)), 1, 3) };
  e.captions = list(raw.captions).map((r, i) => ({ ...range(r, i), text: String(r?.text ?? '').slice(0, 300), size: clamp(Math.round(num(r?.size, 2)), 1, 3) }));
  const cs = raw.captionStyle || {};
  e.captionStyle = {
    font: cs.font in CAPTION_FONTS ? cs.font : 'sans', color: colour(cs.color, '#ffffff'),
    band: ['dark', 'light', 'none', 'outline'].includes(cs.band) ? cs.band : 'dark',
    place: ['bottom', 'top', 'middle'].includes(cs.place) ? cs.place : 'bottom',
    highlight: !!cs.highlight, hcolor: colour(cs.hcolor, DEFAULT_CAPTION_STYLE.hcolor),
    burn: cs.burn !== false, embed: !!cs.embed, lang: langTag(cs.lang),
  };
  const ids = new Set(e.captions.map((c) => c.id));
  e.subtitleTracks = list(raw.subtitleTracks).filter((r) => langTag(r?.lang) && r.texts && typeof r.texts === 'object').slice(0, 8).map((r, i) => ({
    id: plainId(r.id, `s${i}`), lang: langTag(r.lang),
    texts: Object.fromEntries(Object.entries(r.texts).filter(([k, v]) => ids.has(k) && typeof v === 'string').map(([k, v]) => [k, v.slice(0, 300)])),
  }));
  e.layers = list(raw.layers).filter((r) => r?.kind === 'text' || (typeof r?.src === 'string' && r.src)).map((r, i) => ({
    ...range(r, i), src: typeof r.src === 'string' ? r.src : '',
    kind: ['image', 'text', 'sound'].includes(r.kind) ? r.kind : 'video',
    ...(r.kind === 'text' ? { text: String(r.text ?? '').slice(0, 200), color: colour(r.color, '#ffffff'), bg: ['none', 'dark', 'light'].includes(r.bg) ? r.bg : 'dark' } : {}), offset: Math.max(0, num(r.offset, 0)),
    pos: LAYER_POSITIONS.includes(r.pos) ? r.pos : 'br', size: clamp(num(r.size, 0.3), 0.1, 1),
    shape: r.shape === 'circle' ? 'circle' : 'rect', aspect: clamp(num(r.aspect, 16 / 9), 0.1, 10),
    x: frac(r.x, 0.5), y: frac(r.y, 0.5), sound: !!r.sound || r.kind === 'sound', volume: r.sound || r.kind === 'sound' ? clamp(num(r.volume, 1), 0, 2) : 0,
    opacity: clamp(num(r.opacity, 1), 0.1, 1), shadow: !!r.shadow, border: r.border === 'none' ? 'none' : colour(r.border, '#ffffff'),
    fade: clamp(num(r.fade, 0), 0, 3),
    ...(r.move ? { move: true, x2: frac(r.x2, frac(r.x, 0.5)), y2: frac(r.y2, frac(r.y, 0.5)), size2: clamp(num(r.size2, num(r.size, 0.3)), 0.1, 1) } : {}),
  }));
  const m = raw.music;
  e.music = m && typeof m.src === 'string' && m.src ? {
    src: m.src, name: String(m.name ?? '').slice(0, 120), volume: clamp(num(m.volume, 0.5), 0, 2),
    fadeIn: clamp(num(m.fadeIn, 1), 0, 10), fadeOut: clamp(num(m.fadeOut, 2), 0, 10),
    duck: m.duck !== false, loop: m.loop !== false, offset: Math.max(0, num(m.offset, 0)),
  } : null;
  e.chapters = list(raw.chapters).map((c, i) => ({ id: plainId(c?.id, `h${i}`), at: Math.max(0, num(c?.at, 0)), title: String(c?.title ?? '').slice(0, 100) }))
    .sort((a, b) => a.at - b.at);
  return e;
}

/** Whether the edits change anything at all. */
export function hasEdits(e) {
  return !!(e && (e.cuts.length || e.speeds.length || hasSpatial(e) || touchesAudio(e) || e.layers?.length || e.music));
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
  // Split by the speeds (where they overlap, the later one in the list wins). One that
  // eases gets steps up to its rate at its start and back down at its end.
  const speeds = (edits?.speeds || []).filter((s) => s.to > s.from).flatMap((s) => {
    if (!s.ease || s.rate <= 1) return [s];
    const d = Math.min(0.6, (s.to - s.from) / 3), steps = 3;
    const out = [s];
    for (let k = 0; k < steps; k++) {
      const rate = 1 + ((s.rate - 1) * (k + 1)) / (steps + 1);
      out.push({ from: s.from + (d * k) / steps, to: s.from + (d * (k + 1)) / steps, rate });
      out.push({ from: s.to - (d * (k + 1)) / steps, to: s.to - (d * k) / steps, rate });
    }
    return out;
  });
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
  return !!(e && (e.crop || e.blurs.length || e.zooms.length || e.callouts.length || e.background.on || e.rings?.on || e.captions?.some((c) => c.text.trim())));
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

/**
 * Where the pointer was, smoothed like a camera following it: `at(t)` → { x, y } in
 * recording fractions at recording time t, from `moves` [{ t, x, y }]; null without any.
 */
export function pointerPath(moves) {
  const list = (moves || []).filter((m) => Number.isFinite(m.t) && Number.isFinite(m.x) && Number.isFinite(m.y)).sort((a, b) => a.t - b.t);
  if (!list.length) return null;
  const STEP = 0.05, LAG = 0.45; // s between samples; how far behind the pointer the camera follows
  const t0 = list[0].t, n = Math.ceil((list.at(-1).t - t0 + 4 * LAG) / STEP) + 2; // and on, until it settles
  const xs = new Float32Array(n), ys = new Float32Array(n);
  const k = 1 - Math.exp(-STEP / LAG);
  let j = 0, x = list[0].x, y = list[0].y;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * STEP;
    while (j + 1 < list.length && list[j + 1].t <= t) j++;
    x += (list[j].x - x) * k;
    y += (list[j].y - y) * k;
    xs[i] = x; ys[i] = y;
  }
  return {
    at(t) {
      const f = clamp((t - t0) / STEP, 0, n - 1), i = Math.floor(f), w = f - i, i2 = Math.min(n - 1, i + 1);
      return { x: xs[i] + (xs[i2] - xs[i]) * w, y: ys[i] + (ys[i2] - ys[i]) * w };
    },
  };
}

/**
 * The part of the cropped picture on screen at output time o (recording time t):
 * { x, y, w, h } as fractions of it. A zoom with `follow` is centred where `path`
 * (pointerPath) says the pointer is.
 */
export function viewAt(e, map, o, t = null, path = null) {
  let best = null, amount = 0;
  for (const z of e.zooms) {
    const a = zoomAmount(z, map, o);
    if (a > amount) { amount = a; best = z; }
  }
  if (!best) return { x: 0, y: 0, w: 1, h: 1 };
  const s = 1 + (best.scale - 1) * amount;
  const w = 1 / s, h = 1 / s;
  let { x: zx, y: zy } = best;
  if (best.follow && path && t !== null) {
    const p = path.at(t), c = e.crop || { x: 0, y: 0, w: 1, h: 1 };
    zx = clamp((p.x - c.x) / c.w, 0, 1);
    zy = clamp((p.y - c.y) / c.h, 0, 1);
  }
  const cx = 0.5 + (zx - 0.5) * amount, cy = 0.5 + (zy - 0.5) * amount;
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
  } else if (c.kind === 'ellipse') {
    shadow();
    drawEllipse(ctx, Math.min(p.x1, p.x2), Math.min(p.y1, p.y2), Math.abs(p.x2 - p.x1), Math.abs(p.y2 - p.y1));
  } else if (c.kind === 'step') {
    // A numbered step at the first point, as the editor draws them.
    drawStep(ctx, p.x1, p.y1, unit * (18 + c.size * 8), c.text.trim().slice(0, 3) || '1', c.color);
  } else if (c.kind === 'arrow') {
    shadow();
    drawArrow(ctx, p.x1, p.y1, p.x2, p.y2, lw);
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

/**
 * Draws a caption in its style (white on a dark band along the bottom unless chosen
 * otherwise): at most three lines, the same size whatever the zoom. `p` (0–1): how far
 * through the caption it is, to light up the word being said when `style.highlight`.
 */
export function drawCaption(ctx, c, unit, style = DEFAULT_CAPTION_STYLE, p = null) {
  const text = c.text.trim();
  if (!text) return;
  const st = { ...DEFAULT_CAPTION_STYLE, ...(style || {}) };
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const fs = unit * (8 + c.size * 3);
  ctx.save();
  ctx.font = `${st.font === 'mono' ? 500 : 600} ${fs}px ${CAPTION_FONTS[st.font] || CAPTION_FONTS.sans}`;
  const max = W * 0.84;
  // Lines of tokens (words with their spaces; characters in languages without spaces).
  const lines = [];
  for (const para of text.split('\n')) {
    let line = [];
    const words = /\s/.test(para) ? para.split(/(\s+)/).filter(Boolean) : [...para];
    for (const w of words) {
      const next = [...line, w];
      if (line.join('').trim() && ctx.measureText(next.join('')).width > max) { lines.push(line); line = /^\s+$/.test(w) ? [] : [w]; } else line = next;
    }
    lines.push(line);
  }
  const trim = (l) => { const x = [...l]; while (x.length && /^\s+$/.test(x[0])) x.shift(); while (x.length && /^\s+$/.test(x.at(-1))) x.pop(); return x; };
  const shown = lines.map(trim).filter((l) => l.length).slice(-3);
  const lh = fs * 1.3, padX = fs * 0.6, padY = fs * 0.35;
  const width = Math.min(W, Math.max(...shown.map((l) => ctx.measureText(l.join('')).width)) + padX * 2);
  const height = shown.length * lh + padY * 2;
  const x = (W - width) / 2;
  const y = st.place === 'top' ? H * 0.06 : st.place === 'middle' ? (H - height) / 2 : H - H * 0.06 - height;
  if (st.band === 'dark' || st.band === 'light') {
    ctx.fillStyle = st.band === 'light' ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.72)';
    roundRect(ctx, x, y, width, height, fs * 0.3);
    ctx.fill();
  } else if (st.band === 'none') {
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = fs * 0.25;
  }
  // The word being said: words share the caption's time by their length.
  const words = shown.flat().filter((w) => !/^\s+$/.test(w));
  let lit = -1;
  if (st.highlight && p !== null && words.length) {
    const lens = words.map((w) => w.length + 2), total = lens.reduce((n, v) => n + v, 0);
    let acc = 0;
    lit = words.length - 1;
    for (let k = 0; k < words.length; k++) { acc += lens[k]; if (p * total < acc) { lit = k; break; } }
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  let n = 0;
  shown.forEach((l, i) => {
    let at = W / 2 - ctx.measureText(l.join('')).width / 2;
    const ly = y + padY + lh * (i + 0.5);
    for (const w of l) {
      const ww = ctx.measureText(w).width;
      if (!/^\s+$/.test(w)) {
        if (st.band === 'outline') {
          ctx.lineWidth = fs * 0.18;
          ctx.strokeStyle = 'rgba(0,0,0,0.9)';
          ctx.strokeText(w, at, ly);
        }
        ctx.fillStyle = n === lit ? st.hcolor : st.color;
        ctx.fillText(w, at, ly);
        n++;
      }
      at += ww;
    }
  });
  ctx.restore();
}

/**
 * The captions as subtitle cues in the exported video's time: [{ start, end, text }],
 * leaving out those in cut parts. `extra(t)`: seconds of slides played before
 * recording time t.
 */
export function captionCues(e, map, extra = () => 0) {
  return e.captions
    .filter((c) => c.text.trim())
    .map((c) => {
      const a = Math.max(c.from, map.start), b = Math.min(c.to, map.end);
      return { id: c.id, start: map.outOf(a) + extra(a), end: map.outOf(b) + extra(a), text: c.text.trim() };
    })
    .filter((c) => c.end - c.start > 0.05)
    .sort((x, y) => x.start - y.start);
}

/**
 * The subtitle tracks an MP4 or WebM gets, from the captions' `cues` (captionCues):
 * the captions in their language, then each other language, timed the same. None
 * unless captionStyle.embed.
 */
export function subtitleTracks(e, cues) {
  if (!e.captionStyle?.embed || !cues.length) return null;
  const out = [{ lang: e.captionStyle.lang || 'und', cues: cues.map(({ start, end, text }) => ({ start, end, text })) }];
  for (const tr of e.subtitleTracks || []) {
    const list = cues.filter((c) => tr.texts[c.id]?.trim()).map((c) => ({ start: c.start, end: c.end, text: tr.texts[c.id].trim() }));
    if (list.length) out.push({ lang: tr.lang, cues: list });
  }
  return out;
}

// Filler words, in the languages Captode speaks; those written without spaces are found anywhere.
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'hmm', 'mm', 'äh', 'ähm', 'öhm', 'hm', 'euh', 'heu', 'ehm', 'eh', 'em', 'este', 'hum', 'ãh', 'é', 'tipo']);
const FILLERS_CJK = ['えーと', 'えっと', 'えー', 'あのー', '嗯', '呃', '那个', '음', '어'];

/**
 * Filler words in the captions: [{ id (the caption's), word, index (its word number),
 * from, to (s, where it is likely said: its share of the caption's time) }].
 */
export function findFillers(captions) {
  const out = [];
  for (const c of captions || []) {
    const words = c.text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const each = (c.to - c.from) / words.length;
    words.forEach((w, i) => {
      const bare = w.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      if (!FILLERS.has(bare) && !FILLERS_CJK.some((f) => bare === f || (bare.length <= 4 && bare.startsWith(f)))) return;
      const from = c.from + i * each;
      out.push({ id: c.id, word: w, index: i, from: Math.round(from * 100) / 100, to: Math.round(Math.min(c.to, from + Math.max(0.2, each)) * 100) / 100 });
    });
  }
  return out;
}

/** A caption's text without the words numbered in `drop`, tidied. */
export function withoutWords(text, drop) {
  return text.trim().split(/\s+/).filter((_, i) => !drop.has(i)).join(' ').replace(/^[,.;:]\s*/, '').replace(/\s+([,.;:!?])/g, '$1');
}

/** Subtitle cues from an SRT or WebVTT file's text: [{ start, end, text }] (s). */
export function parseSubtitles(text) {
  const time = (s) => {
    const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s);
    return m ? (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000 : NaN;
  };
  const out = [];
  for (const block of String(text).replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = time(a), end = time(b);
    const words = lines.slice(i + 1).join('\n').replace(/<[^>]*>/g, '').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && words) out.push({ start, end, text: words.slice(0, 300) });
  }
  return out.slice(0, 5000);
}

/**
 * Words from file cues (output time) for each caption cue they overlap most: { [id]: text },
 * so a subtitle file of these captions, translated elsewhere, follows them.
 */
export function matchSubtitles(cues, fileCues) {
  const out = {};
  for (const f of fileCues) {
    let best = null, most = 0;
    for (const c of cues) {
      const o = Math.min(c.end, f.end) - Math.max(c.start, f.start);
      if (o > most) { most = o; best = c; }
    }
    if (best) out[best.id] = out[best.id] ? `${out[best.id]} ${f.text}` : f.text;
  }
  for (const k of Object.keys(out)) out[k] = out[k].slice(0, 300);
  return out;
}

const stamp = (s, sep) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
};
/** Cues as an SRT or WebVTT file's text. */
export function subtitles(cues, format = 'srt') {
  if (format === 'vtt') return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}\n`).join('\n')}`;
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`).join('\n');
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
 * it. `clicks`: [{ t, x, y }] where the recording was clicked (recording fractions);
 * `moves`, the same for where the pointer was, for zooms that follow it.
 */
export function composer(edits, map, srcW, srcH, clicks = [], logo = null, moves = null) {
  const e = edits;
  const path = e.zooms.some((z) => z.follow) ? pointerPath(moves) : null;
  const crop = e.crop || { x: 0, y: 0, w: 1, h: 1 };
  const [width, height] = croppedSize(e, srcW, srcH);
  const unit = Math.max(1, Math.min(width, height) / 400);
  // Each click in a part kept, at its time in the output.
  const rings = e.rings?.on ? (clicks || []).filter((c) => map.partAt(c.t)).map((c) => ({ x: c.x, y: c.y, o: map.outOf(c.t) })) : [];
  const draw = (ctx, source, t, o) => {
    const v = viewAt(e, map, o, t, path);
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
    for (const c of e.captionStyle?.burn === false ? [] : e.captions || []) {
      if (!active(c, t)) continue;
      const a = calloutAlpha(c, map, o);
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      drawCaption(ctx, c, unit, e.captionStyle, (t - c.from) / Math.max(0.01, c.to - c.from));
      ctx.globalAlpha = 1;
    }
    if (logo) drawLogo(ctx, logo, 0, 0, width, height);
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
  return !!(e && (e.audio.volume !== 1 || e.audio.fadeIn || e.audio.fadeOut || e.audio.mutes.length || e.audio.clean || e.audio.level));
}

/**
 * The recording's sound cleaned up, as a loudness to multiply by at each moment:
 * `{ step, g }` (g a Float32Array, one value each `step` s), from its `levels`
 * (lib/audio-levels.js). `clean` lowers what is heard between words (background noise),
 * `level` brings quiet and loud speech towards the same loudness. Null when neither.
 */
export function soundCurve(levels, { clean = false, level = false } = {}) {
  if (!levels?.rms?.length || (!clean && !level)) return null;
  const { step, rms } = levels, n = rms.length;
  // Smoothed over about a third of a second, so single words aren't pumped.
  const W = Math.max(1, Math.round(0.175 / step)), L = new Float32Array(n), P = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) P[i + 1] = P[i] + rms[i];
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - W), b = Math.min(n, i + W + 1); L[i] = (P[b] - P[a]) / (b - a); }
  const heard = Array.from(L).filter((v) => v > 1e-5).sort((a, b) => a - b);
  if (!heard.length) return null;
  const floor = heard[Math.floor(heard.length * 0.1)];
  const quiet = Math.max(floor * 2.5, 0.004); // below this: nobody speaking
  const speech = heard.filter((v) => v > quiet);
  const target = speech.length ? speech[Math.floor(speech.length / 2)] : 0;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let x = 1;
    if (level && target && L[i] > quiet) x *= clamp(target / L[i], 0.6, 2.5);
    if (clean && L[i] <= quiet) x *= 0.2;
    g[i] = x;
  }
  // Eased both ways, so it never clicks: about 0.1 s.
  const k = 1 - Math.exp(-step / 0.1);
  for (let i = 1; i < n; i++) g[i] = g[i - 1] + (g[i] - g[i - 1]) * k;
  for (let i = n - 2; i >= 0; i--) g[i] = g[i + 1] + (g[i] - g[i + 1]) * k;
  return { step, g };
}
const curveAt = (c, t) => {
  if (!c) return 1;
  const f = t / c.step, i = Math.max(0, Math.min(c.g.length - 1, Math.floor(f)));
  const j = Math.min(c.g.length - 1, i + 1), w = clamp(f - i, 0, 1);
  return c.g[i] + (c.g[j] - c.g[i]) * w;
};

/**
 * The sound's loudness at recording time t, played at output time u of `total`
 * (seconds, with slides): the volume, the fades at the ends, muted parts, and short
 * ramps where a part was cut or sped up, so the joins don't click.
 */
export function audioGain(e, map, total, curve = null) {
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
    if (curve) g *= curveAt(curve, t);
    return Math.max(0, g);
  };
}

// ---------- video layers ----------

/** Whether the edits put any video over the picture. */
export const hasLayers = (e) => !!e?.layers?.length;

/** The layers playing at recording time t, bottom first (voiceovers too, which show nothing). */
export const layersAt = (e, t) => (e?.layers || []).filter((l) => t >= l.from && t < l.to);
/** The layers seen at recording time t: not voiceovers. */
export const shownLayersAt = (e, t) => layersAt(e, t).filter((l) => l.kind !== 'sound');

/** Where in its own video a layer is at recording time t (s). */
export const layerTime = (l, t) => l.offset + Math.max(0, t - l.from);

/**
 * A layer's box in a W × H output at recording time t: its size and corner, inside a
 * small margin; a moving layer's is on its way from its start to its end.
 */
export function layerBox(l, W, H, t = null) {
  if (l.move && t !== null) {
    const a = placeBox(l, W, H), b = placeBox(layerEnd(l), W, H);
    const p = ease(clamp((t - l.from) / Math.max(0.01, l.to - l.from), 0, 1));
    return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, w: a.w + (b.w - a.w) * p, h: a.h + (b.h - a.h) * p };
  }
  return placeBox(l, W, H);
}

/** Where a moving layer ends: as a layer placed there. */
export const layerEnd = (l) => ({ ...l, pos: 'free', x: l.x2, y: l.y2, size: l.size2 });

function placeBox(l, W, H) {
  const m = Math.round(Math.min(W, H) * 0.03);
  let w = l.size * (W - 2 * m);
  const aspect = l.kind === 'text' ? textArt(l).aspect : l.aspect;
  let h = l.shape === 'circle' ? w : w / aspect;
  if (h > H - 2 * m) { w *= (H - 2 * m) / h; h = H - 2 * m; }
  if (l.pos === 'free') {
    // Its centre where it was dragged, kept inside the picture.
    return { x: clamp(l.x * W - w / 2, 0, W - w), y: clamp(l.y * H - h / 2, 0, H - h), w, h };
  }
  const x = l.pos.endsWith('l') ? m : l.pos.endsWith('r') ? W - m - w : (W - w) / 2;
  const y = l.pos[0] === 't' ? m : l.pos[0] === 'b' ? H - m - h : (H - h) / 2;
  return { x, y, w, h };
}

/**
 * How much of layer `l` shows at recording time t (0–1): its fade in and out. Its sound
 * follows it, with a short ramp even without a fade so it doesn't click.
 */
export function layerAlpha(l, t, sound = false) {
  const f = Math.max(l.fade || 0, sound ? 0.02 : 0);
  if (!f) return 1;
  const d = Math.min(f, (l.to - l.from) / 2);
  return clamp(Math.min((t - l.from) / d, (l.to - t) / d), 0, 1);
}

/**
 * Draws layer `l` with `frame` (a video element, VideoFrame or image) over a W × H
 * output at recording time t: filling its box (a circle crops the middle), with its
 * edge, shadow, opacity and fade.
 */
export function drawLayer(ctx, l, frame, W, H, t = l.from + (l.to - l.from) / 2) {
  const sw = frame.displayWidth || frame.videoWidth || frame.width, sh = frame.displayHeight || frame.videoHeight || frame.height;
  if (!sw || !sh) return;
  const b = layerBox(l, W, H, t);
  const s = Math.max(b.w / sw, b.h / sh);
  const cw = b.w / s, ch = b.h / s;
  const path = new Path2D();
  if (l.shape === 'circle') path.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
  else if (path.roundRect) path.roundRect(b.x, b.y, b.w, b.h, Math.min(b.w, b.h) * 0.05);
  else path.rect(b.x, b.y, b.w, b.h);
  const alpha = (l.opacity ?? 1) * layerAlpha(l, t);
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (l.shadow) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = Math.min(W, H) * 0.03;
    ctx.shadowOffsetY = Math.min(W, H) * 0.008;
    ctx.fillStyle = '#000';
    ctx.fill(path);
    ctx.restore();
  }
  ctx.save();
  ctx.clip(path);
  ctx.drawImage(frame, (sw - cw) / 2, (sh - ch) / 2, cw, ch, b.x, b.y, b.w, b.h);
  ctx.restore();
  if (l.border !== 'none') {
    ctx.lineWidth = Math.max(1.5, Math.min(W, H) * 0.004);
    ctx.strokeStyle = l.border || '#ffffff';
    ctx.stroke(path);
  }
  ctx.restore();
}

/** Layers whose sound is mixed in. */
export const soundingLayers = (e) => (e?.layers || []).filter((l) => ((l.kind || 'video') === 'video' || l.kind === 'sound') && l.sound && l.volume > 0);

const texts = new Map(); // what a text layer looks like → its picture
/**
 * A text layer's picture: its words on a rounded band (or none), at a fixed size the
 * layer is scaled from. `{ canvas, aspect }`; the same text gives the same canvas.
 */
export function textArt(l) {
  const key = JSON.stringify([l.text, l.color, l.bg]);
  if (texts.has(key)) return texts.get(key);
  const lines = (l.text || ' ').split('\n').slice(0, 6);
  const size = 96, pad = l.bg === 'none' ? 8 : 36, lh = size * 1.2;
  const font = `700 ${size}px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const probe = new OffscreenCanvas(1, 1).getContext('2d');
  probe.font = font;
  const w = Math.ceil(Math.max(...lines.map((x) => probe.measureText(x).width), size)) + pad * 2;
  const h = Math.ceil(lines.length * lh) + pad * 2;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (l.bg !== 'none') {
    ctx.fillStyle = l.bg === 'light' ? 'rgba(255,255,255,0.92)' : 'rgba(10,10,16,0.78)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, w, h, size * 0.3); else ctx.rect(0, 0, w, h);
    ctx.fill();
  }
  ctx.font = font;
  ctx.fillStyle = l.color || '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (l.bg === 'none') { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = size * 0.12; }
  lines.forEach((x, i) => ctx.fillText(x, w / 2, pad + lh * (i + 0.5)));
  const out = { canvas, aspect: w / h };
  if (texts.size > 50) texts.clear();
  texts.set(key, out);
  return out;
}

/** Whether there is sound to export: layers' or the music's (the recording's is known to the page). */
export const extraSound = (e) => soundingLayers(e).length > 0 || !!e?.music;

// ---------- transitions between clips ----------

export const TRANSITIONS = ['none', 'fade', 'cross'];
export const TRANSITION_S = 0.5;

/**
 * Where joined clips meet with a transition: [{ at (s, where the next clip starts),
 * kind }], from the clips ([{ len, trans }], lib/join.js).
 */
export function clipTransitions(clips) {
  const out = [];
  let at = 0;
  (clips || []).forEach((c, i) => {
    if (i && (c.trans === 'fade' || c.trans === 'cross')) out.push({ at, kind: c.trans });
    at += c.len;
  });
  return out;
}

/**
 * The transition showing at recording time t: { kind: 'fade', black (0–1) } through
 * black around the join, or { kind: 'cross', at, alpha } over the start of the next
 * clip (the last frame before the join fading out over it); null when none.
 */
export function transitionAt(transitions, t) {
  const d = TRANSITION_S;
  for (const x of transitions || []) {
    if (x.kind === 'fade' && Math.abs(t - x.at) < d) return { kind: 'fade', black: 1 - Math.abs(t - x.at) / d };
    if (x.kind === 'cross' && t >= x.at && t < x.at + 2 * d) return { kind: 'cross', at: x.at, alpha: 1 - (t - x.at) / (2 * d) };
  }
  return null;
}

/**
 * Draws the clips' transitions over each output frame (`apply`, after the frame at
 * recording time t is on `ctx`). A crossfade keeps the last frame drawn before its
 * join, so frames must come in time order to show it (the export, or playing).
 */
export function transitionPainter(transitions) {
  const snaps = new Map(); // join time → the last frame drawn before it
  return {
    apply(ctx, t, W, H) {
      for (const x of transitions || []) {
        if (x.kind !== 'cross' || t >= x.at || t < x.at - 0.3) continue;
        let c = snaps.get(x.at);
        if (!c || c.width !== W || c.height !== H) { c = new OffscreenCanvas(W, H); snaps.set(x.at, c); }
        const g = c.getContext('2d');
        g.clearRect(0, 0, W, H);
        g.drawImage(ctx.canvas, 0, 0, W, H);
      }
      const tr = transitionAt(transitions, t);
      if (!tr) return;
      ctx.save();
      if (tr.kind === 'fade') {
        ctx.globalAlpha = tr.black;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
      } else if (snaps.has(tr.at)) {
        ctx.globalAlpha = tr.alpha;
        ctx.drawImage(snaps.get(tr.at), 0, 0, W, H);
      }
      ctx.restore();
    },
  };
}
