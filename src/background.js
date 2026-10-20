// Captode service worker: runs captures, coordinates recordings and switches the
// toolbar icon between "open the popup" and "stop recording".
import { putCapture } from './lib/db.js';
import { getSettings } from './lib/settings.js';
import {
  pickArea, pickElement, fullPagePrepare, fullPageScroll, fullPageRestore,
  countdown, captureDelay, showOutline, hideOutline, showInputs, findPrivate,
} from './content/page.js';
import { t } from './lib/i18n.js';
import { canRecordTabs, startTabCapture, endTabCapture } from './lib/tab-capture.js';


// ---------- helpers ----------

async function run(tabId, func, ...args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

// captureVisibleTab is limited to two calls a second.
let lastCapture = 0;
async function captureVisible(windowId) {
  const wait = lastCapture + 550 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCapture = Date.now();
  const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  return createImageBitmap(await (await fetch(url)).blob());
}

async function openPage(path, tab, { active = true, offset = 0 } = {}) {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(path),
    index: tab ? tab.index + 1 + offset : undefined,
    windowId: tab?.windowId,
    active,
  });
}

async function badge(text, color = '#e5484d') {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

function explain(err) {
  const m = String(err?.message || err);
  if (/cannot be scripted|Cannot access|chrome:\/\/|extensions gallery|webstore/i.test(m)) {
    return t('error_protected_page');
  }
  return m;
}

// ---------- screenshots ----------

/** Seconds to wait before a screenshot (0, 3, 5 or 10): Esc during the wait cancels. */
const DELAYS = [0, 3, 5, 10];
async function waitBeforeCapture(tab, seconds) {
  if (!seconds) return true;
  const go = await run(tab.id, captureDelay, seconds, t('delay_hint', '{n}'));
  if (go === 'hidden') throw new Error(t('error_tab_changed'));
  if (!go) return false;
  // The browser captures whichever tab is showing: never a different one than asked for.
  if (!(await chrome.tabs.get(tab.id)).active) throw new Error(t('error_tab_changed'));
  return true;
}

/**
 * Details on the page that may be private (see findPrivate), as boxes in image pixels
 * stored with the capture: the editor blurs them, if chosen in Settings. A page that can't be read
 * just has none.
 */
async function notePrivate(tab, meta, region, space, scale) {
  if (!(await chrome.storage.local.get('settings')).settings?.autoBlur) return; // off unless chosen in Settings
  const boxes = await run(tab.id, findPrivate, region, space).catch(() => null);
  if (!boxes?.length) return;
  const pad = 2 * scale;
  meta.private = boxes.map((b) => ({
    x: Math.round(b.x * scale - pad), y: Math.round(b.y * scale - pad),
    w: Math.round(b.w * scale + pad * 2), h: Math.round(b.h * scale + pad * 2), kind: b.kind,
  }));
}

async function captureImage(mode, tab, delay = 0) {
  let blob;
  const settings = await getSettings();
  const meta = { title: tab.title, url: tab.url, mode };
  delay = DELAYS.includes(Number(delay)) ? Number(delay) : 0;
  // A selected area or element is chosen first, then the wait, so a menu can be opened in it.
  if (mode !== 'area' && mode !== 'element' && !(await waitBeforeCapture(tab, delay))) return;

  if (mode === 'visible') {
    const bmp = await captureVisible(tab.windowId);
    const width = bmp.width;
    blob = await toPng(bmp, 0, 0, bmp.width, bmp.height);
    bmp.close();
    // Image pixels per CSS pixel, for measuring in the editor.
    const view = await run(tab.id, () => [innerWidth, innerHeight]).catch(() => null);
    if (view) {
      meta.dpr = width / view[0];
      await notePrivate(tab, meta, { x: 0, y: 0, w: view[0], h: view[1] }, 'viewport', meta.dpr);
    }
  } else if (mode === 'area') {
    const rect = await run(tab.id, pickArea, t('pick_capture_hint'));
    if (!rect) return;
    if (!(await waitBeforeCapture(tab, delay))) return;
    const bmp = await captureVisible(tab.windowId);
    const s = bmp.width / rect.vw;
    meta.dpr = s;
    await notePrivate(tab, meta, rect, 'viewport', s);
    blob = await toPng(bmp, rect.x * s, rect.y * s, rect.w * s, rect.h * s);
    bmp.close();
  } else if (mode === 'element') {
    const rect = await run(tab.id, pickElement, t('pick_element_hint'));
    if (!rect) return;
    if (!(await waitBeforeCapture(tab, delay))) return;
    blob = await captureElement(tab, rect, meta);
  } else {
    blob = await captureFullPage(tab, meta, settings.longPages);
  }

  // A page split into parts gives several images, each with the private details in it.
  const parts = Array.isArray(blob) ? blob : [{ blob }];
  for (const [i, part] of parts.entries()) {
    const m = parts.length > 1 ? { ...meta, part: [i + 1, parts.length], private: part.private } : meta;
    if (!m.private?.length) delete m.private;
    const id = await putCapture(part.blob, m);
    // Downloaded or copied the way the editor would (format, device frame, blurs), by an
    // editor working in a background tab, which closes itself when done.
    const then = settings.afterCapture === 'download' || settings.afterCapture === 'copy' ? settings.afterCapture : null;
    await openPage(`editor/editor.html?id=${id}${then ? `&then=${then}&tab=${tab.id}` : ''}`, tab, { active: !then && i === 0, offset: i });
  }
}

/**
 * The stitched image as a PNG, cut down to what was painted. A long page's canvas can
 * hold up to a gigabyte, so it's given back as soon as it isn't needed, before encoding.
 */
async function finish(canvas, w, h) {
  if (w >= canvas.width && h >= canvas.height) return canvas.convertToBlob({ type: 'image/png' });
  const trimmed = new OffscreenCanvas(Math.max(1, Math.min(canvas.width, w)), Math.max(1, Math.min(canvas.height, h)));
  trimmed.getContext('2d').drawImage(canvas, 0, 0);
  canvas.width = canvas.height = 0;
  return trimmed.convertToBlob({ type: 'image/png' });
}

async function toPng(bmp, x, y, w, h) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmp, Math.round(x), Math.round(y), w, h, 0, 0, w, h);
  return c.convertToBlob({ type: 'image/png' });
}

