import { enhance, tablist, showShortcut } from '../lib/ui.js';

const $ = (s) => document.querySelector(s);
const selectTab = tablist($('.kind'), (t) => { setKind(t.dataset.kind); chrome.storage.local.set({ kind: t.dataset.kind }); });
let kind = 'image';
let fps = '30';

const settings = await chrome.storage.local.get({ kind: 'image', fps: '30', audio: false, countdown: true, device: false });
fps = String(settings.fps);
$('#audio').checked = settings.audio;
$('#countdown').checked = settings.countdown;
$('#device').checked = settings.device;
setKind(settings.kind);
setFps(fps);

const { lastError } = await chrome.storage.session.get('lastError');
if (lastError) {
  $('#error-text').textContent = lastError;
  $('#error').classList.remove('hidden');
  await chrome.storage.session.remove('lastError');
  await chrome.action.setBadgeText({ text: '' });
}
$('#error-close').addEventListener('click', () => $('#error').classList.add('hidden'));

// Chrome doesn't let extensions capture its own pages or the Web Store, so say so
// up front instead of failing after a click. Recording the whole screen still works.
const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
const PROTECTED = /^(chrome|edge|brave|opera|vivaldi|about|devtools|chrome-extension|view-source|chrome-search):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/;
const blocked = !activeTab?.url || PROTECTED.test(activeTab.url);
if (blocked) {
  $('#blocked').classList.remove('hidden');
  for (const b of document.querySelectorAll('.mode:not([data-mode="screen"])')) b.disabled = true;
}
enhance();
showShortcut(document.querySelector('.shortcut-keys'));

function setKind(k) {
  kind = k;
  for (const b of document.querySelectorAll('.kind button')) b.classList.toggle('on', b.dataset.kind === k);
  selectTab($(`.kind [data-kind="${k}"]`));
  for (const id of ['modes-image', 'hint-image']) $('#' + id).classList.toggle('hidden', k !== 'image');
  for (const id of ['modes-video', 'hint-video']) $('#' + id).classList.toggle('hidden', k !== 'video');
}

function setFps(v) {
  fps = v;
  for (const b of document.querySelectorAll('#fps button')) {
    b.classList.toggle('on', b.dataset.fps === v);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(b.dataset.fps === v));
  }
}

for (const b of document.querySelectorAll('.kind button')) {
  b.addEventListener('click', () => {
    setKind(b.dataset.kind);
    chrome.storage.local.set({ kind: b.dataset.kind });
  });
}
$('#fps').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.fps;
  if (!v) return;
  setFps(v);
  chrome.storage.local.set({ fps: v });
});
for (const id of ['audio', 'countdown', 'device']) {
  $('#' + id).addEventListener('change', (e) => chrome.storage.local.set({ [id]: e.target.checked }));
}
$('#open-settings').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
$('#open-editor').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
  window.close();
});

// 1, 2, 3 pick a mode; the hints show as soon as the keyboard is used.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT)$/.test(e.target.tagName)) return;
  const n = Number(e.key);
  if (n >= 1 && n <= 3) {
    document.querySelectorAll(`#modes-${kind} .mode`)[n - 1]?.click();
  } else if (e.key === 'Tab') {
    document.body.classList.add('kbd-nav');
  }
});

for (const b of document.querySelectorAll('.mode')) {
  b.addEventListener('click', async () => {
    if (b.disabled) return;
    const tab = activeTab;
    const msg = kind === 'image'
      ? { type: 'capture-image', mode: b.dataset.mode, tabId: tab.id }
      : {
          type: 'record-start', mode: b.dataset.mode, tabId: tab.id,
          fps: Number(fps), audio: $('#audio').checked, countdown: $('#countdown').checked,
        };
    await chrome.runtime.sendMessage(msg);
    window.close();
  });
}
