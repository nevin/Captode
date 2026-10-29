// Zooming the video page's timeline: the track grows wider than its view (which clips
// it sideways only, so marks above and below still show) and slides along inside it.

const $ = (s) => document.querySelector(s);

/**
 * ctx: { player, duration() }. Returns { apply(), zoomIn(), zoomOut(), follow() (while
 * playing: keeps the playhead in view) }.
 */
export function mountTimelineZoom(ctx) {
  let tlZoom = 1, tlPan = 0; // how many times wider the track is than its view, and how much of it is off to the left (0–1)
  function applyZoom() {
    tlPan = Math.min(Math.max(0, tlPan), 1 - 1 / tlZoom);
    const tr = $('#track');
    tr.style.width = `${tlZoom * 100}%`;
    tr.style.transform = tlZoom > 1 ? `translateX(${-tlPan * 100}%)` : '';
    $('#tl-out').disabled = tlZoom <= 1;
    $('#tl-in').disabled = tlZoom >= 32;
  }
  /** Zooms to `z`, keeping the moment at `anchor` (a fraction of the view) where it is. */
  function setZoom(z, anchor = null) {
    const old = tlZoom;
    const nz = Math.min(32, Math.max(1, z));
    if (nz === old) return;
    const ph = ctx.duration() ? ctx.player.currentTime / ctx.duration() : 0;
    // By default the playhead stays put (or comes to the middle if out of view).
    let a = anchor;
    if (a === null) { const inView = (ph - tlPan) * old; a = inView >= 0 && inView <= 1 ? inView : 0.5; }
    const at = anchor === null && (ph - tlPan) * old >= 0 && (ph - tlPan) * old <= 1 ? ph : tlPan + a / old;
    tlZoom = nz;
    tlPan = at - a / nz;
    applyZoom();
  }
  $('#tl-in').addEventListener('click', () => setZoom(tlZoom * 2));
  $('#tl-out').addEventListener('click', () => setZoom(tlZoom / 2));
  $('#track-view').addEventListener('wheel', (e) => {
    const r = $('#track-view').getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(tlZoom * (e.deltaY < 0 ? 1.25 : 0.8), (e.clientX - r.left) / r.width);
    } else if (tlZoom > 1 && (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey)) {
      e.preventDefault();
      tlPan += ((e.shiftKey ? e.deltaY : e.deltaX) / r.width) / tlZoom;
      applyZoom();
    }
  }, { passive: false });
  /** While playing zoomed in, the view follows the playhead. */
  function followPlayhead() {
    if (tlZoom <= 1 || !ctx.duration()) return;
    const ph = ctx.player.currentTime / ctx.duration();
    if (ph < tlPan || ph > tlPan + 0.95 / tlZoom) { tlPan = ph - 0.1 / tlZoom; applyZoom(); }
  }

  return { apply: applyZoom, zoomIn: () => setZoom(tlZoom * 2), zoomOut: () => setZoom(tlZoom / 2), follow: followPlayhead };
}
