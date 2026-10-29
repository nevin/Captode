// Chapters on the video page: the list in the Chapters section, their marks on the
// timeline, and the list as exported (MP4 and WebM get it from the job), for YouTube or
// as a WebVTT file.

import { toast } from '../lib/ui.js';
import { t } from '../lib/i18n.js';

const $ = (s) => document.querySelector(s);

/**
 * ctx: { ed(), editor(), clip(), player, duration(), busy(), outputTime(t), outputLength(),
 *   fmtTime(s), save(blob, name), exportStem() }
 * Returns { list() (as exported: [{ at, title }]), render() }.
 */
export function mountChapters(ctx) {
  const ytTime = (s) => {
    const x = Math.max(0, Math.floor(s)), h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), sec = String(x % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  /** The chapters in the export: [{ at (output s), title }], from 0:00 (YouTube needs one there). */
  function chapterList() {
    const map = ctx.clip();
    const list = ctx.ed().chapters
      .filter((c) => map.partAt(c.at) || map.parts.some((p) => Math.abs(p.from - c.at) < 0.05))
      .map((c) => ({ at: Math.round(ctx.outputTime(c.at) * 1000) / 1000, title: c.title.trim() || t('chapters_untitled') }));
    if (!list.length) return [];
    if (list[0].at > 0.5) list.unshift({ at: 0, title: t('chapters_start') });
    else list[0].at = 0;
    return list;
  }
  let chapterKey = '';
  function renderChapters() {
    const list = ctx.ed().chapters;
    $('#chapter-count').textContent = list.length ? String(list.length) : '';
    $('#chapter-files').classList.toggle('hidden', !list.length);
    // Marks on the timeline.
    let marks = $('#chapter-marks');
    if (!marks) { marks = document.createElement('div'); marks.id = 'chapter-marks'; marks.className = 'clip-marks'; $('#track').append(marks); }
    marks.replaceChildren(...list.map((c) => { const m = document.createElement('div'); m.className = 'chapter-mark'; m.style.left = `${(c.at / (ctx.duration() || 1)) * 100}%`; return m; }));
    // The list: not rebuilt while a name is being typed.
    const key = JSON.stringify(list.map((c) => [c.id, c.at]));
    const typing = document.activeElement?.closest?.('#chapter-list');
    if (key === chapterKey && typing) return;
    chapterKey = key;
    const el = $('#chapter-list');
    el.replaceChildren(...list.map((c) => {
      const row = document.createElement('div');
      row.className = 'chapter-item';
      row.dataset.id = c.id;
      row.innerHTML = `<span class="tc" data-go title="${t('chapters_go')}"></span><input type="text" maxlength="100" aria-label="${t('chapters_name')}"><button type="button" class="btn ghost icon" data-del aria-label="${t('edit_delete')}" title="${t('edit_delete')}"><svg class="i" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;
      row.querySelector('.tc').textContent = ctx.fmtTime(c.at);
      row.querySelector('input').value = c.title;
      return row;
    }));
  }
  $('#chapter-add').addEventListener('click', () => {
    if (!ctx.editor() || ctx.busy()) return;
    const at = Math.round(ctx.player.currentTime * 1000) / 1000;
    const list = [...ctx.ed().chapters.filter((c) => Math.abs(c.at - at) > 0.05), { id: `h${Date.now().toString(36)}`, at, title: t('chapters_default', String(ctx.ed().chapters.length + 1)) }].sort((a, b) => a.at - b.at);
    ctx.editor().setChapters(list);
    $('#chapters-section').open = true;
    requestAnimationFrame(() => $(`#chapter-list [data-id="${list.find((c) => c.at === at).id}"] input`)?.select());
  });
  $('#chapter-list').addEventListener('input', (e) => {
    const id = e.target.closest('.chapter-item')?.dataset.id;
    if (!id || e.target.tagName !== 'INPUT') return;
    ctx.editor().setChapters(ctx.ed().chapters.map((c) => (c.id === id ? { ...c, title: e.target.value } : c)), true);
  });
  $('#chapter-list').addEventListener('click', (e) => {
    const id = e.target.closest('.chapter-item')?.dataset.id;
    if (!id) return;
    const c = ctx.ed().chapters.find((x) => x.id === id);
    if (e.target.closest('[data-del]')) ctx.editor().setChapters(ctx.ed().chapters.filter((x) => x.id !== id));
    else if (e.target.closest('[data-go]') && c) ctx.player.currentTime = c.at;
  });
  $('#chapter-copy').addEventListener('click', async () => {
    const text = chapterList().map((c) => `${ytTime(c.at)} ${c.title}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast(t('chapters_copied'), { kind: 'success' });
    } catch {
      toast(t('chapters_copy_failed'), { kind: 'error' });
    }
  });
  $('#chapter-vtt').addEventListener('click', async () => {
    const list = chapterList();
    const total = ctx.outputLength();
    const ts = (s) => { const ms = Math.round(s * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
    const vtt = `WEBVTT\n\n${list.map((c, i) => `${i + 1}\n${ts(c.at)} --> ${ts(list[i + 1]?.at ?? total)}\n${c.title}\n`).join('\n')}`;
    ctx.save(new Blob([vtt], { type: 'text/vtt' }), `${await ctx.exportStem()}.chapters.vtt`);
  });

  return { list: chapterList, render: renderChapters };
}
