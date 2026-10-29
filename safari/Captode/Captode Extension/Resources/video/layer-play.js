// The video page's layers as they play: hidden videos for video layers, kept in step
// with the recording or moved to a frame, and the pictures of image and text layers;
// all drawn over the preview or an in-page export. The export worker has its own.

import { layersAt, layerTime, drawLayer, layerAlpha, textArt } from '../lib/video-edits.js';
import { once } from '../lib/util.js';

async function seek(v, t) {
  if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return;
  const done = once(v, 'seeked');
  v.currentTime = t;
  await done;
}
/** Removes a work video and lets go of its decoder now. */
function dropVideo(v) {
  v.remove();
  v.removeAttribute('src');
  v.load();
}

/**
 * `files()`: the layers' files by src; `redraw()`: a picture finished loading.
 * Returns { stillArt, layerVideos }.
 */
export function layerPlayback({ files, redraw }) {
  /**
   * Hidden videos playing the layers' files, one for each layer: kept in step with
   * the recording as it plays (`sync`), or moved to a frame (`seekAll`), then drawn.
   * Their sound plays at each layer's volume (silent where the recording is sped up);
   * with `connect(video)` (which returns a gain node), through that instead.
   */
  const stills = new Map(); // a picture layer's src → its ImageBitmap, 'loading' or null
  /** The picture of an image or text layer, or null while it loads. */
  function stillArt(l) {
    if (l.kind === 'text') return textArt(l).canvas;
    const s = stills.get(l.src);
    if (s === undefined && files()[l.src]) {
      stills.set(l.src, 'loading');
      createImageBitmap(files()[l.src]).then((b) => { stills.set(l.src, b); redraw(); }, () => stills.set(l.src, null));
    }
    return s && s !== 'loading' ? s : null;
  }
  async function stillReady(l) {
    for (let i = 0; i < 250 && l.kind === 'image' && (stills.get(l.src) === undefined || stills.get(l.src) === 'loading'); i++) {
      stillArt(l);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function layerVideos({ connect = null } = {}) {
    const gains = new Map(); // layer id → gain node, with `connect`
    const els = new Map(); // layer id → video
    const urls = new Map(); // src → object URL
    const get = (l) => {
      const file = files()[l.src];
      if (!file) return null;
      let v = els.get(l.id);
      if (!v) {
        if (!urls.has(l.src)) urls.set(l.src, URL.createObjectURL(file));
        v = document.createElement('video');
        v.className = 'work';
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.src = urls.get(l.src);
        document.body.appendChild(v);
        els.set(l.id, v);
        if (connect) {
          try { gains.set(l.id, connect(v)); v.muted = false; } catch { /* stays silent */ }
        }
      }
      return v;
    };
    /** How loud a layer plays now. */
    const loud = (l, v, playing, rate, t) => {
      const g = playing && rate === 1 && l.sound ? l.volume * layerAlpha(l, t, true) : 0;
      const node = gains.get(l.id);
      if (node) { node.gain.value = g; return; }
      v.muted = g <= 0;
      if (g > 0) v.volume = Math.min(1, g);
    };
    const showing = (l, v, t) => v.readyState >= 1 && layerTime(l, t) < v.duration;
    return {
      /** Each layer on screen at recording time t playing along at `rate`, or paused at its frame; the rest paused. */
      sync(e, t, playing, rate = 1) {
        const on = new Set();
        for (const l of layersAt(e, t)) {
          if ((l.kind === 'image' || l.kind === 'text')) continue;
          const v = get(l);
          if (!v || !showing(l, v, t)) continue;
          on.add(v);
          loud(l, v, playing, rate, t);
          const at = layerTime(l, t);
          if (playing) {
            if (v.playbackRate !== rate) v.playbackRate = rate;
            if (Math.abs(v.currentTime - at) > 0.3 && !v.seeking) v.currentTime = at;
            if (v.paused) v.play().catch(() => {});
          } else {
            if (!v.paused) v.pause();
            if (Math.abs(v.currentTime - at) > 0.02 && !v.seeking) v.currentTime = at;
          }
        }
        for (const [id, v] of els) {
          if (on.has(v)) continue;
          if (!v.paused) v.pause();
          if (gains.has(id)) gains.get(id).gain.value = 0;
        }
      },
      /** Moves each layer on screen at t to its frame then. */
      async seekAll(e, t) {
        for (const l of layersAt(e, t)) {
          if ((l.kind === 'image' || l.kind === 'text')) { await stillReady(l); continue; }
          const v = get(l);
          if (!v) continue;
          if (v.readyState < 1) await once(v, 'loadedmetadata');
          if (showing(l, v, t)) await seek(v, layerTime(l, t));
        }
      },
      draw(ctx, e, t, W, H) {
        for (const l of layersAt(e, t)) {
          if (l.kind === 'sound') continue; // a voiceover: only heard
          if ((l.kind === 'image' || l.kind === 'text')) {
            const art = stillArt(l);
            if (art) drawLayer(ctx, l, art, W, H, t);
            continue;
          }
          const v = get(l);
          if (v && v.readyState >= 2 && showing(l, v, t)) drawLayer(ctx, l, v, W, H, t);
        }
      },
      /** What is showing now, to tell when a layer's frame has changed. */
      stamp: (e, t) => layersAt(e, t).map((l) => { const v = els.get(l.id); return v ? `${v.currentTime}:${v.readyState}` : ''; }).join(),
      close() {
        for (const v of els.values()) dropVideo(v);
        for (const u of urls.values()) URL.revokeObjectURL(u);
        els.clear();
        urls.clear();
      },
    };
  }

  return { stillArt, layerVideos };
}
