// Exports queued from the video page, finished here in the offscreen document so they
// carry on after that page is closed. One at a time, oldest first, each with the same
// worker the video page uses; progress and results go to IndexedDB (lib/db.js), and
// pages and the service worker hear of them by message.
import { listJobs, changeJob, getCapture } from '../lib/db.js';

let running = null; // { id, worker }
let waking = null;

const tell = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

/** Runs what is queued, one export after another; says when the queue is empty. */
function wake() {
  waking ||= (async () => {
    try {
      while (!running) {
        const job = (await listJobs()).find((j) => j.status === 'queued');
        if (!job) { tell({ type: 'exports-idle' }); return; }
        await run(job);
      }
    } finally {
      waking = null;
    }
  })();
  return waking;
}

async function run(job) {
  const rec = await getCapture(job.capture);
  if (!rec?.blob) {
    await changeJob(job.id, (j) => { j.status = 'failed'; j.error = 'gone'; });
    tell({ type: 'export-done', id: job.id });
    return;
  }
  await changeJob(job.id, (j) => { j.status = 'running'; j.started = Date.now(); });
  await new Promise((resolve) => {
    const worker = new Worker(new URL('../video/export-worker.js', import.meta.url), { type: 'module' });
    running = { id: job.id, worker };
    let last = 0;
    const end = async (patch) => {
      worker.terminate();
      running = null;
      await changeJob(job.id, (j) => Object.assign(j, patch, { finished: Date.now() }));
      tell({ type: 'export-done', id: job.id });
      resolve();
    };
    running.cancel = () => { worker.terminate(); running = null; resolve(); };
    worker.onmessage = async ({ data }) => {
      if (data.type === 'preview') { data.bitmap.close(); return; }
      if (data.type === 'progress') {
        const now = performance.now();
        if (now - last < 400) return;
        last = now;
        // Removed meanwhile: stop.
        const still = await changeJob(job.id, (j) => { j.progress = data.f; j.what = data.what; });
        if (!still) { running?.cancel(); return; }
        tell({ type: 'export-progress', id: job.id, f: data.f, what: data.what });
      } else if (data.type === 'done') {
        await end({ status: 'done', progress: 1, result: data.blob, size: data.blob.size });
      } else if (data.type === 'error') {
        await end({ status: 'failed', error: data.message, fallback: !!data.fallback });
      }
    };
    worker.onerror = (e) => end({ status: 'failed', error: e.message || 'stopped', fallback: true });
    worker.postMessage({ type: 'start', job: { ...job.job, blob: rec.blob } });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'exports') return;
  if (msg.type === 'busy') { sendResponse({ busy: !!running || !!waking }); return; }
  if (msg.type === 'run') { wake(); sendResponse({ ok: true }); return; }
  if (msg.type === 'cancel' && running?.id === msg.id) { running.cancel(); wake(); sendResponse({ ok: true }); }
});

// This document was just opened: anything marked running was cut off (the browser
// closed); run it again.
(async () => {
  for (const j of await listJobs()) if (j.status === 'running') await changeJob(j.id, (x) => { x.status = 'queued'; x.progress = 0; });
  wake();
})();
