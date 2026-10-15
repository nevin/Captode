// User settings, chosen on the Settings page and shared by every Captode page.

export const DEFAULT_SETTINGS = {
  theme: 'system',           // 'system' | 'light' | 'dark'
  background: 'transparent', // background behind device frames and padding: 'transparent' | 'white' | 'custom'
  backgroundColor: '#ffffff',
  imageFormat: 'png',
  videoFormat: 'mp4',
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
