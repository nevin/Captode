// Makes every icon from the logo: node tools/brand.mjs [path/to/logo.svg|png]
//
// The master logo is store/brand/logo.svg (flat vector artwork), with
// store/brand/logo-small.svg, a simplified mark for 16 and 32 px. A PNG can be given
// instead (on a transparent or plain white background). Writes:
//   store/logo.png            the logo, 1024 × 1024
//   src/icons/icon{16,32,48,128}.png   extension icons (16 and 32: the small mark)
//   store/icon-128.png        Chrome Web Store icon: 96 × 96 artwork in 16 px of padding
//   store/icon-300.png        Microsoft Edge Add-ons icon
//   docs/logo.png             the logo shown at the top of the README
// Image work happens in Chrome (via Puppeteer), which resamples well.
import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] || [join(root, 'store', 'brand', 'logo.svg'), join(root, 'store', 'logo-source.png')].find(existsSync);
if (!source || !existsSync(source)) {
  console.error('No logo found. Save it as store/brand/logo.svg (or a PNG at store/logo-source.png) and run again.');
  process.exit(1);
}
const isSvg = source.endsWith('.svg');
const smallPath = join(dirname(source), 'logo-small.svg');
const small = isSvg && existsSync(smallPath) ? readFileSync(smallPath).toString('base64') : null;
console.log('logo:', source.slice(root.length + 1), small ? '(+ logo-small.svg for 16 and 32 px)' : '');

