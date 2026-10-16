// The interface: popup states, editor flows, settings and themes.
import { open, waitForTab, prepare, ok, sleep, near } from './helpers.mjs';

const theme = (page) => page.evaluate(() => [document.documentElement.dataset.theme || 'system', getComputedStyle(document.body).backgroundColor]);

export async function setup({ browser, url, site }) {
  const page = await open(browser, `${site}/rich.html`);
  const ctl = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
  const tabId = await ctl.evaluate(async (site) => (await chrome.tabs.query({ url: `${site}/*` }))[0].id, site);
  // Captures the test page and returns the editor it opens. A busy CI runner sometimes
  // misses the first capture; try once more, and say what the extension reported.
  const editor = async () => {
    let ed;
    for (let attempt = 0; !ed; attempt++) {
      const before = new Set(browser.targets());
      await ctl.evaluate(() => chrome.storage.session.remove('lastError'));
      await page.bringToFront();
      await ctl.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-image', mode: 'visible', tabId }), tabId);
      try {
        const t = await browser.waitForTarget((t) => !before.has(t) && t.type() === 'page' && t.url().includes('editor.html?id='), { timeout: 15000 });
        ed = await prepare(await t.page());
      } catch (e) {
        const lastError = await ctl.evaluate(async () => (await chrome.storage.session.get('lastError')).lastError);
        if (attempt) throw new Error(`no editor opened after capturing (last error: ${lastError})`);
        await sleep(1000);
      }
    }
    await ed.setViewport({ width: 1440, height: 900 });
    await ed.bringToFront();
    await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { polling: 100 });
    return ed;
  };
  return { page, editor };
}

