// The device picker: a button showing the chosen device, opening a searchable list
// with filters by kind and the devices used most recently at the top. It follows the
// ARIA combobox pattern: the search field keeps focus while the arrow keys move
// through the list.
import { DEVICES, GROUPS } from './devices.js';
import { t } from './i18n.js';

const RECENT_KEY = 'deviceRecent';
const RECENT_MAX = 4;

const FILTERS = [
  ['all', t('picker_all')],
  ['iphone', 'iPhone', (d) => d.os === 'ios'],
  ['ipad', 'iPad', (d) => d.os === 'ipados'],
  ['android', t('picker_android'), (d) => d.os === 'android' && d.type === 'phone'],
  ['tablet', t('picker_tablets'), (d) => d.type === 'tablet'],
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const size = (d) => `${d.px[0]} × ${d.px[1]}`;

let uid = 0;

/**
 * `value`: 'auto' or a device id. `onPick(value)` is called when one is chosen.
 * `autoLabel()` says which device the best match is, for the button.
 * Returns `{ el, set(value), refresh() }`.
 */
export function createDevicePicker({ value, onPick, autoLabel }) {
  const id = `devpick-${++uid}`;
  let current = value;
  let filter = 'all';
  let query = '';
  let active = 0;
  let recent = [];
  let items = []; // what the list shows: { value, label }

  const el = document.createElement('div');
  el.className = 'dev-picker';
  el.innerHTML = `
    <button type="button" class="dev-pick-btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}-pop">
      <span class="dev-pick-name" id="${id}-name"></span>
      <svg class="i" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <div class="dev-pop hidden" id="${id}-pop">
      <input type="search" class="dev-search" placeholder="${t('picker_search')}" aria-label="${t('picker_search')}"
        role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="${id}-list" autocomplete="off" spellcheck="false">
      <div class="dev-chips" role="group" aria-label="${t('picker_kind')}">
        ${FILTERS.map(([k, label]) => `<button type="button" data-filter="${k}" aria-pressed="${k === 'all'}">${label}</button>`).join('')}
      </div>
      <ul class="dev-list" id="${id}-list" role="listbox" aria-label="${t('picker_devices')}"></ul>
    </div>`;
  const btn = el.querySelector('.dev-pick-btn');
  const pop = el.querySelector('.dev-pop');
  const search = el.querySelector('.dev-search');
  const list = el.querySelector('.dev-list');

  const label = (v) => (v === 'auto' ? (autoLabel?.() ? t('picker_best_match_is', autoLabel()) : t('picker_best_match')) : DEVICES[v]?.name || v);
  const showButton = () => { el.querySelector('.dev-pick-name').textContent = label(current); };

  const matches = (d) => {
    const f = FILTERS.find(([k]) => k === filter)?.[2];
    if (f && !f(d)) return false;
    if (!query) return true;
    const hay = `${d.name} ${d.brand} ${size(d)} ${d.type} ${d.os === 'android' ? 'android' : 'apple ios'}`.toLowerCase();
    return query.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  };

  const renderList = () => {
    const rows = [];
    items = [];
    const add = (v, text, sub) => {
      const i = items.length;
      items.push({ value: v });
      rows.push(`<li role="option" id="${id}-o${i}" data-i="${i}" aria-selected="${v === current}" class="${i === active ? 'active' : ''}">` +
        `<span>${esc(text)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</li>`);
    };
    const heading = (text) => rows.push(`<li role="presentation" class="dev-group">${esc(text)}</li>`);
    if (!query && filter === 'all') add('auto', t('picker_best_match_full'), autoLabel?.() || '');
    const recentDevices = recent.map((r) => DEVICES[r]).filter((d) => d && matches(d));
    if (!query && recentDevices.length) {
      heading(t('picker_recent'));
      for (const d of recentDevices) add(d.id, d.name, size(d));
    }
    for (const [group, test] of GROUPS) {
      const ds = Object.values(DEVICES).filter((d) => test(d) && matches(d));
      if (!ds.length) continue;
      heading(group);
      for (const d of ds) add(d.id, d.name, size(d));
    }
    if (!items.length) rows.push(`<li role="presentation" class="dev-none">${esc(t('picker_none'))}</li>`);
    list.innerHTML = rows.join('');
    active = Math.min(active, Math.max(0, items.length - 1));
    moveTo(active, false);
  };

  const moveTo = (i, scroll = true) => {
    if (!items.length) { search.removeAttribute('aria-activedescendant'); return; }
    active = (i + items.length) % items.length;
    for (const li of list.querySelectorAll('[role="option"]')) li.classList.toggle('active', Number(li.dataset.i) === active);
    search.setAttribute('aria-activedescendant', `${id}-o${active}`);
    if (scroll) list.querySelector(`#${id}-o${active}`)?.scrollIntoView({ block: 'nearest' });
  };

  const open = async () => {
    try { recent = (await chrome.storage.local.get({ [RECENT_KEY]: [] }))[RECENT_KEY]; } catch { recent = []; }
    query = '';
    search.value = '';
    // Open upwards when the list wouldn't fit below (above the export buttons, say).
    let box = el.parentElement;
    while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    const r = btn.getBoundingClientRect();
    const bottom = Math.min(innerHeight, box ? box.getBoundingClientRect().bottom : innerHeight);
    pop.classList.toggle('up', bottom - r.bottom < 380 && r.top - (box ? box.getBoundingClientRect().top : 0) > bottom - r.bottom);
    pop.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    active = 0;
    renderList();
    const at = items.findIndex((it) => it.value === current);
    if (at >= 0) moveTo(at);
    search.focus();
  };
  const close = (focusButton = true) => {
    if (pop.classList.contains('hidden')) return;
    pop.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
    if (focusButton) btn.focus();
  };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    current = it.value;
    showButton();
    close();
    if (it.value !== 'auto') {
      recent = [it.value, ...recent.filter((r) => r !== it.value)].slice(0, RECENT_MAX);
      try { chrome.storage.local.set({ [RECENT_KEY]: recent }); } catch {}
    }
    onPick(current);
  };

  btn.addEventListener('click', () => (pop.classList.contains('hidden') ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });
  search.addEventListener('input', (e) => {
    e.stopPropagation(); // not a setting
    query = search.value.trim();
    active = 0;
    renderList();
  });
  search.addEventListener('keydown', (e) => {
    const keys = { ArrowDown: () => moveTo(active + 1), ArrowUp: () => moveTo(active - 1), Home: () => moveTo(0), End: () => moveTo(items.length - 1),
      Enter: () => choose(active), Escape: () => close(), Tab: () => close(false) };
    if (!keys[e.key]) return;
    if (e.key !== 'Tab') e.preventDefault();
    e.stopPropagation();
    keys[e.key]();
  });
  el.querySelector('.dev-chips').addEventListener('click', (e) => {
    const k = e.target.closest('[data-filter]')?.dataset.filter;
    if (!k) return;
    filter = k;
    for (const b of el.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b.dataset.filter === k));
    active = 0;
    renderList();
    search.focus();
  });
  list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the search field
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[role="option"]');
    if (li) choose(Number(li.dataset.i));
  });
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('[role="option"]');
    if (li && Number(li.dataset.i) !== active) moveTo(Number(li.dataset.i), false);
  });
  document.addEventListener('pointerdown', (e) => { if (!el.contains(e.target)) close(false); });

  showButton();
  return {
    el,
    set(v) { current = v; showButton(); },
    refresh: showButton,
  };
}
