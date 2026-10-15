const $ = (s) => document.querySelector(s);
let kind = 'image';
let fps = '30';

const settings = await chrome.storage.local.get({ kind: 'image', fps: '30', audio: false, countdown: true, device: false });
fps = String(settings.fps);
$('#audio').checked = settings.audio;
$('#countdown').checked = settings.countdown;
$('#device').checked = settings.device;
setKind(settings.kind);
setFps(fps);

const { lastError } = await chrome.storage.session.get('lastError');
if (lastError) {
  $('#error').textContent = lastError;
  $('#error').classList.remove('hidden');
  await chrome.storage.session.remove('lastError');
  await chrome.action.setBadgeText({ text: '' });
}

function setKind(k) {
  kind = k;
  for (const b of document.querySelectorAll('.kind button')) b.classList.toggle('on', b.dataset.kind === k);
  for (const id of ['modes-image', 'hint-image']) $('#' + id).classList.toggle('hidden', k !== 'image');
  for (const id of ['modes-video', 'hint-video']) $('#' + id).classList.toggle('hidden', k !== 'video');
}

function setFps(v) {
  fps = v;
  for (const b of document.querySelectorAll('#fps button')) b.classList.toggle('on', b.dataset.fps === v);
}

for (const b of document.querySelectorAll('.kind button')) {
  b.addEventListener('click', () => {
    setKind(b.dataset.kind);
    chrome.storage.local.set({ kind: b.dataset.kind });
  });
}
$('#fps').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.fps;
  if (!v) return;
  setFps(v);
  chrome.storage.local.set({ fps: v });
});
for (const id of ['audio', 'countdown', 'device']) {
  $('#' + id).addEventListener('change', (e) => chrome.storage.local.set({ [id]: e.target.checked }));
}
$('#open-editor').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
  window.close();
});

for (const b of document.querySelectorAll('.mode')) {
  b.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const msg = kind === 'image'
      ? { type: 'capture-image', mode: b.dataset.mode, tabId: tab.id }
      : {
          type: 'record-start', mode: b.dataset.mode, tabId: tab.id,
          fps: Number(fps), audio: $('#audio').checked, countdown: $('#countdown').checked,
        };
    await chrome.runtime.sendMessage(msg);
    window.close();
  });
}
