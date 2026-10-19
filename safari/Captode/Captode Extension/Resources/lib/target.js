// Made by tools/targets.mjs for this browser's package: edit it there, not here.
export const TARGET = {
  /** Captode's page in this browser's add-on store, to share; null until listed. */
  storeUrl: null,
  /** The browser's page for changing extension shortcuts, if it has one to open. */
  shortcutsUrl: null,
  /** Pages no extension may capture: the browser's own, and its add-on store. */
  protectedPages: /^(safari-web-extension|about|view-source):|^https:\/\/(apps\.apple\.com)/,
};
