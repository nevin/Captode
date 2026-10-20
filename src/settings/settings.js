import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../lib/settings.js';
import { toast, enhance, openDialog, showShortcut, shareCaptode } from '../lib/ui.js';
import { t, localize } from '../lib/i18n.js';
import { openShortcutSettings, canChangeShortcuts, STORE_URL, canRecordTabs, canProcessVideo } from '../lib/platform.js';
import { fileStem, DEFAULT_FILE_NAME, FILE_NAME_TOKENS } from '../lib/filename.js';

localize();

const $ = (s) => document.querySelector(s);
let settings = await getSettings();
const { device } = await chrome.storage.local.get({ device: false });

const saved = () => toast(t('settings_saved'), { kind: 'success', ms: 1400 });

async function update(patch) {
  settings = await saveSettings(patch);
  render();
  saved();
}

function choose(group, value) {
  for (const b of document.querySelectorAll(`#${group} [data-v]`)) b.setAttribute('aria-checked', String(b.dataset.v === value));
}

function render() {
  choose('theme', settings.theme);
  choose('background', settings.background);
  $('#custom-row').classList.toggle('hidden', settings.background !== 'custom');
  $('#custom-swatch').style.background = settings.backgroundColor;
  $('#bg-color').value = settings.backgroundColor;
  if (document.activeElement !== $('#bg-hex')) $('#bg-hex').value = settings.backgroundColor;
  $('#imageFormat').value = settings.imageFormat;
  $('#videoFormat').value = settings.videoFormat;
  $('#autoCopy').checked = settings.autoCopy;
  $('#autoBlur').checked = settings.autoBlur;
  for (const id of ['iconAction', 'afterCapture', 'longPages']) $('#' + id).value = settings[id];
  $('#icon-hint').classList.toggle('hidden', settings.iconAction === 'popup');
  $('#after-hint').classList.toggle('hidden', settings.afterCapture === 'editor');
  if (document.activeElement !== $('#fileName')) $('#fileName').value = settings.fileName || DEFAULT_FILE_NAME;
  showExample();
}

// ---------- screenshots ----------

for (const id of ['iconAction', 'afterCapture', 'longPages']) {
  $('#' + id).addEventListener('change', (e) => update({ [id]: e.target.value }));
}
/** The name a screenshot of this page would get now. */
function showExample() {
  const name = fileStem($('#fileName').value, { title: t('settings_example_title'), url: 'https://www.example.com/', when: new Date() });
  $('#name-example').textContent = t('settings_file_name_example', `${name}.png`);
}
// Saved as typed; the default is stored as empty, so it can change with Captode.
const saveName = (v) => update({ fileName: v.trim() === DEFAULT_FILE_NAME ? '' : v.trim() });
let nameTimer = 0;
$('#fileName').addEventListener('input', (e) => {
  showExample();
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => saveName(e.target.value), 600);
});
$('#fileName-default').addEventListener('click', () => { $('#fileName').value = DEFAULT_FILE_NAME; saveName(DEFAULT_FILE_NAME); });
for (const token of FILE_NAME_TOKENS) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.type = 'button';
  b.textContent = token;
  b.addEventListener('click', () => {
    const input = $('#fileName');
    const at = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? at;
    // Joined to its neighbours with a dash, unless there is one already.
    const before = input.value.slice(0, at), after = input.value.slice(end);
    const text = (before && !/[-_ .]$/.test(before) ? '-' : '') + token + (after && !/^[-_ .]/.test(after) ? '-' : '');
    input.value = before + text + after;
    input.focus();
    input.setSelectionRange(at + text.length, at + text.length);
    showExample();
    saveName(input.value);
  });
  $('#name-tokens').append(b);
}

// ---------- recording ----------
// The same options as the popup's, kept where the popup keeps them.

