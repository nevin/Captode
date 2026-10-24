// Captures are handed between the service worker, the offscreen recorder and the
// editor pages through IndexedDB, which every extension context shares and which
// holds Blobs far larger than a runtime message comfortably can.

const DB_NAME = 'captode';
const STORE = 'captures';
// What changes while a capture is worked on (edits, slides, details added later) is
// kept apart from it, keyed by the same id: writing a record rewrites its Blob too,
// which for a long recording meant hundreds of MB on every save.
const EXTRAS = 'extras';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(EXTRAS)) db.createObjectStore(EXTRAS);
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
        const { blob, meta = {}, created = 0, edits } = merged(value, extras.get(id));
        return blob ? [{ id, kind: blob.type.startsWith('video/') ? 'video' : 'image', meta, created, size: blob.size, blob, edited: !!edits?.objects?.length || !!edits?.base }] : [];
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

/** Keeps a recording's edits with it (see lib/video-edits.js). */
export const saveVideoEdits = (id, videoEdits) => changeExtras(id, (x) => { x.videoEdits = videoEdits; });

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

// Keep the store from growing forever: captures older than a day are dropped, with
// their extras (and any extras left without a capture).
async function prune() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const db = await open();
  await new Promise((resolve) => {
    const t = db.transaction([STORE, EXTRAS], 'readwrite');
    const kept = new Set();
    const req = t.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) {
        const ex = t.objectStore(EXTRAS).openKeyCursor();
        ex.onsuccess = () => {
          const e = ex.result;
          if (!e) return;
          if (!kept.has(e.primaryKey)) t.objectStore(EXTRAS).delete(e.primaryKey);
          e.continue();
        };
        return;
      }
      if (c.value.created < cutoff) c.delete(); else kept.add(c.key);
      c.continue();
    };
    t.oncomplete = t.onerror = () => { db.close(); resolve(); };
  });
}
