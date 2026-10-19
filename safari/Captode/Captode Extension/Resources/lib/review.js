// Measuring and colour checks, shared by the image editor and the video page.

import { t } from './i18n.js';

/** WCAG 2 relative luminance of a #rrggbb colour. */
export function luminance(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

/** WCAG 2 contrast ratio of two colours. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The contrast readout: the ratio, and AA and AAA for normal and large text, as HTML. */
export function contrastHtml(a, b) {
  const ratio = contrast(a, b);
  const mark = (ok, label) => `<span class="${ok ? 'pass' : 'fail'}">${t(ok ? 'wcag_pass' : 'wcag_fail', label)}</span>`;
  return `${t('contrast_label')} <b>${ratio.toFixed(2)} : 1</b><br>` +
    `${t('contrast_normal')}: ${mark(ratio >= 4.5, 'AA')} · ${mark(ratio >= 7, 'AAA')}<br>` +
    `${t('contrast_large')}: ${mark(ratio >= 3, 'AA')} · ${mark(ratio >= 4.5, 'AAA')}`;
}

export const hexOf = (d) => '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');

/** A length in image pixels as CSS pixels, at `ratio` image pixels per CSS pixel. */
export function cssLength(v, ratio) {
  const n = v / ratio;
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}

/** A measurement in words: "120 px", or "120 × 40 px · 126 px long". */
export function measureText(m, ratio) {
  const dx = Math.abs(m.x2 - m.x1), dy = Math.abs(m.y2 - m.y1);
  const c = (v) => cssLength(v, ratio);
  if (dx < 0.5 || dy < 0.5) return `${c(Math.max(dx, dy))} px`;
  return t('measure_box', [`${c(dx)} × ${c(dy)}`, c(Math.hypot(dx, dy))]);
}

/** A measurement's label on the image: "120 px", or "120 × 40 px · 126 px". */
export function measureLabel(m, ratio) {
  const dx = Math.abs(m.x2 - m.x1), dy = Math.abs(m.y2 - m.y1);
  const c = (v) => cssLength(v, ratio);
  if (dx < 0.5 || dy < 0.5) return `${c(Math.max(dx, dy))} px`;
  return t('measure_box_short', [`${c(dx)} × ${c(dy)}`, c(Math.hypot(dx, dy))]);
}

/**
 * The edge nearest (x, y) along `axis` in a picture of `w` × `h` pixels, within `r`
 * pixels, or the point itself where nothing changes clearly. An edge is where the
 * colour changes most locally (so a soft, anti-aliased edge counts once, at its
 * middle); the nearest clear one wins, not the strongest, as in design tools.
 * `read(x, y, w, h)` returns RGBA pixels.
 */
export function edgeNear(read, w, h, x, y, axis, r) {
  const at0 = axis === 'x' ? x : y;
  const lo = Math.max(0, at0 - r);
  const hi = Math.min(axis === 'x' ? w : h, at0 + r);
  if (hi - lo < 2 || x < 0 || y < 0 || x > w || y > h) return at0;
  const row = axis === 'x' ? read(lo, Math.min(h - 1, Math.max(0, y)), hi - lo, 1) : read(Math.min(w - 1, Math.max(0, x)), lo, 1, hi - lo);
  // d[i]: the change between pixel i - 1 and i, that is, at the boundary lo + i.
  const d = new Float32Array(hi - lo + 1);
  let strongest = 0;
  for (let i = 1; i < hi - lo; i++) {
    d[i] = Math.abs(row[i * 4] - row[i * 4 - 4]) + Math.abs(row[i * 4 + 1] - row[i * 4 - 3]) + Math.abs(row[i * 4 + 2] - row[i * 4 - 2]);
    strongest = Math.max(strongest, d[i]);
  }
  const clear = Math.max(30, strongest * 0.35);
  let at = at0, best = Infinity;
  for (let i = 1; i < hi - lo; i++) {
    if (d[i] < clear || d[i] < d[i - 1] || d[i] < d[i + 1]) continue; // not a clear peak
    const dist = Math.abs(lo + i - at0);
    if (dist < best) { best = dist; at = lo + i; }
  }
  return at;
}

/**
 * Where a measurement from `a` to `p` ends up: straightened when nearly straight (or
 * with Shift), and with both ends snapped to edges along its direction unless `free`.
 */
export function measureFrom(a, p, { shift = false, free = false, snapAt = null } = {}) {
  const end = { x: Math.round(p.x), y: Math.round(p.y) };
  const across = Math.abs(end.x - a.x) >= Math.abs(end.y - a.y);
  const dx = Math.abs(end.x - a.x), dy = Math.abs(end.y - a.y);
  if (shift || (!free && Math.min(dx, dy) <= Math.max(dx, dy) * 0.07)) { if (across) end.y = a.y; else end.x = a.x; }
  const start = { ...a };
  if (!free && snapAt) {
    const axis = across ? 'x' : 'y';
    start[axis] = snapAt(a.x, a.y, axis);
    end[axis] = snapAt(end.x, end.y, axis);
  }
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/** Draws measurements as pink lines with end ticks and a label, `px` image pixels a screen pixel. */
export function drawMeasures(ctx, list, px, label) {
  for (const m of list) {
    const len = Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
    if (len < 0.5) continue;
    ctx.save();
    ctx.strokeStyle = '#ff3d9a';
    ctx.fillStyle = '#ff3d9a';
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath();
    ctx.moveTo(m.x1, m.y1);
    ctx.lineTo(m.x2, m.y2);
    const nx = -(m.y2 - m.y1) / len * 6 * px, ny = (m.x2 - m.x1) / len * 6 * px;
    for (const [x, y] of [[m.x1, m.y1], [m.x2, m.y2]]) { ctx.moveTo(x - nx, y - ny); ctx.lineTo(x + nx, y + ny); }
    ctx.stroke();
    const text = label(m);
    ctx.font = `600 ${12 * px}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 10 * px, h = 18 * px;
    const lx = (m.x1 + m.x2) / 2 - w / 2, ly = (m.y1 + m.y2) / 2 - h - 6 * px;
    ctx.beginPath();
    ctx.roundRect(lx, ly, w, h, 4 * px);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx + 5 * px, ly + h / 2);
    ctx.restore();
  }
}
