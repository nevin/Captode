import { getSettings, saveSettings } from '../lib/settings.js';

const $ = (s) => document.querySelector(s);
let settings = await getSettings();
const { device } = await chrome.storage.local.get({ device: false });

let toastTimer = 0;
function saved() {
  const t = $('#saved');
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1400);
}

async function update(patch) {
  settings = await saveSettings(patch);
  render();
  saved();
}

function choose(group, value) {
  for (const b of document.querySelectorAll(`#${group} [data-v]`)) b.setAttribute('aria-checked', String(b.dataset.v === value));
}

function render() {
  choose('theme', settings.theme);
  choose('background', settings.background);
  $('#custom-row').classList.toggle('hidden', settings.background !== 'custom');
  $('#custom-swatch').style.background = settings.backgroundColor;
  $('#bg-color').value = settings.backgroundColor;
  if (document.activeElement !== $('#bg-hex')) $('#bg-hex').value = settings.backgroundColor;
  $('#imageFormat').value = settings.imageFormat;
  $('#videoFormat').value = settings.videoFormat;
}

for (const group of ['theme', 'background']) {
  $('#' + group).addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (v) update({ [group]: v });
  });
}
$('#bg-color').addEventListener('input', (e) => update({ backgroundColor: e.target.value }));
$('#bg-hex').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) update({ backgroundColor: v.toLowerCase() });
});
$('#imageFormat').addEventListener('change', (e) => update({ imageFormat: e.target.value }));
$('#videoFormat').addEventListener('change', (e) => update({ videoFormat: e.target.value }));
$('#device').checked = device;
$('#device').addEventListener('change', async (e) => { await chrome.storage.local.set({ device: e.target.checked }); saved(); });
$('#shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
$('#version').textContent = `Captode ${chrome.runtime.getManifest().version}`;
render();
