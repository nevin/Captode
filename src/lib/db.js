// Captures are handed between the service worker, the offscreen recorder and the
// editor pages through IndexedDB, which every extension context shares and which
// holds Blobs far larger than a runtime message comfortably can.

const DB_NAME = 'captode';
const STORE = 'captures';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(result.result ?? result); };
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
    const req = db.transaction(STORE).objectStore(STORE).get(id);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Captures from the last day, newest first: `{ id, kind, meta, created, size, blob }`. */
export async function listCaptures(limit = 12) {
  const db = await open();
  return new Promise((resolve) => {
    const out = [];
    const req = db.transaction(STORE).objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) {
        db.close();
        out.sort((a, b) => b.created - a.created);
        resolve(out.slice(0, limit));
        return;
      }
      const { blob, meta = {}, created = 0 } = c.value;
      if (blob) out.push({ id: c.key, kind: blob.type.startsWith('video/') ? 'video' : 'image', meta, created, size: blob.size, blob });
      c.continue();
    };
    req.onerror = () => { db.close(); resolve(out); };
  });
}

export async function deleteCapture(id) {
  await tx('readwrite', (s) => s.delete(id));
}

// Keep the store from growing forever: captures older than a day are dropped.
async function prune() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const db = await open();
  await new Promise((resolve) => {
    const t = db.transaction(STORE, 'readwrite');
    const req = t.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      if (c.value.created < cutoff) c.delete();
      c.continue();
    };
    t.oncomplete = t.onerror = () => { db.close(); resolve(); };
  });
}
