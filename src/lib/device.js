// Device mode: draws a capture inside a phone or tablet frame, for screenshots and
// for every frame of a video. The frame is drawn from shapes, so it scales cleanly.

export const DEVICES = {
  phone: { label: 'Phone — island', aspect: 19.5 / 9, bezel: 0.045, radius: 0.17, screenRadius: 0.13, cutout: 'island', size: 900 },
  android: { label: 'Phone — punch hole', aspect: 20 / 9, bezel: 0.035, radius: 0.12, screenRadius: 0.095, cutout: 'punch', size: 900 },
  tablet: { label: 'Tablet', aspect: 4 / 3, bezel: 0.05, radius: 0.07, screenRadius: 0.04, cutout: 'camera', size: 1300 },
};

export const FRAMES = {
  midnight: { label: 'Midnight', body: ['#2a2b33', '#111217'], rim: '#4a4b55' },
  silver: { label: 'Silver', body: ['#f3f4f6', '#c9ccd3'], rim: '#a8acb5' },
  gold: { label: 'Gold', body: ['#f6ead6', '#d9c29c'], rim: '#bfa57c' },
  blue: { label: 'Blue', body: ['#4b5d7e', '#25324a'], rim: '#6d7fa1' },
};

export const DEFAULTS = {
  enabled: false,
  device: 'phone',
  orientation: 'auto',
  fit: 'width',
  frame: 'midnight',
  bg: 'gradient',
  bg1: '#5b4bff',
  bg2: '#e5484d',
  padding: 12,
  statusBar: true,
  statusStyle: 'light',
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

function layout(o, srcW, srcH) {
  const d = DEVICES[o.device] || DEVICES.phone;
  const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && srcW > srcH * 1.15);
  const S = d.size;
  const L = Math.round(S * d.aspect);
  const sw = landscape ? L : S;
  const sh = landscape ? S : L;
  const b = Math.round(S * d.bezel);
  const m = Math.round(S * (o.padding / 100));
  const bodyW = sw + b * 2;
  const bodyH = sh + b * 2;
  const statusH = o.statusBar && !(landscape && o.device !== 'tablet')
    ? Math.round(S * (o.device === 'tablet' ? 0.035 : 0.12)) : 0;
  const screen = { x: m + b, y: m + b, w: sw, h: sh, r: S * d.screenRadius };
  return {
    d, S, landscape, statusH,
    width: bodyW + m * 2,
    height: bodyH + m * 2,
    body: { x: m, y: m, w: bodyW, h: bodyH, r: S * d.radius },
    screen,
    content: { x: screen.x, y: screen.y + statusH, w: sw, h: sh - statusH },
  };
}

function drawUnder(ctx, o, g) {
  const { width: W, height: H, body, screen, S, d, landscape } = g;
  ctx.clearRect(0, 0, W, H);
  if (o.bg === 'solid') {
    ctx.fillStyle = o.bg1;
    ctx.fillRect(0, 0, W, H);
  } else if (o.bg === 'gradient') {
    const gr = ctx.createLinearGradient(0, 0, W, H);
    gr.addColorStop(0, o.bg1);
    gr.addColorStop(1, o.bg2);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, W, H);
  }
  const f = FRAMES[o.frame] || FRAMES.midnight;
  const bodyGrad = ctx.createLinearGradient(body.x, body.y, body.x + body.w, body.y + body.h);
  bodyGrad.addColorStop(0, f.body[0]);
  bodyGrad.addColorStop(1, f.body[1]);

  // Side buttons sit behind the body and stick out a little.
  if (o.device !== 'tablet') {
    ctx.fillStyle = f.rim;
    const t = S * 0.012;
    const btn = (along, len, side) => {
      if (!landscape) {
        const x = side ? body.x + body.w - t * 0.4 : body.x - t * 0.6;
        roundRect(ctx, x, body.y + body.h * along, t, body.h * len, t / 2);
      } else {
        const y = side ? body.y + body.h - t * 0.4 : body.y - t * 0.6;
        roundRect(ctx, body.x + body.w * (1 - along - len), y, body.w * len, t, t / 2);
      }
      ctx.fill();
    };
    btn(0.2, 0.05, false);
    btn(0.28, 0.08, false);
    btn(0.38, 0.08, false);
    btn(0.27, 0.13, true);
  }

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = S * 0.08;
  ctx.shadowOffsetY = S * 0.03;
  roundRect(ctx, body.x, body.y, body.w, body.h, body.r);
  ctx.fillStyle = bodyGrad;
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = Math.max(1, S * 0.006);
  ctx.strokeStyle = f.rim;
  roundRect(ctx, body.x + ctx.lineWidth / 2, body.y + ctx.lineWidth / 2, body.w - ctx.lineWidth, body.h - ctx.lineWidth, body.r);
  ctx.stroke();

  roundRect(ctx, screen.x, screen.y, screen.w, screen.h, screen.r);
  ctx.fillStyle = '#000';
  ctx.fill();

  if (d.cutout === 'camera') {
    const cx = landscape ? body.x + (screen.x - body.x) / 2 : body.x + body.w / 2;
    const cy = landscape ? body.y + body.h / 2 : body.y + (screen.y - body.y) / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, S * 0.008, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0b10';
    ctx.fill();
  }
}

