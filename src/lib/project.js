// Captode project files (.captode): a capture with everything made for it (the
// editor's annotations, a recording's edits, slides, guide and captions) in one file,
// to keep it past a day, back it up, or move it to another computer or browser.
//
// The file is a zip of stored files:
//   project.json   { format: 'captode-project', version, app, capture }
//   files/0, …     the capture's Blobs (the image or recording, pictures in slides…)
// where `capture` is the capture's record with each Blob as { $blob: n, type }.

import { zipBlobs, unzip } from './zip.js';
import { getCapture, putCapture, putExtras } from './db.js';

export const PROJECT_EXT = 'captode';
const FORMAT = 'captode-project';
const VERSION = 1; // raised when the layout changes; older files are read by upgrade()

/** `value` as JSON, its Blobs set aside in `files`. */
function pack(value, files) {
  if (value instanceof Blob) {
    files.push(value);
    return { $blob: files.length - 1, type: value.type };
  }
  if (Array.isArray(value)) return value.map((v) => pack(v, files));
  if (value && typeof value === 'object') {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return { $bytes: [...new Uint8Array(value.buffer || value)] };
    const out = {};
    for (const [k, v] of Object.entries(value)) if (typeof v !== 'function' && v !== undefined) out[k] = pack(v, files);
    return out;
  }
  return value;
}

/** The other way: `{ $blob }` back to Blobs from `files` (Map name → Blob). */
function unpack(value, files) {
  if (Array.isArray(value)) return value.map((v) => unpack(v, files));
  if (value && typeof value === 'object') {
    if (Number.isInteger(value.$blob)) {
      const b = files.get(`files/${value.$blob}`);
      if (!b) throw new Error('missing file');
      return new Blob([b], { type: typeof value.type === 'string' ? value.type : '' });
    }
    if (Array.isArray(value.$bytes)) return new Uint8Array(value.$bytes);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = unpack(v, files);
    }
    return out;
  }
  return value;
}

/** A capture's project file: a Blob to download as `<name>.captode`. */
export async function saveProject(id) {
  const rec = await getCapture(id);
  if (!rec?.blob) throw new Error('capture not found');
  const { kept, undoJoin, ...capture } = rec; // keeping is this device's choice; the undo of joining clips is only for here
  const files = [];
  const json = {
    format: FORMAT,
    version: VERSION,
    app: { name: 'Captode', version: globalThis.chrome?.runtime?.getManifest?.().version || '' },
    saved: new Date().toISOString(),
    capture: pack(capture, files),
  };
  return zipBlobs([
    { name: 'project.json', data: new TextEncoder().encode(JSON.stringify(json)) },
    ...files.map((data, i) => ({ name: `files/${i}`, data })),
  ]);
}

/** Older layouts, brought up to this one. */
const upgrade = (json) => json;

/**
 * Opens a project file as a new capture, kept until removed. Resolves to
 * `{ id, kind ('image' | 'video') }`; throws an Error whose message is 'not-project'
 * or 'too-new' when it can't.
 */
export async function openProject(file) {
  let files;
  try { files = await unzip(file); } catch { throw new Error('not-project'); }
  const head = files.get('project.json');
  if (!head) throw new Error('not-project');
  let json;
  try { json = JSON.parse(await head.text()); } catch { throw new Error('not-project'); }
  if (json?.format !== FORMAT || !Number.isInteger(json.version)) throw new Error('not-project');
  if (json.version > VERSION) throw new Error('too-new');
  json = upgrade(json);
  let capture;
  try { capture = unpack(json.capture, files); } catch { throw new Error('not-project'); }
  const { blob, meta, created, ...extras } = capture || {};
  if (!(blob instanceof Blob) || !/^(image|video)\//.test(blob.type)) throw new Error('not-project');
  const id = await putCapture(blob, { ...(meta && typeof meta === 'object' ? meta : {}), opened: Date.now(), ...(Number.isFinite(created) && { made: created }) });
  await putExtras(id, { ...extras, kept: true });
  return { id, kind: blob.type.startsWith('video/') ? 'video' : 'image' };
}

/** Where a capture opens: the video page for recordings, the editor for images. */
export const pageFor = ({ id, kind }) => (kind === 'video' ? `video/video.html?id=${id}` : `editor/editor.html?id=${id}&reopen=1`);
