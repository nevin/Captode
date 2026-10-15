// Captode service worker: runs captures, coordinates recordings and switches the
// toolbar icon between "open the popup" and "stop recording".
import { putCapture } from './lib/db.js';
import {
  pickArea, fullPagePrepare, fullPageScroll, fullPageRestore,
  countdown, showOutline, hideOutline,
} from './content/page.js';

const OFFSCREEN = 'recorder/offscreen.html';

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

async function openPage(path, tab) {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(path),
    index: tab ? tab.index + 1 : undefined,
    windowId: tab?.windowId,
  });
}

async function badge(text, color = '#e5484d') {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

function explain(err) {
  const m = String(err?.message || err);
  if (/cannot be scripted|Cannot access|chrome:\/\/|extensions gallery|webstore/i.test(m)) {
    return 'This page cannot be captured. Browser pages and the extension store are protected.';
  }
  return m;
}

// ---------- screenshots ----------

async function captureImage(mode, tab) {
  let blob;
  const meta = { title: tab.title, url: tab.url, mode };

  if (mode === 'visible') {
    const bmp = await captureVisible(tab.windowId);
    blob = await toPng(bmp, 0, 0, bmp.width, bmp.height);
  } else if (mode === 'area') {
    const rect = await run(tab.id, pickArea, 'Drag to select the area to capture');
    if (!rect) return;
    const bmp = await captureVisible(tab.windowId);
    const s = bmp.width / rect.vw;
    blob = await toPng(bmp, rect.x * s, rect.y * s, rect.w * s, rect.h * s);
  } else {
    blob = await captureFullPage(tab, meta);
  }

  const id = await putCapture(blob, meta);
  await openPage(`editor/editor.html?id=${id}`, tab);
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

async function captureFullPage(tab, meta) {
  const info = await run(tab.id, fullPagePrepare);
  try {
    const first = await (async () => {
      await run(tab.id, fullPageScroll, 0, 0, false);
      return captureVisible(tab.windowId);
    })();
    const scale = first.width / info.vw;

    // Stay inside the browser's canvas limits; very long pages are cut off.
    const maxH = Math.floor(Math.min(32000, 250e6 / (info.width * scale)) / scale);
    const height = Math.min(info.height, maxH);
    if (height < info.height) meta.truncated = true;

    const canvas = new OffscreenCanvas(Math.round(info.width * scale), Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(first, 0, 0);
    // How far the tiles reach: the page's reported size, scaled and rounded, can be
    // a pixel or two more than was actually painted.
    let paintedW = first.width;
    let paintedH = first.height;

    const steps = (total, view) => {
      const out = [];
      for (let p = 0; p < total; p += view) out.push(Math.min(p, Math.max(0, total - view)));
      return [...new Set(out)];
    };
    // Step by what a capture really holds. At fractional scales (125%, 150%) the
    // reported viewport is rounded up, and stepping by it would leave a blank row
    // between tiles; a pixel of overlap is harmless. Each tile is then placed at the
    // scroll position the page actually reached.
    const OVERLAP = 24; // CSS pixels shared by neighbouring tiles, for lining them up
    const viewW = Math.max(1, Math.floor(first.width / scale) - 1);
    const viewH = Math.max(1, Math.floor(first.height / scale) - OVERLAP);
    const xs = steps(info.width, viewW);
    const ys = steps(height, viewH);
    const total = xs.length * ys.length;
    let done = 1;

    for (const y of ys) {
      for (const x of xs) {
        if (x === 0 && y === 0) continue;
        const at = await run(tab.id, fullPageScroll, x, y, true);
        const bmp = await captureVisible(tab.windowId);
        const dx = Math.round(at.x * scale);
        // Where Chrome put the pixels can differ by one from the rounded scroll
        // position at fractional scales, and differently on each OS; line the tile up
        // with what's already drawn where they overlap.
        const dy = y > 0 ? alignTile(ctx, bmp, dx, Math.round(at.y * scale), Math.round(OVERLAP * scale)) : Math.round(at.y * scale);
        ctx.drawImage(bmp, dx, dy);
        paintedW = Math.max(paintedW, dx + bmp.width);
        paintedH = Math.max(paintedH, dy + bmp.height);
        bmp.close();
        await badge(`${Math.round((++done / total) * 100)}%`, '#5b4bff');
      }
    }
    // Trim any unpainted strip at the right or bottom edge.
    if (paintedW < canvas.width || paintedH < canvas.height) {
      const trimmed = new OffscreenCanvas(Math.min(canvas.width, paintedW), Math.min(canvas.height, paintedH));
      trimmed.getContext('2d').drawImage(canvas, 0, 0);
      return await trimmed.convertToBlob({ type: 'image/png' });
    }
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    await run(tab.id, fullPageRestore).catch(() => {});
    await badge('');
  }
}

// ---------- recording ----------

const getRec = async () => (await chrome.storage.session.get('rec')).rec || null;
const setRec = (rec) => chrome.storage.session.set({ rec });

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument?.();
  if (exists) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Record the current tab after the user starts a recording.',
  });
}

