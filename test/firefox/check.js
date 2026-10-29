// Runs inside Captode in Firefox (test copy only): Firefox's automation can't reach an
// extension's pages, so the checks run here and send what they saw to the test.
const params = new URL(location.href).searchParams;
const report = params.get('report'); // where to send what was seen
const site = params.get('site'); // the test site, open in another tab
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = { errors: [] };

/** Opens one of Captode's pages in a tab, waits until `ready(doc)`, and returns `read(doc)`. */
async function visit(path, ready, read) {
  const w = window.open(chrome.runtime.getURL(path));
  w.addEventListener('error', (e) => seen.errors.push(`${path}: ${e.message}`));
  w.addEventListener('unhandledrejection', (e) => seen.errors.push(`${path}: ${e.reason?.message || e.reason}`));
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    try { if (w.document.readyState === 'complete' && ready(w.document)) break; } catch {}
  }
  const out = read(w.document);
  w.close();
  return out;
}

try {
  const hidden = (doc, sel) => doc.querySelector(sel)?.closest('.toggle, .mode')?.classList.contains('hidden');
  seen.popup = await visit('popup/popup.html', (d) => d.querySelector('#opts-summary')?.textContent, (d) => ({
    tabModes: [...d.querySelectorAll('#modes-video .mode')].filter((b) => !b.classList.contains('hidden')).map((b) => b.dataset.mode),
    cameraHidden: hidden(d, '#camera'), sizeHidden: hidden(d, '#size'), inputsHidden: hidden(d, '#inputs'),
    share: !d.querySelector('#share').classList.contains('hidden'),
    numbers: [...d.querySelectorAll('#modes-video .mode:not(.hidden) .num')].map((k) => k.textContent).join(''),
  }));

  // A full-page screenshot of the test page, as the popup starts one.
  // (Firefox's URL patterns can't hold a port, so the tab is found by its address.)
  const page = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(`${site}/`));
  await chrome.tabs.update(page.id, { active: true });
  const editor = new Promise((resolve) => {
    chrome.tabs.onUpdated.addListener(function on(id, change, tab) {
      if (change.status === 'complete' && tab.url?.includes('editor/editor.html?id=')) { chrome.tabs.onUpdated.removeListener(on); resolve(tab); }
    });
  });
  await chrome.runtime.sendMessage({ type: 'capture-image', mode: 'full', tabId: page.id });
  const tab = await Promise.race([editor, sleep(30000).then(() => null)]);
  const { lastError } = await chrome.storage.session.get('lastError');
  if (tab) {
    const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
    const rec = await getCapture(new URL(tab.url).searchParams.get('id'));
    const bmp = await createImageBitmap(rec.blob);
    seen.capture = { width: bmp.width, height: bmp.height, dpr: rec.meta.dpr };
    seen.page = await chrome.scripting.executeScript({ target: { tabId: page.id }, func: () => [document.documentElement.scrollHeight, innerWidth] }).then(([r]) => r.result);
    await chrome.tabs.remove(tab.id);
  } else {
    seen.capture = { error: lastError || 'no editor opened' };
  }

  seen.settings = await visit('settings/settings.html', (d) => d.querySelectorAll('#shortcut-list dd')[1]?.textContent, (d) => ({
    shortcuts: [...d.querySelectorAll('#shortcut-list dd')].map((x) => x.textContent.trim()),
    changeShortcuts: !d.querySelector('#shortcuts').classList.contains('hidden'),
  }));
  seen.editor = await visit('editor/editor.html', (d) => d.querySelector('#tools button'), (d) => ({ tools: d.querySelectorAll('#tools button').length }));
  seen.video = await visit('video/video.html', (d) => d.body.childElementCount, () => true);
  seen.compare = await visit('compare/compare.html', (d) => d.querySelector('#sel-a option'), () => true);

  // The video page's newer parts, in Firefox: two clips joined (copied as they are),
  // then exported in the worker with a text layer, a fade where they meet and chapters.
  seen.clips = await (async () => {
    const { muxWebm } = await import(chrome.runtime.getURL('lib/webm.js'));
    const { joinPieces, probeVideo } = await import(chrome.runtime.getURL('lib/join.js'));
    const makeClip = async (color, n = 20) => {
      const frames = [];
      let err = null;
      const enc = new VideoEncoder({ output: (c) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); frames.push({ timestamp: c.timestamp, key: c.type === 'key', data: d }); }, error: (e) => { err = e; } });
      enc.configure({ codec: 'vp8', width: 320, height: 240, bitrate: 500000, framerate: 10 });
      const cv = new OffscreenCanvas(320, 240);
      const g = cv.getContext('2d');
      for (let i = 0; i < n; i++) {
        g.fillStyle = color; g.fillRect(0, 0, 320, 240); g.fillStyle = '#fff'; g.fillRect(i * 10, 10, 20, 20);
        const f = new VideoFrame(cv, { timestamp: i * 100000, duration: 100000 });
        enc.encode(f, { keyFrame: i % 10 === 0 });
        f.close();
      }
      await enc.flush();
      if (err) throw err;
      return muxWebm({ video: { codecId: 'V_VP8', width: 320, height: 240, frames } });
    };
    const a = await makeClip('#0a0'), b = await makeClip('#00a');
    const pa = await probeVideo(a), pb = await probeVideo(b);
    const { blob } = await joinPieces([{ blob: a, from: 0, len: pa.duration }, { blob: b, from: 0, len: pb.duration }]);
    const joined = await probeVideo(blob);
    const job = {
      blob, format: 'webm', width: 320, height: 240, fps: 10, start: 0, end: joined.duration, device: null, slides: [], clicks: [], logo: null,
      edits: { layers: [{ id: 't1', kind: 'text', text: 'Hi', color: '#ffffff', bg: 'dark', from: 0, to: 1, pos: 'c', size: 0.4, shape: 'rect' }] },
      video: { bitsPerPixel: 0.1, audio: false }, gif: {}, webp: {}, optimize: false, loop: 0,
      transitions: [{ at: pa.duration, kind: 'fade' }], chapters: [{ at: 0, title: 'One' }, { at: 1, title: 'Two' }], layerSources: {},
    };
    const out = await new Promise((resolve) => {
      const w = new Worker(chrome.runtime.getURL('video/export-worker.js'), { type: 'module' });
      w.onmessage = ({ data }) => {
        if (data.type === 'done') { w.terminate(); resolve({ size: data.blob.size, type: data.blob.type }); }
        if (data.type === 'error') { w.terminate(); resolve({ error: data.message, fallback: data.fallback }); }
      };
      w.onerror = (e) => resolve({ error: e.message || 'worker failed' });
      w.postMessage({ type: 'start', job });
    });
    return { joined: joined.duration, sum: pa.duration + pb.duration, out };
  })().catch((e) => ({ error: e.message }));
} catch (e) {
  seen.errors.push(`check: ${e.message}`);
}
await fetch(report, { method: 'POST', body: JSON.stringify(seen) });
