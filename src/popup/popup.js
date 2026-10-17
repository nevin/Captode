import { enhance, tablist, showShortcut } from '../lib/ui.js';
import { outputSize } from '../lib/recorder.js';
import { t, localize } from '../lib/i18n.js';
import { listCaptures } from '../lib/db.js';

localize();

const $ = (s) => document.querySelector(s);
const selectTab = tablist($('.kind'), (t) => { setKind(t.dataset.kind); chrome.storage.local.set({ kind: t.dataset.kind }); });
let kind = 'image';
let tabPixels = null; // this tab's page area in pixels, once known
let fps = '30';
let delay = 0; // seconds before a screenshot

const settings = await chrome.storage.local.get({ kind: 'image', fps: '30', audio: false, countdown: true, countdownSeconds: null, device: false, videoSize: 'page', lastMode: {}, recOptsOpen: false, delay: 0 });
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
  page: t('popup_just_the_page_as_shown'),
  scale: t('popup_size_hint_scale'),
  res: t('popup_size_hint_res'),
};
setSize(settings.videoSize);
setKind(settings.kind);
setFps(fps);
setDelay(settings.delay);
$('#delay').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-delay]');
  if (!b) return;
  setDelay(Number(b.dataset.delay));
  chrome.storage.local.set({ delay: delay });
});
$('#rec-opts').open = settings.recOptsOpen;
let optsOpen = settings.recOptsOpen; // saved only when it changes, not as the popup opens
$('#rec-opts').addEventListener('toggle', () => {
  if ($('#rec-opts').open === optsOpen) return;
  optsOpen = $('#rec-opts').open;
  chrome.storage.local.set({ recOptsOpen: optsOpen });
});
markLastUsed();

const { lastError } = await chrome.storage.session.get('lastError');
if (lastError) {
  $('#error-text').textContent = lastError;
  $('#error').classList.remove('hidden');
  await chrome.storage.session.remove('lastError');
  await chrome.action.setBadgeText({ text: '' });
}
$('#error-close').addEventListener('click', () => $('#error').classList.add('hidden'));

// Once, after an update with new features.
const { whatsNew } = await chrome.storage.local.get('whatsNew');
if (whatsNew && !lastError) $('#whats-new').classList.remove('hidden');
$('#whats-new-close').addEventListener('click', () => { $('#whats-new').classList.add('hidden'); chrome.storage.local.remove('whatsNew'); });

// Chrome doesn't let extensions capture its own pages or the Web Store, so say so
// up front instead of failing after a click. Recording the whole screen still works.
const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
const PROTECTED = /^(chrome|edge|brave|opera|vivaldi|about|devtools|chrome-extension|view-source|chrome-search):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/;
const blocked = !activeTab?.url || PROTECTED.test(activeTab.url);
if (blocked) {
  $('#blocked').classList.remove('hidden');
  for (const b of document.querySelectorAll('.mode:not([data-mode="screen"])')) b.disabled = true;
  markLastUsed();
}
$('#record-instead').addEventListener('click', () => {
  setKind('video');
  chrome.storage.local.set({ kind: 'video' });
  $('#modes-video [data-mode="screen"]').focus();
});
showRecent();

enhance();
showShortcut(document.querySelector('.shortcut-keys'));
showSizes();

/**
 * The size each choice gives for this tab: its page area as recorded (CSS pixels
 * times the screen's pixel ratio). Shown under the choice; full-screen recordings
 * start from the screen's size instead.
 */
async function showSizes() {
  if (blocked) return;
  try {
    const [{ result: [w, h, dpr] }] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: () => [innerWidth, innerHeight, devicePixelRatio],
    });
    tabPixels = [Math.round(w * dpr), Math.round(h * dpr)];
  } catch { return; } // the page can't be scripted: keep the plain hints
  setSize($('#size').value);
}
function setKind(k) {
  kind = k;
  for (const b of document.querySelectorAll('.kind button')) b.classList.toggle('on', b.dataset.kind === k);
  selectTab($(`.kind [data-kind="${k}"]`));
  for (const id of ['modes-image', 'hint-image']) $('#' + id).classList.toggle('hidden', k !== 'image');
  for (const id of ['modes-video', 'hint-video']) $('#' + id).classList.toggle('hidden', k !== 'video');
  $('#record-instead').classList.toggle('hidden', k === 'video');
}

function setFps(v) {
  fps = v;
  queueMicrotask(summarise);
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
  $('#' + id).addEventListener('change', (e) => { chrome.storage.local.set({ [id]: e.target.checked }); summarise(); });
}
$('#recent-all').addEventListener('click', () => $('#open-editor').click());
$('#open-settings').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
$('#open-editor').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
  window.close();
});