/** Seconds of countdown asked for (older popups sent true for a fixed 3 seconds). */
const countdownSeconds = (v) => (v === true ? 3 : Math.max(0, Math.min(30, Number(v) || 0)));

async function startRecording({ mode, fps, audio, countdown: wantCountdown }, tab) {
  if (mode === 'screen') {
    // Picking a screen or window needs a visible page for the browser's picker.
    await setRec({ state: 'starting', kind: 'page', tabId: tab.id });
    const seconds = countdownSeconds(wantCountdown);
    await openPage(`recorder/screen.html?fps=${fps}&audio=${audio ? 1 : 0}&countdown=${seconds}`, tab);
    return;
  }

  let crop = null;
  if (mode === 'area') {
    const rect = await run(tab.id, pickArea, 'Drag to select the area to record');
    if (!rect) return;
    crop = { x: rect.x / rect.vw, y: rect.y / rect.vh, w: rect.w / rect.vw, h: rect.h / rect.vh };
    await run(tab.id, showOutline, rect);
  }
  const seconds = countdownSeconds(wantCountdown);
  if (seconds && !(await run(tab.id, countdown, seconds))) {
    await run(tab.id, hideOutline); // cancelled with Esc
    return;
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: 'recorder', to: 'offscreen', type: 'rec-start', streamId, fps, audio, crop, title: tab.title,
  });
  if (!res?.ok) {
    await run(tab.id, hideOutline).catch(() => {});
    throw new Error(res?.error || 'Could not start recording.');
  }
  await setRec({ state: 'recording', kind: 'offscreen', tabId: tab.id, outline: !!crop });
  await enterRecordingUi();
}

async function enterRecordingUi() {
  await chrome.action.setPopup({ popup: '' });
  await chrome.action.setTitle({ title: 'Captode — click to stop recording' });
  await badge('REC');
}

async function leaveRecordingUi() {
  await chrome.action.setPopup({ popup: 'popup/popup.html' });
  await chrome.action.setTitle({ title: 'Captode' });
  await badge('');
}

async function finishRecording(id, kind) {
  const rec = await getRec();
  await setRec(null);
  await leaveRecordingUi();
  if (rec?.outline) await run(rec.tabId, hideOutline).catch(() => {});
  if (kind === 'offscreen') {
    await chrome.offscreen.closeDocument().catch(() => {});
    const tab = rec ? await chrome.tabs.get(rec.tabId).catch(() => null) : null;
    await openPage(`video/video.html?id=${id}`, tab);
  }
}

chrome.action.onClicked.addListener(async () => {
  // Only fires while recording, when the popup is switched off.
  const rec = await getRec();
  if (rec?.state === 'recording') {
    chrome.runtime.sendMessage({ target: 'recorder', type: 'rec-stop' }).catch(async () => {
      // The recorder is gone (the browser restarted it away); reset the button.
      await setRec(null);
      await leaveRecordingUi();
    });
  } else {
    await setRec(null);
    await leaveRecordingUi();
    chrome.action.openPopup?.().catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRec();
  if (rec && rec.kind === 'page' && rec.recorderTabId === tabId) {
    await setRec(null);
    await leaveRecordingUi();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target) return; // addressed to a recorder, not to us

  if (msg.type === 'capture-image' || msg.type === 'record-start') {
    (async () => {
      const tab = await chrome.tabs.get(msg.tabId);
      if (msg.type === 'capture-image') await captureImage(msg.mode, tab);
      else await startRecording(msg, tab);
    })().catch(async (e) => {
      await badge('');
      await chrome.storage.session.set({ lastError: explain(e) });
      await badge('!', '#d33');
    });
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

chrome.runtime.onStartup.addListener(async () => {
  await setRec(null);
  await leaveRecordingUi();
});
