// Device mode: draws a capture inside a real phone or tablet, for screenshots and for
// every frame of a video. Devices (src/lib/devices.js) have their real proportions,
// and by default the frame is sized around the capture so the capture keeps its
// exact pixels: nothing is resampled, only cropped or framed. The frame is drawn from
// shapes, so it is sharp at any size.
import { getSettings } from './settings.js';
import { DEVICES, LEGACY, DEFAULT_DEVICE, matchDevice } from './devices.js';
import { createDevicePicker } from './device-picker.js';

export { DEVICES, matchDevice };

export const FRAMES = {
  midnight: { label: 'Midnight', body: ['#2a2b33', '#111217'], rim: '#4a4b55' },
  titanium: { label: 'Natural titanium', body: ['#a8a39b', '#7d786f'], rim: '#c4bfb6' },
  silver: { label: 'Silver', body: ['#f3f4f6', '#c9ccd3'], rim: '#a8acb5' },
  gold: { label: 'Gold', body: ['#f6ead6', '#d9c29c'], rim: '#bfa57c' },
  blue: { label: 'Blue', body: ['#4b5d7e', '#25324a'], rim: '#6d7fa1' },
};

export const DEFAULTS = {
  enabled: false,
  device: 'auto',     // 'auto' (best match for the capture) or an id from DEVICES
  orientation: 'auto',
  size: 'exact',      // 'exact': the capture's own pixels; 'device': the device's screen resolution
  fit: 'width',       // 'width' (from the top) | 'cover' | 'contain'
  frame: 'midnight',
  bg: 'none',         // 'none' (transparent) | 'white' | 'custom'
  bg1: '#ffffff',     // colour for 'custom'
  padding: 12,
  // 'auto': over a capture of the whole screen (it already has room for one), else above
  statusBar: 'auto',  // 'auto' | 'above' (the page starts below it) | 'over' (on top of the page) | 'none'
  statusStyle: 'light',
};

// Canvases larger than this fail in some browsers, or use too much memory.
const MAX_SIDE = 16384;
const MAX_AREA = 120e6;

/** Options from any version, with earlier versions' values brought up to date. */
export function normalise(opts) {
  const o = { ...DEFAULTS, ...opts };
  if (LEGACY[o.device]) o.device = LEGACY[o.device];
  if (o.device !== 'auto' && !DEVICES[o.device]) o.device = 'auto';
  if (o.statusBar === true) o.statusBar = 'auto';
  if (o.statusBar === false) o.statusBar = 'none';
  if (!FRAMES[o.frame]) o.frame = DEFAULTS.frame;
  return o;
}