function drawStatusIcons(ctx, x, y, h, color, S) {
  // signal bars, wifi and battery, right-aligned ending at x
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  const u = S * 0.012;
  let px = x;
  // battery
  const bw = u * 5.2, bh = u * 2.5;
  px -= bw;
  ctx.lineWidth = u * 0.3;
  roundRect(ctx, px, y - bh / 2, bw, bh, u * 0.7);
  ctx.globalAlpha = 0.45;
  ctx.stroke();
  ctx.globalAlpha = 1;
  roundRect(ctx, px + u * 0.5, y - bh / 2 + u * 0.5, bw * 0.72, bh - u, u * 0.35);
  ctx.fill();
  roundRect(ctx, px + bw + u * 0.25, y - u * 0.5, u * 0.4, u, u * 0.2);
  ctx.fill();
  // wifi
  px -= u * 4.6;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.lineWidth = u * 0.55;
    ctx.arc(px, y + u * 1.1, u * (0.8 + i * 1.05), Math.PI * 1.25, Math.PI * 1.75);
    ctx.stroke();
  }
  // signal
  px -= u * 7.2;
  for (let i = 0; i < 4; i++) {
    const bh2 = u * (0.8 + i * 0.55);
    roundRect(ctx, px + i * u * 1.15, y + u * 1.2 - bh2, u * 0.8, bh2, u * 0.2);
    ctx.fill();
  }
}

