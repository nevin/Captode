// The Settings page: how long captures stay, backing up settings to a file, finding a
// setting, managing presets, and reset taking the logo too.
import { open, ok } from './helpers.mjs';

export const tests = {
  async 'captures not kept stay for the time chosen: a week keeps a two-day-old one, a day does not'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const run = (keepFor) => lab.evaluate(async (keepFor) => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, keepFor } });
      const db = await import('/lib/db.js');
      const img = () => { const c = new OffscreenCanvas(8, 8); c.getContext('2d').fillRect(0, 0, 4, 4); return c.convertToBlob(); };
      const a = await db.putCapture(await img(), { title: 'old' });
      await new Promise((resolve) => {
        const req = indexedDB.open('captode');
        req.onsuccess = () => {
          const t = req.result.transaction('captures', 'readwrite');
          const s = t.objectStore('captures');
          const g = s.get(a);
          g.onsuccess = () => s.put({ ...g.result, created: Date.now() - 2 * 86400000 }, a);
          t.oncomplete = () => { req.result.close(); resolve(); };
        };
      });
      await db.putCapture(await img(), { title: 'new' }); // tidies up
      return !!(await db.getCapture(a));
    }, keepFor);
    ok(await run(7), 'a week: still there after two days');
    ok(await run(0), 'never: still there');
    ok(!(await run(1)), 'a day: removed');
    await lab.evaluate(async () => { const { settings = {} } = await chrome.storage.local.get('settings'); delete settings.keepFor; await chrome.storage.local.set({ settings }); });
    await lab.close();
  },

  async 'settings page: sections to jump to, search, keep-for, presets, backup and reset'({ browser, url }) {
    const st = await open(browser, url('settings/settings.html'));
    await st.evaluate(() => chrome.storage.local.set({
      exportPresets: { image: [{ id: 'a', name: 'Alpha', format: 'png', controls: {} }, { id: 'b', name: 'Beta', format: 'jpeg', controls: {} }] },
    }));
    await st.reload();
    await st.waitForFunction(() => document.querySelectorAll('#preset-lists li').length === 2, { polling: 100, timeout: 5000 });
    // Jump links, one per section.
    const jumps = await st.evaluate(() => [document.querySelectorAll('#settings-jump a').length, document.querySelectorAll('main > section.card[id]').length]);
    ok(jumps[0] === jumps[1] && jumps[0] >= 9, `jump links ${jumps}`);
    ok(await st.evaluate(() => !document.querySelector('h2[data-i18n="settings_defaults"]')), 'Defaults merged into Screenshots and Recording');
    // Search: "camera" leaves Recording, with the camera row, and hides the rest.
    await st.type('#settings-search', 'camera');
    await st.waitForFunction(() => document.getElementById('appearance').classList.contains('s-hide'), { polling: 100, timeout: 3000 });
    const r = await st.evaluate(() => ({
      recording: !document.getElementById('recording').classList.contains('s-hide'),
      camera: !document.getElementById('rec-camera').closest('.toggle').classList.contains('s-hide'),
      fps: !document.getElementById('rec-fps').closest('.field').classList.contains('s-hide'),
    }));
    ok(r.recording && r.camera && !r.fps, `search ${JSON.stringify(r)}`);
    await st.evaluate(() => { const s = document.getElementById('settings-search'); s.value = 'zzzz nothing'; s.dispatchEvent(new Event('input')); });
    await st.waitForFunction(() => !document.getElementById('settings-none').classList.contains('hidden'), { polling: 100, timeout: 3000 });
    await st.evaluate(() => { const s = document.getElementById('settings-search'); s.value = ''; s.dispatchEvent(new Event('input')); });
    await st.waitForFunction(() => !document.querySelector('.card.s-hide'), { polling: 100, timeout: 3000 });
    // Keep for a week.
    await st.select('#keepFor', '7');
    await st.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings?.keepFor === 7, { polling: 100, timeout: 3000 });
    // Presets: rename, move down, delete.
    await st.evaluate(() => { const i = document.querySelector('#preset-lists li input'); i.value = 'Alpha 2'; i.dispatchEvent(new Event('change')); });
    await st.waitForFunction(async () => (await chrome.storage.local.get('exportPresets')).exportPresets.image[0].name === 'Alpha 2', { polling: 100, timeout: 3000 });
    await st.evaluate(() => document.querySelector('#preset-lists li .down').click());
    await st.waitForFunction(async () => (await chrome.storage.local.get('exportPresets')).exportPresets.image[0].name === 'Beta', { polling: 100, timeout: 3000 });
    await st.evaluate(() => document.querySelector('#preset-lists li .delete').click());
    await st.waitForFunction(async () => (await chrome.storage.local.get('exportPresets')).exportPresets.image.length === 1, { polling: 100, timeout: 3000 });
    // Backup: the file holds the settings and presets; loading it puts them back.
    const file = await st.evaluate(async () => {
      let saved = null;
      HTMLAnchorElement.prototype.click = function () { saved = fetch(this.href).then((r) => r.text()); };
      document.getElementById('backup-save').click();
      for (let i = 0; i < 50 && !saved; i++) await new Promise((r) => setTimeout(r, 50));
      return saved;
    });
    const json = JSON.parse(file);
    ok(json.format === 'captode-settings' && json.data.settings.keepFor === 7 && json.data.exportPresets.image[0].name === 'Alpha 2', `backup ${file.slice(0, 200)}`);
    await st.evaluate(() => chrome.storage.local.set({ settings: { theme: 'dark', keepFor: 30 }, exportPresets: {} }));
    const load = async (text) => {
      const input = await st.$('#backup-load');
      await st.evaluate((text) => {
        const dt = new DataTransfer();
        dt.items.add(new File([text], 'settings.json', { type: 'application/json' }));
        const i = document.getElementById('backup-load');
        i.files = dt.files;
        i.dispatchEvent(new Event('change'));
      }, text);
      return input;
    };
    await load(file);
    await st.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings?.keepFor === 7, { polling: 100, timeout: 5000 });
    ok(await st.evaluate(() => document.getElementById('keepFor').value === '7' && document.querySelectorAll('#preset-lists li').length === 1), 'the page shows what was loaded');
    await load('{"format":"something else"}');
    await st.waitForFunction(() => /settings file/i.test(document.body.innerText), { polling: 100, timeout: 3000 });
    // Reset takes the logo too.
    await st.evaluate(() => chrome.storage.local.set({ brand: { image: 'data:image/png;base64,AAAA', images: true } }));
    await st.evaluate(() => document.getElementById('reset-yes').click());
    await st.waitForFunction(async () => !(await chrome.storage.local.get('brand')).brand && (await chrome.storage.local.get('settings')).settings?.keepFor === 1, { polling: 100, timeout: 5000 });
    await st.close();
  },
};
