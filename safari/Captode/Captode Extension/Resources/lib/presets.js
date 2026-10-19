// Export presets: named bundles of export settings, built in or saved by the user,
// for screenshots ('image') and recordings ('video'). A preset holds the format,
// the values of the page's export controls, and whether a device frame is used.

import { t } from './i18n.js';
import { toast } from './ui.js';

const KEY = 'exportPresets';

export const BUILTIN = {
  image: [
    { id: 'chat', name: t('preset_chat'), format: 'png', controls: { 'x-scale': '1', 'x-limit': '5120' }, device: { enabled: false } },
    { id: 'issue', name: t('preset_issue'), format: 'png', controls: { 'x-scale': '1', 'x-limit': '10240' }, device: { enabled: false } },
    { id: 'email', name: t('preset_email'), format: 'jpeg', controls: { 'x-quality': '85', 'x-scale': '1', 'x-limit': '1024' }, device: { enabled: false } },
    { id: 'review', name: t('preset_review'), format: 'png', controls: { 'x-scale': '1', 'x-limit': '0' }, device: { enabled: false } },
    { id: 'mockup', name: t('preset_mockup'), format: 'png', controls: { 'x-scale': '1', 'x-limit': '0' }, device: { enabled: true, device: 'auto', size: 'exact', bg: 'none' } },
    { id: 'web', name: t('preset_web'), format: 'webp', controls: { 'x-quality': '80', 'x-scale': '1', 'x-limit': '0' }, device: { enabled: false } },
  ],
  video: [
    { id: 'chat-gif', name: t('preset_chat_gif'), format: 'gif', controls: { res: '480', fps: '15', 'g-colors': '256', 'g-lossy': '20' }, device: { enabled: false } },
    { id: 'share-mp4', name: t('preset_share_mp4'), format: 'mp4', controls: { res: '1080', 'v-quality': '0.08' }, device: { enabled: false } },
    { id: 'original', name: t('preset_original'), format: 'mp4', controls: { res: '0', 'v-quality': '0.16' }, device: { enabled: false } },
    { id: 'docs-webp', name: t('preset_docs_webp'), format: 'webp', controls: { res: '720', fps: '20', 'w-quality': '80' }, device: { enabled: false } },
    { id: 'mockup-mp4', name: t('preset_mockup_mp4'), format: 'mp4', controls: { res: '0' }, device: { enabled: true, device: 'auto', size: 'exact', bg: 'white' } },
  ],
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function saved(kind) {
  try { return (await chrome.storage.local.get({ [KEY]: {} }))[KEY][kind] || []; } catch { return []; }
}
async function store(kind, list) {
  const all = (await chrome.storage.local.get({ [KEY]: {} }))[KEY];
  all[kind] = list;
  await chrome.storage.local.set({ [KEY]: all });
}

/**
 * Builds the preset row in `el`. `capture()` returns the current settings as a
 * preset (without name); `apply(preset)` puts one into effect. `watch` is the
 * element whose changes mean the settings no longer match the preset.
 */
export async function mountPresets(el, { kind, capture, apply, watch }) {
  let mine = await saved(kind);
  let chosen = '';
  let applying = false;

  el.innerHTML = `
    <label class="field preset-field"><span>${t('preset_label')}</span>
      <div class="row">
        <select class="preset-select"></select>
        <button type="button" class="btn ghost icon preset-delete hidden" data-tip="${t('preset_delete')}" aria-label="${t('preset_delete')}">
          <svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
        </button>
      </div>
    </label>
    <form class="preset-save hidden">
      <input type="text" class="preset-name" placeholder="${t('preset_name_placeholder')}" aria-label="${t('preset_name')}" maxlength="60" required>
      <button type="submit" class="btn primary">${t('preset_save')}</button>
      <button type="button" class="btn ghost preset-cancel">${t('settings_cancel')}</button>
    </form>`;
  const select = el.querySelector('.preset-select');
  const form = el.querySelector('.preset-save');
  const name = el.querySelector('.preset-name');

  const all = () => [...BUILTIN[kind].map((p) => ({ ...p, builtin: true })), ...mine];
  const render = () => {
    select.innerHTML = `<option value="">${esc(t('preset_custom'))}</option>` +
      `<optgroup label="${esc(t('preset_builtin'))}">${BUILTIN[kind].map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</optgroup>` +
      (mine.length ? `<optgroup label="${esc(t('preset_yours'))}">${mine.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</optgroup>` : '') +
      `<option value="__save">${esc(t('preset_save_current'))}</option>`;
    select.value = chosen;
    el.querySelector('.preset-delete').classList.toggle('hidden', !mine.some((p) => p.id === chosen));
  };
  render();

  select.addEventListener('change', async (e) => {
    e.stopPropagation();
    if (select.value === '__save') {
      select.value = chosen;
      form.classList.remove('hidden');
      name.value = '';
      name.focus();
      return;
    }
    chosen = select.value;
    render();
    const p = all().find((x) => x.id === chosen);
    if (!p) return;
    applying = true;
    try { await apply(p); } finally { applying = false; }
  });
  select.addEventListener('input', (e) => e.stopPropagation());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n) return;
    const p = { id: `u${Date.now().toString(36)}`, name: n, ...capture() };
    mine = [...mine.filter((x) => x.name !== n), p];
    await store(kind, mine);
    chosen = p.id;
    form.classList.add('hidden');
    render();
    select.focus();
  });
  el.querySelector('.preset-cancel').addEventListener('click', () => { form.classList.add('hidden'); select.focus(); });
  name.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); form.classList.add('hidden'); select.focus(); } });
  name.addEventListener('input', (e) => e.stopPropagation());

  el.querySelector('.preset-delete').addEventListener('click', async () => {
    const before = mine;
    const gone = mine.find((p) => p.id === chosen);
    mine = mine.filter((p) => p.id !== chosen);
    await store(kind, mine);
    chosen = '';
    render();
    toast(t('preset_deleted', gone?.name || ''), {
      ms: 6000,
      action: { label: t('editor_undo'), run: async () => { mine = before; await store(kind, mine); chosen = gone?.id || ''; render(); } },
    });
  });

  // Any change made by hand: the settings are now custom.
  const custom = (e) => {
    if (applying || el.contains(e.target) || !chosen) return;
    chosen = '';
    render();
  };
  watch.addEventListener('input', custom);
  watch.addEventListener('change', custom);
  return { get: () => chosen };
}