/**
 * The vertical position (near `guess`) at which `bmp`'s top rows best match the
 * rows already drawn on the canvas. Flat overlaps match anywhere, so ties keep
 * the guess.
 */
function alignTile(ctx, bmp, dx, guess, overlap) {
  const rows = Math.max(1, Math.min(overlap - 2, bmp.height));
  const w = Math.min(bmp.width, ctx.canvas.width - dx);
  if (w < 1 || guess < 2) return guess;
  const sample = new OffscreenCanvas(w, rows).getContext('2d', { willReadFrequently: true });
  sample.drawImage(bmp, 0, 0, w, rows, 0, 0, w, rows);
  const tile = sample.getImageData(0, 0, w, rows).data;
  const top = Math.max(0, guess - 2);
  const area = ctx.getImageData(dx, top, w, rows + 4).data;
  let best = guess, bestCost = Infinity;
  for (let shift = -2; shift <= 2; shift++) {
    const from = guess + shift - top;
    if (from < 0 || from + rows > rows + 4) continue;
    let cost = 0;
    for (let r = 0; r < rows; r++) {
      for (let x = 0; x < w; x += 3) {
        const i = (r * w + x) * 4, j = ((from + r) * w + x) * 4;
        cost += Math.abs(tile[i] - area[j]) + Math.abs(tile[i + 1] - area[j + 1]) + Math.abs(tile[i + 2] - area[j + 2]);
      }
    }
    if (cost < bestCost - 1 || (cost <= bestCost + 1 && shift === 0)) { bestCost = cost; best = guess + shift; }
  }
  return best;
}

/** Scroll positions that cover `total` in steps of `view`, the last one flush with the end. */
function steps(total, view) {
  const out = [];
  for (let p = 0; p < total; p += view) out.push(Math.min(p, Math.max(0, total - view)));
  return [...new Set(out)];
}