/** The device and orientation used for a `srcW` × `srcH` capture. */
export function resolveDevice(o, srcW, srcH) {
  const match = o.device === 'auto' ? matchDevice(srcW, srcH) : null;
  const d = DEVICES[match ? match.id : o.device] || DEVICES[DEFAULT_DEVICE];
  const landscape = o.orientation === 'landscape' ||
    (o.orientation === 'auto' && (match ? match.landscape : srcW > srcH * 1.15));
  return { d, landscape, exact: !!match?.exact };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

/**
 * Where everything goes, in output pixels. The device is laid out in points, then
 * scaled by `k` pixels a point, chosen so the capture is drawn at its own size.
 */
function layout(opts, srcW, srcH) {
  const { d, landscape, exact } = resolveDevice(opts, srcW, srcH);
  const [vw, vh] = d.screen; // portrait, in points
  const screenShaped = Math.abs(Math.log((srcW / srcH) / (landscape ? vh / vw : vw / vh))) < 0.005;
  const o = { ...opts, statusBar: opts.statusBar === 'auto' ? (screenShaped ? 'over' : 'above') : opts.statusBar };
  // iPhones hide the status bar in landscape; iPads and Android keep it.
  const showStatus = o.statusBar !== 'none' && !(landscape && d.os === 'ios');
  const statusPt = showStatus ? d.status : 0;
  const pushPt = o.statusBar === 'above' ? statusPt : 0;
  // The screen and the page's area on it, as the viewer sees them.
  const [sw, sh] = landscape ? [vh, vw] : [vw, vh];
  const cw = sw, ch = sh - pushPt;

  let k;
  if (o.size === 'device') k = d.dpr; // the device's own screen resolution
  else if (o.fit === 'contain') k = Math.max(srcW / cw, srcH / ch);
  else if (o.fit === 'cover') k = Math.min(srcW / cw, srcH / ch);
  else k = srcW / cw;

  const bx = d.bezel.x, by = d.bezel.y;
  const bodyPt = { w: vw + bx * 2, h: vh + by * 2 }; // portrait
  const marginPt = Math.min(bodyPt.w, bodyPt.h) * (o.padding / 100);
  const outPt = landscape
    ? { w: bodyPt.h + marginPt * 2, h: bodyPt.w + marginPt * 2 }
    : { w: bodyPt.w + marginPt * 2, h: bodyPt.h + marginPt * 2 };
  // Very large captures: scale everything down to what a canvas can hold.
  const limit = Math.min(1, MAX_SIDE / (outPt.w * k), MAX_SIDE / (outPt.h * k), Math.sqrt(MAX_AREA / (outPt.w * outPt.h * k * k)));
  k *= limit;

  const W = Math.round(outPt.w * k), H = Math.round(outPt.h * k);
  const m = marginPt * k;
  // Portrait geometry, for the hardware (rotated when drawn in landscape).
  const P = {
    k,
    body: { x: m, y: m, w: bodyPt.w * k, h: bodyPt.h * k },
    screen: { x: m + bx * k, y: m + by * k, w: vw * k, h: vh * k, r: d.radius * k },
  };
  P.body.r = d.bodyRadius != null ? d.bodyRadius * Math.min(bodyPt.w, bodyPt.h) * k : (d.radius + Math.min(bx, by) * 0.9) * k;
  // The screen as the viewer sees it.
  const screen = landscape
    ? { x: P.screen.y, y: H - P.screen.x - P.screen.w, w: P.screen.h, h: P.screen.w, r: P.screen.r }
    : { ...P.screen };
  const content = { x: screen.x, y: screen.y + pushPt * k, w: cw * k, h: ch * k };
  // The capture's scale on screen: 1 when its pixels are kept exactly.
  let scale;
  if (o.size !== 'device' && o.fit !== 'contain' && o.fit !== 'cover') scale = limit;
  else if (o.fit === 'contain') scale = Math.min(content.w / srcW, content.h / srcH);
  else if (o.fit === 'cover') scale = Math.max(content.w / srcW, content.h / srcH);
  else scale = content.w / srcW;
  return { d, o, landscape, exact, k, W, H, P, screen, content, statusH: statusPt * k, scale };
}

/** Runs `draw` in portrait coordinates: rotated a quarter turn for landscape. */
function portrait(ctx, g, draw) {
  ctx.save();
  if (g.landscape) {
    ctx.translate(0, g.H);
    ctx.rotate(-Math.PI / 2); // the top of the device is on the left
  }
  draw();
  ctx.restore();
}

function drawUnder(ctx, g) {
  const { o, d, P, W, H } = g;
  const { body, screen, k } = P;
  ctx.clearRect(0, 0, W, H);
  if (o.bg === 'white' || o.bg === 'custom') {
    ctx.fillStyle = o.bg === 'white' ? '#ffffff' : o.bg1;
    ctx.fillRect(0, 0, W, H);
  }
  const f = FRAMES[o.frame];
  portrait(ctx, g, () => {
    // Buttons sit behind the body and stick out a little.
    ctx.fillStyle = f.rim;
    const t = 3.2 * k;
    for (const [side, from, len] of d.buttons || []) {
      if (side === 'top') roundRect(ctx, body.x + body.w * from, body.y - t * 0.6, body.w * len, t, t / 2);
      else roundRect(ctx, side === 'left' ? body.x - t * 0.6 : body.x + body.w - t * 0.4, body.y + body.h * from, t, body.h * len, t / 2);
      ctx.fill();
    }

    const grad = ctx.createLinearGradient(body.x, body.y, body.x + body.w, body.y + body.h);
    grad.addColorStop(0, f.body[0]);
    grad.addColorStop(1, f.body[1]);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = Math.min(body.w, body.h) * 0.06;
    ctx.shadowOffsetY = Math.min(body.w, body.h) * 0.02;
    roundRect(ctx, body.x, body.y, body.w, body.h, body.r);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
    // The metal rim, then the glass's black border.
    ctx.lineWidth = Math.max(1, 1.6 * k);
    ctx.strokeStyle = f.rim;
    roundRect(ctx, body.x + ctx.lineWidth / 2, body.y + ctx.lineWidth / 2, body.w - ctx.lineWidth, body.h - ctx.lineWidth, body.r);
    ctx.stroke();
    const rim = 3.5 * k;
    if (d.home !== 'button') {
      roundRect(ctx, body.x + rim, body.y + rim, body.w - rim * 2, body.h - rim * 2, body.r - rim);
      ctx.fillStyle = '#050507';
      ctx.fill();
    }
    roundRect(ctx, screen.x, screen.y, screen.w, screen.h, screen.r);
    ctx.fillStyle = '#000';
    ctx.fill();

    const dot = (cx, cy, r, color = '#14141c') => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); };
    if (d.home === 'button') {
      // Earpiece and camera above the screen, the home button below.
      const top = (screen.y - body.y) / 2 + body.y;
      roundRect(ctx, body.x + body.w / 2 - 22 * k, top - 2.5 * k, 44 * k, 5 * k, 2.5 * k);
      ctx.fillStyle = '#3a3b42';
      ctx.fill();
      dot(body.x + body.w / 2 - 40 * k, top, 4 * k);
      const cy = screen.y + screen.h + (body.y + body.h - screen.y - screen.h) / 2;
      dot(body.x + body.w / 2, cy, 26 * k, '#1d1e24');
      ctx.lineWidth = 1.5 * k;
      ctx.strokeStyle = f.rim;
      ctx.stroke();
    } else if (d.camera === 'short') {
      dot(body.x + body.w / 2, (screen.y + body.y) / 2, 3.5 * k);
    } else if (d.camera === 'long') {
      // On the long edge: the top in landscape.
      dot((screen.x + body.x) / 2, body.y + body.h / 2, 3.5 * k);
    }
  });
}

