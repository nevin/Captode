// What the browser Captode runs in can do. Features are checked for, not browser names;
// what differs by store (its link, shortcut settings, protected pages) comes from
// lib/target.js, made for each browser's package by tools/targets.mjs.
import { TARGET } from './target.js';

/** Recording a tab needs tab capture and an offscreen document (lib/tab-capture.js). */
export { canRecordTabs } from './tab-capture.js';

/** Reworking a video's frames (camera bubble, video size) needs MediaStreamTrackProcessor. */
export const canProcessVideo = typeof globalThis.MediaStreamTrackProcessor === 'function'
  && typeof globalThis.MediaStreamTrackGenerator === 'function';

/** Captode's page in this browser's add-on store, to share; null until it is listed. */
export const STORE_URL = TARGET.storeUrl;

/** Pages no extension may capture: the popup says so up front rather than failing later. */
export const PROTECTED = TARGET.protectedPages;

/** Whether the browser has a page for changing extension shortcuts that Captode can open. */
export const canChangeShortcuts = !!(globalThis.chrome?.commands?.openShortcutSettings || TARGET.shortcutsUrl);

/** Opens the browser's page for changing extension shortcuts. */
export function openShortcutSettings() {
  if (chrome.commands?.openShortcutSettings) return chrome.commands.openShortcutSettings();
  return chrome.tabs.create({ url: TARGET.shortcutsUrl });
}
