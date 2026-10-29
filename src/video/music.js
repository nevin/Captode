// Background music on the video page: adding a sound file (made into an Opus WebM
// kept beside the edits, lib/join.js), its settings in the Sound section, and playing
// it with the preview. The export worker mixes it in itself.

import { musicSource } from '../lib/join.js';
import { toast } from '../lib/ui.js';
import { t } from '../lib/i18n.js';

const $ = (s) => document.querySelector(s);

/**
 * ctx: { ed(), editor(), files() (by src), addFile(src, blob), player, busy(),
 *   run(label, fn) (with progress shown), outputTime(t), outputLength(), speakingAt(t) }
 * Returns { now(), url(), gain(m, u, total, speaking), preview(), render() }.
 */
export function mountMusic(ctx) {
  const el = new Audio();
  el.preload = 'auto';
  let url = '', src = '';

  /** The music, when it has its file: the preview's element playing that file. */
  function now() {
    const m = ctx.ed().music;
    const file = m && ctx.files()[m.src];
    if (!file) return null;
    if (src !== m.src) {
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(file);
      el.src = url;
      src = m.src;
    }
    return m;
  }

  /** How loud the music is at output time u (s): its volume, fades, and lowered under speech. */
  function gain(m, u, total, speaking) {
    const fade = Math.min(1, m.fadeIn ? u / m.fadeIn : 1, m.fadeOut ? (total - u) / m.fadeOut : 1);
    return m.volume * Math.max(0, fade) * (m.duck && speaking ? 0.3 : 1);
  }

  /** Keeps the preview's music with the recording as it plays. */
  function preview() {
    const m = now();
    const { player } = ctx;
    if (!m || player.paused || ctx.busy()) { if (!el.paused) el.pause(); return; }
    const u = ctx.outputTime(player.currentTime);
    let pos = u + m.offset;
    const d = el.duration;
    if (Number.isFinite(d) && d > 0) {
      if (m.loop) pos %= d;
      else if (pos >= d) { if (!el.paused) el.pause(); return; }
    }
    if (Math.abs(el.currentTime - pos) > 0.35) el.currentTime = pos;
    el.volume = Math.min(1, gain(m, u, ctx.outputLength(), ctx.speakingAt(player.currentTime)));
    if (el.paused) el.play().catch(() => {});
  }

  // ---------- where the music starts: its waveform ----------

  let wave = null; // { src, peaks, duration }: peaks and duration once the file is read
  async function readWave(m) {
    if (wave?.src === m.src) return;
    wave = { src: m.src, peaks: null, duration: 0 };
    try {
      const buf = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await ctx.files()[m.src].arrayBuffer());
      const data = buf.getChannelData(0), n = 300, step = Math.max(1, Math.floor(data.length / n));
      const peaks = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let p = 0;
        for (let j = i * step, e = Math.min(data.length, j + step); j < e; j += 8) p = Math.max(p, Math.abs(data[j]));
        peaks[i] = p;
      }
      if (wave?.src === m.src) { wave.peaks = peaks; wave.duration = buf.duration; drawWave(); }
    } catch { /* drawn without its shape */ }
  }

  function drawWave() {
    const m = ctx.ed().music;
    const c = $('#music-wave');
    if (!m || !c.clientWidth) return;
    const r = devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * r), H = Math.round(c.clientHeight * r);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    const d = wave?.duration || 0;
    const colour = getComputedStyle(c).color || '#888';
    if (d) {
      // The part the video plays, lit up.
      const a = (m.offset / d) * W, b = Math.min(W, ((m.offset + ctx.outputLength()) / d) * W);
      g.fillStyle = 'rgba(91, 75, 255, 0.25)';
      g.fillRect(a, 0, Math.max(2, b - a), H);
      g.fillStyle = colour;
      const peaks = wave.peaks, bw = W / peaks.length;
      const top = Math.max(...peaks) || 1;
      for (let i = 0; i < peaks.length; i++) {
        const h = Math.max(1, (peaks[i] / top) * (H - 6));
        g.globalAlpha = i * bw >= a && i * bw <= b ? 0.9 : 0.4;
        g.fillRect(i * bw, (H - h) / 2, Math.max(1, bw - 1), h);
      }
      g.globalAlpha = 1;
      g.fillStyle = '#5b4bff';
      g.fillRect(Math.min(W - 2, a), 0, 2 * r, H);
    }
    c.setAttribute('aria-valuemax', String(Math.round(d)));
    c.setAttribute('aria-valuenow', String(Math.round(m.offset * 10) / 10));
    c.setAttribute('aria-valuetext', ctx.fmtTime(m.offset));
  }

  /** Puts the start at `s` seconds into the music. */
  function startAt(s, quiet) {
    const d = wave?.duration || Infinity;
    set({ offset: Math.round(Math.max(0, Math.min(d - 0.5, s)) * 10) / 10 }, quiet);
  }
  const waveEl = $('#music-wave');
  waveEl.addEventListener('pointerdown', (e) => {
    const d = wave?.duration;
    if (!d || ctx.busy()) return;
    waveEl.setPointerCapture(e.pointerId);
    const at = (ev) => { const b = waveEl.getBoundingClientRect(); startAt(((ev.clientX - b.left) / b.width) * d, true); };
    at(e);
    const up = () => { waveEl.removeEventListener('pointermove', at); waveEl.removeEventListener('pointerup', up); waveEl.removeEventListener('pointercancel', up); };
    waveEl.addEventListener('pointermove', at);
    waveEl.addEventListener('pointerup', up);
    waveEl.addEventListener('pointercancel', up);
  });
  waveEl.addEventListener('keydown', (e) => {
    const m = ctx.ed().music;
    const by = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 }[e.key];
    if (!m || (by === undefined && e.key !== 'Home')) return;
    e.preventDefault();
    e.stopPropagation(); // not also a seek
    startAt(e.key === 'Home' ? 0 : m.offset + by * (e.shiftKey ? 5 : 1), true);
  });
  addEventListener('resize', () => drawWave());

  function render() {
    const m = ctx.ed().music;
    $('#music-on').classList.toggle('hidden', !m);
    $('#music-add').classList.toggle('hidden', !!m);
    if (!m) return;
    readWave(m);
    $('#music-offset-v').textContent = ctx.fmtTime(m.offset);
    requestAnimationFrame(drawWave);
    $('#music-name').textContent = m.name || t('music_title');
    $('#music-volume').value = m.volume;
    $('#music-volume-v').textContent = `${Math.round(m.volume * 100)}%`;
    $('#music-fade-in').value = String(m.fadeIn);
    $('#music-fade-out').value = String(m.fadeOut);
    $('#music-duck').checked = m.duck;
    $('#music-loop').checked = m.loop;
  }

  async function add(file) {
    if (ctx.busy() || !ctx.editor()) return;
    if (!(await ctx.hasRoom(file.size * 2))) return;
    try {
      const made = await ctx.run(t('music_preparing'), async (signal, progress) => {
        progress(0.3, t('music_preparing'));
        const m = await musicSource(file);
        const id = `m${Date.now().toString(36)}`;
        await ctx.addFile(id, m.blob);
        return id;
      });
      if (!made) return;
      ctx.editor().setMusic({ src: made, name: file.name.replace(/\.[^.]+$/, '').slice(0, 120), volume: 0.5, fadeIn: 1, fadeOut: 2, duck: true, loop: true, offset: 0 });
      toast(t('music_added'), { kind: 'success' });
    } catch (err) {
      console.warn('Captode: adding music failed:', err);
      toast(t(err?.code === 'unplayable' ? 'music_unplayable' : 'music_failed'), { kind: 'error', ms: 6000 });
    }
  }

  const set = (patch, quiet = false) => ctx.editor()?.setMusic(patch, quiet);
  $('#music-add').addEventListener('click', () => { if (!ctx.busy()) $('#music-file').click(); });
  $('#music-file').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) add(f);
  });
  $('#music-remove').addEventListener('click', () => ctx.editor()?.setMusic(null));
  $('#music-volume').addEventListener('input', (e) => set({ volume: Number(e.target.value) }, true));
  $('#music-fade-in').addEventListener('change', (e) => set({ fadeIn: Number(e.target.value) }));
  $('#music-fade-out').addEventListener('change', (e) => set({ fadeOut: Number(e.target.value) }));
  $('#music-duck').addEventListener('change', (e) => set({ duck: e.target.checked }));
  $('#music-loop').addEventListener('change', (e) => set({ loop: e.target.checked }));

  return { now, url: () => url, gain, preview, render };
}
