// The export queue as pages show it: exports added from the video page run in the
// background (recorder/exports.js) and are listed, with their progress, in the video
// page and the popup until downloaded and removed (or a day has passed).
import { addJob, listJobs, removeJob } from './db.js';
import { t } from './i18n.js';
import { fmtBytes, toast, canShareFiles, shareFile } from './ui.js';
import { downloadBlob } from './keep.js';

/** Queues `{ capture, name, format, job }` and starts the queue. Resolves to its id. */
export async function queueExport(entry) {
  const id = await addJob(entry);
  const res = await chrome.runtime.sendMessage({ type: 'export-queued' }).catch((e) => ({ ok: false, error: e.message }));
  if (!res?.ok) throw new Error(res?.error || 'queue');
  return id;
}

const ICON_DL = '<svg class="i" viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg>';
const ICON_SHARE = '<svg class="i" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>';
const ICON_X = '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';

const status = (j) => {
  if (j.status === 'queued') return t('queue_waiting');
  if (j.status === 'running') return t('queue_running', String(Math.round((j.progress || 0) * 100)));
  if (j.status === 'done') return t('queue_ready', fmtBytes(j.size || 0));
  return j.fallback ? t('queue_failed_here') : t('queue_failed', String(j.error || ''));
};

/**
 * Shows the queue in `list` (an element), only `capture`'s exports if given, and keeps
 * it up to date. `onEmpty(empty)` is told whether there is anything to show.
 */
export function mountJobs(list, { capture = null, onEmpty = () => {} } = {}) {
  let drawing = null;
  const draw = async () => {
    const jobs = (await listJobs()).filter((j) => !capture || j.capture === capture);
    list.textContent = '';
    onEmpty(!jobs.length);
    for (const j of jobs) {
      const li = document.createElement('li');
      li.className = `job ${j.status}`;
      li.dataset.id = j.id;
      li.innerHTML = `<div class="job-what"><b></b><small class="job-status"></small><progress max="1"></progress></div><div class="job-actions"></div>`;
      li.querySelector('b').textContent = j.name;
      li.querySelector('.job-status').textContent = status(j);
      const bar = li.querySelector('progress');
      bar.value = j.progress || 0;
      bar.classList.toggle('hidden', j.status !== 'running');
      const actions = li.querySelector('.job-actions');
      const button = (icon, label, run) => {
        const b = document.createElement('button');
        b.className = 'btn ghost icon';
        b.innerHTML = icon;
        b.dataset.tip = label;
        b.setAttribute('aria-label', `${label}: ${j.name}`);
        b.addEventListener('click', run);
        actions.append(b);
      };
      if (j.status === 'done' && j.result) {
        button(ICON_DL, t('editor_download'), () => {
          downloadBlob(j.result, j.name);
          toast(t('saved_file_size', [j.name, fmtBytes(j.result.size)]), { kind: 'success' });
        });
        if (canShareFiles) button(ICON_SHARE, t('share_file'), () => shareFile(j.result, j.name).catch((e) => toast(t('share_file_failed', e.message), { kind: 'error' })));
      }
      button(ICON_X, j.status === 'running' || j.status === 'queued' ? t('queue_cancel') : t('remove'), async () => {
        await removeJob(j.id);
        if (j.status === 'running') chrome.runtime.sendMessage({ target: 'exports', type: 'cancel', id: j.id }).catch(() => {});
        refresh();
      });
      list.append(li);
    }
  };
  const refresh = () => { drawing = (drawing || Promise.resolve()).then(draw).catch(() => {}); return drawing; };
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'export-progress') {
      const li = list.querySelector(`[data-id="${msg.id}"]`);
      if (!li) return refresh();
      li.className = 'job running';
      li.querySelector('progress').classList.remove('hidden');
      li.querySelector('progress').value = msg.f;
      li.querySelector('.job-status').textContent = t('queue_running', String(Math.round(msg.f * 100)));
    } else if (msg.type === 'export-done') refresh();
  });
  refresh();
  return { refresh };
}
