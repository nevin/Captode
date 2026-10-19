// Applies the Light, Dark or System theme. Loaded as a classic script in each page's
// <head> so the theme is set before the page is drawn. The choice is mirrored in
// localStorage (shared by all extension pages) because extension storage is async.
(() => {
  const KEY = 'captode-theme';
  const apply = (theme) => {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme; // System: follow the browser and OS
  };
  const remember = (theme) => {
    try { localStorage.setItem(KEY, theme); } catch { /* storage may be blocked */ }
    apply(theme);
  };
  try { apply(localStorage.getItem(KEY)); } catch { /* storage may be blocked */ }
  if (!globalThis.chrome?.storage) return;
  chrome.storage.local.get('settings').then(({ settings }) => remember(settings?.theme || 'system'));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) remember(changes.settings.newValue?.theme || 'system');
  });
})();