const OVERLAP = 24; // CSS pixels shared by neighbouring tiles, for lining them up

/** The tallest image, in CSS pixels, that stays inside the browser's canvas limits. */
const maxHeight = (width, scale) => Math.floor(Math.min(32000, 250e6 / (width * scale)) / scale);

/**
 * A panel that scrolls inside the page (as in mail, chat and document apps), at its
 * full height: each tile is the panel's box cut from a capture of the window.
 */
async function capturePanel(tab, info, meta) {
  await run(tab.id, fullPageScroll, 0, 0, false);
  const first = await captureVisible(tab.windowId);
  const scale = first.width / info.vw;
  meta.dpr = scale;
  meta.panel = true;
  const p = info.panel;
  const sx = Math.round(p.x * scale), sy = Math.round(p.y * scale);
  const sw = Math.max(1, Math.min(first.width - sx, Math.round(p.w * scale)));
  const sh = Math.max(1, Math.min(first.height - sy, Math.round(p.h * scale)));
  const cut = (bmp) => createImageBitmap(bmp, sx, sy, sw, sh);

  const height = Math.min(info.height, maxHeight(sw / scale, scale));
  if (height < info.height) meta.truncated = true;
  await notePrivate(tab, meta, { x: 0, y: 0, w: sw / scale, h: height }, 'panel', scale);
  const canvas = new OffscreenCanvas(sw, Math.max(sh, Math.round(height * scale)));
  const ctx = canvas.getContext('2d');
  const top = await cut(first);
  first.close();
  ctx.drawImage(top, 0, 0);
  top.close();
  let paintedH = sh;

  const viewH = Math.max(1, Math.floor(sh / scale) - OVERLAP);
  const ys = steps(height, viewH);
  let done = 1;
  for (const y of ys) {
    if (y === 0) continue;
    const at = await run(tab.id, fullPageScroll, 0, y, true);
    const bmp = await captureVisible(tab.windowId);
    const tile = await cut(bmp);
    bmp.close();
    const dy = alignTile(ctx, tile, 0, Math.round(at.y * scale), Math.round(OVERLAP * scale));
    ctx.drawImage(tile, 0, dy);
    paintedH = Math.max(paintedH, dy + tile.height);
    tile.close();
    await badge(`${Math.round((++done / ys.length) * 100)}%`, '#5b4bff');
  }
  return finish(canvas, canvas.width, paintedH);
}

/**
 * One element of the page, from its box in the viewport (see pickElement). One that fits
 * the window is cut from a single screenshot; a taller one is stitched together as the
 * page scrolls through it, like a full page.
 */