function drawOver(ctx, o, g) {
  const { screen, S, d, statusH, landscape } = g;
  ctx.clearRect(0, 0, g.width, g.height);
  ctx.save();
  roundRect(ctx, screen.x, screen.y, screen.w, screen.h, screen.r);
  ctx.clip();

  if (statusH) {
    const dark = o.statusStyle === 'dark';
    ctx.fillStyle = dark ? '#000' : '#fff';
    ctx.fillRect(screen.x, screen.y, screen.w, statusH);
    const color = dark ? '#fff' : '#000';
    const cy = screen.y + statusH * (d.cutout === 'island' ? 0.55 : 0.5);
    ctx.fillStyle = color;
    ctx.font = `600 ${Math.round(S * (o.device === 'tablet' ? 0.018 : 0.042))}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'middle';
    const pad = o.device === 'tablet' ? S * 0.03 : S * 0.1;
    ctx.fillText('9:41', screen.x + pad, cy);
    drawStatusIcons(ctx, screen.x + screen.w - pad, cy, statusH, color, o.device === 'tablet' ? S * 0.45 : S);
  }

  ctx.fillStyle = '#000';
  if (d.cutout === 'island') {
    const w = S * 0.3, h = S * 0.085;
    if (!landscape) roundRect(ctx, screen.x + (screen.w - w) / 2, screen.y + S * 0.03, w, h, h / 2);
    else roundRect(ctx, screen.x + S * 0.03, screen.y + (screen.h - w) / 2, h, w, h / 2);
    ctx.fill();
  } else if (d.cutout === 'punch') {
    const r = S * 0.026;
    ctx.beginPath();
    if (!landscape) ctx.arc(screen.x + screen.w / 2, screen.y + S * 0.05, r, 0, Math.PI * 2);
    else ctx.arc(screen.x + S * 0.05, screen.y + screen.h / 2, r, 0, Math.PI * 2);
    ctx.fill();
  }

  if (o.device !== 'tablet') {
    // home indicator
    const w = (landscape ? screen.w : screen.w) * 0.36, h = S * 0.013;
    roundRect(ctx, screen.x + (screen.w - w) / 2, screen.y + screen.h - S * 0.04, w, h, h / 2);
    ctx.fillStyle = 'rgba(127,127,127,0.7)';
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Prepares a renderer for content of size srcW × srcH. `render(ctx, source)` draws
 * the whole device picture (renderer.width × renderer.height) with `source` on screen.
 */
export function deviceRenderer(opts, srcW, srcH) {
  const o = { ...DEFAULTS, ...opts };
  const g = layout(o, srcW, srcH);
  const under = new OffscreenCanvas(g.width, g.height);
  drawUnder(under.getContext('2d'), o, g);
  const over = new OffscreenCanvas(g.width, g.height);
  drawOver(over.getContext('2d'), o, g);

  const c = g.content;
  let dw, dh, dx, dy;
  if (o.fit === 'contain') {
    const s = Math.min(c.w / srcW, c.h / srcH);
    dw = srcW * s; dh = srcH * s;
    dx = c.x + (c.w - dw) / 2; dy = c.y + (c.h - dh) / 2;
  } else if (o.fit === 'cover') {
    const s = Math.max(c.w / srcW, c.h / srcH);
    dw = srcW * s; dh = srcH * s;
    dx = c.x + (c.w - dw) / 2; dy = c.y + (c.h - dh) / 2;
  } else { // fit width, from the top
    const s = c.w / srcW;
    dw = c.w; dh = srcH * s;
    dx = c.x; dy = c.y;
  }
  const screenFill = o.fit === 'width' ? '#fff' : '#000';

  return {
    width: g.width,
    height: g.height,
    render(ctx, source) {
      ctx.clearRect(0, 0, g.width, g.height);
      ctx.drawImage(under, 0, 0);
      ctx.save();
      roundRect(ctx, g.screen.x, g.screen.y, g.screen.w, g.screen.h, g.screen.r);
      ctx.clip();
      ctx.fillStyle = screenFill;
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, dx, dy, dw, dh);
      ctx.restore();
      ctx.drawImage(over, 0, 0);
    },
    transparent: o.bg === 'none',
  };
}

/** Renders `source` in a device frame onto a new canvas. */
export function renderInDevice(opts, source, srcW = source.width, srcH = source.height) {
  const r = deviceRenderer(opts, srcW, srcH);
  const c = new OffscreenCanvas(r.width, r.height);
  r.render(c.getContext('2d'), source);
  return c;
}

const sel = (name, options, value) =>
  `<select data-k="${name}">${Object.entries(options)
    .map(([k, v]) => `<option value="${k}"${k === value ? ' selected' : ''}>${v}</option>`).join('')}</select>`;

/** Builds the device-mode controls inside `el`. Calls `onChange(opts)` on every change. */
export async function mountDevicePanel(el, onChange) {
  const stored = await chrome.storage.local.get({ deviceOpts: {}, device: false });
  const o = { ...DEFAULTS, ...stored.deviceOpts, enabled: stored.device };
  const map = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v.label]));

  el.innerHTML = `
    <label class="toggle"><span>Show in a device frame<small>Phone or tablet mock-up around the capture</small></span><input type="checkbox" data-k="enabled"${o.enabled ? ' checked' : ''}></label>
    <div class="dev-opts">
      <label class="field"><span>Device</span>${sel('device', map(DEVICES), o.device)}</label>
      <div class="grid2">
        <label class="field"><span>Orientation</span>${sel('orientation', { auto: 'Automatic', portrait: 'Portrait', landscape: 'Landscape' }, o.orientation)}</label>
        <label class="field"><span>Finish</span>${sel('frame', map(FRAMES), o.frame)}</label>
      </div>
      <label class="field"><span>Fit on screen</span>${sel('fit', { width: 'Fill width, from the top', cover: 'Fill the screen', contain: 'Show everything' }, o.fit)}</label>
      <div class="field"><span>Background</span>
        <div class="row">${sel('bg', { gradient: 'Gradient', solid: 'Solid colour', none: 'Transparent' }, o.bg)}
          <input type="color" data-k="bg1" value="${o.bg1}" title="Background colour">
          <input type="color" data-k="bg2" value="${o.bg2}" title="Second gradient colour">
        </div>
      </div>
      <label class="field"><span>Padding</span><input type="range" min="0" max="30" data-k="padding" value="${o.padding}"></label>
      <label class="toggle"><span>Status bar</span><input type="checkbox" data-k="statusBar"${o.statusBar ? ' checked' : ''}></label>
      <label class="field status-style"><span>Status bar style</span>${sel('statusStyle', { light: 'Light', dark: 'Dark' }, o.statusStyle)}</label>
    </div>`;

  const sync = () => {
    el.querySelector('.dev-opts').classList.toggle('hidden', !o.enabled);
    el.querySelector('[data-k="bg2"]').classList.toggle('hidden', o.bg !== 'gradient');
    el.querySelector('[data-k="bg1"]').classList.toggle('hidden', o.bg === 'none');
    el.querySelector('.status-style').classList.toggle('hidden', !o.statusBar);
  };
  sync();
  el.addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    const t = e.target;
    o[k] = t.type === 'checkbox' ? t.checked : t.type === 'range' ? Number(t.value) : t.value;
    sync();
    const { enabled, ...rest } = o;
    chrome.storage.local.set({ deviceOpts: rest, device: enabled });
    onChange({ ...o });
  });
  return { get: () => ({ ...o }) };
}
