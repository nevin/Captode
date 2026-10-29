// A thumbnail on the video page: the frame at the playhead as exported, with a title in
// big letters, saved as a PNG.

const $ = (s) => document.querySelector(s);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * ctx: { player, busy(), plan() → { width, height }, frame(w, h) (the frame as exported),
 *   title(), save(blob, name), exportStem() }
 */
export function mountThumbnail(ctx) {
  let thumbBase = null; // the frame, at up to 1280 px
  function drawThumb() {
    const c = $('#thumb-view');
    if (!thumbBase) return;
    c.width = thumbBase.width;
    c.height = thumbBase.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(thumbBase, 0, 0);
    const text = $('#thumb-text').value.trim();
    if (!text) return;
    const W = c.width, H = c.height;
    const size = Math.round(Math.min(W, H) * Number($('#thumb-size').value) * 1.6);
    ctx.font = `800 ${size}px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    // Words wrapped to the width, at most three lines.
    const words = text.split(/\s+/), lines = [];
    for (const w of words) {
      const last = lines.at(-1);
      if (last && ctx.measureText(`${last} ${w}`).width < W * 0.88) lines[lines.length - 1] = `${last} ${w}`; else lines.push(w);
    }
    const shown = lines.slice(0, 3), lh = size * 1.12;
    const block = shown.length * lh;
    const place = $('#thumb-place').value;
    const top = place === 'top' ? H * 0.06 : place === 'middle' ? (H - block) / 2 : H * 0.94 - block;
    const g = ctx.createLinearGradient(0, top - size * 0.6, 0, top + block + size * 0.6);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.3, 'rgba(0,0,0,0.55)'); g.addColorStop(0.7, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, top - size * 0.6, W, block + size * 1.2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size * 0.12);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.fillStyle = '#fff';
    shown.forEach((l, i) => { ctx.strokeText(l, W / 2, top + i * lh); ctx.fillText(l, W / 2, top + i * lh); });
  }
  $('#thumb-open').addEventListener('click', async () => {
    if (ctx.busy() || !ctx.player.videoWidth) return;
    ctx.player.pause();
    const p = ctx.plan();
    const k = Math.min(1, 1280 / Math.max(p.width, p.height));
    thumbBase = await ctx.frame(even(p.width * k), even(p.height * k));
    if (!$('#thumb-text').value) $('#thumb-text').value = ctx.title();
    drawThumb();
    $('#thumb').showModal();
  });
  for (const id of ['#thumb-text', '#thumb-place', '#thumb-size']) $(id).addEventListener('input', drawThumb);
  $('#thumb').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-close]');
    if (!b) return;
    $('#thumb').close(b.dataset.close);
    if (b.dataset.close !== 'yes') return;
    const blob = await new Promise((r) => $('#thumb-view').toBlob(r, 'image/png'));
    ctx.save(blob, `${await ctx.exportStem()}.thumbnail.png`);
  });
}
