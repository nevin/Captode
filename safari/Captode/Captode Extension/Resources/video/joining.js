// Video layers and joined clips on the video page: a file laid over the picture, and
// the recording rebuilt when clips are joined, moved or removed (with Undo). State is
// shared through S (state.js).

import { replaceBlob, putExtras, updateMeta } from '../lib/db.js';
import { toast } from '../lib/ui.js';
import { t } from '../lib/i18n.js';
import { layerPlayback } from './layer-play.js';
import { joinPieces, moveTimes, layerSource } from '../lib/join.js';
import { editId } from '../lib/video-edits.js';
import { S, $, player, captureId, ed, trim } from './state.js';
import { progress, markRunning, markDone, roomFor, startWork, endWork } from './export.js';
import { renderStorage } from './video.js';

// ---------- video layers ----------

export const { layerVideos } = layerPlayback({ files: () => S.layerFiles, redraw: () => { if (S.fx) S.fx.at = -1; } });
export const previewLayers = layerVideos();

/** Lays [from, from + len) of `blob` over the picture from the playhead: kept with the recording, then a layer in the edits. */
export async function addLayer(blob, { from = 0, len = null } = {}) {
  if (S.busy || !S.source || !S.editor) return;
  if (!(await roomFor(blob.size)) || S.busy) return;
  startWork(t('vlayer_preparing'));
  let made = null;
  try {
    const fps = Math.round(Math.min(60, Math.max(15, Number(S.meta.fps) || 30)));
    made = await layerSource(blob, { from, len, fps, signal: S.joinAbort.signal, onProgress: (f) => progress(f) });
    const src = `v${Date.now().toString(36)}`;
    S.layerFiles = { ...S.layerFiles, [src]: made.blob };
    await putExtras(captureId, { layerSources: S.layerFiles });
    made.src = src;
  } catch (err) {
    made = null;
    if (err?.code !== 'cancelled') {
      console.warn('Captode: adding a video layer failed:', err);
      toast(t({ unplayable: 'clips_unplayable', unsupported: 'clips_unsupported' }[err?.code] || 'vlayer_failed'), { kind: 'error', ms: 6000 });
    }
  } finally {
    endWork();
  }
  if (made) {
    $('#edit-section').open = true;
    const added = S.editor.add('layers', { kind: 'video', src: made.src, offset: made.offset, pos: 'br', size: 0.3, shape: 'rect', aspect: made.width / made.height, sound: !!made.sound, volume: made.sound ? 1 : 0, len: Math.min(made.len, Math.max(0.5, S.duration - player.currentTime)) });
    if (added) toast(t('vlayer_added'), { kind: 'success' });
  }
}

// ---------- joined clips ----------

/** Puts the recording back as it was before clips last changed. */
export async function undoJoin() {
  const u = S.undoData;
  if (!u?.blob || S.busy) return;
  S.busy = true;
  S.leaving = true;
  try {
    await replaceBlob(captureId, u.blob);
    await putExtras(captureId, { videoEdits: u.videoEdits, slides: u.slides, trim: u.trim, clips: u.clips, undoJoin: null });
    await updateMeta(captureId, { duration: u.duration, ...(u.clicks ? { clicks: u.clicks } : {}), ...(u.moves ? { moves: u.moves } : {}) });
    try { sessionStorage.setItem('captode-clips', 'clips_undone'); } catch { /* the note is only a nicety */ }
    location.reload();
  } catch (err) {
    console.warn('Captode: undoing clips failed:', err);
    S.leaving = false;
    S.busy = false;
    toast(t('clips_failed'), { kind: 'error' });
  }
}

/** Lays a picture over the video from the playhead, for 5 s. */
export async function addImage(blob, name = '') {
  if (S.busy || !S.editor) return;
  if (!(await roomFor(blob.size))) return;
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch { toast(t('clips_unplayable'), { kind: 'error' }); return; }
  const src = `i${Date.now().toString(36)}`;
  S.layerFiles = { ...S.layerFiles, [src]: blob };
  await putExtras(captureId, { layerSources: S.layerFiles }).catch(() => {});
  $('#edit-section').open = true;
  const added = S.editor.add('layers', { kind: 'image', src, offset: 0, pos: 'tr', size: 0.25, shape: 'rect', aspect: bmp.width / bmp.height, len: Math.min(5, Math.max(0.5, S.duration - player.currentTime)) });
  bmp.close();
  if (added) toast(t('vlayer_picture_added', name || t('vlayer_picture')), { kind: 'success' });
  renderStorage();
}

/**
 * Joins the clips' pieces into a new recording in place of this one, moves the
 * edits, slides and clicks along with their clips, and opens it again.
 */
export async function rebuild({ pieces, moves, clips: list }, done) {
  if (S.busy || !S.source) return;
  // The joined recording, beside the one kept to undo this.
  if (!(await roomFor([...new Set(pieces.map((p) => p.blob))].reduce((n, b) => n + b.size, 0)))) return;
  if (S.busy) return;
  const runAt = markRunning('join');
  startWork(t('clips_joining'));
  try {
    const fps = Math.round(Math.min(60, Math.max(15, Number(S.meta.fps) || 30)));
    const { blob, lostSound } = await joinPieces(pieces, { fps, signal: S.joinAbort.signal, onProgress: (f) => progress(f) });
    const e = JSON.parse(JSON.stringify(ed()));
    // What the trim leaves out becomes cuts, so it stays out wherever it moves.
    const { start, end } = trim();
    if (start > 0.05) e.cuts.push({ id: editId(), from: 0, to: start });
    if (end < S.duration - 0.05) e.cuts.push({ id: editId(), from: end, to: S.duration });
    const moved = moveTimes({ edits: e, slides: S.slides.all().map((s) => ({ ...s })), clicks: S.meta.clicks || [] }, moves);
    const movedPointer = S.meta.moves?.length ? moveTimes({ clicks: S.meta.moves }, moves).clicks : null;
    S.leaving = true;
    // The recording as it was, to undo this (one step; it goes when clips change again).
    const now = trim();
    await putExtras(captureId, {
      undoJoin: {
        blob: S.source, videoEdits: JSON.parse(JSON.stringify(ed())), slides: S.slides.all().map((s) => ({ ...s })),
        trim: now.start > 0.05 || now.end < S.duration - 0.05 ? now : null, clips: S.clips.all().map(({ id, name, len, trans }) => ({ id, name, len, ...(trans ? { trans } : {}) })),
        clicks: S.meta.clicks || null, moves: S.meta.moves || null, duration: S.duration, at: runAt,
      },
    });
    await replaceBlob(captureId, blob);
    await putExtras(captureId, { videoEdits: moved.edits, slides: moved.slides, trim: null, clips: list });
    await updateMeta(captureId, { duration: list.reduce((n, c) => n + c.len, 0), ...(S.meta.clicks ? { clicks: moved.clicks } : {}), ...(movedPointer ? { moves: movedPointer } : {}) });
    try { sessionStorage.setItem('captode-clips', lostSound ? 'clips_sound_lost' : done); } catch { /* the note is only a nicety */ }
    location.reload();
  } catch (err) {
    S.leaving = false;
    markDone();
    if (err?.code !== 'cancelled') {
      console.warn('Captode: joining clips failed:', err);
      toast(t({ unplayable: 'clips_unplayable', unsupported: 'clips_unsupported' }[err?.code] || 'clips_failed'), { kind: 'error', ms: 6000 });
    }
  } finally {
    if (S.leaving) S.joinAbort = null; // the page opens again: busy until then
    else endWork();
  }
}