export const tests = {
  async 'popup explains protected pages and leaves screen recording available'({ browser, url }) {
    // Opened as a tab, the popup's active tab is itself: a chrome-extension:// page.
    const pop = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
    await sleep(300);
    const r = await pop.evaluate(() => ({
      banner: !document.querySelector('#blocked').classList.contains('hidden'),
      disabled: [...document.querySelectorAll('.mode')].map((b) => `${b.dataset.mode}:${b.disabled}`),
    }));
    ok(r.banner, 'no protected-page banner');
    ok(r.disabled.includes('screen:false') && r.disabled.includes('visible:true'), `modes ${r.disabled}`);
    await pop.close();
  },

  async 'editor: draw, download label, unsaved-changes guard, shortcuts sheet'({ editor }) {
    const ed = await editor();
    ok(/Download PNG/.test(await ed.evaluate(() => document.querySelector('#download').textContent)), 'download button names the format');
    const b = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await ed.keyboard.press('r');
    await ed.mouse.move(b.x + b.w * 0.3, b.y + b.h * 0.3);
    await ed.mouse.down();
    await ed.mouse.move(b.x + b.w * 0.6, b.y + b.h * 0.6, { steps: 5 });
    await ed.mouse.up();
    const guarded = () => ed.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    ok(await guarded(), 'closing with unsaved changes should ask first');
    await ed.keyboard.press('Escape');
    await ed.keyboard.type('?');
    await sleep(200);
    ok(await ed.evaluate(() => document.querySelector('#shortcuts').open), 'shortcuts sheet did not open');
    await ed.keyboard.press('Escape');
    await ed.click('#copy');
    for (let t = 0; t < 100 && (await guarded()); t++) await sleep(100); // copying takes a moment
    ok(!(await guarded()), 'copying should count as saving: ' + await ed.evaluate(() => document.querySelector('.toast')?.textContent));
    await ed.close();
  },

  async 'editor: export preview, size limit and tabs'({ editor }) {
    const ed = await editor();
    await ed.click('#tab-export');
    ok(await ed.evaluate(() => document.querySelector('#tab-export').getAttribute('aria-selected') === 'true'), 'tab not selected');
    await ed.click('#device-panel input[data-k="enabled"]');
    await ed.waitForFunction(() => !document.querySelector('#export-preview').classList.contains('hidden') && document.querySelector('#device-preview').width > 300, { timeout: 20000, polling: 100 });
    // A small preview of the device sits in the panel.
    await ed.waitForFunction(() => { const t = document.querySelector('.dev-thumb'); return !t.classList.contains('hidden') && t.width > 50; }, { timeout: 20000, polling: 100 });
    await ed.click('#device-panel input[data-k="enabled"]');
    await ed.evaluate(() => { const s = document.querySelector('#x-format'); s.value = 'jpeg'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await ed.evaluate(() => { const s = document.querySelector('#x-limit'); s.value = '100'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(600);
    await ed.waitForFunction(() => !/Working/.test(document.querySelector('#x-estimate').textContent), { timeout: 30000, polling: 100 });
    const est = await ed.evaluate(() => [document.querySelector('#x-estimate').textContent, document.querySelector('#x-fitted').textContent]);
    const kb = Number(est[0].match(/([\d.]+) KB/)?.[1]);
    ok(kb && kb <= 100, `estimate ${est[0]}`);
    ok(/quality|size/.test(est[1]) || kb < 100, `fitting not explained: ${est[1]}`);
    await ed.close();
    return est.join(' — ');
  },

  async 'empty editor lists recent captures'({ browser, url, editor }) {
    await (await editor()).close(); // make sure there is at least one
    const em = await open(browser, url('editor/editor.html'));
    await sleep(800);
    ok(await em.evaluate(() => document.querySelectorAll('.recent-item').length) > 0, 'no recent captures');
    await em.close();
  },

  async 'settings: theme follows the system by default and applies everywhere'({ browser, url }) {
    const st = await open(browser, url('settings/settings.html'), { width: 900, height: 1000 });
    await st.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await sleep(200);
    ok((await theme(st))[0] === 'system', 'default theme is not System');
    await st.click('#theme [data-v="dark"]');
    await sleep(300);
    const pop = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
    await sleep(200);
    ok((await theme(pop))[0] === 'dark', 'popup did not take the dark theme');
    await st.bringToFront();
    await st.click('#theme [data-v="system"]');
    await st.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    ok((await theme(st))[1] === 'rgb(15, 15, 19)', 'System did not follow a dark browser');
    await st.click('#reset');
    await sleep(200);
    await st.click('#reset-yes');
    await sleep(300);
    ok(await st.evaluate(() => document.querySelector('#background [aria-checked=true]').dataset.v) === 'transparent', 'reset did not restore defaults');
    await pop.close();
    await st.close();
  },

  async 'popup shows the keyboard shortcut as Chrome has it set'({ browser, url }) {
    const pop = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
    await sleep(300);
    const r = await pop.evaluate(async () => ({
      shown: document.querySelector('.shortcut-keys').textContent.replace(/\s+/g, ''),
      actual: ((await chrome.commands.getAll()).find((c) => c.name === '_execute_action')?.shortcut || '').replace(/\+/g, ''),
    }));
    ok(r.actual ? r.shown === r.actual : r.shown === 'noshortcutset', `shows "${r.shown}", Chrome has "${r.actual}"`);
    await pop.close();
    return r.actual || 'no shortcut set';
  },

  async 'switches and selections stay visible in Windows high-contrast mode'({ browser, url }) {
    const pop = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
    // Puppeteer's helper doesn't know this feature; Chrome's DevTools protocol does.
    const cdp = await pop.createCDPSession();
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
    await sleep(200);
    const r = await pop.evaluate(() => {
      const box = getComputedStyle(document.querySelector('#audio'));
      const on = getComputedStyle(document.querySelector('.kind button.on'));
      return { border: box.borderTopStyle !== 'none' && box.borderTopWidth !== '0px', onAdjust: on.forcedColorAdjust };
    });
    ok(r.border, 'switches have no outline in high-contrast mode');
    ok(r.onAdjust === 'none', 'selected tab does not use the system highlight');
    await pop.close();
  },

  async 'recording countdown can be set from off to 30 seconds'({ browser, url }) {
    const pop = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
    await pop.evaluate(() => chrome.storage.local.remove(['countdown', 'countdownSeconds']).then(() => chrome.storage.local.set({ kind: 'video' })));
    await pop.reload();
    await pop.waitForSelector('#modes-video:not(.hidden)');
    const state = () => pop.evaluate(async () => ({
      shown: document.querySelector('#countdown').textContent,
      hint: document.querySelector('#countdown-hint').textContent,
      now: Number(document.querySelector('#countdown').getAttribute('aria-valuenow')),
      text: document.querySelector('#countdown').getAttribute('aria-valuetext'),
      less: document.querySelector('#countdown-less').disabled,
      more: document.querySelector('#countdown-more').disabled,
      stored: (await chrome.storage.local.get('countdownSeconds')).countdownSeconds,
    }));
    let r = await state();
    ok(r.shown === '3 s' && r.now === 3, `default is ${r.shown}`);
    await pop.click('#countdown-more');
    r = await state();
    ok(r.now === 4 && r.stored === 4 && r.text === '4 seconds', `after + : ${JSON.stringify(r)}`);
    // Keyboard: End jumps to the most, then steps go down 5 at a time above 10.
    await pop.focus('#countdown');
    await pop.keyboard.press('End');
    r = await state();
    ok(r.now === 30 && r.more, `End gives ${r.now}, + still enabled: ${!r.more}`);
    await pop.keyboard.press('ArrowDown');
    ok((await state()).now === 25, 'below 30 comes 25');
    for (let i = 0; i < 3; i++) await pop.keyboard.press('ArrowDown');
    ok((await state()).now === 10, 'then 20, 15, 10');
    await pop.keyboard.press('ArrowDown');
    ok((await state()).now === 9, 'below 10 it goes a second at a time');
    // Typing a digit sets it, and doesn't pick a capture mode.
    await pop.keyboard.press('2');
    ok((await state()).now === 2, 'typing 2 sets 2 seconds');
    await pop.keyboard.press('Home');
    r = await state();
    ok(r.shown === 'Off' && r.less && r.stored === 0 && /straight away/.test(r.hint), `Home: ${JSON.stringify(r)}`);
    // Remembered next time.
    await pop.evaluate(() => chrome.storage.local.set({ countdownSeconds: 15 }));
    await pop.reload();
    await pop.waitForSelector('#modes-video:not(.hidden)');
    ok((await state()).shown === '15 s', 'setting not remembered');
    // Settings from older versions: an on/off switch for 3 seconds.
    await pop.evaluate(() => chrome.storage.local.remove('countdownSeconds').then(() => chrome.storage.local.set({ countdown: false })));
    await pop.reload();
    await pop.waitForSelector('#modes-video:not(.hidden)');
    ok((await state()).now === 0, 'old "off" setting not carried over');
    await pop.evaluate(() => chrome.storage.local.remove(['countdown', 'countdownSeconds', 'kind']));
    await pop.close();
  },

  async 'recording keeps only the page when DevTools shows it phone-sized, at the chosen size'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    await lab.bringToFront();
    // A tab capture of a 400 × 1000 page shown in device mode: black either side.
    const run = (size, aspect) => lab.evaluate(async (size, aspect) => {
      const { record } = await import('/lib/recorder.js');
      const c = document.createElement('canvas'); c.width = 1600; c.height = 1000; document.body.append(c);
      const g = c.getContext('2d');
      let t = 0;
      const draw = () => {
        g.fillStyle = '#000'; g.fillRect(0, 0, 1600, 1000);
        g.fillStyle = '#3a6'; g.fillRect(600, 0, 400, 1000);
        g.fillStyle = '#fff'; g.fillRect(620 + (t++ % 200), 400, 100, 100);
      };
      draw();
      const timer = setInterval(draw, 33);
      const session = await record(c.captureStream(30), { fps: 30, aspect, size });
      await new Promise((r) => setTimeout(r, 1500));
      const { blob } = await session.stop();
      clearInterval(timer); c.remove();
      const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(blob);
      await new Promise((r) => { v.onloadeddata = r; });
      v.currentTime = 1; // a frame from the middle (the first may not be drawn yet)
      await new Promise((r) => { v.onseeked = r; });
      const k = new OffscreenCanvas(v.videoWidth, v.videoHeight).getContext('2d', { willReadFrequently: true });
      k.drawImage(v, 0, 0);
      const px = (x, y) => [...k.getImageData(x, y, 1, 1).data.slice(0, 3)];
      return { w: v.videoWidth, h: v.videoHeight, reported: [session.width, session.height], left: px(3, 50), right: px(v.videoWidth - 4, v.videoHeight - 50) };
    }, size, aspect);
    const green = (p) => p[0] < 110 && p[1] > 130 && p[2] < 140;
    let r = await run('page', 0.4);
    ok(r.w === 400 && r.h === 1000, `page size ${r.w}×${r.h}`);
    ok(green(r.left) && green(r.right), `edges should be the page, not black: ${r.left} ${r.right}`);
    r = await run('0.5x', 0.4);
    ok(r.w === 200 && r.h === 500 && green(r.left), `50%: ${r.w}×${r.h}`);
    r = await run('1080p', 0.4);
    ok(r.w === 1080 && r.h === 2700 && r.reported.join() === '1080,2700', `1080p (shorter side): ${r.w}×${r.h}`);
    // A page as wide as the tab is recorded whole, black areas and all.
    r = await run('page', 1.6);
    ok(r.w === 1600 && r.h === 1000, `normal tab ${r.w}×${r.h}`);
    await lab.close();

    // The popup remembers the size and offers scaling and resolutions.
    const pop = await open(browser, url('popup/popup.html'), { width: 340, height: 700 });
    await pop.evaluate(() => chrome.storage.local.set({ kind: 'video', videoSize: 'nonsense' }));
    await pop.reload();
    await pop.waitForSelector('#modes-video:not(.hidden)');
    ok(await pop.$eval('#size', (e) => e.value) === 'page', 'unknown sizes fall back to the page size');
    await pop.select('#size', '720p');
    const st = await pop.evaluate(async () => ({ stored: (await chrome.storage.local.get('videoSize')).videoSize, hint: document.querySelector('#size-hint').textContent, n: document.querySelectorAll('#size option').length }));
    ok(st.stored === '720p' && /shorter side/i.test(st.hint) && st.n === 10, JSON.stringify(st));
    await pop.evaluate(() => chrome.storage.local.remove('videoSize'));
    await pop.close();
  },

  async 'image exports say their colours are sRGB'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const r = await lab.evaluate(async () => {
      const { encodeImage } = await import('/lib/formats.js');
      const c = new OffscreenCanvas(64, 48);
      const g = c.getContext('2d');
      for (let x = 0; x < 64; x++) { g.fillStyle = `rgb(${x * 4}, 86, 255)`; g.fillRect(x, 0, 1, 48); }
      const out = {};
      for (const f of ['png', 'png8', 'jpeg', 'pdf']) {
        const b = new Uint8Array(await (await encodeImage(c, f, { quality: 0.85 })).arrayBuffer());
        const text = new TextDecoder('latin1').decode(b);
        out[f] = { srgb: text.includes('sRGB'), icc: text.includes('ICC_PROFILE'), iccBased: /\/ICCBased \d+ 0 R/.test(text), decodes: await createImageBitmap(new Blob([b])).then(() => true, () => f === 'pdf') };
      }
      return out;
    });
    await lab.close();
    ok(r.png.srgb && r.png.decodes, `PNG: ${JSON.stringify(r.png)}`);
    ok(r.png8.srgb && r.png8.decodes, `PNG-8: ${JSON.stringify(r.png8)}`);
    ok(r.jpeg.icc && r.jpeg.decodes, `JPEG: ${JSON.stringify(r.jpeg)}`);
    ok(r.pdf.iccBased, `PDF: ${JSON.stringify(r.pdf)}`);
  },

  async 'device frames: real devices, both orientations, and exact capture pixels'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const r = await lab.evaluate(async () => {
      const { deviceRenderer, DEVICES, matchDevice, normalise, describe } = await import('/lib/device.js');
      const problems = [];
      // The catalogue: real resolutions, consistent sizes, believable bezels.
      const names = new Set();
      for (const d of Object.values(DEVICES)) {
        if (names.has(d.name)) problems.push(`two devices called ${d.name}`);
        names.add(d.name);
        if (Math.abs(d.px[1] / d.dpr - d.viewport[1]) > 1.5) problems.push(`${d.name}: viewport height doesn't match its pixels`);
        const limit = d.type === 'tablet' ? 70 : d.home === 'button' ? 120 : 30;
        if (d.bezel.x < 2 || d.bezel.y < 2 || d.bezel.x > limit || d.bezel.y > limit) problems.push(`${d.name}: bezel ${d.bezel.x.toFixed(1)} × ${d.bezel.y.toFixed(1)} pt`);
      }
      const kinds = Object.values(DEVICES);
      const count = (f) => kinds.filter(f).length;
      // A capture with every pixel different, so any resampling shows.
      const capture = (w, h) => {
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        const img = ctx.createImageData(w, h);
        for (let i = 0; i < img.data.length; i += 4) { const p = i / 4; img.data[i] = p % 251; img.data[i + 1] = (p >> 3) % 241; img.data[i + 2] = (p * 7) % 239; img.data[i + 3] = 255; }
        ctx.putImageData(img, 0, 0);
        return c;
      };
      // The capture's pixels, found in the output: a 40 × 40 patch from its middle.
      const kept = (out, src, r) => {
        const s = src.getContext('2d').getImageData(Math.floor(src.width / 2), Math.floor(src.height / 2), 40, 40).data;
        const ctx = out.getContext('2d', { willReadFrequently: true });
        // Where the capture's middle landed: search near the screen's middle.
        const x0 = Math.floor(out.width / 2) - 80, y0 = Math.floor(out.height / 2) - 80, R = 200;
        const area = ctx.getImageData(x0, y0, R, R).data;
        const at = (x, y, i) => area[((y * R) + x) * 4 + i];
        for (let dy = 0; dy <= 160; dy++) for (let dx = 0; dx <= 160; dx++) {
          let same = true;
          for (let y = 0; y < 40 && same; y++) for (let x = 0; x < 40 && same; x++) {
            for (let i = 0; i < 3; i++) if (at(dx + x, dy + y, i) !== s[(y * 40 + x) * 4 + i]) { same = false; break; }
          }
          if (same) return true;
        }
        return false;
      };
      const out = {};
      for (const [id, orientation] of [['iphone-17-pro', 'portrait'], ['iphone-17-pro', 'landscape'], ['pixel-9', 'portrait'], ['galaxy-s25-ultra', 'landscape'], ['ipad-pro-11', 'landscape'], ['iphone-se', 'portrait']]) {
        const d = DEVICES[id];
        const [w, h] = orientation === 'portrait' ? d.px : [d.px[1], d.px[0]];
        const src = capture(w, h);
        const r = deviceRenderer({ device: id, orientation, padding: 0 }, w, h);
        const c = new OffscreenCanvas(r.width, r.height);
        r.render(c.getContext('2d'), src);
        out[`${id} ${orientation}`] = { exact: r.info.exact, screen: r.info.screen.join('×'), want: `${w}×${h}`, kept: kept(c, src), wide: r.width > r.height };
      }
      // A desktop capture: the device's real shape around the capture's own pixels.
      const desk = capture(1280, 800);
      const rd = deviceRenderer({ device: 'iphone-17-pro', orientation: 'portrait' }, 1280, 800);
      // The device's own screen resolution instead.
      const rs = deviceRenderer({ device: 'iphone-17-pro', orientation: 'portrait', size: 'device', statusBar: 'none' }, 1280, 800);
      return {
        problems, out,
        counts: { ios: count((d) => d.os === 'ios'), ipad: count((d) => d.os === 'ipados'), android: count((d) => d.os === 'android' && d.type === 'phone'), androidTablets: count((d) => d.os === 'android' && d.type === 'tablet') },
        match: [matchDevice(1206, 2622), matchDevice(2424, 1080), matchDevice(1179, 9000)],
        legacy: [normalise({ device: 'phone', statusBar: true }), normalise({ device: 'gone' })].map((o) => `${o.device} ${o.statusBar}`),
        desk: { exact: rd.info.exact, screen: rd.info.screen },
        deviceSize: { exact: rs.info.exact, screen: rs.info.screen, scale: rs.info.scale },
        describe: describe({ device: 'auto' }, 1206, 2622),
      };
    });
    await lab.close();
    ok(!r.problems.length, r.problems.join('; '));
    ok(r.counts.ios >= 10 && r.counts.ipad >= 5 && r.counts.android >= 10 && r.counts.androidTablets >= 3, `devices: ${JSON.stringify(r.counts)}`);
    for (const [k, v] of Object.entries(r.out)) {
      ok(v.exact && v.screen === v.want, `${k}: screen ${v.screen}, expected the device's ${v.want}`);
      ok(v.kept, `${k}: the capture's pixels were changed`);
      ok(v.wide === k.endsWith('landscape'), `${k}: wrong orientation`);
    }
    ok(r.match[0].id === 'iphone-17-pro' && r.match[0].exact && !r.match[0].landscape, `1206 × 2622 matched ${JSON.stringify(r.match[0])}`);
    ok(r.match[1].landscape && r.match[1].exact && /pixel/.test(r.match[1].id), `2424 × 1080 matched ${JSON.stringify(r.match[1])}`);
    ok(!r.match[2].exact && r.match[2].id === 'iphone-16', `a full page 1179 px wide matched ${JSON.stringify(r.match[2])}`);
    ok(r.legacy[0] === 'iphone-17-pro auto' && r.legacy[1] === 'auto auto', `older settings: ${r.legacy}`);
    ok(r.desk.exact && r.desk.screen[0] === 1280, `a desktop capture keeps its pixels: ${JSON.stringify(r.desk)}`);
    ok(r.deviceSize.screen.join() === '1206,2622' && !r.deviceSize.exact, `device resolution: ${JSON.stringify(r.deviceSize)}`);
    ok(/iPhone 17 Pro: 1206 × 2622 px.*matches this capture exactly.*kept exactly/.test(r.describe), r.describe);
    return `${Object.keys(r.out).length} layouts exact; ${JSON.stringify(r.counts)}`;
  },

  async 'device picker: search, filters, keyboard and recent devices'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const id = await lab.evaluate(async () => {
      const { putCapture } = await import('/lib/db.js');
      await chrome.storage.local.set({ device: true, deviceRecent: [] });
      const c = new OffscreenCanvas(1206, 2622);
      c.getContext('2d').fillRect(0, 0, 10, 10);
      return putCapture(await c.convertToBlob(), { title: 'Phone', mode: 'visible' });
    });
    await lab.close();
    const ed = await open(browser, url(`editor/editor.html?id=${id}`), { width: 1440, height: 1000 });
    await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { polling: 100 });
    await ed.evaluate(() => document.querySelector('[data-pane="export"]').click());
    await ed.waitForFunction(() => /:/.test(document.querySelector('.dev-pick-name')?.textContent), { polling: 100 });
    const state = () => ed.evaluate(() => ({
      name: document.querySelector('.dev-pick-name').textContent,
      open: document.querySelector('.dev-pick-btn').getAttribute('aria-expanded'),
      options: [...document.querySelectorAll('.dev-list [role="option"]')].map((li) => li.firstChild.textContent),
      groups: [...document.querySelectorAll('.dev-group')].map((g) => g.textContent),
      active: document.querySelector('.dev-search').getAttribute('aria-activedescendant'),
      focus: document.activeElement.className,
    }));
    ok((await state()).name === 'Best match: iPhone 17 Pro', `button: ${(await state()).name}`);
    await ed.click('.dev-pick-btn');
    let st = await state();
    ok(st.open === 'true' && st.focus === 'dev-search' && st.options.length > 40, `opened: ${JSON.stringify({ ...st, options: st.options.length })}`);
    // The iPad filter, then a search within everything.
    await ed.click('[data-filter="ipad"]');
    st = await state();
    ok(st.options.length === 6 && st.options.every((o) => /iPad/.test(o)), `iPad filter: ${st.options}`);
    await ed.click('[data-filter="all"]');
    await ed.focus('.dev-search');
    await ed.keyboard.type('galaxy fold');
    st = await state();
    ok(st.options.join() === 'Galaxy Z Fold6 (folded),Galaxy Z Fold6 (open)', `search: ${st.options}`);
    await ed.keyboard.press('ArrowDown');
    await ed.keyboard.press('Enter');
    st = await state();
    ok(st.name === 'Galaxy Z Fold6 (open)' && st.open === 'false' && st.focus === 'dev-pick-btn', `chosen: ${JSON.stringify(st)}`);
    ok(/Galaxy Z Fold6 \(open\): 1856 × 2160/.test(await ed.$eval('.dev-info', (e) => e.textContent)), 'the description follows the choice');
    // Recently used devices come first next time; Escape closes.
    await ed.click('.dev-pick-btn');
    st = await state();
    ok(st.groups[0] === 'Recent' && st.options[1] === 'Galaxy Z Fold6 (open)', `recent: ${st.groups} ${st.options.slice(0, 3)}`);
    await ed.keyboard.press('Escape');
    ok((await state()).open === 'false', 'Escape closes the list');
    await ed.evaluate(() => chrome.storage.local.set({ device: false, deviceRecent: [], deviceOpts: {} }));
    await ed.close();
  },

  async 'removing a capture, deleting annotations and resetting settings can all be undone'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const id = await lab.evaluate(async () => {
      const { putCapture } = await import('/lib/db.js');
      const c = new OffscreenCanvas(400, 300);
      c.getContext('2d').fillRect(0, 0, 50, 50);
      return putCapture(await c.convertToBlob(), { title: 'Undo me', mode: 'visible' });
    });
    await lab.close();
    // Recent captures: Remove, then Undo brings it back.
    const ed = await open(browser, url('editor/editor.html'), { width: 1280, height: 900 });
    const titles = () => ed.evaluate(() => [...document.querySelectorAll('.recent-item b')].map((b) => b.textContent));
    await ed.waitForFunction(() => [...document.querySelectorAll('.recent-item b')].some((b) => b.textContent === 'Undo me'), { polling: 100 });
    await ed.evaluate(() => [...document.querySelectorAll('.recent-item')].find((a) => a.querySelector('b').textContent === 'Undo me').querySelector('.remove').click());
    await ed.waitForFunction(() => /Removed Undo me/.test(document.querySelector('.toast')?.textContent), { polling: 100 });
    ok(!(await titles()).includes('Undo me'), 'the capture should be gone from the list');
    await ed.click('.toast-action');
    await ed.waitForFunction(() => [...document.querySelectorAll('.recent-item b')].some((b) => b.textContent === 'Undo me'), { polling: 100 });

    // Deleting annotations says so, with Undo.
    await ed.goto(url(`editor/editor.html?id=${id}&reopen=1`));
    await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { polling: 100 });
    await ed.evaluate(() => document.querySelector('[data-tool="rect"]').click());
    const box = await ed.$eval('#fg', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top }; });
    await ed.mouse.move(box.x + 60, box.y + 60);
    await ed.mouse.down();
    await ed.mouse.move(box.x + 160, box.y + 140, { steps: 4 });
    await ed.mouse.up();
    ok((await ed.evaluate(() => captodeEditor.objects().length)) === 1, 'a rectangle was drawn');
    await ed.evaluate(() => document.querySelector('#delete').click());
    await ed.waitForFunction(() => /Annotation deleted/.test(document.querySelector('.toast')?.textContent), { polling: 100 });
    ok((await ed.evaluate(() => captodeEditor.objects().length)) === 0, 'deleted');
    await ed.click('.toast-action');
    ok((await ed.evaluate(() => captodeEditor.objects().length)) === 1, 'Undo brings the annotation back');
    await ed.close();

    // Settings: Reset, then Undo puts them back.
    const st = await open(browser, url('settings/settings.html'), { width: 900, height: 900 });
    await st.evaluate(() => chrome.storage.local.set({ fps: '60', settings: { theme: 'dark', imageFormat: 'jpeg' } }));
    await st.reload();
    await st.waitForFunction(() => /Version/.test(document.querySelector('#version').textContent), { polling: 100 });
    await st.evaluate(() => document.querySelector('#reset').click());
    await st.waitForFunction(() => document.querySelector('#reset-dialog').open, { polling: 100 });
    await st.click('#reset-yes');
    await st.waitForFunction(() => /Settings reset/.test(document.querySelector('.toast')?.textContent), { polling: 100 });
    const after = await st.evaluate(async () => (await chrome.storage.local.get(['fps', 'settings'])));
    ok(!after.fps && after.settings.theme === 'system', `reset: ${JSON.stringify(after)}`);
    await st.click('.toast-action');
    await st.waitForFunction(() => /Settings restored/.test(document.querySelector('.toast')?.textContent), { polling: 100 });
    const back = await st.evaluate(async () => (await chrome.storage.local.get(['fps', 'settings'])));
    ok(back.fps === '60' && back.settings.theme === 'dark' && back.settings.imageFormat === 'jpeg', `restored: ${JSON.stringify(back)}`);
    ok(await st.$eval('#imageFormat', (e) => e.value) === 'jpeg', 'the page shows the restored settings');
    await st.evaluate(() => chrome.storage.local.remove(['fps', 'settings']));
    await st.close();
  },

  async 'export choices are remembered for next time'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const id = await lab.evaluate(async () => {
      const { putCapture } = await import('/lib/db.js');
      await chrome.storage.local.remove(['lastExport', 'settings']);
      const c = new OffscreenCanvas(300, 200);
      c.getContext('2d').fillRect(0, 0, 50, 50);
      return putCapture(await c.convertToBlob(), { title: 'Remember', mode: 'visible' });
    });
    await lab.close();
    const ed = await open(browser, url(`editor/editor.html?id=${id}&reopen=1`), { width: 1280, height: 900 });
    const ready = () => ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { polling: 100 });
    await ready();
    ok(await ed.$eval('#x-format', (e) => e.value) === 'png', 'PNG to begin with');
    await ed.evaluate(() => document.querySelector('[data-pane="export"]').click());
    await ed.click('#formats [data-f="jpeg"]');
    await ed.select('#x-scale', '0.5');
    await ed.evaluate(() => { const q = document.querySelector('#x-quality'); q.value = '60'; q.dispatchEvent(new Event('input', { bubbles: true })); q.dispatchEvent(new Event('change', { bubbles: true })); });
    await ed.waitForFunction(async () => (await chrome.storage.local.get('lastExport')).lastExport?.image?.controls?.['x-quality'] === '60', { polling: 100 });
    await ed.reload();
    await ready();
    const got = await ed.evaluate(() => ['#x-format', '#x-scale', '#x-quality'].map((s) => document.querySelector(s).value).join());
    ok(got === 'jpeg,0.5,60', `remembered: ${got}`);
    ok(/Download JPEG/.test(await ed.$eval('#download', (e) => e.textContent)), 'the download button says JPEG');
    // A format chosen in Settings wins over the last one used.
    await ed.evaluate(() => chrome.storage.local.set({ settings: { imageFormat: 'webp' } }));
    await ed.reload();
    await ready();
    ok(await ed.$eval('#x-format', (e) => e.value) === 'webp', 'the Settings default applies');
    await ed.evaluate(() => chrome.storage.local.remove(['lastExport', 'settings']));
    await ed.close();
  },

  async 'popup shows the video size in pixels for the current tab'({ browser, url, page }) {
    const want = await page.evaluate(() => [Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio)]);
    const pop = await browser.newPage();
    // As when the popup opens over the test page: that page is the active tab.
    await pop.evaluateOnNewDocument((pageUrl) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q) => (q?.active ? query({ url: pageUrl }) : query(q));
    }, page.url());
    await pop.setViewport({ width: 340, height: 700 });
    await pop.goto(url('popup/popup.html'));
    await pop.evaluate(() => chrome.storage.local.set({ kind: 'video' }));
    await pop.reload();
    await prepare(pop);
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    const hint = async (v) => {
      await pop.select('#size', v);
      return pop.$eval('#size-hint', (e) => e.textContent);
    };
    await pop.waitForFunction(() => / px$/.test(document.querySelector('#size-hint').textContent), { polling: 100 });
    ok(await hint('page') === `${even(want[0])} × ${even(want[1])} px`, `page size: ${await hint('page')}`);
    ok(await hint('0.5x') === `${even(want[0] / 2)} × ${even(want[1] / 2)} px`, `50%: ${await hint('0.5x')}`);
    const h720 = await hint('720p');
    ok(h720.includes(want[0] <= want[1] ? '720 ×' : '× 720'), `720p: ${h720}`);
    await pop.select('#size', 'page');
    await pop.evaluate(() => chrome.storage.local.remove('videoSize'));
    await pop.close();
  },

  async 'export presets: built in, saved, applied, and custom once changed'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const id = await lab.evaluate(async () => {
      const { putCapture } = await import('/lib/db.js');
      await chrome.storage.local.remove(['exportPresets', 'lastExport', 'settings']);
      const c = new OffscreenCanvas(600, 400);
      c.getContext('2d').fillRect(0, 0, 50, 50);
      return putCapture(await c.convertToBlob(), { title: 'Presets', mode: 'visible' });
    });
    await lab.close();
    const ed = await open(browser, url(`editor/editor.html?id=${id}&reopen=1`), { width: 1280, height: 900 });
    try {
      const ready = () => ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent) && document.querySelector('.preset-select option'), { polling: 100 });
      await ready();
      await ed.evaluate(() => document.querySelector('[data-pane="export"]').click());
      const state = () => ed.evaluate(() => ({
        preset: document.querySelector('.preset-select').value,
        format: document.querySelector('#x-format').value,
        limit: document.querySelector('#x-limit').value,
        scale: document.querySelector('#x-scale').value,
        quality: document.querySelector('#x-quality').value,
        device: document.querySelector('#device-panel [data-k="enabled"]').checked,
        mine: [...document.querySelectorAll('.preset-select optgroup[label="Yours"] option')].map((o) => o.textContent),
      }));
      await ed.select('.preset-select', 'email');
      let st = await state();
      ok(st.format === 'jpeg' && st.limit === '1024' && st.quality === '85' && st.preset === 'email', `email preset: ${JSON.stringify(st)}`);
      await ed.select('.preset-select', 'mockup');
      st = await state();
      ok(st.format === 'png' && st.device, `mock-up preset turns the device frame on: ${JSON.stringify(st)}`);
      // Changing something by hand makes it custom.
      await ed.select('#x-scale', '0.5');
      st = await state();
      ok(st.preset === '', `after a change: ${st.preset}`);
      // Save it as a preset of your own; it is there next time, and can be deleted.
      await ed.select('.preset-select', '__save');
      await ed.waitForFunction(() => document.activeElement.classList.contains('preset-name'), { polling: 100 });
      await ed.keyboard.type('Half-size mock-up');
      await ed.keyboard.press('Enter');
      await ed.waitForFunction(() => document.querySelector('.preset-select optgroup[label="Yours"]'), { polling: 100 });
      st = await state();
      ok(st.mine.join() === 'Half-size mock-up' && st.preset.startsWith('u'), `saved: ${JSON.stringify(st)}`);
      await ed.select('.preset-select', 'review');
      ok((await state()).scale === '1' && !(await state()).device, 'design review: full size, no frame');
      await ed.reload();
      await ready();
      await ed.evaluate(() => document.querySelector('[data-pane="export"]').click());
      const mine = await ed.$eval('.preset-select optgroup[label="Yours"] option', (o) => o.value);
      await ed.select('.preset-select', mine);
      st = await state();
      ok(st.scale === '0.5' && st.device && st.format === 'png', `your preset applied: ${JSON.stringify(st)}`);
      await ed.click('.preset-delete');
      ok(!(await state()).mine.length, 'deleted');
    } finally {
      // Presets turn the device frame on: never leave it on for later tests.
      await ed.evaluate(() => chrome.storage.local.remove(['exportPresets', 'lastExport', 'device', 'deviceOpts'])).catch(() => {});
      await ed.close();
    }
  },

  async 'review: measure in CSS pixels with edge snapping, colour contrast, and a grid that is not exported'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    // A 2× capture: a 360 × 200 px box (180 × 100 CSS px) at (100, 100), dark text colour on white.
    const id = await lab.evaluate(async () => {
      const { putCapture } = await import('/lib/db.js');
      const c = new OffscreenCanvas(800, 500);
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 800, 500);
      g.fillStyle = '#5b4bff'; g.fillRect(100, 100, 360, 200);
      g.fillStyle = '#767676'; g.fillRect(100, 360, 200, 40);
      return putCapture(await c.convertToBlob(), { title: 'Review', mode: 'visible', dpr: 2 });
    });
    await lab.close();
    const ed = await open(browser, url(`editor/editor.html?id=${id}&reopen=1`), { width: 1400, height: 900 });
    await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { polling: 100 });
    const at = async (x, y) => {
      const r = await ed.evaluate(() => { const b = document.querySelector('#wrap').getBoundingClientRect(); return { x: b.left, y: b.top, z: captodeEditor.zoom() }; });
      return [r.x + x * r.z, r.y + y * r.z];
    };
    // Measure: start a little outside the box's left edge, end a little inside its right edge.
    await ed.keyboard.press('u');
    ok(await ed.evaluate(() => document.body.dataset.pane) === 'review', 'the Measure tool opens the Review tab');
    await ed.mouse.move(...(await at(97, 200)));
    await ed.mouse.down();
    await ed.mouse.move(...(await at(457, 203)), { steps: 6 });
    await ed.mouse.up();
    let r = await ed.evaluate(() => captodeEditor.review());
    ok(r.measures.length === 1 && r.measures[0].x1 === 100 && r.measures[0].x2 === 460, `snapped to the edges: ${JSON.stringify(r.measures)}`);
    ok(r.text.startsWith('180 px') && r.measures[0].y2 === r.measures[0].y1, `in CSS pixels, straightened: ${r.text}`);
    // With Alt, no snapping.
    await ed.keyboard.down('Alt');
    await ed.mouse.move(...(await at(97, 250)));
    await ed.mouse.down();
    await ed.mouse.move(...(await at(457, 250)), { steps: 6 });
    await ed.mouse.up();
    await ed.keyboard.up('Alt');
    r = await ed.evaluate(() => captodeEditor.review());
    ok(r.measures[1].x1 === 97 && r.measures[1].x2 === 457, `Alt: ${JSON.stringify(r.measures[1])}`);
    // Colours: grey #767676 on white is 4.54:1, which passes AA for normal text.
    await ed.keyboard.press('i');
    await ed.mouse.click(...(await at(150, 380)));
    await ed.mouse.click(...(await at(600, 450)));
    r = await ed.evaluate(() => captodeEditor.review());
    ok(r.colours.join() === '#767676,#ffffff', `picked ${r.colours}`);
    ok(/4\.54 : 1/.test(r.contrast) && /Normal text: AA pass · AAA fail/.test(r.contrast), r.contrast);
    // The grid shows on screen only: the export is unchanged, measurements too.
    await ed.keyboard.press('g');
    ok(await ed.$eval('#g-on', (e) => e.checked), 'G turns the grid on');
    const exported = await ed.evaluate(async () => { const d = await captodeEditor.render(); const i = (16 * d.width + 16) * 4; return [d.data[i], d.data[i + 1], d.data[i + 2], d.width]; });
    ok(exported.join() === '255,255,255,800', `the export has no grid or measurements: ${exported}`);
    await ed.click('#m-clear');
    ok(!(await ed.evaluate(() => captodeEditor.review())).measures.length, 'Clear all');
    await ed.close();
  },

  async 'compare: slider, side by side, overlay, and a difference that finds the change'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    // A at 2×, B the same design at 1× with one button moved: matching widths lines them up.
    const [a, b] = await lab.evaluate(async () => {
      const { putCapture } = await import('/lib/db.js');
      const page = async (s, buttonX) => {
        const c = new OffscreenCanvas(400 * s, 300 * s);
        const g = c.getContext('2d');
        g.scale(s, s);
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, 400, 300);
        g.fillStyle = '#5b4bff'; g.fillRect(0, 0, 400, 40);
        g.fillStyle = '#30a46c'; g.fillRect(buttonX, 200, 100, 40);
        return c.convertToBlob();
      };
      return [await putCapture(await page(2, 40), { title: 'Build' }), await putCapture(await page(1, 60), { title: 'Design' })];
    });
    await lab.close();
    const cmp = await open(browser, url(`compare/compare.html?a=${a}&b=${b}`), { width: 1400, height: 900 });
    await cmp.waitForFunction(() => !document.querySelector('#view').classList.contains('hidden'), { polling: 100 });
    ok((await cmp.evaluate(() => captodeCompare.size())).join() === '800,600', 'A sets the size');
    ok(/×2\.00/.test(await cmp.$eval('#match-note', (e) => e.textContent)), 'B is scaled to A');
    // Slider: the divider moves with the keyboard.
    await cmp.focus('#divider');
    await cmp.keyboard.press('Home');
    ok(await cmp.$eval('#divider', (e) => e.getAttribute('aria-valuenow')) === '0', 'Home moves the divider to the left');
    // Side by side and overlay.
    await cmp.click('#modes [data-mode="side"]');
    ok(await cmp.$eval('#view', (e) => e.dataset.mode) === 'side', 'side by side');
    await cmp.click('#modes [data-mode="overlay"]');
    ok(!(await cmp.$eval('[data-for="overlay"]', (e) => e.classList.contains('hidden'))), 'overlay shows its opacity');
    // Difference: the moved button is found: 20 CSS px = 40 px across, two 40 px-wide strips.
    await cmp.click('#modes [data-mode="diff"]');
    await cmp.waitForFunction(() => captodeCompare.stats(), { polling: 100 });
    const st = await cmp.evaluate(() => captodeCompare.stats());
    ok(st.box && st.box.x === 80 && st.box.y === 400 && st.box.w === 240 && st.box.h === 80, `changes at ${JSON.stringify(st.box)}`);
    ok(Math.abs(st.changed - 2 * 40 * 80) < 400, `${st.changed} pixels changed, expected about ${2 * 40 * 80}`);
    // Lining B up by hand removes the difference: move it 40 px left.
    await cmp.evaluate(() => { const i = document.querySelector('#dx'); i.value = '-40'; i.dispatchEvent(new Event('input')); });
    await cmp.waitForFunction(() => captodeCompare.stats()?.box?.y === 0 || /differ/.test(document.querySelector('#stats').textContent), { polling: 100 });
    ok(/% of pixels differ|No differences/.test(await cmp.$eval('#stats', (e) => e.textContent)), 'the readout updates');
    await cmp.close();
  },

  async 'quick styles colour the selection and new annotations'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const id = await lab.evaluate(async () => {
      const { putCapture } = await import('/lib/db.js');
      await chrome.storage.local.remove('editorDefaults');
      const c = new OffscreenCanvas(800, 500);
      c.getContext('2d').fillRect(0, 0, 10, 10);
      return putCapture(await c.convertToBlob(), { title: 'Looks', mode: 'visible' });
    });
    await lab.close();
    const ed = await open(browser, url(`editor/editor.html?id=${id}&reopen=1`), { width: 1400, height: 900 });
    try {
      await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { polling: 100 });
      const at = async (x, y) => {
        const r = await ed.evaluate(() => { const b = document.querySelector('#wrap').getBoundingClientRect(); return { x: b.left, y: b.top, z: captodeEditor.zoom() }; });
        return [r.x + x * r.z, r.y + y * r.z];
      };
      const draw = async (key, x1, y1, x2, y2) => {
        await ed.keyboard.press(key);
        await ed.mouse.move(...(await at(x1, y1)));
        await ed.mouse.down();
        await ed.mouse.move(...(await at(x2, y2)), { steps: 4 });
        await ed.mouse.up();
      };
      await draw('a', 100, 100, 300, 200);
      // The new arrow is selected: the Approved style recolours it.
      await ed.click('[data-look="ok"]');
      let objs = await ed.evaluate(() => captodeEditor.objects());
      ok(objs[0].color === '#30a46c', `arrow colour ${objs[0].color}`);
      // New annotations use it too, text with its label colours.
      await ed.keyboard.press('Escape');
      await draw('r', 400, 100, 600, 300);
      await ed.keyboard.press('Escape');
      await ed.keyboard.press('n');
      await ed.mouse.click(...(await at(500, 400)));
      objs = await ed.evaluate(() => captodeEditor.objects());
      ok(objs[1].color === '#30a46c' && objs[2].color === '#30a46c', `new shapes: ${objs.map((o) => o.color)}`);
      ok(await ed.$eval('[data-look="ok"]', (b) => b.getAttribute('aria-pressed')) === 'true', 'the style shows as current');
      // Undo takes the restyle back.
      await ed.keyboard.press('Escape');
      await ed.keyboard.press('v');
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
      const shortcut = async (key) => { await ed.keyboard.down(mod); await ed.keyboard.press(key); await ed.keyboard.up(mod); };
      await shortcut('a');
      await ed.click('[data-look="bug"]');
      objs = await ed.evaluate(() => captodeEditor.objects());
      ok(objs.every((o) => o.color === '#e5484d'), `everything selected is red: ${objs.map((o) => o.color)}`);
      await shortcut('z');
      objs = await ed.evaluate(() => captodeEditor.objects());
      ok(objs.every((o) => o.color === '#30a46c'), `undone: ${objs.map((o) => o.color)}`);
    } finally {
      await ed.evaluate(() => chrome.storage.local.remove('editorDefaults')).catch(() => {});
      await ed.close();
    }
  },

  async 'several devices: one zip with an image for each device'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const id = await lab.evaluate(async () => {
      const { putCapture } = await import('/lib/db.js');
      await chrome.storage.local.remove(['multiDevices', 'lastExport', 'settings', 'device', 'deviceOpts']);
      const c = new OffscreenCanvas(1206, 2622);
      c.getContext('2d').fillRect(0, 0, 10, 10);
      return putCapture(await c.convertToBlob(), { title: 'Multi', mode: 'visible' });
    });
    await lab.close();
    const ed = await open(browser, url(`editor/editor.html?id=${id}&reopen=1`), { width: 1400, height: 900 });
    try {
      await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { polling: 100 });
      // Keep the download in the page, to look inside it.
      await ed.evaluate(() => { HTMLAnchorElement.prototype.click = function () { window.__download = { name: this.download, href: this.href }; }; });
      await ed.evaluate(() => document.querySelector('[data-pane="export"]').click());
      await ed.evaluate(() => document.querySelector('#multi-open').scrollIntoView({ block: 'center' }));
      await ed.click('#multi-open');
      await ed.waitForFunction(() => document.querySelector('#multi').open && document.querySelectorAll('#multi-list input').length > 40, { polling: 100 });
      await ed.evaluate(() => {
        for (const i of document.querySelectorAll('#multi-list input')) i.checked = ['none', 'iphone-17-pro', 'ipad-pro-11'].includes(i.value);
      });
      await ed.click('#multi-go');
      await ed.waitForFunction(() => window.__download, { polling: 100, timeout: 60000 });
      const z = await ed.evaluate(async () => {
        const { name, href } = window.__download;
        const b = new Uint8Array(await (await fetch(href)).arrayBuffer());
        const v = new DataView(b.buffer);
        const files = [];
        for (let p = 0; v.getUint32(p, true) === 0x04034b50;) {
          const size = v.getUint32(p + 18, true), n = v.getUint16(p + 26, true);
          const fname = new TextDecoder().decode(b.subarray(p + 30, p + 30 + n));
          const data = b.subarray(p + 30 + n, p + 30 + n + size);
          const dv = new DataView(data.buffer, data.byteOffset);
          files.push({ name: fname, w: dv.getUint32(16), h: dv.getUint32(20) });
          p += 30 + n + size;
        }
        return { name, files };
      });
      ok(/^captode-multi-.*-devices\.zip$/.test(z.name), `zip name ${z.name}`);
      ok(z.files.length === 3, `files: ${JSON.stringify(z.files)}`);
      const [none, phone, tablet] = z.files;
      ok(/-no-frame\.png$/.test(none.name) && none.w === 1206 && none.h === 2622, `no frame: ${JSON.stringify(none)}`);
      ok(/-iphone-17-pro\.png$/.test(phone.name) && phone.w > 1206 && phone.h > 2622, `phone: ${JSON.stringify(phone)}`);
      ok(/-ipad-pro-11\.png$/.test(tablet.name) && tablet.w > tablet.h * 0.6, `tablet: ${JSON.stringify(tablet)}`);
      ok(!(await ed.$eval('#multi', (d) => d.open)), 'the dialog closes');
      // The choice is remembered.
      const saved = await ed.evaluate(async () => (await chrome.storage.local.get('multiDevices')).multiDevices);
      ok(saved.join() === 'none,iphone-17-pro,ipad-pro-11', `remembered ${saved}`);
    } finally {
      await ed.evaluate(() => chrome.storage.local.remove(['multiDevices'])).catch(() => {});
      await ed.close();
    }
  },

  async 'share for review: a single page with the image, step notes and where it came from'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const id = await lab.evaluate(async () => {
      const { putCapture } = await import('/lib/db.js');
      const c = new OffscreenCanvas(800, 500);
      c.getContext('2d').fillRect(0, 0, 10, 10);
      return putCapture(await c.convertToBlob(), { title: 'Checkout page', url: 'https://example.com/checkout', mode: 'visible', dpr: 2 });
    });
    await lab.close();
    const ed = await open(browser, url(`editor/editor.html?id=${id}&reopen=1`), { width: 1400, height: 900 });
    try {
      await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { polling: 100 });
      const at = async (x, y) => {
        const r = await ed.evaluate(() => { const b = document.querySelector('#wrap').getBoundingClientRect(); return { x: b.left, y: b.top, z: captodeEditor.zoom() }; });
        return [r.x + x * r.z, r.y + y * r.z];
      };
      await ed.keyboard.press('n');
      await ed.mouse.click(...(await at(200, 100)));
      await ed.mouse.click(...(await at(600, 400)));
      await ed.keyboard.press('Escape');
      await ed.evaluate(() => { HTMLAnchorElement.prototype.click = function () { window.__download = { name: this.download, href: this.href }; }; });
      await ed.evaluate(() => document.querySelector('[data-pane="export"]').click());
      await ed.evaluate(() => document.querySelector('#share-open').scrollIntoView({ block: 'center' }));
      await ed.click('#share-open');
      await ed.waitForFunction(() => document.querySelector('#share').open && document.querySelectorAll('#sh-steps textarea').length === 2, { polling: 100 });
      ok(await ed.$eval('#sh-title', (e) => e.value) === 'Checkout page', 'the title starts as the capture\'s');
      await ed.type('#sh-summary', 'Spacing above the button is off.');
      await ed.type('#sh-steps [data-i="0"]', 'Header <b>too</b> tall');
      await ed.type('#sh-steps [data-i="1"]', 'Button should be 48 px');
      await ed.click('#sh-go');
      await ed.waitForFunction(() => window.__download, { polling: 100, timeout: 30000 });
      const page = await ed.evaluate(async () => ({ name: window.__download.name, html: await (await fetch(window.__download.href)).text() }));
      ok(page.name === 'Checkout page-review.html', `file name ${page.name}`);
      ok(page.html.includes('Spacing above the button is off.') && page.html.includes('Button should be 48 px'), 'the summary and notes are in the page');
      ok(page.html.includes('Header &lt;b&gt;too&lt;/b&gt; tall') && !page.html.includes('<b>too</b>'), 'notes are escaped');
      ok(page.html.includes('https://example.com/checkout') && page.html.includes('2× pixel ratio'), 'where it came from');
      ok(/src="data:image\/png;base64,/.test(page.html) && (page.html.match(/class="marker"/g) || []).length === 2, 'the image and two step markers are inside');
      ok(!/<(script|link)[^>]+src=|<link[^>]+href=/.test(page.html.replace(/<script>[\s\S]*?<\/script>/g, '')), 'nothing is loaded from elsewhere');
      // The notes are kept on the steps.
      const notes = await ed.evaluate(() => captodeEditor.objects().filter((o) => o.type === 'step').map((o) => o.note));
      ok(notes.join('|') === 'Header <b>too</b> tall|Button should be 48 px', `kept: ${notes}`);
      // And the page works: clicking a step lights up its marker.
      const view = await browser.newPage();
      await view.setContent(page.html);
      await view.click('#step-1');
      ok(await view.$eval('.marker[data-i="1"]', (m) => m.classList.contains('on')), 'clicking a note highlights its marker');
      await view.close();
    } finally {
      await ed.close();
    }
  },

  async 'annotations can be found, chosen and moved from the keyboard, and are announced'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const id = await lab.evaluate(async () => {
      const { putCapture } = await import('/lib/db.js');
      const c = new OffscreenCanvas(800, 500);
      c.getContext('2d').fillRect(0, 0, 10, 10);
      return putCapture(await c.convertToBlob(), { title: 'Keyboard', mode: 'visible' });
    });
    await lab.close();
    const ed = await open(browser, url(`editor/editor.html?id=${id}&reopen=1`), { width: 1400, height: 900 });
    try {
      await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { polling: 100 });
      const at = async (x, y) => {
        const r = await ed.evaluate(() => { const b = document.querySelector('#wrap').getBoundingClientRect(); return { x: b.left, y: b.top, z: captodeEditor.zoom() }; });
        return [r.x + x * r.z, r.y + y * r.z];
      };
      const said = () => ed.$eval('#announce', (e) => e.textContent);
      await ed.keyboard.press('a');
      await ed.mouse.move(...(await at(100, 100)));
      await ed.mouse.down();
      await ed.mouse.move(...(await at(300, 200)), { steps: 4 });
      await ed.mouse.up();
      await ed.waitForFunction(() => /^Added: Arrow from 100, 100 to 300, 200$/.test(document.querySelector('#announce').textContent), { polling: 50 });
      await ed.keyboard.press('r');
      await ed.mouse.move(...(await at(400, 100)));
      await ed.mouse.down();
      await ed.mouse.move(...(await at(600, 250)), { steps: 4 });
      await ed.mouse.up();
      await ed.keyboard.press('n');
      await ed.mouse.click(...(await at(700, 400)));
      await ed.waitForFunction(() => document.querySelector('#announce').textContent === 'Added step 1', { polling: 50 });
      await ed.keyboard.press('Escape');
      await ed.keyboard.press('v');
      const items = () => ed.$$eval('#layers [role="option"]', (li) => li.map((l) => [l.textContent, l.getAttribute('aria-selected')]));
      await ed.waitForFunction(() => document.querySelectorAll('#layers [role="option"]').length === 3, { polling: 50 });
      let list = await items();
      ok(list[0][0] === 'Step 1' && /^Rectangle, \d+ × \d+ at \d+, \d+$/.test(list[1][0]) && list[2][0] === 'Arrow from 100, 100 to 300, 200', `front to back: ${JSON.stringify(list)}`);
      // Arrow keys choose; Alt + arrows move; Delete removes.
      await ed.focus('#layers');
      await ed.keyboard.press('End');
      list = await items();
      ok(list[2][1] === 'true' && list[0][1] === 'false', `End chooses the arrow: ${JSON.stringify(list)}`);
      ok(await ed.$eval('#layers', (u) => u.getAttribute('aria-activedescendant')) === 'layer-2', 'the active item is announced');
      await ed.keyboard.down('Alt');
      await ed.keyboard.press('ArrowRight');
      await ed.keyboard.down('Shift');
      await ed.keyboard.press('ArrowDown');
      await ed.keyboard.up('Shift');
      await ed.keyboard.up('Alt');
      const arrow = await ed.evaluate(() => captodeEditor.objects().find((o) => o.type === 'arrow'));
      ok(arrow.x1 === 101 && arrow.y1 === 110, `moved by 1 across and 10 down: ${arrow.x1}, ${arrow.y1}`);
      await ed.waitForFunction(() => /^Moved to /.test(document.querySelector('#announce').textContent), { polling: 50 });
      ok(await ed.evaluate(() => document.activeElement.id) === 'layers', 'focus stays in the list');
      await ed.keyboard.press('ArrowUp');
      await ed.keyboard.down('Shift');
      await ed.keyboard.press('ArrowUp');
      await ed.keyboard.up('Shift');
      list = await items();
      ok(list[0][1] === 'true' && list[1][1] === 'true' && list[2][1] === 'false', `Shift adds to the choice: ${JSON.stringify(list)}`);
      await ed.keyboard.press('Delete');
      ok((await ed.evaluate(() => captodeEditor.objects().map((o) => o.type))).join() === 'arrow', 'Delete removes what is chosen');
      await ed.waitForFunction(() => document.querySelectorAll('#layers [role="option"]').length === 1, { polling: 50 });
      // A text box left before it had focus (another tool chosen at once) is not left behind empty.
      await ed.keyboard.press('t');
      await ed.mouse.click(...(await at(500, 400)));
      await ed.evaluate(() => document.querySelector('[data-tool="rect"]').click());
      ok((await ed.evaluate(() => captodeEditor.objects().map((o) => o.type))).join() === 'arrow', 'no empty text box remains');
    } finally {
      await ed.close();
    }
  },

  async 'countdown shows the chosen seconds and Esc cancels it'({ browser, url }) {
    const p = await open(browser, url('popup/popup.html'), { width: 800, height: 600 });
    const r = await p.evaluate(async () => {
      const { countdown } = await import('/content/page.js');
      const shown = [];
      const watch = setInterval(() => { const t = document.querySelector('#__captode_countdown')?.firstChild?.textContent; if (t && shown.at(-1) !== t) shown.push(t); }, 50);
      const t0 = performance.now();
      const done = await countdown(2);
      const ms = performance.now() - t0;
      clearInterval(watch);
      const cancelled = countdown(30);
      await new Promise((res) => setTimeout(res, 300));
      dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return { done, ms, shown, cancelled: await cancelled, left: !!document.querySelector('#__captode_countdown') };
    });
    ok(r.done === true && r.shown.join() === '2,1', `showed ${r.shown}, finished ${r.done}`);
    near(r.ms, 2000, 300, 'countdown length (ms)');
    ok(r.cancelled === false && !r.left, 'Esc did not cancel the countdown');
    await p.close();
  },

  async 'full-screen recording counts down after the picker, and can be cancelled'({ browser, url }) {
    const p = await open(browser, url('recorder/screen.html?fps=30&audio=0&countdown=2'), { width: 800, height: 600 });
    // Chrome's screen picker can't be driven from a test: share a canvas instead.
    const fakeShare = () => p.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas'); c.width = 320; c.height = 240;
        const x = c.getContext('2d');
        setInterval(() => { x.fillStyle = `hsl(${Date.now() / 10 % 360} 60% 50%)`; x.fillRect(0, 0, 320, 240); }, 33);
        return c.captureStream(30);
      };
    });
    const visible = (id) => p.evaluate((id) => !document.getElementById(id).classList.contains('hidden'), id);
    await fakeShare();
    await p.click('#choose');
    await sleep(300);
    ok(await visible('counting'), 'no countdown after choosing');
    const badge = await p.evaluate(() => chrome.action.getBadgeText({}));
    ok(badge === '2', `badge shows "${badge}"`);
    await p.click('#cancel');
    await sleep(200);
    ok(await visible('pick') && !(await visible('live')), 'cancel did not go back to the start');
    ok(await p.evaluate(() => chrome.action.getBadgeText({})) === '', 'badge not cleared after cancel');
    // Again, letting it finish: recording starts.
    await p.click('#choose');
    await sleep(2600);
    ok(await visible('live') && !(await visible('counting')), 'recording did not start after the countdown');
    await Promise.all([p.waitForNavigation({ timeout: 30000 }), p.click('#stop')]);
    ok(p.url().includes('video/video.html?id='), `after stopping: ${p.url()}`);
    await p.close();
  },

  async 'editor: step numbers count up, can be renumbered, and undo'({ editor }) {
    const ed = await editor();
    const b = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const at = (fx, fy) => [b.x + b.w * fx, b.y + b.h * fy];
    const panel = () => ed.evaluate(() => ({ label: document.querySelector('#st-n-label').textContent, n: document.querySelector('#st-n').value, size: Number(document.querySelector('#st-size').value) }));
    await ed.keyboard.press('n');
    ok((await panel()).n === '1', 'first step is not 1');
    for (const fx of [0.2, 0.4, 0.6]) { await ed.mouse.click(...at(fx, 0.5)); await sleep(50); }
    let p = await panel();
    ok(p.label === 'Number' && p.n === '3', `after three clicks the selected step shows ${p.label} ${p.n}`);
    // Three circles in the chosen colour (#e5484d) are drawn.
    const red = await ed.evaluate(async () => {
      const d = (await captodeEditor.render()).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 0xe5) < 12 && Math.abs(d[i + 1] - 0x48) < 12 && Math.abs(d[i + 2] - 0x4d) < 12 && d[i + 3] > 250) n++;
      return n;
    });
    const area = Math.PI * (p.size / 2) ** 2;
    ok(red > area * 3 * 0.5, `step circles: ${red} pixels in the step colour, expected about ${Math.round(area * 3 * 0.8)}`);
    await ed.keyboard.press('Escape');
    ok((await panel()).n === '4', 'next number after 3 is not 4');
    // Select the second and renumber it.
    await ed.keyboard.press('v');
    await ed.mouse.click(...at(0.4, 0.5));
    ok((await panel()).n === '2', 'clicking the second step did not select it');
    await ed.click('#st-n', { count: 3 });
    await ed.keyboard.type('7');
    await ed.keyboard.press('Enter'); // leaves the box
    await sleep(500);
    await ed.keyboard.press('Escape');
    // Start the next one at 10.
    await ed.keyboard.press('n');
    await ed.click('#st-n', { count: 3 });
    await ed.keyboard.type('10');
    await ed.keyboard.press('Enter');
    await ed.mouse.click(...at(0.8, 0.5));
    await ed.keyboard.press('Escape');
    ok((await panel()).n === '11', 'after a step set to 10 the next is not 11');
    // Undo removes 10; the next is then one more than the highest left (7).
    await ed.keyboard.down('Meta'); await ed.keyboard.press('z'); await ed.keyboard.up('Meta');
    await ed.keyboard.down('Control'); await ed.keyboard.press('z'); await ed.keyboard.up('Control');
    await sleep(100);
    // (One of the two undo shortcuts applies on this platform; the other is ignored.)
    const n = (await panel()).n;
    ok(n === '8' || n === '4', `after undo the next number is ${n}`);
    await ed.close();
  },

  async 'editor: copy from the Export panel, and copy new screenshots automatically'({ browser, url, editor, page }) {
    // Extension pages can't be granted clipboard reading in a test, so read it from the
    // test web page.
    await browser.defaultBrowserContext().overridePermissions(new URL(page.url()).origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    const clip = async () => {
      await page.bringToFront();
      return page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const item = items.find((i) => i.types.includes('image/png'));
        if (!item) return null;
        const bmp = await createImageBitmap(await item.getType('image/png'));
        return [bmp.width, bmp.height];
      });
    };
    const clear = async () => { await page.bringToFront(); await page.evaluate(() => navigator.clipboard.writeText('before')); };
    const ed = await editor();
    const size = await ed.evaluate(() => captodeEditor.size());
    await clear();
    await ed.bringToFront();
    await ed.evaluate(() => document.querySelector('#tab-export').click());
    await ed.evaluate(() => document.querySelector('#copy2').click());
    await sleep(500);
    let got = await clip();
    ok(got && got[0] === size[0] && got[1] === size[1], `Export panel copy put ${got} on the clipboard, expected ${size}`);
    await ed.close();

    // Settings → Copy screenshots to the clipboard.
    const st = await open(browser, url('settings/settings.html'), { width: 900, height: 1000 });
    await st.click('#autoCopy');
    await sleep(300);
    await st.close();
    await clear();
    const ed2 = await editor();
    await ed2.waitForFunction(() => /copied to the clipboard/i.test(document.body.innerText), { timeout: 10000, polling: 100 }).catch(() => {});
    got = await clip();
    ok(got && got[0] > 0, 'new screenshot was not copied automatically');
    ok(await ed2.evaluate(() => location.search.includes('reopen=1')), 'a reload would copy it again');
    await ed2.evaluate(async () => { const { saveSettings } = await import('/lib/settings.js'); await saveSettings({ autoCopy: false }); });
    await ed2.close();
  },

  async 'editor: undo all, and bring the changes back'({ editor }) {
    const ed = await editor();
    const b = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const drawn = () => ed.evaluate(() => captodeEditor.objects().length);
    const disabled = (id) => ed.evaluate((id) => document.getElementById(id).disabled, id);
    ok(await disabled('undo-all'), 'Undo all is enabled before any change');
    await ed.keyboard.press('r');
    await ed.mouse.move(b.x + b.w * 0.2, b.y + b.h * 0.2);
    await ed.mouse.down();
    await ed.mouse.move(b.x + b.w * 0.5, b.y + b.h * 0.5, { steps: 4 });
    await ed.mouse.up();
    await ed.keyboard.press('n');
    await ed.mouse.click(b.x + b.w * 0.7, b.y + b.h * 0.7);
    await ed.keyboard.press('Escape');
    ok(await drawn() > 0 && !(await disabled('undo-all')), 'nothing drawn, or Undo all not available');
    await ed.evaluate(() => document.querySelector('#undo-all').click());
    await sleep(100);
    ok(await drawn() === 0, 'Undo all left annotations behind');
    ok(await disabled('undo-all') && !(await disabled('undo')), 'after Undo all: it should be disabled, and Undo available');
    // The toast's Undo brings everything back.
    await ed.evaluate(() => document.querySelector('.toast-action').click());
    await sleep(100);
    ok(await drawn() > 0, 'Undo did not bring the changes back');
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close({ runBeforeUnload: false });
  },

  async 'editor: pan with the hand tool, Space or the middle button'({ editor }) {
    const ed = await editor();
    for (let i = 0; i < 4; i++) await ed.keyboard.press('+');
    await sleep(100);
    const scroll = () => ed.evaluate(() => { const s = document.querySelector('#stage'); return [s.scrollLeft, s.scrollTop]; });
    const mid = await ed.evaluate(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    const dragBy = async (dx, dy, button = 'left') => {
      await ed.mouse.move(...mid);
      await ed.mouse.down({ button });
      await ed.mouse.move(mid[0] + dx, mid[1] + dy, { steps: 5 });
      await ed.mouse.up({ button });
    };
    const undoState = () => ed.evaluate(() => document.querySelector('#undo').disabled);
    await ed.evaluate(() => { const s = document.querySelector('#stage'); s.scrollLeft = 400; s.scrollTop = 400; });
    // Hand tool.
    await ed.keyboard.press('m');
    let before = await scroll();
    await dragBy(-120, -80);
    let after = await scroll();
    ok(Math.abs(after[0] - before[0] - 120) <= 2 && Math.abs(after[1] - before[1] - 80) <= 2, `hand tool scrolled ${before} → ${after}`);
    // Space with the rectangle tool: pans, draws nothing.
    await ed.keyboard.press('r');
    const undoBefore = await undoState();
    before = await scroll();
    await ed.keyboard.down(' ');
    await dragBy(100, 60);
    await ed.keyboard.up(' ');
    after = await scroll();
    ok(Math.abs(before[0] - after[0] - 100) <= 2 && Math.abs(before[1] - after[1] - 60) <= 2, `Space-drag scrolled ${before} → ${after}`);
    ok(await undoState() === undoBefore, 'Space-drag drew a rectangle');
    // Middle button.
    before = await scroll();
    await dragBy(-50, -30, 'middle');
    after = await scroll();
    ok(Math.abs(after[0] - before[0] - 50) <= 2, `middle-button drag scrolled ${before} → ${after}`);
    await ed.close();
  },

  async 'editor: large captures draw only what is on screen, correctly'({ browser, url }) {
    const ed = await open(browser, url('editor/editor.html'), { width: 1440, height: 900 });
    await ed.bringToFront();
    await ed.evaluate(async () => {
      // 2560 × 24000: a long page on a high-resolution screen. Each 100-px band has its own colour.
      const c = new OffscreenCanvas(2560, 24000); const x = c.getContext('2d');
      for (let y = 0; y < 24000; y += 100) { x.fillStyle = `rgb(${(y / 100) % 256}, ${(y / 37) % 256 | 0}, 120)`; x.fillRect(0, y, 2560, 100); }
      const dt = new DataTransfer(); dt.items.add(new File([await c.convertToBlob()], 'long.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
    });
    await ed.waitForFunction(() => captodeEditor.size()?.[1] === 24000, { polling: 100, timeout: 60000 });
    await ed.evaluate(() => document.querySelector('#zoom-label').click()); // 100%
    await sleep(200);
    // Scroll deep into the image and compare what's drawn with the image itself.
    const r = await ed.evaluate(async () => {
      const stage = document.querySelector('#stage');
      stage.scrollTop = 20000;
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const bg = document.querySelector('#bg');
      const canvasPx = [...document.querySelectorAll('#wrap canvas')].reduce((n, c) => n + c.width * c.height, 0);
      // The pixel in the middle of the visible canvas, and where it is in the image.
      const br = bg.getBoundingClientRect(), wr = document.querySelector('#wrap').getBoundingClientRect();
      const cx = br.left + br.width / 2, cy = br.top + br.height / 2;
      const drawn = [...bg.getContext('2d').getImageData(Math.round(bg.width / 2), Math.round(bg.height / 2), 1, 1).data];
      const ix = Math.round(cx - wr.left), iy = Math.round(cy - wr.top);
      const want = [...captodeEditor.pixels().data.subarray((iy * 2560 + ix) * 4, (iy * 2560 + ix) * 4 + 4)];
      return { canvasPx, viewport: innerWidth * innerHeight * devicePixelRatio ** 2, drawn, want, iy };
    });
    ok(r.canvasPx <= r.viewport * 2.2, `canvases hold ${r.canvasPx} px for a ${r.viewport} px window`);
    ok(r.iy > 19000 && r.drawn.every((v, i) => Math.abs(v - r.want[i]) <= 2), `at row ${r.iy}: drawn ${r.drawn}, image has ${r.want}`);
    await ed.close();
  },

  async 'editor: blur changes only its area, and undo stays within its memory budget'({ editor }) {
    const ed = await editor();
    const b = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await ed.keyboard.press('b');
    await ed.evaluate(() => { const s = document.querySelector('#r-mode'); s.value = 'blur'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await ed.mouse.move(b.x + b.w * 0.1, b.y + b.h * 0.1);
    await ed.mouse.down();
    await ed.mouse.move(b.x + b.w * 0.5, b.y + b.h * 0.5, { steps: 4 });
    await ed.mouse.up();
    const r = await ed.evaluate(async () => {
      const a = captodeEditor.pixels(), f = await captodeEditor.render();
      const o = captodeEditor.objects()[0];
      const x0 = Math.round(Math.min(o.x1, o.x2)), y0 = Math.round(Math.min(o.y1, o.y2)), x1 = Math.round(Math.max(o.x1, o.x2)), y1 = Math.round(Math.max(o.y1, o.y2));
      let inside = 0, outside = 0;
      for (let y = 0; y < a.height; y += 3) for (let x = 0; x < a.width; x += 3) {
        const i = (y * a.width + x) * 4;
        const d = Math.abs(a.data[i] - f.data[i]) + Math.abs(a.data[i + 1] - f.data[i + 1]) + Math.abs(a.data[i + 2] - f.data[i + 2]);
        if (x >= x0 && x < x1 && y >= y0 && y < y1) inside += d > 0; else outside += d > 0;
      }
      return { inside, outside };
    });
    ok(r.inside > 100 && r.outside === 0, `blur changed ${r.inside} pixels inside and ${r.outside} outside`);
    // Undo memory: resizing a capture keeps a copy per step; old ones go past the budget.
    await ed.evaluate(() => document.querySelector('#tab-adjust').click());
    for (const w of [12000, 11000, 10000, 9000, 8000]) {
      await ed.evaluate((w) => { const i = document.querySelector('#rs-w'); i.value = w; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#rs-apply').click(); }, w);
      await ed.waitForFunction((w) => captodeEditor.size()[0] === w, { polling: 100, timeout: 30000 }, w);
    }
    const h = await ed.evaluate(() => captodeEditor.history());
    ok(h.steps < 7 && h.index === h.steps - 1, `history kept ${h.steps} steps of big images`);
    await ed.keyboard.down('Control'); await ed.keyboard.press('z'); await ed.keyboard.up('Control');
    await ed.keyboard.down('Meta'); await ed.keyboard.press('z'); await ed.keyboard.up('Meta');
    ok([9000, 10000].includes((await ed.evaluate(() => captodeEditor.size()))[0]), 'undo after trimming did not go back a step');
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close();
  },

  async 'editor: resize handles for shapes, text and steps'({ editor }) {
    const ed = await editor();
    await ed.evaluate(() => document.querySelector('#zoom-label').click()); // 100%: image px = CSS px
    await sleep(100);
    const wrap = () => ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    let w = await wrap();
    const at = (x, y) => [w.x + x, w.y + y];
    const dragFrom = async (from, to) => { await ed.mouse.move(...from); await ed.mouse.down(); await ed.mouse.move(...to, { steps: 4 }); await ed.mouse.up(); };
    // Rectangle: drag its bottom-right corner, then its left edge.
    await ed.keyboard.press('r');
    await dragFrom(at(100, 100), at(300, 200));
    await ed.keyboard.press('v');
    await dragFrom(at(300, 200), at(400, 260));
    let o = (await ed.evaluate(() => captodeEditor.objects()))[0];
    ok(Math.abs(o.x2 - 400) <= 1 && Math.abs(o.y2 - 260) <= 1 && Math.abs(o.x1 - 100) <= 1, `corner drag gave ${JSON.stringify(o)}`);
    await dragFrom(at(100, 180), at(150, 120));
    o = (await ed.evaluate(() => captodeEditor.objects()))[0];
    ok(Math.abs(Math.min(o.x1, o.x2) - 150) <= 1 && Math.abs(o.y1 - 100) <= 1 && Math.abs(o.y2 - 260) <= 1, `edge drag gave ${JSON.stringify(o)}`);
    // Step: its corner scales it, keeping it round.
    await ed.keyboard.press('n');
    await ed.mouse.click(...at(600, 400));
    const step = (await ed.evaluate(() => captodeEditor.objects())).at(-1);
    await ed.keyboard.press('v');
    await ed.mouse.click(...at(600, 400));
    const half = step.size / 2 + Math.max(1.5, step.size * 0.06) / 2;
    await dragFrom(at(600 + half, 400 + half), at(600 + half * 2, 400 + half * 2));
    const bigger = (await ed.evaluate(() => captodeEditor.objects())).at(-1);
    ok(bigger.size > step.size * 1.4, `step size ${step.size} → ${bigger.size}`);
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close();
  },

  async 'editor: select several, move, restyle, duplicate, copy and paste, arrange'({ editor, browser, page }) {
    const ed = await editor();
    await ed.evaluate(() => document.querySelector('#zoom-label').click());
    await sleep(100);
    const w = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const at = (x, y) => [w.x + x, w.y + y];
    const objs = () => ed.evaluate(() => captodeEditor.objects());
    const dragFrom = async (from, to, shift = false) => {
      if (shift) await ed.keyboard.down('Shift');
      await ed.mouse.move(...from); await ed.mouse.down(); await ed.mouse.move(...to, { steps: 4 }); await ed.mouse.up();
      if (shift) await ed.keyboard.up('Shift');
    };
    const key = async (k) => { for (const m of ['Control', 'Meta']) { await ed.keyboard.down(m); await ed.keyboard.press(k); await ed.keyboard.up(m); } };
    // Three rectangles.
    await ed.keyboard.press('r');
    for (const x of [100, 300, 500]) await dragFrom(at(x, 100), at(x + 100, 180));
    await ed.keyboard.press('v');
    // Drag a box around the first two.
    await dragFrom(at(80, 80), at(420, 200));
    let t = await ed.evaluate(() => document.querySelector('#style-title').textContent);
    ok(/^2 ×/.test(t), `box selection: "${t}"`);
    // Shift-click adds the third; move all three together.
    await ed.keyboard.down('Shift'); await ed.mouse.click(...at(500, 140)); await ed.keyboard.up('Shift');
    await dragFrom(at(150, 100), at(150, 160));
    let o = await objs();
    ok(o.every((r) => Math.abs(Math.min(r.y1, r.y2) - 160) <= 1), `moved together: ${o.map((r) => r.y1)}`);
    // Restyle all three at once.
    await ed.evaluate(() => { const i = document.querySelector('#s-color'); i.value = '#0090ff'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    o = await objs();
    ok(o.every((r) => r.color === '#0090ff'), 'colour did not apply to all');
    // Duplicate (⌘D / Ctrl+D): six, and the copies are selected.
    await key('d');
    o = await objs();
    ok(o.length === 6 || o.length === 9, `after duplicate there are ${o.length}`);
    const count = o.length;
    // Copy and paste through the clipboard.
    await ed.evaluate(() => document.querySelector('#a-front').click());
    // ⌘C puts the annotations on the clipboard as text; read it from the web page (an
    // extension page can't be given clipboard access in a test), then paste it back.
    await browser.defaultBrowserContext().overridePermissions(new URL(page.url()).origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    await ed.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true })));
    await sleep(300);
    await page.bringToFront();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    ok(/captode-annotations/.test(text), `clipboard has ${text.slice(0, 60)}`);
    await ed.bringToFront();
    await ed.evaluate((text) => {
      const dt = new DataTransfer(); dt.setData('text/plain', text);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, text);
    o = await objs();
    ok(o.length > count, `paste added nothing (${count} → ${o.length})`);
    // Send to back puts the selection first in the stack.
    const before = o.length;
    await ed.evaluate(() => document.querySelector('#a-back').click());
    const sel = await ed.evaluate(() => document.querySelector('#style-title').textContent);
    ok(/×/.test(sel), `selection lost after arranging: ${sel}`);
    // Select all and delete.
    await key('a');
    await ed.keyboard.press('Delete');
    ok((await objs()).length === 0, 'select all + delete left annotations');
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close();
    void before; void page;
  },

  async 'editor: spotlight, magnifier, callout, dashed and double-headed arrows'({ editor }) {
    const ed = await editor();
    await ed.evaluate(() => document.querySelector('#zoom-label').click());
    await sleep(100);
    const w = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const at = (x, y) => [w.x + x, w.y + y];
    const dragFrom = async (from, to) => { await ed.mouse.move(...from); await ed.mouse.down(); await ed.mouse.move(...to, { steps: 5 }); await ed.mouse.up(); };
    // Spotlight: inside unchanged, outside darker.
    await ed.keyboard.press('f');
    await dragFrom(at(100, 100), at(400, 300));
    // Magnifier somewhere else.
    await ed.keyboard.press('z');
    await dragFrom(at(700, 400), at(860, 560));
    const px = await ed.evaluate(async () => {
      const a = captodeEditor.pixels(), f = await captodeEditor.render();
      const get = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
      const lum = (p) => p[0] + p[1] + p[2];
      const m = captodeEditor.objects()[1];
      const cx = Math.round((m.x1 + m.x2) / 2), cy = Math.round((m.y1 + m.y2) / 2);
      return { inA: get(a, 250, 200), inF: get(f, 250, 200), outA: lum(get(a, 600, 150)), outF: lum(get(f, 600, 150)), lensA: get(a, cx, cy), lensF: get(f, cx, cy), outLens: lum(get(f, cx + 120, cy)) };
    });
    ok(px.inA.every((v, i) => Math.abs(v - px.inF[i]) <= 1), `spotlight changed its inside: ${px.inA} → ${px.inF}`);
    ok(px.outF < px.outA * 0.7 || px.outA < 30, `outside the spotlight not dimmed: ${px.outA} → ${px.outF}`);
    ok(px.lensA.every((v, i) => Math.abs(v - px.lensF[i]) <= 12), `magnifier centre ${px.lensF}, image ${px.lensA}`);
    // Callout: press on the target, drag to where the bubble goes, type.
    await ed.keyboard.press('k');
    await dragFrom(at(500, 500), at(600, 620));
    await sleep(150);
    await ed.keyboard.type('Look');
    await ed.keyboard.press('Escape');
    const c = (await ed.evaluate(() => captodeEditor.objects())).find((o) => o.tail);
    ok(c && c.text === 'Look' && Math.abs(c.tail.x - 500) <= 1 && Math.abs(c.x - 600) <= 1, `callout ${JSON.stringify(c)}`);
    // Arrow: dashed, heads at both ends.
    await ed.keyboard.press('a');
    await ed.evaluate(() => {
      for (const [id, v] of [['s-dash', 'dashed'], ['s-heads', '2']]) { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await dragFrom(at(900, 150), at(1100, 300));
    const a = (await ed.evaluate(() => captodeEditor.objects())).at(-1);
    ok(a.type === 'arrow' && a.dash === 'dashed' && a.heads === 2, `arrow ${JSON.stringify(a)}`);
    // Clicking inside a spotlight reaches what's under it: here, nothing, so no selection.
    await ed.keyboard.press('v');
    await ed.mouse.click(...at(250, 200));
    ok(/Annotate/.test(await ed.evaluate(() => document.querySelector('#style-title').textContent)), 'clicking inside a spotlight selected it');
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close();
  },

  async 'editor: edits are kept with the capture and come back on reopening'({ editor }) {
    const ed = await editor();
    await ed.evaluate(() => document.querySelector('#zoom-label').click());
    await sleep(100);
    const w = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const at = (x, y) => [w.x + x, w.y + y];
    await ed.keyboard.press('r');
    await ed.mouse.move(...at(100, 100)); await ed.mouse.down(); await ed.mouse.move(...at(300, 200), { steps: 3 }); await ed.mouse.up();
    await ed.keyboard.press('n');
    await ed.mouse.click(...at(500, 300));
    // Crop too, so the stored image changes.
    await ed.keyboard.press('c');
    await ed.mouse.move(...at(50, 50)); await ed.mouse.down(); await ed.mouse.move(...at(900, 600), { steps: 3 }); await ed.mouse.up();
    await ed.keyboard.press('Enter');
    // Saved shortly after the last change (slower on a busy machine): wait until it is.
    const stored = () => ed.evaluate(async () => { const { getCapture } = await import('/lib/db.js'); return (await getCapture(new URLSearchParams(location.search).get('id')))?.edits?.objects?.length ?? 0; });
    for (let t = 0; t < 100 && (await stored()) < 2; t++) await sleep(100);
    const before = await ed.evaluate(() => ({ size: captodeEditor.size(), n: captodeEditor.objects().length }));
    ed.on('dialog', (d) => d.accept()); // "leave without downloading?"
    await ed.reload({ waitUntil: 'load' });
    await ed.waitForFunction(() => window.captodeEditor?.size(), { polling: 100, timeout: 20000 });
    await ed.waitForFunction(() => captodeEditor.objects().length > 0, { polling: 100, timeout: 10000 }).catch(() => {});
    const after = await ed.evaluate(() => ({ size: captodeEditor.size(), n: captodeEditor.objects().length, toast: document.body.innerText.includes('Your edits are back') }));
    ok(after.n === before.n && after.size.join() === before.size.join(), `before ${JSON.stringify(before)}, after reopening ${JSON.stringify(after)}`);
    ok(after.toast, 'no message that the edits were restored');
    // Undo all goes back to the original capture (not the restored edits)…
    await ed.evaluate(() => document.querySelector('#undo-all').click());
    const orig = await ed.evaluate(() => ({ size: captodeEditor.size(), n: captodeEditor.objects().length }));
    ok(orig.n === 0 && orig.size[0] > before.size[0], `Undo all gave ${JSON.stringify(orig)}`);
    // …and that is saved too.
    for (let t = 0; t < 100 && (await stored()) > 0; t++) await sleep(100);
    await ed.reload({ waitUntil: 'load' });
    await ed.waitForFunction(() => window.captodeEditor?.size(), { polling: 100, timeout: 20000 });
    await sleep(500);
    ok((await ed.evaluate(() => captodeEditor.objects().length)) === 0, 'reopening after Undo all brought edits back');
    await ed.close();
  },

  async 'editor: rotate and flip with annotations, and zoom at the pointer'({ editor }) {
    const ed = await editor();
    // With reduced motion, as some users (and CI runners) have it: it once broke zooming.
    await ed.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await ed.evaluate(() => document.querySelector('#zoom-label').click());
    await sleep(100);
    const w = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    await ed.keyboard.press('r');
    await ed.mouse.move(w.x + 100, w.y + 120); await ed.mouse.down(); await ed.mouse.move(w.x + 300, w.y + 200, { steps: 3 }); await ed.mouse.up();
    const state = () => ed.evaluate(() => {
      const p = captodeEditor.pixels(); let h = 0;
      for (let i = 0; i < p.data.length; i += 997) h = (h * 31 + p.data[i]) >>> 0;
      return { size: captodeEditor.size(), o: captodeEditor.objects()[0], hash: h };
    });
    const start = await state();
    const click = (id) => ed.evaluate((id) => document.getElementById(id).click(), id);
    await click('rot-cw');
    const turned = await state();
    ok(turned.size[0] === start.size[1] && turned.size[1] === start.size[0], `rotated size ${turned.size}`);
    // The rectangle's top-left (100, 120) is now at (H - 120, 100).
    const H = start.size[1];
    ok(Math.abs(Math.max(turned.o.x1, turned.o.x2) - (H - 120)) <= 1 && Math.abs(Math.min(turned.o.y1, turned.o.y2) - 100) <= 1, `rotated rectangle ${JSON.stringify(turned.o)}`);
    await click('rot-ccw');
    const back = await state();
    ok(back.hash === start.hash && back.size.join() === start.size.join(), 'rotating right then left changed the image');
    ok(Math.abs(back.o.x1 - start.o.x1) < 0.01 && Math.abs(back.o.y2 - start.o.y2) < 0.01, 'rotating right then left moved the rectangle');
    await click('flip-h'); await click('flip-h'); await click('flip-v'); await click('flip-v');
    ok((await state()).hash === start.hash, 'flipping twice changed the image');
    // Zoom at the pointer: the image point under it stays put. The Ctrl+wheel event goes
    // straight to the page: how a runner's Chrome turns synthetic wheel input into
    // pinch gestures varies.
    await ed.evaluate(() => document.querySelector('#zoom-label').click());
    await sleep(100);
    const r0 = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const pt = [r0.x + 400, r0.y + 300];
    const under = () => ed.evaluate(([x, y]) => { const r = document.querySelector('#wrap').getBoundingClientRect(); const z = parseFloat(document.querySelector('#zoom-label').textContent) / 100; return [(x - r.left) / z, (y - r.top) / z]; }, pt);
    const a = await under();
    const info = await ed.evaluate(([x, y]) => {
      const stage = document.querySelector('#stage'), wrap = document.querySelector('#wrap');
      const errors = [];
      const onError = (e) => errors.push(e.message);
      addEventListener('error', onError);
      for (let i = 0; i < 3; i++) stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, clientX: x, clientY: y, ctrlKey: true, bubbles: true, cancelable: true }));
      removeEventListener('error', onError);
      const r = wrap.getBoundingClientRect();
      return { zoom: document.querySelector('#zoom-label').textContent, scroll: [stage.scrollLeft, stage.scrollTop], max: [stage.scrollWidth - stage.clientWidth, stage.scrollHeight - stage.clientHeight],
        wrapRect: [Math.round(r.width), Math.round(r.height)], errors,
        animations: wrap.getAnimations().map((x) => x.transitionProperty || x.animationName) };
    }, pt);
    const b = await under();
    ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 3, `point under the pointer moved from ${a.map(Math.round)} to ${b.map(Math.round)} (${JSON.stringify(info)})`);
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close();
  },

  async 'editor: snapping with guides, align and distribute'({ editor }) {
    const ed = await editor();
    await ed.evaluate(() => document.querySelector('#zoom-label').click());
    await sleep(100);
    const w = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const at = (x, y) => [w.x + x, w.y + y];
    const dragFrom = async (from, to, mod) => {
      if (mod) await ed.keyboard.down(mod);
      await ed.mouse.move(...from); await ed.mouse.down(); await ed.mouse.move(...to, { steps: 6 }); await ed.mouse.up();
      if (mod) await ed.keyboard.up(mod);
    };
    const objs = () => ed.evaluate(() => captodeEditor.objects());
    const left = (o) => Math.min(o.x1, o.x2) - o.width / 2;
    await ed.keyboard.press('r');
    await dragFrom(at(100, 100), at(200, 160));
    await dragFrom(at(330, 300), at(430, 360));
    await ed.keyboard.press('v');
    // Drag the second so its left edge is 4 px right of the first's: it snaps into line.
    await dragFrom(at(380, 330), at(380 - 226, 360)); // from the middle (the top edge has a handle)
    let o = await objs();
    ok(Math.abs(left(o[1]) - left(o[0])) < 0.01, `snapped: left edges ${left(o[0])} and ${left(o[1])}`);
    // With Alt held it lands where it was dropped.
    await dragFrom(at(160, 330), at(164, 360), 'Alt');
    o = await objs();
    ok(Math.abs(left(o[1]) - left(o[0]) - 4) < 1, `Alt: left edges ${left(o[0])} and ${left(o[1])}`);
    // A third, then select all and align tops, then space evenly across.
    await ed.keyboard.press('r');
    await dragFrom(at(700, 500), at(760, 540));
    for (const m of ['Control', 'Meta']) { await ed.keyboard.down(m); await ed.keyboard.press('a'); await ed.keyboard.up(m); }
    await ed.evaluate(() => document.querySelector('[data-align="top"]').click());
    o = await objs();
    const tops = o.map((r) => Math.min(r.y1, r.y2));
    ok(Math.max(...tops) - Math.min(...tops) < 0.01, `tops after aligning: ${tops}`);
    await ed.evaluate(() => document.querySelector('[data-align="dist-h"]').click());
    o = (await objs()).map((r) => ({ l: Math.min(r.x1, r.x2) - r.width / 2, r: Math.max(r.x1, r.x2) + r.width / 2 })).sort((a, b) => a.l - b.l);
    const gaps = [o[1].l - o[0].r, o[2].l - o[1].r];
    ok(Math.abs(gaps[0] - gaps[1]) < 0.5, `gaps after spacing: ${gaps}`);
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close();
  },
};