async function captureElement(tab, r, meta) {
  if (r.h <= r.vh + 0.5 && r.w <= r.vw + 0.5) {
    const bmp = await captureVisible(tab.windowId);
    const s = bmp.width / r.vw;
    meta.dpr = s;
    const x = Math.max(0, r.x * s), y = Math.max(0, r.y * s);
    await notePrivate(tab, meta, { x: x / s, y: y / s, w: r.w, h: r.h }, 'viewport', s);
    try { return await toPng(bmp, x, y, Math.min(r.w * s, bmp.width - x), Math.min(r.h * s, bmp.height - y)); } finally { bmp.close(); }
  }
  await run(tab.id, () => {
    window.__captodeState = { x: scrollX, y: scrollY, behavior: document.documentElement.style.scrollBehavior };
    document.documentElement.style.scrollBehavior = 'auto';
  });
  try {
    const scrollX = r.left - r.x;
    let at = await run(tab.id, fullPageScroll, scrollX, r.top, false);
    let bmp = await captureVisible(tab.windowId);
    const scale = bmp.width / r.vw;
    meta.dpr = scale;
    const x0 = Math.max(0, r.x), w = Math.min(r.w, r.vw - x0);
    const height = Math.min(r.h, maxHeight(w, scale));
    if (height < r.h) meta.truncated = true;
    await notePrivate(tab, meta, { x: r.left + x0 - r.x, y: r.top, w, h: height }, 'document', scale);
    const canvas = new OffscreenCanvas(Math.round(w * scale), Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    let paintedH = 0;
    const viewH = Math.max(1, Math.floor(bmp.height / scale) - OVERLAP);
    const ys = steps(height, viewH);
    for (let i = 0; i < ys.length; i++) {
      if (i) {
        at = await run(tab.id, fullPageScroll, scrollX, r.top + ys[i], true);
        bmp = await captureVisible(tab.windowId);
      }
      // The rows of the element now on screen, and where they go in the image.
      const from = Math.max(0, r.top - at.y + ys[i]);
      const to = Math.min(r.vh, r.top - at.y + height);
      if (to <= from) { bmp.close(); continue; }
      const tile = await createImageBitmap(bmp, Math.round(x0 * scale), Math.round(from * scale), canvas.width, Math.max(1, Math.round((to - from) * scale)));
      bmp.close();
      const guess = Math.round((at.y + from - r.top) * scale);
      const dy = i ? alignTile(ctx, tile, 0, guess, Math.round(OVERLAP * scale)) : guess;
      ctx.drawImage(tile, 0, dy);
      paintedH = Math.max(paintedH, dy + tile.height);
      tile.close();
      await badge(`${Math.round(((i + 1) / ys.length) * 100)}%`, '#5b4bff');
    }
    return await finish(canvas, canvas.width, paintedH || canvas.height);
  } finally {
    await run(tab.id, fullPageRestore).catch(() => {});
    await badge('');
  }
}

/**
 * How much to scale a page down so all of it fits in one image: at most 32,000 pixels
 * tall and 250 million in all, as for any capture.
 */
const fitScale = (width, height, scale) => Math.min(1, Math.min(32000 / height, Math.sqrt(250e6 / (width * height))) / scale);

/**
 * The whole page, scrolled through and stitched. A page longer than an image can be is
 * cut off, scaled down to fit (`longPages` 'scale') or captured in parts ('split'): then
 * the result is a list of `{ blob, private }`, one for each part.
 */
async function captureFullPage(tab, meta, longPages = 'cut') {
  const info = await run(tab.id, fullPagePrepare);
  try {
    if (info.panel) return await capturePanel(tab, info, meta);
    const first = await (async () => {
      await run(tab.id, fullPageScroll, 0, 0, false);
      return captureVisible(tab.windowId);
    })();
    const scale = first.width / info.vw;

    // Stay inside the browser's canvas limits.
    let height = info.height, f = 1, partH = info.height;
    const limit = maxHeight(info.width, scale);
    if (height > limit) {
      if (longPages === 'scale') f = fitScale(info.width, height, scale);
      else if (longPages === 'split') partH = limit;
      else { height = limit; meta.truncated = true; }
    }
    const s = scale * f; // image pixels per CSS pixel
    meta.dpr = s; // for measuring
    if (f < 1) meta.scaledTo = f;
    await notePrivate(tab, meta, { x: 0, y: 0, w: info.width, h: height }, 'document', s);

    // Step by what a capture really holds. At fractional scales (125%, 150%) the
    // reported viewport is rounded up, and stepping by it would leave a blank row
    // between tiles; a pixel of overlap is harmless. Each tile is then placed at the
    // scroll position the page actually reached.
    const viewW = Math.max(1, Math.floor(first.width / scale) - 1);
    const viewH = Math.max(1, Math.floor(first.height / scale) - OVERLAP);
    const xs = steps(info.width, viewW);
    const parts = [];
    for (let top = 0; top < height; top += partH) parts.push({ top, h: Math.min(partH, height - top) });
    for (const p of parts) p.ys = steps(p.h, viewH).map((y) => p.top + y);
    const total = parts.reduce((n, p) => n + p.ys.length, 0) * xs.length;
    let done = 0;
    let firstTile = first;

    const out = [];
    for (const { top, h, ys } of parts) {
      const canvas = new OffscreenCanvas(Math.round(info.width * s), Math.max(1, Math.round(h * s)));
      const ctx = canvas.getContext('2d');
      // How far the tiles reach: the page's reported size, scaled and rounded, can be
      // a pixel or two more than was actually painted.
      let paintedW = 0, paintedH = 0;
      for (const [i, y] of ys.entries()) {
        for (const x of xs) {
          let bmp, at;
          if (firstTile && x === 0 && y === 0) {
            [bmp, at, firstTile] = [firstTile, { x: 0, y: 0 }, null];
          } else {
            at = await run(tab.id, fullPageScroll, x, y, true);
            bmp = await captureVisible(tab.windowId);
          }
          if (f < 1) {
            const small = await createImageBitmap(bmp, { resizeWidth: Math.max(1, Math.round(bmp.width * f)), resizeHeight: Math.max(1, Math.round(bmp.height * f)), resizeQuality: 'high' });
            bmp.close();
            bmp = small;
          }
          const dx = Math.round(at.x * s);
          const guess = Math.round((at.y - top) * s);
          // Where the browser put the pixels can differ by one from the rounded scroll
          // position at fractional scales, and differently on each OS; line the tile up
          // with what's already drawn where they overlap.
          const dy = i > 0 ? alignTile(ctx, bmp, dx, guess, Math.round(OVERLAP * s)) : guess;
          ctx.drawImage(bmp, dx, dy);
          paintedW = Math.max(paintedW, dx + bmp.width);
          paintedH = Math.max(paintedH, dy + bmp.height);
          bmp.close();
          await badge(`${Math.round((++done / total) * 100)}%`, '#5b4bff');
        }
      }
      // Trim any unpainted strip at the right or bottom edge.
      const blob = await finish(canvas, paintedW, paintedH);
      if (parts.length === 1) return blob;
      // The private details in this part, moved to its own top.
      const y0 = top * s, y1 = (top + h) * s;
      out.push({ blob, private: meta.private?.filter((b) => b.y + b.h > y0 && b.y < y1).map((b) => ({ ...b, y: Math.round(b.y - y0) })) });
    }
    return out;
  } finally {
    await run(tab.id, fullPageRestore).catch(() => {});
    await badge('');
  }
}

// ---------- recording ----------

const getRec = async () => (await chrome.storage.session.get('rec')).rec || null;
const setRec = (rec) => chrome.storage.session.set({ rec });


/** Seconds of countdown asked for (older popups sent true for a fixed 3 seconds). */
const countdownSeconds = (v) => (v === true ? 3 : Math.max(0, Math.min(30, Number(v) || 0)));

/** Seconds after which a recording stops on its own (0: it doesn't). */
const autoStopSeconds = (v) => Math.max(0, Math.min(3600, Math.round(Number(v) || 0)));

async function startRecording({ mode, fps, audio, size = 'page', countdown: wantCountdown, inputs = false, cursor = false, camera = false, mic = false, autoStop = 0 }, tab) {
  const stopAfter = autoStopSeconds(autoStop);
  if (mode === 'screen') {
    // Picking a screen or window needs a visible page for the browser's picker.
    await setRec({ state: 'starting', kind: 'page', tabId: tab.id });
    const seconds = countdownSeconds(wantCountdown);
    await openPage(`recorder/screen.html?fps=${fps}&audio=${audio ? 1 : 0}&countdown=${seconds}&size=${encodeURIComponent(size)}&camera=${camera ? 1 : 0}&mic=${mic ? 1 : 0}&stop=${stopAfter}`, tab);
    return;
  }

  // Without tab capture the popup only offers full-screen recording; never get here.
  if (!canRecordTabs) throw new Error(t('error_recording_start'));

  let crop = null;
  let aspect = null;
  let pageWidth = null; // CSS pixels, so the video page can measure in them
  if (mode === 'area') {
    const rect = await run(tab.id, pickArea, t('pick_record_hint'));
    if (!rect) return;
    crop = { x: rect.x / rect.vw, y: rect.y / rect.vh, w: rect.w / rect.vw, h: rect.h / rect.vh };
    aspect = rect.vw / rect.vh;
    pageWidth = rect.vw;
    await run(tab.id, showOutline, rect);
  }
  if (!aspect) {
    const view = await run(tab.id, () => [innerWidth, innerHeight]).catch(() => null);
    if (view) { aspect = view[0] / view[1]; pageWidth = view[0]; }
  }
  const seconds = countdownSeconds(wantCountdown);
  if (seconds && !(await run(tab.id, countdown, seconds, t('countdown_hint')))) {
    await run(tab.id, hideOutline); // cancelled with Esc
    return;
  }

  const streamId = await startTabCapture(tab.id);
  const res = await chrome.runtime.sendMessage({
    target: 'recorder', to: 'offscreen', type: 'rec-start', streamId, fps, audio, aspect, crop, size, pageWidth, title: tab.title, camera: !!camera, mic: !!mic, autoStop: stopAfter,
  });
  if (!res?.ok) {
    await run(tab.id, hideOutline).catch(() => {});
    throw new Error(res?.error || t('error_recording_start'));
  }
  await setRec({ state: 'recording', kind: 'offscreen', tabId: tab.id, outline: !!crop, inputs: !!inputs, cursor: !!cursor });
  if (inputs || cursor) await run(tab.id, showInputs, true, { clicks: !!inputs, cursor: !!cursor }).catch(() => {});
  await enterRecordingUi();
}

// Clicks, keys and the cursor stay shown when the recorded tab loads another page.
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.status !== 'complete') return;
  const rec = await getRec();
  if (rec?.state === 'recording' && (rec.inputs || rec.cursor) && rec.tabId === tabId) {
    await run(tabId, showInputs, true, { clicks: !!rec.inputs, cursor: !!rec.cursor }).catch(() => {});
  }
});

