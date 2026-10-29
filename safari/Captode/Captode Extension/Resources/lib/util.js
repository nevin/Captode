// Small helpers shared by the pages (not the content script, whose functions are
// injected on their own and can't import).

/** `s` as text safe to put in HTML, in an element or a quoted attribute. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Resolves when `el` next fires `ev` (with the event). */
export const once = (el, ev) => new Promise((r) => el.addEventListener(ev, r, { once: true }));

/** Resolves after `ms` milliseconds. */
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Blob as a data: URL. */
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
