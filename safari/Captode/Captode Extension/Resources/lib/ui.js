// Shared interface helpers: notifications, accessible tabs and tooltips, dialogs.

import { t } from './i18n.js';
import { STORE_URL } from './platform.js';

const ICONS = {
  success: '<path d="m5 12 5 5 9-10"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/>',
};

let region = null;
let timer = 0;

/** Shows a short notification. `kind` is 'success', 'error' or 'info'. */
/** Shows a short message; `action` ({ label, run }) adds a button, such as Undo. */
export function toast(message, { kind = 'info', ms = 2600, action = null } = {}) {
  if (!region) {
    region = document.createElement('div');
    region.className = 'toast hidden';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  region.dataset.kind = kind;
  region.innerHTML = `<svg class="i" viewBox="0 0 24 24">${ICONS[kind] || ICONS.info}</svg><span></span>`;
  region.lastChild.textContent = message;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => { region.classList.add('hidden'); action.run(); });
    region.append(b);
  }
  region.classList.toggle('has-action', !!action);
  region.classList.remove('hidden');
  region.style.animation = 'none';
  void region.offsetWidth;
  region.style.animation = '';
  clearTimeout(timer);
  timer = setTimeout(() => region.classList.add('hidden'), ms);
}

/**
 * Gives icon-only buttons with a tooltip an accessible name, and wires a
 * `.tabs` bar to the panes it controls with the ARIA tab pattern.
 */
export function enhance(root = document) {
  for (const el of root.querySelectorAll('[data-tip]')) {
    if (!el.hasAttribute('aria-label') && !el.textContent.trim()) {
      el.setAttribute('aria-label', el.dataset.tip.split(/\s{2,}/)[0]);
    }
  }
  for (const el of root.querySelectorAll('button:not([type])')) el.type = 'button';
  if (!isMac) {
    for (const el of root.querySelectorAll('[data-tip]')) el.dataset.tip = el.dataset.tip.replace(/⇧⌘|⌘⇧/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+');
    for (const el of root.querySelectorAll('kbd')) if (el.textContent === '⌘') el.textContent = 'Ctrl';
    for (const el of root.querySelectorAll('[title]')) el.title = el.title.replace(/⌘⇧|⇧⌘/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+');
  }
}

/** Keeps `aria-selected` and roving focus in step for a tab list. */
export function tablist(list, onSelect) {
  const tabs = () => [...list.querySelectorAll('[role="tab"]')];
  list.addEventListener('keydown', (e) => {
    const all = tabs();
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const t = all[(next + all.length) % all.length];
    t.focus();
    onSelect(t);
  });
  return (selected) => {
    for (const t of tabs()) {
      const on = t === selected;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
  };
}

/** Opens a modal `<dialog>` and closes it on a click outside. */
export function openDialog(dialog) {
  if (!dialog.dataset.wired) {
    dialog.dataset.wired = '1';
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    for (const b of dialog.querySelectorAll('[data-close]')) b.addEventListener('click', () => dialog.close());
  }
  dialog.tabIndex = -1;
  dialog.showModal();
  dialog.focus(); // focus the dialog, not its first button, so no tooltip pops up
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/** "2 minutes ago" style text for a timestamp. */
export function ago(time) {
  const s = Math.round((Date.now() - time) / 1000);
  if (s < 45) return t('ago_just_now');
  const m = Math.round(s / 60);
  if (m < 60) return t('ago_minutes', m);
  const h = Math.round(m / 60);
  return t('ago_hours', h);
}

const platform = navigator.userAgentData?.platform || navigator.platform || '';
export const isMac = /mac|iphone|ipad/i.test(platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

/**
 * Shows the keyboard shortcut that opens Captode (and stops a recording) in `el`,
 * as the user has it set: Chrome reports it in the platform's own style, such as
 * "Alt+Shift+R" or "⌥⇧R". Says so when no shortcut is set.
 */
export async function showShortcut(el, name = '_execute_action') {
  let key = '';
  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === name);
    key = cmd?.shortcut || '';
  } catch { /* commands API unavailable */ }
  el.textContent = '';
  if (!key) {
    el.textContent = t('shortcut_none');
    return;
  }
  // "Ctrl+Shift+R" splits on "+"; macOS symbols ("⌥⇧R") are one character each.
  const parts = key.includes('+') ? key.split('+') : [...key];
  for (const p of parts) {
    const k = document.createElement('kbd');
    k.textContent = p;
    el.append(k, ' ');
  }
}

/**
 * Shares Captode's store page: the system's share sheet where Chrome has one (unless
 * `copyOnly`, as in the popup, which closes when the sheet takes focus), otherwise the
 * link is copied. Nothing is sent by Captode itself.
 */
export async function shareCaptode({ copyOnly = false } = {}) {
  if (!copyOnly && navigator.share) {
    try {
      await navigator.share({ title: 'Captode', text: t('share_text'), url: STORE_URL });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // closed without sharing
    }
  }
  try {
    await navigator.clipboard.writeText(STORE_URL);
    toast(t('share_copied'), { kind: 'success', ms: 4000 });
  } catch (e) {
    toast(e.message || String(e), { kind: 'error' });
  }
}