async function enterRecordingUi() {
  await chrome.action.setPopup({ popup: '' });
  await chrome.action.setTitle({ title: t('action_stop_title') });
  await badge('REC');
}

async function leaveRecordingUi() {
  await applyIconAction();
  await chrome.action.setTitle({ title: 'Captode' });
  await badge('');
}

// ---------- the toolbar icon ----------

// A click on the icon opens the popup or, if chosen in Settings, takes a screenshot
// straight away; the popup is then in the icon's right-click menu (see openMenu).
const POPUP = 'popup/popup.html';
async function applyIconAction() {
  const { iconAction } = await getSettings();
  await chrome.action.setPopup({ popup: iconAction === 'popup' ? POPUP : '' });
}

/** Opens the popup once, when a click on the icon takes a screenshot instead. */
async function openMenu() {
  await chrome.action.setPopup({ popup: POPUP }); // put back when the popup closes
  await chrome.action.openPopup?.().catch(() => {}); // if not, the next click opens it
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  port.onDisconnect.addListener(async () => { if ((await getRec())?.state !== 'recording') await applyIconAction(); });
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const [was, now] = [changes.settings.oldValue?.iconAction, changes.settings.newValue?.iconAction];
  if (was === now) return;
  createMenu();
  if ((await getRec())?.state !== 'recording') await applyIconAction();
});

