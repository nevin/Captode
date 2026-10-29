// Slides: title cards put into a recording at a moment in it. While an inserted slide
// is on screen the recording waits, then carries on from the same frame; an overlay
// is drawn over the recording as it plays, with no background. Slides are drawn
// by this one module in the video page's preview, the export worker and the in-page
// fallback, so what is previewed is what is exported. Sizes are relative to the
// picture, so a slide looks the same at any resolution or shape.
//
// A slide: {
//   id, at (s, in the recording), duration (s), fade,
//   mode ('insert' | 'overlay'), band (an overlay's shade behind its words),
//   bandColor, bandOpacity (0–100, of the band), slideIn (an overlay slides in from
//   the left and out again), whole (an overlay kept over all of the kept part),
//   layout ('center' | 'left' | 'split' | 'lower'), title, subtitle, body,
//   theme, font ('sans' | 'serif' | 'mono' | 'custom': fontFile, a font file Blob called fontName),
//   titleColor, textColor, accent,
//   bgKind ('solid' | 'gradient' | 'image'), bg1, bg2, bgImage (Blob), bgDim (0–90),
//   logo (Blob), logoPos ('tl' | 'tr' | 'bl' | 'br' | 'top'), logoSize (% of the height),
//   logoAt ({ x, y }: the logo's centre, as fractions of the picture, once dragged; else logoPos),
//   textAt ({ x, y }: how far the words were dragged from their layout's place, as fractions), textSize (%),
//   picture (Blob, shown by the 'split' layout)
// }

export const THEMES = {
  midnight: { bgKind: 'gradient', bg1: '#0f172a', bg2: '#312e81', titleColor: '#ffffff', textColor: '#c7d2fe', accent: '#818cf8', font: 'sans' },
  paper: { bgKind: 'solid', bg1: '#ffffff', bg2: '#eef2f7', titleColor: '#0f172a', textColor: '#475569', accent: '#5b4bff', font: 'sans' },
  indigo: { bgKind: 'gradient', bg1: '#5b4bff', bg2: '#a855f7', titleColor: '#ffffff', textColor: '#ede9fe', accent: '#ffffff', font: 'sans' },
  sunset: { bgKind: 'gradient', bg1: '#f97316', bg2: '#db2777', titleColor: '#ffffff', textColor: '#ffedd5', accent: '#ffffff', font: 'sans' },
  ocean: { bgKind: 'gradient', bg1: '#0369a1', bg2: '#0d9488', titleColor: '#ffffff', textColor: '#ccfbf1', accent: '#5eead4', font: 'sans' },
  editorial: { bgKind: 'solid', bg1: '#f5f0e6', bg2: '#e7dcc8', titleColor: '#1c1917', textColor: '#57534e', accent: '#b45309', font: 'serif' },
  terminal: { bgKind: 'solid', bg1: '#0a0f0d', bg2: '#052e16', titleColor: '#4ade80', textColor: '#a7f3d0', accent: '#4ade80', font: 'mono' },
};

/** What "style" means when a new slide copies one: everything but its words and timing. */
export const STYLE_KEYS = ['band', 'bandColor', 'bandOpacity', 'theme', 'layout', 'font', 'titleColor', 'textColor', 'accent', 'bgKind', 'bg1', 'bg2', 'bgImage', 'bgDim', 'logo', 'logoPos', 'logoSize', 'logoAt', 'fontFile', 'fontName'];

export function newSlide(at, style = {}) {
  const s = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    at, duration: 3, fade: true, mode: 'insert', band: true, slideIn: false, whole: false,
    layout: 'center', title: '', subtitle: '', body: '',
    theme: 'midnight', ...THEMES.midnight,
    bgImage: null, bgDim: 40, logo: null, logoPos: 'tr', logoSize: 10, logoAt: null, picture: null,
    textAt: null, textSize: 100, fontFile: null, fontName: '',
    ...style,
  };
  // Ids go into the page's markup and selectors: only plain ones are kept (a file may hold anything).
  if (typeof s.id !== 'string' || !/^[\w-]{1,64}$/.test(s.id)) s.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  // The band is in the background colour unless chosen otherwise.
  s.bandColor ??= s.bg1;
  s.bandOpacity ??= 82;
  return s;
}

/** An overlay is drawn over the recording; any other slide is put into it. */
export const isOverlay = (s) => s.mode === 'overlay';

