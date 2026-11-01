// Recording with Chrome's stand-in devices instead of stand-ins written in the test:
// its fake screen, camera and microphone (a moving picture and a beep), asked for the
// way Captode asks for them. Covers the paths that otherwise need a real microphone.
import { open, recordClip, ok, near, sleep, Skip } from './helpers.mjs';

export const launchArgs = ['--use-fake-device-for-media-stream'];

export async function setup({ browser, url }) {
  const ctl = await open(browser, url('lab/lab.html'));
  await ctl.waitForFunction(() => globalThis.lab, { polling: 100 });
  const clip = await recordClip(ctl, { seconds: 4, audio: true });
  const video = await open(browser, url(`video/video.html?id=${clip}`), { width: 1440, height: 900 });
  await video.bringToFront();
  await video.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent), { polling: 100 });
  return { video, clip };
}

/** Starts a voiceover from `at` s, talks for `ms`, and stops it. */
async function voiceover(video, at, ms) {
  await video.evaluate((at) => {
    const p = document.querySelector('#player'); p.pause(); p.currentTime = at;
    document.querySelector('#sound-section').open = true;
  }, at);
  await video.$eval('#vo-rec', (b) => b.scrollIntoView({ block: 'center' }));
  await video.click('#vo-rec');
  await sleep(ms);
  await video.click('#vo-rec');
}

export const tests = {
  async 'a screen recording with the camera and microphone: shared, recorded, saved and opened'({ browser, url }) {
    const p = await open(browser, url('recorder/screen.html?fps=30&audio=0&countdown=0&camera=1&mic=1'), { width: 800, height: 600 });
    try {
      await p.bringToFront();
      await p.click('#choose');
      await p.waitForFunction(() => !document.querySelector('#live').classList.contains('hidden') || !document.querySelector('#err').classList.contains('hidden'), { polling: 100, timeout: 15000 });
      const err = await p.$eval('#err', (e) => (e.classList.contains('hidden') ? '' : e.textContent));
      if (err) throw new Skip(`this Chrome shares no stand-in screen: ${err}`);
      await sleep(2500);
      await Promise.all([p.waitForNavigation({ timeout: 30000 }), p.click('#stop')]);
      ok(p.url().includes('video/video.html?id='), `opened in the video page: ${p.url()}`);
      await p.waitForFunction(() => /fps/.test(document.querySelector('#dims')?.textContent || ''), { polling: 100, timeout: 20000 });
      const r = await p.evaluate(async () => {
        const { getCapture } = await import('/lib/db.js');
        const { meta, blob } = await getCapture(new URLSearchParams(location.search).get('id'));
        const v = document.querySelector('#player');
        return { meta, size: blob.size, w: v.videoWidth, h: v.videoHeight };
      });
      ok(r.meta.camera && r.meta.mic && r.meta.hasAudio, `with the camera and the microphone's sound: ${JSON.stringify(r.meta)}`);
      near(r.meta.duration, 2.5, 1.2, 'as long as recorded');
      ok(r.size > 20000 && r.w > 0 && r.h > 0, `a picture: ${r.w}×${r.h}, ${r.size} bytes`);
      return `${r.w}×${r.h}, ${r.meta.duration.toFixed(1)} s`;
    } finally {
      await p.close();
    }
  },

  async 'a voiceover through the microphone: heard in the file, and the microphone let go'({ video }) {
    await video.evaluate(() => {
      captodeEdits.replace({ ...captodeEdits.get(), cuts: [], layers: [] });
      // Chrome's own microphone, kept hold of only to check it is let go.
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => (window.__mic = await real(c));
      document.querySelector('#player').muted = false;
    });
    await voiceover(video, 0.5, 2200);
    await video.waitForFunction(() => captodeEdits.get().layers.some((l) => l.kind === 'sound'), { timeout: 30000, polling: 200 });
    const r = await video.evaluate(async () => {
      const { getCapture } = await import('/lib/db.js');
      const l = captodeEdits.get().layers.find((x) => x.kind === 'sound');
      const rec = await getCapture(new URLSearchParams(location.search).get('id'));
      const file = rec.layerSources?.[l.src];
      // The loudest moment of what was kept.
      const ac = new OfflineAudioContext(1, 48000, 48000);
      const buf = await ac.decodeAudioData(await file.arrayBuffer());
      let peak = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) for (const v of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
      const b = document.querySelector('#vo-rec');
      return {
        layer: l, seconds: buf.duration, peak,
        released: window.__mic.getTracks().every((t) => t.readyState === 'ended'),
        muted: document.querySelector('#player').muted,
        idle: b.getAttribute('aria-pressed') === 'false' && !b.classList.contains('recording'),
      };
    });
    near(r.layer.from, 0.5, 0.25, 'where the voice started');
    near(r.seconds, 2.2, 0.8, 'about as long as spoken');
    ok(r.peak > 0.02, `the microphone's sound is in it (loudest ${r.peak.toFixed(3)})`);
    ok(r.released, 'the microphone is let go');
    ok(!r.muted && r.idle, `the player's sound and the button are back as they were: ${JSON.stringify({ muted: r.muted, idle: r.idle })}`);
    await video.evaluate(() => captodeEdits.replace({ ...captodeEdits.get(), layers: [] }));
    return `${r.seconds.toFixed(1)} s, loudest ${r.peak.toFixed(2)}`;
  },

  async 'a voiceover with the microphone refused says so, and adds nothing'({ video }) {
    await video.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
    });
    await video.evaluate(() => { document.querySelector('#sound-section').open = true; });
    await video.$eval('#vo-rec', (b) => b.scrollIntoView({ block: 'center' }));
    await video.click('#vo-rec');
    const want = await video.evaluate(() => chrome.i18n.getMessage('vo_no_mic'));
    await video.waitForFunction((w) => document.querySelector('.toast')?.textContent.includes(w), { timeout: 5000, polling: 100 }, want);
    const r = await video.evaluate(() => ({
      layers: captodeEdits.get().layers.length,
      idle: document.querySelector('#vo-rec').getAttribute('aria-pressed') !== 'true',
      paused: document.querySelector('#player').paused,
    }));
    ok(!r.layers && r.idle && r.paused, `nothing added or started: ${JSON.stringify(r)}`);
  },
};