const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage();
const out = await page.evaluate(async (logo, isSvg, small) => {
  /** An SVG as an image element, which draws crisply at any size. */
  const svgImage = async (b64) => { const i = new Image(); i.src = 'data:image/svg+xml;base64,' + b64; await i.decode(); return i; };
  const img = isSvg ? await svgImage(logo) : await createImageBitmap(await (await fetch('data:image/png;base64,' + logo)).blob());
  const W = isSvg ? 1024 : img.width, H = isSvg ? 1024 : img.height;
  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H);
  const px = d.data;

  // Remove a white background: flood-fill from the edges through near-white
  // pixels, so white *inside* the artwork stays. Edge pixels that are partly
  // white become partly transparent, keeping the outline smooth.
  const whiteness = (i) => Math.min(px[i], px[i + 1], px[i + 2]);
  const opaqueWhiteEdge = !isSvg && (() => {
    let n = 0, white = 0;
    for (let i = 0; i < W; i++) for (const y of [0, H - 1]) { const k = (y * W + i) * 4; n++; if (px[k + 3] > 250 && whiteness(k) > 240) white++; }
    return white / n > 0.9;
  })();
  if (opaqueWhiteEdge) {
    const seen = new Uint8Array(W * H);
    const stack = [];
    for (let i = 0; i < W; i++) stack.push(i, (H - 1) * W + i);
    for (let j = 0; j < H; j++) stack.push(j * W, j * W + W - 1);
    while (stack.length) {
      const p = stack.pop();
      if (seen[p]) continue;
      const k = p * 4;
      if (whiteness(k) < 200) continue; // reached the artwork
      seen[p] = 1;
      const xx = p % W, yy = (p / W) | 0;
      if (xx > 0) stack.push(p - 1);
      if (xx < W - 1) stack.push(p + 1);
      if (yy > 0) stack.push(p - W);
      if (yy < H - 1) stack.push(p + W);
    }
    for (let p = 0; p < W * H; p++) {
      if (!seen[p]) continue;
      const k = p * 4;
      // 255 → clear, 200 → nearly opaque; un-mix the white from the colour.
      const a = Math.max(0, Math.min(1, (255 - whiteness(k)) / 55));
      if (a <= 0.01) { px[k + 3] = 0; continue; }
      for (let ch = 0; ch < 3; ch++) px[k + ch] = Math.max(0, Math.min(255, Math.round((px[k + ch] - 255 * (1 - a)) / a)));
      px[k + 3] = Math.round(a * 255);
    }
    x.putImageData(d, 0, 0);
  }

  // The window (the saturated part of the logo) and the corner brackets around it.
  let wx0 = W, wy0 = H, wx1 = -1, wy1 = -1;
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    const k = (yy * W + xx) * 4;
    if (px[k + 3] > 40 && Math.max(px[k], px[k + 1], px[k + 2]) - Math.min(px[k], px[k + 1], px[k + 2]) > 50) {
      wx0 = Math.min(wx0, xx); wx1 = Math.max(wx1, xx); wy0 = Math.min(wy0, yy); wy1 = Math.max(wy1, yy);
    }
  }
  // (Only for a bitmap logo: the vector artwork is already drawn this way.)
  const hasWindow = !isSvg && wx1 > wx0 && (wx1 - wx0) < W * 0.9;
  if (hasWindow) {
    // Dark brackets vanish on dark toolbars and dark tiles, so colour them violet, in
    // a diagonal gradient that matches the window's frame: visible on light and dark.
    const from = [108, 86, 255], to = [158, 92, 255];
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
      if (xx >= wx0 - 2 && xx <= wx1 + 2 && yy >= wy0 - 2 && yy <= wy1 + 2) continue;
      const k = (yy * W + xx) * 4;
      if (!px[k + 3]) continue;
      const t = (xx / W + yy / H) / 2;
      for (let ch = 0; ch < 3; ch++) px[k + ch] = Math.round(from[ch] + (to[ch] - from[ch]) * t);
    }
    x.putImageData(d, 0, 0);
  }

  // Trim to the artwork and centre it on a square.
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    if (px[(yy * W + xx) * 4 + 3] > 8) { x0 = Math.min(x0, xx); x1 = Math.max(x1, xx); y0 = Math.min(y0, yy); y1 = Math.max(y1, yy); }
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const side = Math.max(bw, bh);
  const square = new OffscreenCanvas(side, side);
  square.getContext('2d').drawImage(c, x0, y0, bw, bh, (side - bw) / 2, (side - bh) / 2, bw, bh);

  // Downscale in halving steps for clean small sizes (vector artwork is drawn
  // straight at the size).
  const resize = (src, size) => {
    if (src instanceof HTMLImageElement) {
      const o = new OffscreenCanvas(size, size);
      o.getContext('2d').drawImage(src, 0, 0, size, size);
      return o;
    }
    let cur = src;
    while (cur.width / 2 >= size) {
      const half = new OffscreenCanvas(Math.round(cur.width / 2), Math.round(cur.height / 2));
      const hx = half.getContext('2d');
      hx.imageSmoothingQuality = 'high';
      hx.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
    const o = new OffscreenCanvas(size, size);
    const ox = o.getContext('2d');
    ox.imageSmoothingQuality = 'high';
    ox.drawImage(cur, 0, 0, size, size);
    return o;
  };
  // Just the window, for the smallest icons, where the brackets would leave it too
  // small to make out.
  let windowOnly = isSvg ? img : square;
  if (small) windowOnly = await svgImage(small);
  else if (hasWindow) {
    const ww = wx1 - wx0 + 1, wh = wy1 - wy0 + 1, wside = Math.max(ww, wh);
    windowOnly = new OffscreenCanvas(wside, wside);
    windowOnly.getContext('2d').drawImage(c, wx0, wy0, ww, wh, (wside - ww) / 2, (wside - wh) / 2, ww, wh);
  }
  /** The logo at `art` px, centred in a `size` px transparent square. */
  const icon = (size, art, src = square) => {
    const o = new OffscreenCanvas(size, size);
    const a = resize(src, art);
    o.getContext('2d').drawImage(a, Math.round((size - art) / 2), Math.round((size - art) / 2));
    return o;
  };
  const b64 = async (cv) => {
    const a = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let s = '';
    for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
    return btoa(s);
  };
  return {
    removedBackground: opaqueWhiteEdge,
    'store/logo.png': await b64(isSvg ? resize(img, 1024) : resize(square, Math.min(1024, side))),
    'src/icons/icon16.png': await b64(icon(16, 16, windowOnly)),
    'src/icons/icon32.png': await b64(icon(32, 32, windowOnly)),
    'src/icons/icon48.png': await b64(icon(48, 46)),
    // Chrome's guideline: 128 × 128 with the artwork in the middle 96 × 96.
    'src/icons/icon128.png': await b64(icon(128, 96)),
    'store/icon-128.png': await b64(icon(128, 96)),
    'store/icon-300.png': await b64(icon(300, 284)),
    'docs/logo.png': await b64(resize(square, 256)),
  };
}, readFileSync(source).toString('base64'), isSvg, small);
await browser.close();

const { removedBackground, ...files } = out;
for (const [path, data] of Object.entries(files)) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), Buffer.from(data, 'base64'));
  console.log('wrote', path);
}
if (removedBackground) console.log('(removed the white background around the logo)');
