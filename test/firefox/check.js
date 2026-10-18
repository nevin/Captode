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
} catch (e) {
  seen.errors.push(`check: ${e.message}`);
}
await fetch(report, { method: 'POST', body: JSON.stringify(seen) });
