import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../lib/settings.js';
import { toast, enhance, openDialog, showShortcut, shareCaptode } from '../lib/ui.js';
import { t, localize } from '../lib/i18n.js';
import { openShortcutSettings, canChangeShortcuts, STORE_URL } from '../lib/platform.js';

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
}

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
  const local = await chrome.storage.local.get(['fps', 'videoSize', 'audio', 'inputs', 'camera', 'mic', 'delay', 'device']);
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
const RESET_KEYS = ['settings', 'device', 'fps', 'audio', 'countdown', 'countdownSeconds', 'videoSize', 'kind', 'deviceOpts', 'deviceRecent', 'editorDefaults', 'exportPresets', 'lastExport', 'inputs', 'camera', 'mic', 'delay'];
$('#reset-yes').addEventListener('click', async () => {
  const before = await chrome.storage.local.get(RESET_KEYS);
  await chrome.storage.local.remove(RESET_KEYS);
  settings = await saveSettings(DEFAULT_SETTINGS);
  $('#device').checked = false;
  render();
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