const FONTS = {
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

// ---------- images ----------

const decoded = new WeakMap(); // Blob -> Promise<ImageBitmap | null>

function bitmap(blob) {
  if (!blob) return Promise.resolve(null);
  if (!decoded.has(blob)) decoded.set(blob, createImageBitmap(blob).catch(() => null));
  return decoded.get(blob);
}

// Font files are added to the page's or the worker's fonts under a name of their own,
// once each, so the preview and the export draw with the same font.
const fonts = new WeakMap(); // Blob -> Promise<family name | null>
let fontCount = 0;

/** Loads a font file (WOFF2, WOFF, TrueType or OpenType). Resolves to its family name here, or null if it isn't one. */
export function loadFontFile(blob) {
  if (!blob) return Promise.resolve(null);
  if (!fonts.has(blob)) {
    fonts.set(blob, (async () => {
      const name = `Captode slide font ${++fontCount}`;
      const face = new FontFace(name, await blob.arrayBuffer());
      await face.load();
      (globalThis.document?.fonts || globalThis.fonts).add(face);
      return name;
    })().catch(() => null));
  }
  return fonts.get(blob);
}

/** The pictures (and font) a slide shows, ready to draw: `{ bg, logo, picture, font }`. */
export async function slideImages(s) {
  const [bg, logo, picture, font] = await Promise.all([
    s.bgKind === 'image' && !isOverlay(s) ? bitmap(s.bgImage) : null,
    bitmap(s.logo),
    s.layout === 'split' ? bitmap(s.picture) : null,
    s.font === 'custom' ? loadFontFile(s.fontFile) : null,
  ]);
  return { bg, logo, picture, font };
}

/** Where `img` goes in a box to fill it ('cover') or fit inside it ('contain'). */
function fit(img, x, y, w, h, mode) {
  const iw = img.width, ih = img.height;
  const k = mode === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
  const dw = iw * k, dh = ih * k;
  return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh };
}

// ---------- text ----------

/** Splits a paragraph into lines no wider than `max`. Words too long (or text without spaces, as in Chinese or Japanese) break between characters. */
function wrap(ctx, text, max) {
  const lines = [];
  const fits = (s) => ctx.measureText(s).width <= max;
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) { line = next; continue; }
    if (line) { lines.push(line); line = ''; }
    if (fits(word)) { line = word; continue; }
    // Too long for a line of its own: by character.
    for (const ch of word) {
      if (line && !fits(line + ch)) { lines.push(line); line = ''; }
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** The text block, laid out to fit `box` (shrinking it until it does). */
function layoutText(ctx, s, box, u, family) {
  const parts = [];
  if (s.title?.trim()) parts.push({ text: s.title.trim(), size: 6.2, weight: 700, color: s.titleColor, lh: 1.12, gap: 0 });
  if (s.subtitle?.trim()) parts.push({ text: s.subtitle.trim(), size: 3.1, weight: 500, color: s.textColor, lh: 1.3, gap: 1.6 });
  if (s.body?.trim()) parts.push({ text: s.body.trim(), size: 2.3, weight: 400, color: s.textColor, lh: 1.45, gap: 2.8, alpha: 0.92 });
  if (!parts.length) return null;
  const bar = { w: 7 * u, h: 0.55 * u, gap: 2.6 * u };
  for (const scale of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42, 0.35, 0.28]) {
    let height = bar.h + bar.gap * scale;
    let width = 0;
    const laid = parts.map((p, i) => {
      const px = p.size * u * scale;
      ctx.font = `${p.weight} ${px}px ${family}`;
      // The description keeps its own lines; "- " or "* " at the start makes a bullet.
      const lines = p.text.split('\n').flatMap((para) => {
        const text = para.trim().replace(/^[-*•]\s+/, '• ');
        return text ? wrap(ctx, text, box.w) : [''];
      });
      const gap = i ? p.gap * u * scale : 0;
      height += gap + lines.length * px * p.lh;
      width = Math.max(width, ...lines.map((l) => ctx.measureText(l).width));
      return { ...p, px, lines, gap, font: ctx.font };
    });
    if (height <= box.h || scale === 0.28) return { parts: laid, height, width, bar: { ...bar, gap: bar.gap * scale } };
  }
  return null;
}

// ---------- drawing ----------

