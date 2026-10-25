// The Keep and Save project buttons the editor and the video page share.
import { getCapture, setKept } from './db.js';
import { saveProject, PROJECT_EXT } from './project.js';
import { t } from './i18n.js';
import { toast } from './ui.js';

/** Downloads `blob` as `name`. */
export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

/** Downloads capture `id` as a project file named `stem`.captode. */
export async function downloadProject(id, stem) {
  downloadBlob(await saveProject(id), `${stem || 'captode'}.${PROJECT_EXT}`);
}

/**
 * Wires `keep` (a toggle button) and `project` (a button) to the capture `id()` names.
 * `beforeSave()` saves pending work first; `stem()` names the file.
 */
export function mountCaptureTools({ keep, project, id, beforeSave = async () => {}, stem }) {
  const show = (on) => {
    keep.setAttribute('aria-pressed', String(on));
    keep.classList.toggle('on', on);
    const tip = t(on ? 'keep_on_tip' : 'keep_off_tip');
    keep.dataset.tip = tip;
    keep.setAttribute('aria-label', tip);
  };
  const sync = async () => {
    const has = !!id();
    keep.classList.toggle('hidden', !has);
    project.classList.toggle('hidden', !has);
    if (has) show(!!(await getCapture(id()))?.kept);
  };
  keep.addEventListener('click', async () => {
    const on = keep.getAttribute('aria-pressed') !== 'true';
    await setKept(id(), on);
    show(on);
    toast(t(on ? 'keep_on' : 'keep_off'), { kind: on ? 'success' : 'info' });
  });
  project.addEventListener('click', async () => {
    project.disabled = true;
    try {
      await beforeSave();
      await downloadProject(id(), await stem());
    } catch (e) {
      toast(t('project_save_failed', String(e?.message || e)), { kind: 'error', ms: 5000 });
    } finally {
      project.disabled = false;
    }
  });
  return { sync };
}