async function finishRecording(id, kind) {
  const rec = await getRec();
  await setRec(null);
  await leaveRecordingUi();
  if (rec?.outline) await run(rec.tabId, hideOutline).catch(() => {});
  if (rec?.inputs || rec?.cursor) await run(rec.tabId, showInputs, false).catch(() => {});
  if (kind === 'offscreen') {
    await endTabCapture();
    const tab = rec ? await chrome.tabs.get(rec.tabId).catch(() => null) : null;
    await openPage(`video/video.html?id=${id}`, tab);
  }
}

// Fires while recording (the popup is switched off), and when a click on the icon is set
// to take a screenshot.
async function iconClicked(tab) {
  const rec = await getRec();
  if (rec?.state === 'recording') {
    chrome.runtime.sendMessage({ target: 'recorder', type: 'rec-stop' }).catch(async () => {
      // The recorder is gone (the browser restarted it away); reset the button.
      await setRec(null);
      await leaveRecordingUi();
    });
    return;
  }
  if (rec) await setRec(null);
  const { iconAction } = await getSettings();
  const mode = iconAction === 'last'
    ? (await chrome.storage.local.get({ lastMode: {} })).lastMode.image || 'visible'
    : iconAction;
  if (!['full', 'visible', 'area', 'element'].includes(mode) || !tab?.id || tab.id < 0) {
    await leaveRecordingUi();
    chrome.action.openPopup?.().catch(() => {});
    return;
  }
  // A page that can't be captured (the browser's own, say): the popup explains why,
  // and offers recording the screen instead.
  await captureImage(mode, tab).catch(async (e) => { await reportError(e); await openMenu(); });
}
chrome.action.onClicked.addListener(iconClicked);
globalThis.captodeIconClick = iconClicked; // for the automated tests: their browser has no toolbar to click

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRec();
  if (rec && rec.kind === 'page' && rec.recorderTabId === tabId) {
    await setRec(null);
    await leaveRecordingUi();
  }
});

