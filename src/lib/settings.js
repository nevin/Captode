// User settings, chosen on the Settings page and shared by every Captode page.

export const DEFAULT_SETTINGS = {
  theme: 'system',           // 'system' | 'light' | 'dark'
  background: 'transparent', // background behind device frames and padding: 'transparent' | 'white' | 'custom'
  backgroundColor: '#ffffff',
  imageFormat: 'last',       // 'last' (the editor remembers it) or a format
  videoFormat: 'last',
  autoCopy: false,           // copy new screenshots to the clipboard when the editor opens them
  autoBlur: false,           // blur email addresses and phone and card numbers in new screenshots
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

/** The chosen background colour, or null for transparent. */
export function backgroundColour(settings) {
  if (settings.background === 'white') return '#ffffff';
  if (settings.background === 'custom') return settings.backgroundColor;
  return null;
}