// 1, 2, 3 pick a mode; the hints show as soon as the keyboard is used.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT)$/.test(e.target.tagName)) return;
  const n = Number(e.key);
  if (e.key === 'Enter' && (e.target === document.body || e.target === document.documentElement)) {
    document.querySelector(`#modes-${kind} .mode:not(:disabled) .last`)?.closest('.mode').click();
  } else if (n >= 1 && n <= 3) {
    document.querySelectorAll(`#modes-${kind} .mode`)[n - 1]?.click();
  } else if (e.key === 'Tab') {
    document.body.classList.add('kbd-nav');
  }
});

for (const b of document.querySelectorAll('.mode')) {
  b.addEventListener('click', async () => {
    if (b.disabled) return;
    await chrome.storage.local.set({ lastMode: { ...settings.lastMode, [kind]: b.dataset.mode } });
    const tab = activeTab;
    const msg = kind === 'image'
      ? { type: 'capture-image', mode: b.dataset.mode, tabId: tab.id, delay }
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
  out.textContent = countdown ? t('popup_seconds_short', countdown) : t('video_off');
  out.setAttribute('aria-valuenow', countdown);
  out.setAttribute('aria-valuetext', countdown === 1 ? t('popup_one_second') : countdown ? t('popup_n_seconds', countdown) : t('video_off'));
  $('#countdown-less').disabled = countdown === 0;
  $('#countdown-more').disabled = countdown === MAX_COUNTDOWN;
  $('#countdown-hint').textContent = countdown ? t('popup_time_to_get_ready_first') : t('popup_countdown_off_hint');
  if (save) chrome.storage.local.set({ countdownSeconds: countdown });
  summarise();
}

function setSize(v) {
  const select = $('#size');
  select.value = v;
  if (select.value !== v) select.value = 'page'; // a size this version doesn't offer
  const group = select.value === 'page' ? 'page' : select.value.endsWith('x') ? 'scale' : 'res';
  if (tabPixels) {
    const { width, height } = outputSize(...tabPixels, select.value);
    $('#size-hint').textContent = `${width} × ${height} px`;
    $('#size-hint').title = t('popup_size_hint_title', SIZE_HINTS[group]);
  } else {
    $('#size-hint').textContent = SIZE_HINTS[group];
  }
  summarise();
}

/** The recording options in one line, shown while they're folded away. */
function summarise() {
  const out = $('#opts-summary');
  if (!out || !$('#size').selectedOptions[0]) return;
  out.textContent = [
    `${fps} fps`,
    $('#size').selectedOptions[0].textContent,
    countdown ? t('popup_countdown_short', countdown) : t('popup_no_countdown'),
    ...($('#audio').checked ? [t('popup_with_audio')] : []),
  ].join(' · ');
}

/** Marks the mode used last for each kind; Enter repeats it. */
function markLastUsed() {
  for (const el of document.querySelectorAll('.mode .last')) el.remove();
  for (const [k, mode] of Object.entries(settings.lastMode)) {
    const b = document.querySelector(`#modes-${k === 'video' ? 'video' : 'image'} .mode[data-mode="${mode}"]`);
    if (!b || b.disabled) continue;
    b.querySelector('.num').insertAdjacentHTML('beforebegin', `<span class="last" title="${t('popup_enter_repeats')}">${t('popup_last_used')}</span>`);
  }
}

/** The last three captures, a click from reopening. */
async function showRecent() {
  const items = await listCaptures(3).catch(() => []);
  if (!items.length) return;
  const row = $('#recent-list');
  for (const it of items) {
    const a = document.createElement('a');
    const video = it.kind === 'video';
    a.href = chrome.runtime.getURL(video ? `video/video.html?id=${it.id}` : `editor/editor.html?id=${it.id}&reopen=1`);
    const title = it.meta.title || (video ? t('video_recording') : t('popup_screenshot'));
    a.title = title;
    a.setAttribute('aria-label', title);
    const thumb = document.createElement(video ? 'video' : 'img');
    thumb.src = URL.createObjectURL(it.blob) + (video ? '#t=0.1' : '');
    if (video) { thumb.muted = true; thumb.preload = 'metadata'; } else { thumb.decoding = 'async'; thumb.alt = ''; }
    a.append(thumb);
    if (video) a.insertAdjacentHTML('beforeend', `<span class="badge">${t('badge_video')}</span>`);
    a.addEventListener('click', async (e) => { e.preventDefault(); await chrome.tabs.create({ url: a.href }); window.close(); });
    row.append(a);
  }
  $('#recent').classList.remove('hidden');
}

function setDelay(v) {
  delay = [0, 3, 5, 10].includes(v) ? v : 0;
  for (const b of document.querySelectorAll('#delay button')) {
    b.classList.toggle('on', Number(b.dataset.delay) === delay);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(Number(b.dataset.delay) === delay));
  }
}