function statusIcons(ctx, right, cy, u, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  let x = right;
  // Battery
  const bw = u * 25, bh = u * 12;
  x -= bw;
  ctx.lineWidth = u * 1.1;
  ctx.globalAlpha = 0.4;
  roundRect(ctx, x, cy - bh / 2, bw, bh, u * 3.5);
  ctx.stroke();
  ctx.globalAlpha = 1;
  roundRect(ctx, x + u * 2, cy - bh / 2 + u * 2, (bw - u * 4) * 0.8, bh - u * 4, u * 2);
  ctx.fill();
  roundRect(ctx, x + bw + u, cy - u * 2, u * 1.5, u * 4, u);
  ctx.fill();
  // Wi-Fi
  x -= u * 13;
  ctx.lineWidth = u * 2.2;
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(x, cy + u * 5, u * (2.5 + i * 3.6), Math.PI * 1.25, Math.PI * 1.75);
    ctx.stroke();
  }
  // Signal
  x -= u * 26;
  for (let i = 0; i < 4; i++) {
    const h = u * (3.5 + i * 2.2);
    roundRect(ctx, x + i * u * 4.6, cy + u * 5.5 - h, u * 3.2, h, u);
    ctx.fill();
  }
}

function drawOver(ctx, g) {
  const { o, d, P, W, H, screen, statusH, landscape } = g;
  const k = P.k;
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  roundRect(ctx, screen.x, screen.y, screen.w, screen.h, screen.r);
  ctx.clip();
  if (statusH) {
    const dark = o.statusStyle === 'dark';
    const color = dark ? '#fff' : '#000';
    if (o.statusBar === 'above') {
      ctx.fillStyle = dark ? '#000' : '#fff';
      ctx.fillRect(screen.x, screen.y, screen.w, statusH);
    }
    const island = d.cutout?.kind === 'island' && !landscape;
    const cy = screen.y + (island ? (d.cutout.top + d.cutout.h / 2) * k : statusH / 2);
    const ios = d.os !== 'android';
    const size = (d.type === 'tablet' ? 13 : ios ? 17 : 14) * k;
    ctx.font = `${ios ? 600 : 500} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    // Beside a notch or island, the time is centred in the space to its left.
    const ear = d.cutout && d.cutout.kind !== 'punch' && !landscape ? (screen.w - d.cutout.w * k) / 2 : 0;
    const time = ios ? '9:41' : '12:30';
    if (ear) {
      ctx.textAlign = 'center';
      ctx.fillText(time, screen.x + ear / 2 + 4 * k, cy);
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(time, screen.x + (d.type === 'tablet' ? 20 : ios ? 24 : 18) * k, cy);
    }
    ctx.textAlign = 'left';
    const right = ear ? screen.x + screen.w - ear / 2 + 32 * k : screen.x + screen.w - (d.type === 'tablet' ? 20 : 18) * k;
    statusIcons(ctx, right, cy, (d.type === 'tablet' ? 0.8 : 0.95) * k, color);
  }

  // Home indicator or gesture bar: always along the bottom as the viewer sees it.
  if (d.home === 'indicator' || d.home === 'gesture') {
    const w = Math.min(screen.w * 0.36, (d.home === 'gesture' ? 108 : d.type === 'tablet' ? 320 : landscape ? 208 : 134) * k);
    const h = (d.home === 'gesture' ? 4 : 5) * k;
    roundRect(ctx, screen.x + (screen.w - w) / 2, screen.y + screen.h - (d.home === 'gesture' ? 8 : 8) * k - h, w, h, h / 2);
    ctx.fillStyle = o.statusStyle === 'dark' ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.75)';
    ctx.fill();
  }
  ctx.restore();

  // The cut-out is part of the hardware, so it turns with the device.
  const c = d.cutout;
  if (c) {
    portrait(ctx, g, () => {
      const s = P.screen;
      const cx = c.x === 'right' ? s.x + s.w - 40 * k : s.x + s.w / 2;
      ctx.fillStyle = '#000';
      if (c.kind === 'island') {
        roundRect(ctx, cx - (c.w * k) / 2, s.y + c.top * k, c.w * k, c.h * k, (c.h * k) / 2);
        ctx.fill();
      } else if (c.kind === 'notch') {
        const w = c.w * k, h = c.h * k, r = 8 * k;
        const x0 = cx - w / 2;
        ctx.beginPath();
        ctx.moveTo(x0 - r, s.y);
        ctx.quadraticCurveTo(x0, s.y, x0, s.y + r);
        ctx.lineTo(x0, s.y + h - 2 * r);
        ctx.quadraticCurveTo(x0, s.y + h, x0 + 2 * r, s.y + h);
        ctx.lineTo(x0 + w - 2 * r, s.y + h);
        ctx.quadraticCurveTo(x0 + w, s.y + h, x0 + w, s.y + h - 2 * r);
        ctx.lineTo(x0 + w, s.y + r);
        ctx.quadraticCurveTo(x0 + w, s.y, x0 + w + r, s.y);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(cx, s.y + (c.top + c.h / 2) * k, (c.w * k) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
}

/**
 * Prepares a renderer for content of size srcW × srcH. `render(ctx, source)` draws
 * the whole device picture (renderer.width × renderer.height) with `source` on
 * screen. `info` says which device, and at what scale the capture is drawn
 * (1: its exact pixels).
 */
export function deviceRenderer(opts, srcW, srcH) {
  const g = layout(normalise(opts), srcW, srcH);
  const under = new OffscreenCanvas(g.W, g.H);
  drawUnder(under.getContext('2d'), g);
  const over = new OffscreenCanvas(g.W, g.H);
  drawOver(over.getContext('2d'), g);

  const c = g.content;
  const dw = srcW * g.scale, dh = srcH * g.scale;
  const fitWidth = g.o.fit === 'width';
  // From the top when filling the width; centred otherwise. Whole pixels, so the
  // capture's pixels line up with the output's.
  const dx = Math.round(c.x + (c.w - dw) / 2);
  const dy = Math.round(fitWidth ? c.y : c.y + (c.h - dh) / 2);
  const screenFill = fitWidth ? '#fff' : '#000';
  const exact = Math.abs(g.scale - 1) < 1e-6;

  return {
    width: g.W,
    height: g.H,
    info: {
      device: g.d, landscape: g.landscape, matched: g.o.device === 'auto', matchExact: g.exact,
      scale: g.scale, exact,
      screen: [Math.round(g.screen.w), Math.round(g.screen.h)],
    },
    render(ctx, source) {
      ctx.clearRect(0, 0, g.W, g.H);
      ctx.drawImage(under, 0, 0);
      ctx.save();
      roundRect(ctx, g.screen.x, g.screen.y, g.screen.w, g.screen.h, g.screen.r);
      ctx.clip();
      ctx.fillStyle = screenFill;
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.beginPath();
      ctx.rect(c.x, c.y, c.w, c.h);
      ctx.clip();
      if (exact) ctx.drawImage(source, dx, dy);
      else {
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, dx, dy, dw, dh);
      }
      ctx.restore();
      ctx.drawImage(over, 0, 0);
    },
    transparent: g.o.bg === 'none',
  };
}

/** Renders `source` in a device frame onto a new canvas. */
export function renderInDevice(opts, source, srcW = source.width, srcH = source.height) {
  const r = deviceRenderer(opts, srcW, srcH);
  const c = new OffscreenCanvas(r.width, r.height);
  r.render(c.getContext('2d'), source);
  return c;
}

/** One line about how a capture is shown: the device, its screen, and the scale. */
export function describe(opts, srcW, srcH) {
  if (!srcW || !srcH) return '';
  const { info } = deviceRenderer({ ...opts, padding: 0 }, srcW, srcH);
  const d = info.device;
  const [pw, ph] = info.landscape ? [d.px[1], d.px[0]] : d.px;
  const [vw, vh] = info.landscape ? [d.viewport[1], d.viewport[0]] : d.viewport;
  const dpr = Math.round(d.dpr * 100) / 100;
  const parts = [`${d.name}: ${pw} × ${ph} px, ${vw} × ${vh} ${d.os === 'android' ? 'dp' : 'pt'} at ${dpr}×`];
  if (info.matched) parts.push(info.matchExact ? 'matches this capture exactly' : 'closest to this capture');
  parts.push(info.exact ? `the capture's ${srcW} × ${srcH} pixels are kept exactly` : `the capture is shown at ${Math.round(info.scale * 100)}%`);
  return parts.join(' · ');
}

const options = (list, value) => list.map(([k, v]) => `<option value="${k}"${k === value ? ' selected' : ''}>${v}</option>`).join('');
const sel = (name, list, value) => `<select data-k="${name}">${options(list, value)}</select>`;

const THUMB = { w: 236, h: 200 }; // the preview's largest size, in CSS pixels

/**
 * Builds the device-mode controls inside `el`. Calls `onChange(opts)` on every
 * change. `source()` gives the capture's [width, height], for the description;
 * `picture(width)` gives the capture as a canvas about that wide, for the preview.
 */
export async function mountDevicePanel(el, onChange, { source, picture } = {}) {
  const stored = await chrome.storage.local.get({ deviceOpts: {}, device: false });
  const settings = await getSettings();
  // The background always starts from Settings; the frame itself is remembered.
  const { bg, bg1, bg2, ...frameOpts } = stored.deviceOpts;
  const o = normalise({
    ...frameOpts, enabled: stored.device,
    bg: { transparent: 'none', white: 'white', custom: 'custom' }[settings.background] || 'none',
    bg1: settings.backgroundColor,
  });
  const map = (obj) => Object.entries(obj).map(([k, v]) => [k, v.label]);

  el.innerHTML = `
    <label class="toggle"><span>Show in a device frame<small>A real phone or tablet around the capture</small></span><input type="checkbox" data-k="enabled"${o.enabled ? ' checked' : ''}></label>
    <div class="dev-opts">
      <div class="field"><span class="dev-pick-label">Device</span><div class="dev-pick-slot"></div></div>
      <canvas class="dev-thumb hidden" role="img" aria-label="Preview of the capture in the device"></canvas>
      <p class="dev-info" aria-live="polite"></p>
      <div class="grid2">
        <label class="field"><span>Orientation</span>${sel('orientation', [['auto', 'Automatic'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], o.orientation)}</label>
        <label class="field"><span>Finish</span>${sel('frame', map(FRAMES), o.frame)}</label>
      </div>
      <label class="field"><span>Size</span>${sel('size', [['exact', 'The capture’s own pixels (exact)'], ['device', 'The device’s screen resolution']], o.size)}</label>
      <label class="field"><span>Fit on screen</span>${sel('fit', [['width', 'Fill width, from the top'], ['cover', 'Fill the screen'], ['contain', 'Show everything']], o.fit)}</label>
      <div class="field"><span>Background <a href="#" class="settings-link">Change default</a></span>
        <div class="row">${sel('bg', [['none', 'Transparent'], ['white', 'White'], ['custom', 'Custom colour']], o.bg)}
          <input type="color" data-k="bg1" value="${o.bg1}" title="Background colour">
        </div>
      </div>
      <label class="field"><span>Padding</span><input type="range" min="0" max="30" data-k="padding" value="${o.padding}"></label>
      <div class="grid2">
        <label class="field"><span>Status bar</span>${sel('statusBar', [['auto', 'Automatic'], ['above', 'Above the page'], ['over', 'Over the page'], ['none', 'None']], o.statusBar)}</label>
        <label class="field status-style"><span>Status bar text</span>${sel('statusStyle', [['light', 'Dark on light'], ['dark', 'Light on dark']], o.statusStyle)}</label>
      </div>
    </div>`;

  // The preview: the capture, scaled down, in the device. Drawn after changes settle.
  let thumbTimer = 0;
  let thumbRun = 0;
  const drawThumb = () => {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(async () => {
      const run = ++thumbRun;
      const thumb = el.querySelector('.dev-thumb');
      const pic = o.enabled && picture ? await picture(480) : null;
      if (run !== thumbRun) return;
      thumb.classList.toggle('hidden', !pic);
      if (!pic) return;
      const framed = renderInDevice({ ...o, padding: 0, bg: 'none' }, pic);
      const dpr = globalThis.devicePixelRatio || 1;
      const s = Math.min(THUMB.w / framed.width, THUMB.h / framed.height);
      thumb.style.width = `${Math.round(framed.width * s)}px`;
      thumb.style.height = `${Math.round(framed.height * s)}px`;
      thumb.width = Math.round(framed.width * s * dpr);
      thumb.height = Math.round(framed.height * s * dpr);
      const ctx = thumb.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(framed, 0, 0, thumb.width, thumb.height);
    }, 120);
  };

  const picker = createDevicePicker({
    value: o.device,
    onPick: (v) => apply('device', v),
    autoLabel: () => { const [w, h] = source?.() || []; return w && h ? DEVICES[matchDevice(w, h).id].name : ''; },
  });
  // Read as "Device, iPhone 17 Pro".
  el.querySelector('.dev-pick-label').id = 'dev-pick-label';
  const btn = picker.el.querySelector('.dev-pick-btn');
  btn.setAttribute('aria-labelledby', `dev-pick-label ${btn.querySelector('.dev-pick-name').id}`);
  el.querySelector('.dev-pick-slot').replaceWith(picker.el);

  const sync = () => {
    drawThumb();
    picker.refresh();
    el.querySelector('.dev-opts').classList.toggle('hidden', !o.enabled);
    el.querySelector('[data-k="bg1"]').classList.toggle('hidden', o.bg !== 'custom');
    el.querySelector('.status-style').classList.toggle('hidden', o.statusBar === 'none');
    const [w, h] = source?.() || [];
    el.querySelector('.dev-info').textContent = o.enabled ? describe(o, w, h) : '';
  };
  sync();
  el.querySelector('.settings-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  const apply = (k, v) => {
    o[k] = v;
    sync();
    const { enabled, bg: _bg, bg1: _bg1, ...rest } = o;
    chrome.storage.local.set({ deviceOpts: rest, device: enabled });
    onChange({ ...o });
  };
  el.addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    const t = e.target;
    apply(k, t.type === 'checkbox' ? t.checked : t.type === 'range' ? Number(t.value) : t.value);
  });
  return { get: () => ({ ...o }), refresh: sync };
}

/**
 * Returns `draw(ctx, source)`, which paints one video frame at `width` × `height`,
 * inside the device frame when `renderer` is given. With `opaque`, a transparent
 * device background becomes white (for formats without transparency).
 */
export function frameDrawer({ width, height }, renderer, opaque = false) {
  return (ctx, source) => {
    if (!renderer) {
      ctx.drawImage(source, 0, 0, width, height);
      return;
    }
    ctx.save();
    ctx.scale(width / renderer.width, height / renderer.height);
    renderer.render(ctx, source);
    ctx.restore();
    if (opaque && renderer.transparent) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over'; // paint behind the frame
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
  };
}
