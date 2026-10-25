import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../lib/settings.js';
import { toast, enhance, openDialog, showShortcut, shareCaptode } from '../lib/ui.js';
import { t, localize } from '../lib/i18n.js';
import { openShortcutSettings, canChangeShortcuts, STORE_URL, canRecordTabs, canProcessVideo } from '../lib/platform.js';
import { fileStem, DEFAULT_FILE_NAME, FILE_NAME_TOKENS } from '../lib/filename.js';
import { listCaptures, setKept, deleteCapture, restoreCapture } from '../lib/db.js';
import { openProject, pageFor } from '../lib/project.js';
import { downloadProject } from '../lib/keep.js';
import { fmtBytes, ago, confirmDialog } from '../lib/ui.js';
import { getBrand, saveBrand, logoFromFile, loadLogo, drawLogo } from '../lib/brand.js';

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
  $('#keepFor').value = String(settings.keepFor ?? 1);
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
const RESET_KEYS = ['settings', 'device', 'fps', 'audio', 'countdown', 'countdownSeconds', 'videoSize', 'kind', 'deviceOpts', 'deviceRecent', 'editorDefaults', 'exportPresets', 'lastExport', 'inputs', 'cursor', 'camera', 'mic', 'delay', 'autoStop', 'brand'];
/** Everything on this page after its settings change underneath it (reset, undo, loaded from a file). */
async function renderAll() {
  settings = await getSettings();
  $('#device').checked = !!(await chrome.storage.local.get({ device: false })).device;
  render();
  renderRecording();
  renderBrand();
  renderPresets();
  renderStorage();
}
$('#reset-yes').addEventListener('click', async () => {
  const before = await chrome.storage.local.get(RESET_KEYS);
  await chrome.storage.local.remove(RESET_KEYS);
  settings = await saveSettings(DEFAULT_SETTINGS);
  await renderAll();
  $('#reset-dialog').close();
  toast(t('settings_reset_done'), {
    kind: 'success', ms: 8000,
    action: {
      label: t('editor_undo'),
      run: async () => {
        await chrome.storage.local.set(before);
        await renderAll();
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

// ---------- your logo ----------

async function renderBrand() {
  const b = await getBrand();
  $('#brand-preview').classList.toggle('hidden', !b.image);
  if (b.image) $('#brand-preview').src = b.image; else $('#brand-preview').removeAttribute('src');
  $('#brand-remove').classList.toggle('hidden', !b.image);
  $('#brand-options').classList.toggle('hidden', !b.image);
  $('#brand-position').value = b.position;
  $('#brand-size').value = String(b.size);
  $('#brand-opacity').value = String(Math.round(b.opacity * 100));
  $('#brand-images').checked = b.images;
  $('#brand-videos').checked = b.videos;
  drawBrandSample(b);
}

/** A made-up page with the logo where it will go, so a change shows at once. */
async function drawBrandSample(b) {
  const c = $('#brand-sample');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.fillStyle = '#f6f6f9'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#5b4bff'; ctx.fillRect(0, 0, W, 30);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(24, 50, W - 48, H - 74);
  ctx.fillStyle = '#d9d9e3';
  for (let i = 0; i < 7; i++) ctx.fillRect(44, 72 + i * 24, (W - 120) * (i % 3 === 2 ? 0.55 : 0.9), 10);
  const logo = await loadLogo(b);
  if (logo) { drawLogo(ctx, logo, 0, 0, W, H); logo.bitmap.close(); }
}
const brandUpdate = async (patch) => { await saveBrand(patch); await renderBrand(); saved(); };
$('#brand-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let image;
  try { image = await logoFromFile(file); } catch { toast(t('brand_not_image'), { kind: 'error' }); return; }
  // Turned on for screenshots the first time a logo is chosen: that's why it was chosen.
  const first = !(await getBrand()).image;
  await brandUpdate({ image, ...(first && { images: true }) });
});
$('#brand-remove').addEventListener('click', () => brandUpdate({ image: '', images: false, videos: false }));
$('#brand-position').addEventListener('change', (e) => brandUpdate({ position: e.target.value }));
$('#brand-size').addEventListener('change', (e) => brandUpdate({ size: Number(e.target.value) }));
$('#brand-opacity').addEventListener('change', (e) => brandUpdate({ opacity: Number(e.target.value) / 100 }));
$('#brand-opacity').addEventListener('input', async (e) => drawBrandSample({ ...(await getBrand()), opacity: Number(e.target.value) / 100 }));
$('#brand-images').addEventListener('change', (e) => brandUpdate({ images: e.target.checked }));
$('#brand-videos').addEventListener('change', (e) => brandUpdate({ videos: e.target.checked }));
renderBrand();

// ---------- captures and storage ----------

const ICON_KEEP = '<svg class="i" viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
const ICON_PROJECT = '<svg class="i" viewBox="0 0 24 24"><path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7M12 11v10"/></svg>';
const ICON_DELETE = '<svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

async function renderStorage() {
  const list = document.getElementById('storage-list');
  if (!list) return;
  const items = await listCaptures(500);
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const used = items.reduce((n, it) => n + it.size, 0);
  document.getElementById('storage-usage').textContent = `${t('storage_hint')} ${t('storage_used', [String(items.length), fmtBytes(est?.usage ?? used)])}`;
  document.getElementById('delete-unkept').disabled = !items.some((it) => !it.kept);
  list.textContent = '';
  // Search and show only some: offered once there are enough to look through.
  $('#storage-filter').classList.toggle('hidden', items.length < 6);
  const words = $('#storage-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const kind = $('#storage-kind').value;
  const shown = items.filter((it) => {
    if (kind === 'kept' ? !it.kept : kind && it.kind !== kind) return false;
    let host = '';
    try { host = it.meta.url ? new URL(it.meta.url).hostname : ''; } catch {}
    const hay = `${it.meta.title || ''} ${host} ${new Date(it.created).toLocaleDateString()}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  $('#storage-none').classList.toggle('hidden', !items.length || shown.length > 0);
  if ($('#storage-sort').value === 'big') shown.sort((a, b) => b.size - a.size);
  // How the space is shared between screenshots and recordings.
  const bytes = { image: 0, video: 0 };
  for (const it of items) bytes[it.kind === 'video' ? 'video' : 'image'] += it.size;
  const total = bytes.image + bytes.video;
  $('#storage-meter').classList.toggle('hidden', !total);
  $('#storage-breakdown').classList.toggle('hidden', !total);
  if (total) {
    $('#storage-meter .m-img').style.width = `${(bytes.image / total) * 100}%`;
    $('#storage-meter .m-vid').style.width = `${(bytes.video / total) * 100}%`;
    $('#storage-breakdown').textContent = t('storage_breakdown', [fmtBytes(bytes.image), fmtBytes(bytes.video)]);
  }
  for (const it of shown) {
    const title = it.meta.title || (it.kind === 'video' ? t('video_recording') : t('popup_screenshot'));
    const li = document.createElement('li');
    li.innerHTML = `<a class="what" href="#"><b></b><small></small></a>
      <button class="btn ghost icon keep">${ICON_KEEP}</button>
      <button class="btn ghost icon project">${ICON_PROJECT}</button>
      <button class="btn ghost icon delete">${ICON_DELETE}</button>`;
    li.querySelector('b').textContent = title;
    li.querySelector('small').textContent = [it.kind === 'video' ? t('badge_video') : t('popup_screenshot'), it.kept ? t('kept') : ago(it.created), fmtBytes(it.size)].join(' · ');
    li.querySelector('.what').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL(pageFor(it)) }); });
    const tips = [['.keep', t(it.kept ? 'keep_on_tip' : 'keep_off_tip')], ['.project', t('project_save_tip')], ['.delete', t('remove')]];
    for (const [sel, tip] of tips) { const b = li.querySelector(sel); b.dataset.tip = tip; b.setAttribute('aria-label', `${tip}: ${title}`); }
    const keep = li.querySelector('.keep');
    keep.classList.toggle('on', it.kept);
    keep.setAttribute('aria-pressed', String(it.kept));
    keep.addEventListener('click', async () => { await setKept(it.id, !it.kept); await renderStorage(); });
    li.querySelector('.project').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try { await downloadProject(it.id, fileStem(settings?.fileName, { title, url: it.meta.url, when: new Date(it.created) })); } catch (err) { toast(t('project_save_failed', String(err?.message || err)), { kind: 'error' }); }
      e.currentTarget.disabled = false;
    });
    li.querySelector('.delete').addEventListener('click', async () => {
      const rec = await deleteCapture(it.id);
      await renderStorage();
      toast(t('removed_named', title), { ms: 6000, action: { label: t('editor_undo'), run: async () => { await restoreCapture(it.id, rec); renderStorage(); } } });
    });
    list.append(li);
  }
  enhance(list);
}

let searchTimer = 0;
$('#storage-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderStorage, 150); });
$('#storage-kind').addEventListener('change', renderStorage);
$('#storage-sort').addEventListener('change', renderStorage);
$('#keepFor').addEventListener('change', (e) => update({ keepFor: Number(e.target.value) }));

document.getElementById('delete-unkept')?.addEventListener('click', async () => {
  const items = (await listCaptures(500)).filter((it) => !it.kept);
  if (!items.length) return;
  if (!(await confirmDialog({ title: t('storage_delete_unkept'), text: t('storage_delete_unkept_text', String(items.length)), confirm: t('discard_confirm') }))) return;
  for (const it of items) await deleteCapture(it.id);
  await renderStorage();
  toast(t('storage_deleted', String(items.length)), { kind: 'success' });
});

document.getElementById('open-project')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const opened = await openProject(file);
    await renderStorage();
    chrome.tabs.create({ url: chrome.runtime.getURL(pageFor(opened)) });
  } catch (err) {
    toast(t(err.message === 'too-new' ? 'project_too_new' : 'project_not_project'), { kind: 'error', ms: 6000 });
  }
});

renderStorage();

// ---------- export presets ----------
// Saved in the editor, on the video page and in Slides; renamed, reordered or deleted here.

const PRESET_KINDS = [['image', 'settings_screenshots'], ['video', 'storage_recordings'], ['slideKit', 'slides_kit']];
const ICON_UP = '<svg class="i" viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>';
const ICON_DOWN = '<svg class="i" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';

async function renderPresets() {
  const { exportPresets: all = {} } = await chrome.storage.local.get('exportPresets');
  const box = $('#preset-lists');
  box.textContent = '';
  const store = async (kind, list) => {
    const cur = (await chrome.storage.local.get({ exportPresets: {} })).exportPresets;
    cur[kind] = list;
    await chrome.storage.local.set({ exportPresets: cur });
    await renderPresets();
  };
  let any = false;
  for (const [kind, label] of PRESET_KINDS) {
    const list = Array.isArray(all[kind]) ? all[kind] : [];
    if (!list.length) continue;
    any = true;
    const h = document.createElement('h3');
    h.className = 'preset-kind';
    h.textContent = t(label);
    const ul = document.createElement('ul');
    ul.className = 'preset-list';
    list.forEach((p, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<input type="text" maxlength="60"><span class="muted small"></span>
        <button class="btn ghost icon up">${ICON_UP}</button><button class="btn ghost icon down">${ICON_DOWN}</button><button class="btn ghost icon delete">${ICON_DELETE}</button>`;
      const name = li.querySelector('input');
      name.value = p.name || '';
      name.setAttribute('aria-label', t('preset_name'));
      li.querySelector('span').textContent = p.format ? String(p.format).toUpperCase() : '';
      name.addEventListener('change', () => {
        const v = name.value.trim();
        if (!v) { name.value = p.name || ''; return; }
        store(kind, list.map((x, j) => (j === i ? { ...x, name: v } : x))).then(saved);
      });
      const tips = [['.up', t('guide_move_up')], ['.down', t('guide_move_down')], ['.delete', t('remove')]];
      for (const [sel, tip] of tips) { const b = li.querySelector(sel); b.dataset.tip = tip; b.setAttribute('aria-label', `${tip}: ${p.name || ''}`); }
      li.querySelector('.up').disabled = i === 0;
      li.querySelector('.down').disabled = i === list.length - 1;
      const move = (d) => { const next = [...list]; [next[i], next[i + d]] = [next[i + d], next[i]]; store(kind, next); };
      li.querySelector('.up').addEventListener('click', () => move(-1));
      li.querySelector('.down').addEventListener('click', () => move(1));
      li.querySelector('.delete').addEventListener('click', async () => {
        await store(kind, list.filter((_, j) => j !== i));
        toast(t('removed_named', p.name || ''), { ms: 6000, action: { label: t('editor_undo'), run: () => store(kind, list) } });
      });
      ul.append(li);
    });
    box.append(h, ul);
  }
  $('#presets-none').classList.toggle('hidden', any);
  enhance(box);
}
renderPresets();

// ---------- back up and restore ----------
// A file of this page's settings, the logo and saved presets: never captures.

const BACKUP_FORMAT = 'captode-settings';
const BACKUP_VERSION = 1;

$('#backup-save').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(RESET_KEYS);
  const file = { format: BACKUP_FORMAT, version: BACKUP_VERSION, app: chrome.runtime.getManifest().version, saved: new Date().toISOString(), data };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  a.download = `captode-settings-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  toast(t('saved_file', a.download), { kind: 'success' });
});

$('#backup-load').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let json = null;
  try { json = JSON.parse(await file.text()); } catch {}
  if (json?.format !== BACKUP_FORMAT || !Number.isInteger(json.version) || !json.data || typeof json.data !== 'object') {
    toast(t('backup_not_file'), { kind: 'error', ms: 6000 });
    return;
  }
  if (json.version > BACKUP_VERSION) { toast(t('backup_too_new'), { kind: 'error', ms: 6000 }); return; }
  // Only what this page saves; anything else in the file is left out.
  const data = Object.fromEntries(RESET_KEYS.filter((k) => k in json.data).map((k) => [k, json.data[k]]));
  if (data.settings && (typeof data.settings !== 'object' || Array.isArray(data.settings))) delete data.settings;
  const before = await chrome.storage.local.get(RESET_KEYS);
  await chrome.storage.local.remove(RESET_KEYS);
  await chrome.storage.local.set(data);
  await renderAll();
  toast(t('backup_loaded'), {
    kind: 'success', ms: 8000,
    action: { label: t('editor_undo'), run: async () => { await chrome.storage.local.remove(RESET_KEYS); await chrome.storage.local.set(before); await renderAll(); toast(t('settings_restored'), { kind: 'success' }); } },
  });
});

// ---------- sections and search ----------

const cards = [...document.querySelectorAll('main > section.card[id]')];
for (const card of cards) {
  const a = document.createElement('a');
  a.href = `#${card.id}`;
  a.className = 'btn small';
  a.textContent = card.querySelector('h2').textContent;
  $('#settings-jump').append(a);
}
const ROWS = '.toggle, .field, .shortcut-list > div, .choices, p.hint, p.callout, .tokens, .name-example';
let findTimer = 0;
function find() {
  const words = $('#settings-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const has = (el) => { const text = el.textContent.toLowerCase(); return words.every((w) => text.includes(w)); };
  let shown = 0;
  for (const card of cards) {
    const rows = [...card.querySelectorAll(ROWS)].filter((r) => !r.parentElement.closest(ROWS));
    const whole = !words.length || has(card.querySelector('h2'));
    let hits = 0;
    for (const r of rows) {
      const on = whole || has(r);
      r.classList.toggle('s-hide', !on);
      if (on) hits++;
    }
    const show = whole || hits > 0 || has(card);
    card.classList.toggle('s-hide', !show);
    if (show) shown++;
  }
  $('#settings-none').classList.toggle('hidden', shown > 0);
  for (const a of $('#settings-jump').children) a.classList.toggle('s-hide', $(a.getAttribute('href')).classList.contains('s-hide'));
}
$('#settings-search').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(find, 120); });