/** Shows a failed capture on the toolbar icon; the popup explains it when opened. */
async function reportError(e) {
  await badge('');
  await chrome.storage.session.set({ lastError: explain(e) });
  // Kept for Settings' Copy diagnostics, without the address of the page it happened on.
  const message = String(e?.message || e).replace(/\b[a-z][\w+.-]*:\/\/[^\s"')]+/gi, '<url>').slice(0, 500);
  await chrome.storage.local.set({ lastFailure: { message, when: Date.now(), version: chrome.runtime.getManifest().version } });
  await badge('!', '#d33');
}

// ---------- right-click menu ----------

// On pages the browser groups an extension's items under its name; they are also in the
// menu of Captode's toolbar icon. A click on one grants activeTab, like the toolbar
// button does.
const MENU = [['full', 'menu_full_page'], ['visible', 'menu_visible'], ['area', 'menu_area'], ['element', 'menu_element']];
const MENU_CONTEXTS = ['page', 'frame', 'selection', 'link', 'editable', 'image', 'video', 'audio', 'action'];

async function createMenu() {
  await chrome.contextMenus.removeAll();
  for (const [id, key] of MENU) chrome.contextMenus.create({ id, title: t(key), contexts: MENU_CONTEXTS }, () => void chrome.runtime.lastError);
  // When a click on the icon takes a screenshot, the popup is a right-click away.
  if ((await getSettings()).iconAction !== 'popup') {
    chrome.contextMenus.create({ id: 'open-popup', title: t('menu_open_popup'), contexts: ['action'] }, () => void chrome.runtime.lastError);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-popup') { openMenu(); return; }
  if (!tab?.id || tab.id < 0 || !MENU.some(([id]) => id === info.menuItemId)) return;
  captureImage(info.menuItemId, tab).catch(reportError);
});

// A shortcut for each kind of screenshot (set or changed in the browser's shortcut settings).
chrome.commands.onCommand.addListener(async (command, tab) => {
  const mode = /^capture-(full|visible|area|element)$/.exec(command)?.[1];
  if (!mode) return;
  tab ||= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab?.id) return;
  captureImage(mode, tab).catch(reportError);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target) return; // addressed to a recorder, not to us

  if (msg.type === 'capture-image' || msg.type === 'record-start') {
    (async () => {
      const tab = await chrome.tabs.get(msg.tabId);
      if (msg.type === 'capture-image') await captureImage(msg.mode, tab, msg.delay);
      else await startRecording(msg, tab);
    })().catch(reportError);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'rec-started') {
    (async () => {
      const rec = (await getRec()) || {};
      await setRec({ ...rec, state: 'recording', kind: 'page', recorderTabId: sender.tab?.id });
      await enterRecordingUi();
    })();
    return;
  }

  if (msg.type === 'rec-tick') {
    const s = Math.floor(msg.elapsed);
    badge(s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    return;
  }

  if (msg.type === 'rec-done') {
    finishRecording(msg.id, msg.kind).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// After an update that adds features, the popup says what's new, once.
const WHATS_NEW = '1.6.0';
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  createMenu();
  applyIconAction();
  const older = (a, b) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
    return false;
  };
  if (reason === 'update' && previousVersion && older(previousVersion, WHATS_NEW)) chrome.storage.local.set({ whatsNew: WHATS_NEW });
});

chrome.runtime.onStartup.addListener(async () => {
  createMenu(); // in the browser's current language
  await setRec(null);
  await leaveRecordingUi();
});
