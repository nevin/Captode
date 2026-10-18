// Made by tools/targets.mjs for this browser's package: edit it there, not here.
export const TARGET = {
  /** Captode's page in this browser's add-on store, to share; null until listed. */
  storeUrl: 'https://chromewebstore.google.com/detail/mphigcddnecjbnkcpiaabheopepcmgce?utm_source=item-share-cb',
  /** The browser's page for changing extension shortcuts, if it has one to open. */
  shortcutsUrl: 'chrome://extensions/shortcuts',
  /** Pages no extension may capture: the browser's own, and its add-on store. */
  protectedPages: /^(chrome|chrome-extension|chrome-search|chrome-untrusted|devtools|view-source|about):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/,
};
