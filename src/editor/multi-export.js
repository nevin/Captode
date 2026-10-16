// "Several devices": one capture framed in each chosen device, downloaded as a zip.

import { DEVICES, matchDevice } from '../lib/device.js';
import { GROUPS } from '../lib/devices.js';
import { zip } from '../lib/zip.js';
import { toast, openDialog } from '../lib/ui.js';

const $ = (s) => document.querySelector(s);
const KEY = 'multiDevices';
const DEFAULT = ['none', 'iphone-18-pro', 'iphone-18-pro-max', 'ipad-pro-11', 'pixel-11', 'galaxy-s26'];

/**
 * `ed`: `hasImage()`, `size()` ([w, h] of the image with its padding),
 * `deviceOptions()` (the device panel's), `render(deviceOpts)` (a canvas, as
 * exported), `encode(canvas)` (with the Export settings), `extension()` and `stem()`
 * (the file name without its extension).
 */
export function mountMultiExport(ed) {
  async function open() {
    if (!ed.hasImage()) return;
    let chosen = DEFAULT;
    try { chosen = (await chrome.storage.local.get({ [KEY]: DEFAULT }))[KEY]; } catch {}
    const [w, h] = ed.size();
    const best = DEVICES[matchDevice(w, h).id];
    const item = (id, name, sub) => `<label><input type="checkbox" value="${id}"${chosen.includes(id) ? ' checked' : ''}>${name}${sub ? `<small>${sub}</small>` : ''}</label>`;
    $('#multi-list').innerHTML =
      item('none', 'No frame', `${w} × ${h}`) + item('auto', `Best match (${best.name})`, '') +
      GROUPS.map(([label, test]) => `<div class="group">${label}</div>` +
        Object.values(DEVICES).filter(test).map((d) => item(d.id, d.name, '')).join('')).join('');
    $('#multi-status').textContent = '';
    $('#multi-go').disabled = false;
    openDialog($('#multi'));
  }

  async function save() {
    const ids = [...$('#multi-list').querySelectorAll('input:checked')].map((i) => i.value);
    if (!ids.length) { $('#multi-status').textContent = 'Choose at least one.'; return; }
    try { chrome.storage.local.set({ [KEY]: ids }); } catch {}
    $('#multi-go').disabled = true;
    const files = [];
    const name = ed.stem();
    try {
      for (const [i, id] of ids.entries()) {
        const label = id === 'none' ? 'no frame' : id === 'auto' ? 'best match' : DEVICES[id].name;
        $('#multi-status').textContent = `Making ${i + 1} of ${ids.length}: ${label}…`;
        const opts = id === 'none' ? { enabled: false } : { ...ed.deviceOptions(), enabled: true, device: id };
        const { blob } = await ed.encode(await ed.render(opts));
        const slug = id === 'none' ? 'no-frame' : id === 'auto' ? `best-match-${matchDevice(...ed.size()).id}` : id;
        files.push({ name: `${name}-${slug}.${ed.extension()}`, data: new Uint8Array(await blob.arrayBuffer()) });
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(zip(files));
      a.download = `${name}-devices.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      $('#multi').close();
      toast(`Saved ${a.download} · ${files.length} image${files.length > 1 ? 's' : ''}`, { kind: 'success' });
    } catch (e) {
      $('#multi-status').textContent = `That didn't work: ${e.message}`;
    } finally {
      $('#multi-go').disabled = false;
    }
  }

  $('#multi-open').addEventListener('click', open);
  $('#multi-go').addEventListener('click', save);
}
