// Captures are handed between the service worker, the offscreen recorder and the
// editor pages through IndexedDB, which every extension context shares and which
// holds Blobs far larger than a runtime message comfortably can.

const DB_NAME = 'captode';
const STORE = 'captures';
// What changes while a capture is worked on (edits, slides, details added later) is
// kept apart from it, keyed by the same id: writing a record rewrites its Blob too,
// which for a long recording meant hundreds of MB on every save.
const EXTRAS = 'extras';
// A recording is also written here a second at a time while it runs, keyed
// [recording, n], so a crash or a closed browser doesn't lose it (see recoverRecordings).
// [recording, -1] holds its details and when it was last seen running.
const PARTS = 'parts';
// Exports waiting or running in the background (see recorder/exports.js), with their
// results once made.
const JOBS = 'jobs';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(EXTRAS)) db.createObjectStore(EXTRAS);
      if (!db.objectStoreNames.contains(PARTS)) db.createObjectStore(PARTS);
      if (!db.objectStoreNames.contains(JOBS)) db.createObjectStore(JOBS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE, EXTRAS], mode);
    const result = fn(t.objectStore(STORE), t.objectStore(EXTRAS));
    t.oncomplete = () => { db.close(); resolve(result?.result ?? result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

/** A capture with its extras laid over it (older captures kept them in the record itself). */
function merged(rec, extra) {
  if (!rec) return null;
  if (!extra) return rec;
  const { meta, ...rest } = extra;
  return { ...rec, ...rest, meta: { ...(rec.meta || {}), ...(meta || {}) } };
}

/** Changes a capture's extras with `fn(extra)`; nothing happens if the capture is gone. */
async function changeExtras(id, fn) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction([STORE, EXTRAS], 'readwrite');
    const extras = t.objectStore(EXTRAS);
    const has = t.objectStore(STORE).count(id); // answered before `cur`, which is asked after
    const cur = extras.get(id);
    cur.onsuccess = () => {
      if (!has.result) return;
      const extra = { ...(cur.result || {}) };
      fn(extra);
      extras.put(extra, id);
    };
    t.oncomplete = () => { db.close(); resolve(); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Saves `{ blob, meta }` and returns its id. */
export async function putCapture(blob, meta = {}) {
  const id = newId();
  await tx('readwrite', (s) => s.put({ blob, meta, created: Date.now() }, id));
  await prune();
  return id;
}

export async function getCapture(id) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE, EXTRAS]);
    const rec = t.objectStore(STORE).get(id);
    const extra = t.objectStore(EXTRAS).get(id);
    t.oncomplete = () => { db.close(); resolve(merged(rec.result, extra.result)); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

/** Captures from the last day, newest first: `{ id, kind, meta, created, size, blob }`. */
export async function listCaptures(limit = 12) {
  const db = await open();
  return new Promise((resolve) => {
    const out = [];
    const t = db.transaction([STORE, EXTRAS]);
    const extras = new Map();
    const ex = t.objectStore(EXTRAS).openCursor();
    ex.onsuccess = () => {
      const c = ex.result;
      if (c) { extras.set(c.key, c.value); c.continue(); }
    };
    const req = t.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) { out.push([c.key, c.value]); c.continue(); }
    };
    const done = () => {
      db.close();
      const list = out.flatMap(([id, value]) => {
        const { blob, meta = {}, created = 0, edits, kept = false } = merged(value, extras.get(id));
        return blob ? [{ id, kind: blob.type.startsWith('video/') ? 'video' : 'image', meta, created, size: blob.size, blob, kept, edited: !!edits?.objects?.length || !!edits?.base }] : [];
      });
      list.sort((a, b) => b.created - a.created);
      resolve(list.slice(0, limit));
    };
    t.oncomplete = done;
    t.onerror = () => { db.close(); resolve([]); };
  });
}

/**
 * Keeps the editor's work on a capture with it: `{ objects, frame, base, saved }`,
 * where `base` is the edited image (a Blob) if it was cropped or resized, else null.
 * Pass null to drop them.
 */
export const saveEdits = (id, edits) => changeExtras(id, (x) => { x.edits = edits || null; });

/** Keeps a recording's slides with it (see lib/slides.js; their pictures are Blobs). */
export const saveSlides = (id, slides) => changeExtras(id, (x) => { x.slides = slides; });

/** Adds `patch` to a capture's details. */
export const updateMeta = (id, patch) => changeExtras(id, (x) => { x.meta = { ...(x.meta || {}), ...patch }; });

/** Keeps a recording's step-by-step guide with it: `{ title, steps: [{ t, x, y, text }] }`. */
export const saveGuide = (id, guide) => changeExtras(id, (x) => { x.guide = guide; });

/** Keeps a capture until it is removed (true), or lets it go after a day as usual (false). */
export const setKept = (id, kept) => changeExtras(id, (x) => { x.kept = !!kept; });

/** Puts a capture's extras (edits, slides, guide…) in place, as a project file had them. */
export const putExtras = (id, extras) => changeExtras(id, (x) => { Object.assign(x, extras); });

/** Keeps a recording's edits with it (see lib/video-edits.js). */
export const saveVideoEdits = (id, videoEdits) => changeExtras(id, (x) => { x.videoEdits = videoEdits; });

/** Keeps the part of a recording chosen to keep: `{ start, end }` (s), or null for all of it. */
export const saveTrim = (id, trim) => changeExtras(id, (x) => { x.trim = trim; });

/** Deletes a capture. Resolves to the record, which `restoreCapture` can put back. */
export async function deleteCapture(id) {
  const rec = await getCapture(id);
  await tx('readwrite', (s, x) => { s.delete(id); x.delete(id); });
  return rec;
}