/** A slide's background over the whole picture: a colour, a gradient or a picture. */
function drawBackground(ctx, s, W, H, imgs) {
  ctx.fillStyle = s.bg1;
  ctx.fillRect(0, 0, W, H);
  if (s.bgKind === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, s.bg1);
    g.addColorStop(1, s.bg2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  } else if (s.bgKind === 'image' && imgs.bg) {
    const r = fit(imgs.bg, 0, 0, W, H, 'cover');
    ctx.drawImage(imgs.bg, r.x, r.y, r.w, r.h);
    if (s.bgDim) {
      ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(90, s.bgDim) / 100})`;
      ctx.fillRect(0, 0, W, H);
    }
  }
}

/**
 * Draws slide `s` over the whole of a `W` × `H` context. `imgs` from `slideImages`.
 * An overlay leaves everything but its words, pictures and band transparent.
 * Returns where the logo and the words went (`{ logo, text }`, rects or null), for
 * the preview to move them with the pointer.
 */
export function drawSlide(ctx, s, W, H, imgs = {}) {
  const overlay = isOverlay(s);
  ctx.save();
  ctx.globalAlpha = 1;

  if (!overlay) drawBackground(ctx, s, W, H, imgs);

  // 1u is 1% of the width of a 16:9 picture that fits; on tall pictures the width rules.
  const u = Math.min(W, (H * 16) / 9) / 100;
  const pad = Math.max(6 * u, Math.min(W, H) * 0.07);
  const margin = pad * 0.6;

  // Logo: placed now, drawn last, and the text keeps clear of it.
  let logo = null;
  if (imgs.logo) {
    let h = (Math.max(2, Math.min(40, s.logoSize || 10)) / 100) * H;
    let w = (imgs.logo.width / imgs.logo.height) * h;
    if (w > W * 0.4) { h *= (W * 0.4) / w; w = W * 0.4; }
    const pos = s.logoPos || 'tr';
    if (s.logoAt) {
      // Dragged: wherever it was put, kept inside the picture.
      const x = Math.max(0, Math.min(W - w, s.logoAt.x * W - w / 2));
      const y = Math.max(0, Math.min(H - h, s.logoAt.y * H - h / 2));
      logo = { x, y, w, h, free: true };
    } else {
      const x = pos === 'tl' || pos === 'bl' ? margin : pos === 'top' ? (W - w) / 2 : W - margin - w;
      const y = pos === 'bl' || pos === 'br' ? H - margin - h : margin;
      logo = { x, y, w, h, top: pos !== 'bl' && pos !== 'br' };
    }
  }

  // The words keep clear of a logo in a corner; one that was dragged goes where it's put.
  const box = { x: pad, y: pad, w: W - 2 * pad, h: H - 2 * pad };
  if (logo?.free) { /* nothing to keep clear of */ } else if (logo?.top) { const top = logo.y + logo.h + 2 * u; if (top > box.y) { box.h -= top - box.y; box.y = top; } }
  if (logo && !logo.top && !logo.free) { const bottom = logo.y - 2 * u; if (bottom < box.y + box.h) box.h = bottom - box.y; }

  const layout = s.layout === 'split' && !imgs.picture ? 'left' : s.layout || 'center';
  let pictureBox = null;
  if (layout === 'split') {
    if (W >= H) {
      const half = (box.w - pad) / 2;
      pictureBox = { x: box.x + half + pad, y: box.y, w: half, h: box.h };
      box.w = half;
    } else {
      const h = (box.h - pad) * 0.48;
      pictureBox = { x: box.x, y: box.y, w: box.w, h };
      box.y += h + pad;
      box.h -= h + pad;
    }
  } else if (layout === 'left') {
    box.w = Math.min(box.w, W * 0.72);
  } else if (layout === 'lower' && !overlay && s.bgKind === 'image' && imgs.bg) {
    // A shade behind the words, so they read over any picture.
    const g = ctx.createLinearGradient(0, H * 0.4, 0, H);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0.6)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H * 0.4, W, H * 0.6);
  }

  if (pictureBox) {
    const r = fit(imgs.picture, pictureBox.x, pictureBox.y, pictureBox.w, pictureBox.h, 'contain');
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 3 * u;
    ctx.shadowOffsetY = 0.8 * u;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 1.2 * u);
    ctx.fillStyle = s.bg1;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.clip();
    ctx.drawImage(imgs.picture, r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  const tu = u * Math.max(0.5, Math.min(2, (s.textSize || 100) / 100)); // the words' unit, after Text size
  // A font file of the user's own, with the usual sans serif for any character it lacks.
  const family = s.font === 'custom' && imgs.font ? `"${imgs.font}", ${FONTS.sans}` : FONTS[s.font] || FONTS.sans;
  const text = box.w > u && box.h > u ? layoutText(ctx, s, box, tu, family) : null;
  let textRect = null;
  if (text) {
    const center = layout === 'center';
    ctx.textAlign = center ? 'center' : 'left';
    ctx.textBaseline = 'top';
    let x = center ? box.x + box.w / 2 : box.x;
    let y = layout === 'lower' ? box.y + box.h - text.height : box.y + (box.h - text.height) / 2;
    y = Math.max(box.y, y);
    // Dragged: moved from there, but kept inside the picture.
    const tw = Math.max(text.width, text.bar.w);
    if (s.textAt) {
      const left = (center ? x - tw / 2 : x) + s.textAt.x * W;
      const shift = Math.max(0, Math.min(W - tw, left)) - (center ? x - tw / 2 : x);
      x += shift;
      y = Math.max(0, Math.min(H - text.height, y + s.textAt.y * H));
    }
    const m = 1.2 * u; // a little room around the words, to point at
    textRect = { x: (center ? x - tw / 2 : x) - m, y: y - m, w: tw + 2 * m, h: text.height + 2 * m };
    if (overlay && s.band) {
      // A band behind the words, so they read over any recording.
      const p = 2.2 * u;
      const w = Math.max(text.width, text.bar.w);
      ctx.fillStyle = s.bandColor || s.bg1;
      ctx.globalAlpha = Math.max(0, Math.min(100, s.bandOpacity ?? 82)) / 100;
      ctx.beginPath();
      ctx.roundRect((center ? x - w / 2 : x) - p, y - p, w + 2 * p, text.height + 2 * p, 1.2 * u);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // A short bar in the accent colour leads into the words.
    ctx.fillStyle = s.accent;
    ctx.beginPath();
    ctx.roundRect(center ? x - text.bar.w / 2 : x, y, text.bar.w, text.bar.h, text.bar.h / 2);
    ctx.fill();
    y += text.bar.h + text.bar.gap;
    for (const p of text.parts) {
      y += p.gap;
      ctx.font = p.font;
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha ?? 1;
      for (const line of p.lines) {
        ctx.fillText(line, x, y + ((p.lh - 1) * p.px) / 2);
        y += p.px * p.lh;
      }
      ctx.globalAlpha = 1;
    }
  }

  if (logo) ctx.drawImage(imgs.logo, logo.x, logo.y, logo.w, logo.h);
  ctx.restore();
  return { logo: logo && { x: logo.x, y: logo.y, w: logo.w, h: logo.h }, text: textRect };
}

/** Each scheduled slide drawn once at the output size, to copy into every frame it shows on. */
export async function renderSlides(schedule, W, H) {
  const out = new Map();
  for (const e of schedule) {
    const c = new OffscreenCanvas(W, H);
    drawSlide(c.getContext('2d'), e.s, W, H, await slideImages(e.s));
    out.set(e, c);
  }
  return out;
}

// ---------- timing ----------

/**
 * The slides that fall in the exported part (`start` to `end`, seconds), in the order
 * they show: each with `k`, the frame of the clip it comes before (`count` for after
 * the last), and `frames`, how many output frames it lasts.
 */
export function slideSchedule(slides = [], start, end, fps, map = null) {
  const count = map ? Math.max(1, Math.round(map.length * fps)) : Math.max(1, Math.round((end - start) * fps));
  // `map` (lib/video-edits.js): where each moment of the recording plays, with parts cut or sped up.
  const frameOf = (at) => Math.round((map ? map.outOf(at) : at - start) * fps);
  return slides
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !isOverlay(s) && s.at >= start - 1e-3 && s.at <= end + 1e-3)
    .map(({ s, i }) => ({ s, i, k: Math.min(count, Math.max(0, frameOf(s.at))), frames: Math.max(1, Math.round(s.duration * fps)) }))
    .sort((a, b) => a.k - b.k || a.s.at - b.s.at || a.i - b.i);
}

/**
 * Every output frame in order: `{ k, slide, j }`, where `k` is the clip's frame
 * (shown alone, or under a fading slide) and `slide` the schedule entry showing,
 * on its frame `j`, or null.
 */
export function frameOrder(schedule, count) {
  const out = [];
  let n = 0;
  const slideFrames = (e, k) => { for (let j = 0; j < e.frames; j++) out.push({ k, slide: e, j }); };
  for (let k = 0; k < count; k++) {
    while (n < schedule.length && schedule[n].k <= k) slideFrames(schedule[n++], k);
    out.push({ k, slide: null, j: 0 });
  }
  while (n < schedule.length) slideFrames(schedule[n++], count - 1);
  return out;
}

/** How opaque a slide is on its frame `j`: it fades in and out over 0.4 s if asked. */
export function slideAlpha(e, j, fps) {
  if (!e.s.fade) return 1;
  const f = Math.min(Math.round(fps * 0.4), Math.floor(e.frames / 3));
  if (f < 1) return 1;
  return Math.min(1, (j + 1) / (f + 1), (e.frames - j) / (f + 1));
}

/** Seconds of slides in a schedule. */
export const slideSeconds = (schedule, fps) => schedule.reduce((n, e) => n + e.frames, 0) / fps;

/**
 * For audio: how far (µs) the sound at source time `t` (µs) moves later in the
 * output, as every slide shown before it pushes it back.
 */
export function slideShift(schedule, fps) {
  const frameUs = 1e6 / fps;
  const at = schedule.map((e) => ({ t: e.k * frameUs, by: e.frames * frameUs }));
  /** How far (µs) the sound at output time `u` (µs, before slides) moves later. */
  return (u) => at.reduce((n, x) => (x.t <= u ? n + x.by : n), 0);
}

export function audioShift(schedule, startUs, fps) {
  const frameUs = 1e6 / fps;
  const at = schedule.map((e) => ({ t: startUs + e.k * frameUs, by: e.frames * frameUs }));
  return (t) => at.reduce((n, x) => (x.t <= t ? n + x.by : n), 0);
}

// ---------- overlays ----------

/**
 * The overlays that show in the exported part, each with `from`, the clip frame it
 * starts on (below 0 if it started before `start`), and `frames`, how many it lasts.
 * They go by the clip's frames, so they stay put while an inserted slide shows.
 */
export function overlaySchedule(slides = [], start, end, fps, map = null) {
  const frameOf = (at) => Math.round((map && at > start ? map.outOf(at) : at - start) * fps);
  return slides
    .filter((s) => isOverlay(s) && s.at < end - 1e-3 && s.at + s.duration > start + 1e-3)
    .map((s) => ({ s, from: frameOf(s.at), frames: Math.max(1, Math.round(s.duration * fps)) }))
    .sort((a, b) => a.s.at - b.s.at);
}

/**
 * How an overlay looks on its frame `j`: `a`, how opaque, and `dx`, how far left it
 * is moved (a fraction of the width) while it slides in or out over 0.5 s.
 */
export function overlayLook(e, j, fps) {
  if (!e.s.slideIn) return { a: slideAlpha(e, j, fps), dx: 0 };
  const f = Math.min(Math.round(fps * 0.5), Math.floor(e.frames / 3));
  if (f < 1) return { a: 1, dx: 0 };
  const p = Math.min(1, (j + 1) / (f + 1), (e.frames - j) / (f + 1));
  return { a: e.s.fade ? p : 1, dx: -0.12 * (1 - p) ** 3 }; // eased: quick at first, settling in place
}

/** The overlays showing on clip frame `k` (it may be fractional), each with how it looks: `[{ e, a, dx }]`. */
export function overlaysAt(overlays, k, fps) {
  return overlays
    .filter((e) => k >= e.from && k < e.from + e.frames)
    .map((e) => ({ e, ...overlayLook(e, Math.floor(k - e.from), fps) }));
}

/** Draws the overlays showing on clip frame `k` over what is in `ctx`. `art` from `renderSlides`. */
export function paintOverlays(ctx, overlays, art, k, fps) {
  for (const { e, a, dx } of overlaysAt(overlays, k, fps)) {
    const c = art.get(e);
    ctx.globalAlpha = a;
    ctx.drawImage(c, dx * c.width, 0);
  }
  ctx.globalAlpha = 1;
}

// ---------- slides as a file, and styles kept by name ----------
// Slides (or a style) go out as plain JSON, with their pictures and font file as data:
// URLs. What comes back in is from elsewhere, so only known fields with sensible values
// are taken; anything else is dropped.

const BLOB_KEYS = ['bgImage', 'logo', 'picture', 'fontFile'];
const COLOUR_KEYS = ['titleColor', 'textColor', 'accent', 'bg1', 'bg2', 'bandColor'];
const CHOICES = {
  mode: ['insert', 'overlay'], layout: ['center', 'left', 'split', 'lower'], font: ['sans', 'serif', 'mono', 'custom'],
  bgKind: ['solid', 'gradient', 'image'], logoPos: ['tl', 'tr', 'bl', 'br', 'top'], theme: Object.keys(THEMES),
};
const NUMBERS = { at: [0, 86400], duration: [0.5, 86400], bgDim: [0, 90], logoSize: [2, 40], textSize: [50, 200], bandOpacity: [0, 100] };
const TEXTS = { title: 500, subtitle: 500, body: 4000, fontName: 100 };
const FLAGS = ['fade', 'band', 'slideIn', 'whole'];
const POINTS = { logoAt: [0, 1], textAt: [-1, 1] };
// Pictures as Captode keeps them (SVG is turned into PNG when chosen), and font files.
const IMAGE_URL = /^data:image\/(png|jpeg|webp|gif|avif);base64,[a-z0-9+/=]+$/i;
const FONT_URL = /^data:(font\/(ttf|otf|woff|woff2|sfnt)|application\/(octet-stream|font-woff|font-sfnt|x-font-ttf|x-font-otf|vnd\.ms-opentype));base64,[a-z0-9+/=]+$/i;
const MAX_URL = 12e6; // characters: about 9 MB of file

async function toDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

/** Slide fields as plain JSON (no id). Files over `maxBlob` bytes are left out. */
export async function portable(fields, { maxBlob = Infinity } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'id') continue;
    out[k] = BLOB_KEYS.includes(k) ? (v && v.size <= maxBlob ? await toDataUrl(v) : null) : v;
  }
  return out;
}

/** Slide fields from JSON that came from elsewhere: only what is known and sensible, files as Blobs. */
export async function cleanFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  const has = (k) => Object.hasOwn(raw, k);
  for (const k of COLOUR_KEYS) if (typeof raw[k] === 'string' && /^#[0-9a-f]{6}$/i.test(raw[k])) out[k] = raw[k];
  for (const [k, list] of Object.entries(CHOICES)) if (list.includes(raw[k])) out[k] = raw[k];
  for (const [k, [lo, hi]] of Object.entries(NUMBERS)) if (Number.isFinite(raw[k])) out[k] = Math.max(lo, Math.min(hi, raw[k]));
  for (const [k, max] of Object.entries(TEXTS)) if (typeof raw[k] === 'string') out[k] = raw[k].slice(0, max);
  for (const k of FLAGS) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  for (const [k, [lo, hi]] of Object.entries(POINTS)) {
    const p = raw[k];
    if (p === null && has(k)) out[k] = null;
    else if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out[k] = { x: Math.max(lo, Math.min(hi, p.x)), y: Math.max(lo, Math.min(hi, p.y)) };
  }
  for (const k of BLOB_KEYS) {
    const v = raw[k];
    if (v === null && has(k)) { out[k] = null; continue; }
    const ok = typeof v === 'string' && v.length <= MAX_URL && (k === 'fontFile' ? FONT_URL : IMAGE_URL).test(v);
    if (ok) out[k] = await (await fetch(v)).blob();
  }
  // A custom font without its file: the usual sans serif.
  if (out.font === 'custom' && !out.fontFile) out.font = 'sans';
  return out;
}

/** The slides as a file's contents. */
export async function slidesFile(slides) {
  return { type: 'captode-slides', version: 1, slides: await Promise.all(slides.map((s) => portable(s))) };
}

/** The slides' fields from a file's contents (at most 200), or null if it isn't one. */
export async function readSlidesFile(json) {
  if (json?.type !== 'captode-slides' || !Array.isArray(json.slides)) return null;
  return Promise.all(json.slides.slice(0, 200).map(cleanFields));
}
