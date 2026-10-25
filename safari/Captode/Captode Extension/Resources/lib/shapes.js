// Drawing shared by the screenshot editor, the video page's callouts and the
// step-by-step guide, so arrows, outlines and numbered steps look the same wherever
// they are drawn. Each function draws on a 2D context in that canvas's pixels.

/** Relative luminance of a #rrggbb colour, 0 (black) to 1 (white). (Here too, so the export worker needs nothing more.) */
function luminance(hex) {
  const v = [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

/** The colours offered for annotations and callouts. */
export const PALETTE = ['#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#0090ff', '#5b4bff', '#17171c', '#ffffff'];

/** Starts a path of a rectangle with corners rounded by `r`. */
export function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A filled arrowhead at (x2, y2), pointing away from (x1, y1); returns its length. */
export function arrowHead(ctx, x1, y1, x2, y2, width) {
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

/**
 * An arrow from (x1, y1) to (x2, y2) in the context's stroke and fill style, `width`
 * wide, with a head at the end (and at the start too when `heads` is 2). The shaft
 * stops inside the heads, so its end doesn't poke out of their points.
 */
export function drawArrow(ctx, x1, y1, x2, y2, width, heads = 1) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const size = arrowHead(ctx, x1, y1, x2, y2, width);
  if (heads === 2) arrowHead(ctx, x2, y2, x1, y1, width);
  const k1 = len ? Math.max(0, len - size * 0.7) / len : 0;
  const k0 = heads === 2 && len ? Math.min(k1, (size * 0.7) / len) : 0;
  ctx.beginPath();
  ctx.moveTo(x1 + (x2 - x1) * k0, y1 + (y2 - y1) * k0);
  ctx.lineTo(x1 + (x2 - x1) * k1, y1 + (y2 - y1) * k1);
  ctx.stroke();
}

/** A smooth line through `points` ([[x, y]]), stroked. */
export function drawStroke(ctx, points) {
  const p = points;
  ctx.beginPath();
  ctx.moveTo(p[0][0], p[0][1]);
  if (p.length === 1) ctx.lineTo(p[0][0] + 0.01, p[0][1]);
  for (let i = 1; i < p.length - 1; i++) {
    ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
  }
  if (p.length > 1) ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
  ctx.stroke();
}

/** The outline (and fill, when `fill` is a colour) of the ellipse in a box. */
export function drawEllipse(ctx, x, y, w, h, fill = null) {
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, Math.PI * 2);
  if (fill) { ctx.save(); ctx.fillStyle = fill; ctx.fill(); ctx.restore(); }
  ctx.stroke();
}

/** A numbered step: a disc of `color`, `size` across, with a white ring and its number. */
export function drawStep(ctx, x, y, size, label, color) {
  const r = size / 2;
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = r * 0.35;
  ctx.shadowOffsetY = r * 0.1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = Math.max(1.5, size * 0.06);
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  const text = String(label);
  const fs = r * (text.length >= 3 ? 0.78 : text.length === 2 ? 0.95 : 1.1);
  ctx.font = `700 ${fs}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = luminance(color) > 0.55 ? '#17171c' : '#ffffff';
  ctx.fillText(text, x, y + fs * 0.04);
  ctx.restore();
}
