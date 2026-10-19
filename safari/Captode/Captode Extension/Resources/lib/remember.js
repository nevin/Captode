// Remembers export choices between visits: the format and its options, for
// screenshots ('image') and recordings ('video') separately.

const KEY = 'lastExport';

const valueOf = (el) => (el.type === 'checkbox' ? el.checked : el.value);

/** The remembered choices for `kind`: `{ format, controls: { id: value } }`, or {}. */
export async function recall(kind) {
  try {
    return (await chrome.storage.local.get(KEY))[KEY]?.[kind] || {};
  } catch {
    return {};
  }
}

/** Saves `patch` (format and/or controls) into what is remembered for `kind`. */
export async function remember(kind, patch) {
  try {
    const all = (await chrome.storage.local.get(KEY))[KEY] || {};
    const prev = all[kind] || {};
    all[kind] = { ...prev, ...patch, controls: { ...prev.controls, ...patch.controls } };
    await chrome.storage.local.set({ [KEY]: all });
  } catch { /* outside the extension */ }
}

/**
 * Sets the controls with these ids to their remembered values (where the value is
 * still offered), then remembers any later change to them.
 */
export function rememberControls(kind, ids, saved = {}) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el || !(id in saved)) continue;
    if (el.type === 'checkbox') el.checked = !!saved[id];
    else if (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === String(saved[id]))) el.value = saved[id];
  }
  for (const id of ids) {
    const el = document.getElementById(id);
    el?.addEventListener('change', () => remember(kind, { controls: { [id]: valueOf(el) } }));
  }
}
