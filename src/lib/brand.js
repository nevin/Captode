// Your logo: a small image chosen once in Settings, added to a corner of screenshots
// and recordings when you want it. Kept on this device in chrome.storage.local.

export const POSITIONS = ['br', 'bl', 'tr', 'tl'];
const SIZES = { 1: 0.1, 2: 0.15, 3: 0.22 }; // the logo's width, as a part of the picture's shorter side
const MAX_SIDE = 600; // logos are stored at most this many pixels across

export const DEFAULT_BRAND = { image: '', position: 'br', size: 2, opacity: 0.9, images: false, videos: false };

/** The logo and how it's placed, from storage. */
export async function getBrand() {
  try {
    const { brand } = await chrome.storage.local.get('brand');
    const b = { ...DEFAULT_BRAND, ...(brand && typeof brand === 'object' ? brand : {}) };
    if (!POSITIONS.includes(b.position)) b.position = 'br';
    b.size = SIZES[b.size] ? b.size : 2;
    b.opacity = Math.min(1, Math.max(0.1, Number(b.opacity) || 0.9));
    if (typeof b.image !== 'string' || !b.image.startsWith('data:image/')) b.image = '';
    return b;
  } catch { return { ...DEFAULT_BRAND }; }
}

export async function saveBrand(patch) {
  const brand = { ...(await getBrand()), ...patch };
  await chrome.storage.local.set({ brand });
  return brand;
}

/** `file` (any image the browser can show, SVG too) as a PNG data URL at most MAX_SIDE across. */
export async function logoFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 300, h = img.naturalHeight || 300;
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A data URL's bytes as a Blob (no fetch: works the same everywhere). */
export function dataUrlBlob(url) {
  const [head, body] = url.split(',');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: head.slice(5).split(';')[0] });
}

/** The logo ready to draw: `{ bitmap, position, size, opacity }`, or null when none is set. */
export async function loadLogo(brand) {
  if (!brand?.image) return null;
  try {
    return { bitmap: await createImageBitmap(dataUrlBlob(brand.image)), position: brand.position, size: brand.size, opacity: brand.opacity };
  } catch { return null; }
}

/** Draws `logo` (from loadLogo) in its corner of the box (x, y, w, h) on `ctx`. */
export function drawLogo(ctx, logo, x, y, w, h) {
  const bmp = logo?.bitmap;
  if (!bmp?.width) return;
  const short = Math.min(w, h);
  let lw = short * (SIZES[logo.size] || SIZES[2]);
  let lh = lw * (bmp.height / bmp.width);
  if (lh > h * 0.25) { lh = h * 0.25; lw = lh * (bmp.width / bmp.height); } // tall logos stay small
  const m = Math.max(4, short * 0.03);
  const pos = POSITIONS.includes(logo.position) ? logo.position : 'br';
  const lx = pos[1] === 'l' ? x + m : x + w - m - lw;
  const ly = pos[0] === 't' ? y + m : y + h - m - lh;
  ctx.save();
  ctx.globalAlpha *= logo.opacity ?? 0.9;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, lx, ly, lw, lh);
  ctx.restore();
}
