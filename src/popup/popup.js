import { enhance, tablist, showShortcut } from '../lib/ui.js';

const $ = (s) => document.querySelector(s);
const selectTab = tablist($('.kind'), (t) => { setKind(t.dataset.kind); chrome.storage.local.set({ kind: t.dataset.kind }); });
let kind = 'image';
let fps = '30';

const settings = await chrome.storage.local.get({ kind: 'image', fps: '30', audio: false, countdown: true, countdownSeconds: null, device: false, videoSize: 'page' });
fps = String(settings.fps);
$('#audio').checked = settings.audio;
// Seconds of countdown before a recording starts (0 = none): a second at a time up
// to 10, then 5 at a time up to 30. Earlier versions only stored whether the
// 3-second countdown was on.
const COUNTDOWNS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30];
const MAX_COUNTDOWN = COUNTDOWNS.at(-1);
/** The countdown `by` steps from the current one. */
const stepCountdown = (by) => {
  const i = COUNTDOWNS.findIndex((v) => v >= countdown);
  const at = i < 0 ? COUNTDOWNS.length - 1 : COUNTDOWNS[i] > countdown && by > 0 ? i - 1 : i;
  return COUNTDOWNS[Math.max(0, Math.min(COUNTDOWNS.length - 1, at + by))];
};
let countdown = settings.countdownSeconds ?? (settings.countdown ? 3 : 0);
setCountdown(countdown, false);
$('#device').checked = settings.device;
// How large recordings are: the page as shown (only the page, so a phone-sized page in
// DevTools' device mode isn't recorded with the black around it), scaled, or a standard
// resolution with the page's own shape.
const SIZE_HINTS = {
  page: 'Just the page, as shown',
  scale: 'The page, scaled up or down',
  res: 'Shorter side, same shape',
};
setSize(settings.videoSize);
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
$('#countdown-less').addEventListener('click', () => setCountdown(stepCountdown(-1)));
$('#countdown-more').addEventListener('click', () => setCountdown(stepCountdown(1)));
$('#countdown').addEventListener('keydown', (e) => {
  const next = { ArrowUp: stepCountdown(1), ArrowRight: stepCountdown(1), ArrowDown: stepCountdown(-1), ArrowLeft: stepCountdown(-1), PageUp: stepCountdown(5), PageDown: stepCountdown(-5), Home: 0, End: MAX_COUNTDOWN }[e.key]
    ?? (/^\d$/.test(e.key) ? Number(e.key) : undefined);
  if (next === undefined) return;
  e.preventDefault();
  e.stopPropagation(); // digits here set the countdown, not the capture mode
  setCountdown(next);
});
$('#size').addEventListener('change', (e) => { setSize(e.target.value); chrome.storage.local.set({ videoSize: e.target.value }); });
for (const id of ['audio', 'device']) {
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
          fps: Number(fps), audio: $('#audio').checked, countdown, size: $('#size').value,
        };
    await chrome.runtime.sendMessage(msg);
    window.close();
  });
}

function setCountdown(n, save = true) {
  countdown = Math.max(0, Math.min(MAX_COUNTDOWN, Math.round(n) || 0));
  const out = $('#countdown');
  out.textContent = countdown ? `${countdown} s` : 'Off';
  out.setAttribute('aria-valuenow', countdown);
  out.setAttribute('aria-valuetext', countdown ? `${countdown} second${countdown > 1 ? 's' : ''}` : 'Off');
  $('#countdown-less').disabled = countdown === 0;
  $('#countdown-more').disabled = countdown === MAX_COUNTDOWN;
  $('#countdown-hint').textContent = countdown ? 'Time to get ready first' : 'Recording starts straight away';
  if (save) chrome.storage.local.set({ countdownSeconds: countdown });
}

function setSize(v) {
  const select = $('#size');
  select.value = v;
  if (select.value !== v) select.value = 'page'; // a size this version doesn't offer
  const group = select.value === 'page' ? 'page' : select.value.endsWith('x') ? 'scale' : 'res';
  $('#size-hint').textContent = SIZE_HINTS[group];
}