const REC_DEFAULTS = { fps: '30', videoSize: 'page', countdown: true, countdownSeconds: null, autoStop: 0, audio: false, mic: false, camera: false, inputs: false, cursor: false };
const COUNTDOWNS = [0, 1, 2, 3, 5, 10, 15, 20, 30];
const STOPS = [0, 15, 30, 60, 120, 300, 600, 1800];
const seconds = (n) => (n === 1 ? t('popup_one_second') : t('popup_n_seconds', n));
const minutes = (n) => (n === 1 ? t('settings_one_minute') : t('settings_n_minutes', n));
$('#rec-countdown').append(...COUNTDOWNS.map((n) => new Option(n ? seconds(n) : t('video_off'), n)));
$('#rec-autoStop').append(...STOPS.map((n) => new Option(n ? (n < 60 ? seconds(n) : minutes(n / 60)) : t('settings_stop_never'), n)));
// Only what this browser can do (as in the popup).
if (!canProcessVideo) for (const id of ['rec-size-field', 'rec-camera']) ($('#' + id).closest('.toggle') || $('#' + id)).classList.add('hidden');
if (!canRecordTabs) for (const id of ['rec-inputs', 'rec-cursor']) $('#' + id).closest('.toggle').classList.add('hidden');

async function renderRecording() {
  const r = await chrome.storage.local.get(REC_DEFAULTS);
  $('#rec-fps').value = String(r.fps);
  $('#rec-size').value = r.videoSize;
  if ($('#rec-size').value !== r.videoSize) $('#rec-size').value = 'page';
  const countdown = r.countdownSeconds ?? (r.countdown ? 3 : 0);
  if (!COUNTDOWNS.includes(countdown)) $('#rec-countdown').append(new Option(seconds(countdown), countdown)); // set in the popup
  $('#rec-countdown').value = String(countdown);
  if (!STOPS.includes(Number(r.autoStop))) $('#rec-autoStop').append(new Option(seconds(r.autoStop), r.autoStop));
  $('#rec-autoStop').value = String(r.autoStop);
  for (const k of ['audio', 'mic', 'camera', 'inputs', 'cursor']) $('#rec-' + k).checked = !!r[k];
}
const saveRec = async (patch) => { await chrome.storage.local.set(patch); saved(); };
$('#rec-fps').addEventListener('change', (e) => saveRec({ fps: e.target.value }));
$('#rec-size').addEventListener('change', (e) => saveRec({ videoSize: e.target.value }));
$('#rec-countdown').addEventListener('change', (e) => saveRec({ countdownSeconds: Number(e.target.value) }));
$('#rec-autoStop').addEventListener('change', (e) => saveRec({ autoStop: Number(e.target.value) }));
for (const k of ['audio', 'inputs', 'cursor']) $('#rec-' + k).addEventListener('change', (e) => saveRec({ [k]: e.target.checked }));
// The camera and microphone: this page can ask the browser for them itself.
for (const [k, kind] of [['mic', 'audio'], ['camera', 'video']]) {
  $('#rec-' + k).addEventListener('change', async (e) => {
    if (!e.target.checked) { saveRec({ [k]: false }); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ [kind]: true });
      for (const track of stream.getTracks()) track.stop();
      saveRec({ [k]: true });
    } catch {
      e.target.checked = false;
      toast(t('settings_not_allowed'), { kind: 'error', ms: 6000 });
    }
  });
}
// Changed in the popup meanwhile: show it on coming back.
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderRecording(); });
renderRecording();

for (const group of ['theme', 'background']) {
  $('#' + group).addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (v) update({ [group]: v });
  });
}
$('#bg-color').addEventListener('input', (e) => update({ backgroundColor: e.target.value }));
$('#bg-hex').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) update({ backgroundColor: v.toLowerCase() });
});
$('#imageFormat').addEventListener('change', (e) => update({ imageFormat: e.target.value }));
$('#videoFormat').addEventListener('change', (e) => update({ videoFormat: e.target.value }));
$('#autoCopy').addEventListener('change', (e) => update({ autoCopy: e.target.checked }));
$('#autoBlur').addEventListener('change', (e) => update({ autoBlur: e.target.checked }));
$('#device').checked = device;
$('#device').addEventListener('change', async (e) => { await chrome.storage.local.set({ device: e.target.checked }); saved(); });
$('#shortcuts').classList.toggle('hidden', !canChangeShortcuts);
$('#shortcuts').addEventListener('click', () => openShortcutSettings());
$('#version').textContent = t('settings_version', chrome.runtime.getManifest().version);
$('#reset').addEventListener('click', () => openDialog($('#reset-dialog')));
$('#share').classList.toggle('hidden', !STORE_URL); // until listed in this browser's store
$('#share').addEventListener('click', () => shareCaptode());