/** Puts back a capture removed with `deleteCapture`, under its old id. */
export async function restoreCapture(id, rec) {
  if (rec) await tx('readwrite', (s, x) => { s.put(rec, id); x.delete(id); });
}

const DAY = 24 * 60 * 60 * 1000;
export const KEEP_FOR = [1, 7, 30, 0]; // days captures not kept stay (Settings); 0: until removed

/** Settings → "Remove captures not kept after", in days; null where settings can't be read. */
async function keepDays() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const d = Number(settings?.keepFor ?? 1);
    return KEEP_FOR.includes(d) ? d : 1;
  } catch { return null; }
}

// Keep the store from growing forever: captures older than the time chosen in Settings
// (a day at first) are dropped, with their extras (and any extras left without a
// capture), unless they were kept. Where the setting can't be read, none are dropped.
async function prune() {
  const days = await keepDays();
  const cutoff = days ? Date.now() - days * DAY : -Infinity;
  const jobCutoff = Date.now() - DAY;
  const db = await open();
  await new Promise((resolve) => {
    const t = db.transaction([STORE, EXTRAS, JOBS], 'readwrite');
    const captures = t.objectStore(STORE), extras = t.objectStore(EXTRAS);
    // Exports from the background queue go after a day too.
    const jobs = t.objectStore(JOBS).openCursor();
    jobs.onsuccess = () => {
      const c = jobs.result;
      if (!c) return;
      if ((c.value.created || 0) < jobCutoff && c.value.status !== 'running') c.delete();
      c.continue();
    };
    // First the captures that were kept, then the old ones that weren't, then extras
    // left without a capture.
    const pinned = new Set();
    const left = new Set();
    const pins = extras.openCursor();
    pins.onsuccess = () => {
      const c = pins.result;
      if (c) { if (c.value?.kept) pinned.add(c.key); c.continue(); return; }
      const req = captures.openCursor();
      req.onsuccess = () => {
        const d = req.result;
        if (d) {
          if (d.value.created < cutoff && !pinned.has(d.key)) d.delete(); else left.add(d.key);
          d.continue();
          return;
        }
        const ex = extras.openKeyCursor();
        ex.onsuccess = () => {
          const e = ex.result;
          if (!e) return;
          if (!left.has(e.primaryKey)) extras.delete(e.primaryKey);
          e.continue();
        };
      };
    };
    t.oncomplete = t.onerror = () => { db.close(); resolve(); };
  });
}

// ---------- recordings in progress ----------

async function parts(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(PARTS, mode);
    const result = fn(t.objectStore(PARTS));
    t.oncomplete = () => { db.close(); resolve(result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

const allOf = (rec) => IDBKeyRange.bound([rec, -1], [rec, Infinity]);

/** Keeps the `n`th piece of recording `rec` (a Blob), and its details so far (see recordingAlive). */
export const savePart = (rec, n, blob, info) => parts('readwrite', (s) => {
  s.put(blob, [rec, n]);
  if (info) s.put({ ...info, seen: Date.now() }, [rec, -1]);
});

/** Notes that recording `rec` is still running, with the details it will be saved with. */
export const recordingAlive = (rec, info) => parts('readwrite', (s) => { s.put({ ...info, seen: Date.now() }, [rec, -1]); });

/** Forgets recording `rec`'s pieces (once it is saved, or discarded). */
export const dropParts = (rec) => parts('readwrite', (s) => { s.delete(allOf(rec)); });

/**
 * Saves recordings that stopped without being saved (the browser closed or crashed,
 * or the recorder's page was closed): their pieces become a capture, marked
 * `recovered`. Recordings seen running in the last `quietFor` ms are left alone.
 * Resolves to the new captures' ids.
 */
export async function recoverRecordings(quietFor = 15000) {
  const found = new Map(); // rec → { info, blobs }
  await parts('readonly', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const [rec, n] = c.key;
      if (!found.has(rec)) found.set(rec, { info: null, blobs: [] });
      if (n < 0) found.get(rec).info = c.value; else found.get(rec).blobs.push(c.value);
      c.continue();
    };
  });
  const ids = [];
  for (const [rec, { info, blobs }] of found) {
    if (Date.now() - (info?.seen || 0) < quietFor) continue;
    const { seen, ...meta } = info || {};
    if (blobs.length) {
      const blob = new Blob(blobs, { type: meta.mime || blobs[0].type || 'video/webm' });
      ids.push(await putCapture(blob, { ...meta, mime: blob.type, recovered: true }));
    }
    await dropParts(rec);
  }
  return ids;
}

// ---------- exports in the background ----------

async function jobsTx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(JOBS, mode);
    const result = fn(t.objectStore(JOBS));
    t.oncomplete = () => { db.close(); resolve(result?.result ?? result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

/**
 * Adds an export to the queue: `{ capture, name, format, job }` (job as the export
 * worker takes it, without the recording). Resolves to its id.
 */
export async function addJob(job) {
  const id = newId();
  await jobsTx('readwrite', (s) => s.put({ ...job, id, status: 'queued', progress: 0, created: Date.now() }, id));
  return id;
}

export const getJob = (id) => jobsTx('readonly', (s) => s.get(id));

/** Every export in the queue, oldest first. */
export async function listJobs() {
  const all = await jobsTx('readonly', (s) => s.getAll());
  return (all || []).sort((a, b) => a.created - b.created);
}

/** Changes an export with `fn(job)`; nothing happens if it was removed. Resolves to the job. */
export async function changeJob(id, fn) {
  let out = null;
  await jobsTx('readwrite', (s) => {
    const req = s.get(id);
    req.onsuccess = () => {
      if (!req.result) return;
      out = req.result;
      fn(out);
      s.put(out, id);
    };
  });
  return out;
}

export const removeJob = (id) => jobsTx('readwrite', (s) => { s.delete(id); });