/**
 * What a bug report needs, as text to paste: versions, the browser's language and
 * screen, shortcuts, settings and the last error. Nothing about pages or captures,
 * and it is only copied, never sent.
 */
async function diagnostics() {
  const ua = navigator.userAgentData;
  const hi = await ua?.getHighEntropyValues(['platformVersion', 'fullVersionList', 'architecture']).catch(() => null);
  const browser = hi?.fullVersionList?.filter((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`).join(', ')
    || /Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] || navigator.userAgent;
  const shortcuts = (await chrome.commands.getAll().catch(() => [])).map((c) => `${c.name} = ${c.shortcut || '-'}`).join(', ');
  const { lastFailure } = await chrome.storage.local.get('lastFailure');
  const local = await chrome.storage.local.get(['fps', 'videoSize', 'audio', 'inputs', 'cursor', 'camera', 'mic', 'delay', 'device', 'countdownSeconds', 'autoStop']);
  const m = chrome.runtime.getManifest();
  return [
    `Captode ${m.version}`,
    `Browser: ${browser}`,
    `OS: ${ua?.platform || navigator.platform}${hi?.platformVersion ? ` ${hi.platformVersion}` : ''}${hi?.architecture ? ` (${hi.architecture})` : ''}`,
    `Language: ${chrome.i18n.getUILanguage()}`,
    `Screen: ${screen.width} × ${screen.height} at ${devicePixelRatio}×`,
    `Shortcuts: ${shortcuts}`,
    `Settings: ${JSON.stringify({ ...settings, ...local })}`,
    `Last error: ${lastFailure ? `${lastFailure.message} (${new Date(lastFailure.when).toISOString()}, ${lastFailure.version})` : 'none'}`,
  ].join('\n');
}
$('#diagnostics').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(await diagnostics());
    toast(t('settings_diagnostics_copied'), { kind: 'success', ms: 4000 });
  } catch (e) {
    toast(e.message || String(e), { kind: 'error' });
  }
});
const RESET_KEYS = ['settings', 'device', 'fps', 'audio', 'countdown', 'countdownSeconds', 'videoSize', 'kind', 'deviceOpts', 'deviceRecent', 'editorDefaults', 'exportPresets', 'lastExport', 'inputs', 'cursor', 'camera', 'mic', 'delay', 'autoStop'];
$('#reset-yes').addEventListener('click', async () => {
  const before = await chrome.storage.local.get(RESET_KEYS);
  await chrome.storage.local.remove(RESET_KEYS);
  settings = await saveSettings(DEFAULT_SETTINGS);
  $('#device').checked = false;
  render();
  renderRecording();
  $('#reset-dialog').close();
  toast(t('settings_reset_done'), {
    kind: 'success', ms: 8000,
    action: {
      label: t('editor_undo'),
      run: async () => {
        await chrome.storage.local.set(before);
        settings = await getSettings();
        $('#device').checked = !!before.device;
        render();
        renderRecording();
        toast(t('settings_restored'), { kind: 'success' });
      },
    },
  });
});
enhance();
const showShortcuts = () => { for (const row of document.querySelectorAll('#shortcut-list [data-command]')) showShortcut(row.querySelector('dd'), row.dataset.command); };
showShortcuts();
// Pick up shortcuts changed in the browser's shortcut settings when coming back.
document.addEventListener('visibilitychange', () => { if (!document.hidden) showShortcuts(); });
render();
