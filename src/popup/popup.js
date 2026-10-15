const $ = (s) => document.querySelector(s);
let kind = 'image';

const settings = await chrome.storage.local.get({ kind: 'image', fps: '30', audio: false, countdown: true, device: false });
$('#fps').value = settings.fps;
$('#audio').checked = settings.audio;
$('#countdown').checked = settings.countdown;
$('#device').checked = settings.device;
$('#ver').textContent = 'v' + chrome.runtime.getManifest().version;
setKind(settings.kind);

const { lastError } = await chrome.storage.session.get('lastError');
if (lastError) {
  $('#error').textContent = lastError;
  $('#error').classList.remove('hidden');
  await chrome.storage.session.remove('lastError');
  await chrome.action.setBadgeText({ text: '' });
}

function setKind(k) {
  kind = k;
  for (const b of document.querySelectorAll('.seg button')) b.classList.toggle('on', b.dataset.kind === k);
  $('#modes-image').classList.toggle('hidden', k !== 'image');
  $('#modes-video').classList.toggle('hidden', k !== 'video');
}

for (const b of document.querySelectorAll('.seg button')) {
  b.addEventListener('click', () => {
    setKind(b.dataset.kind);
    chrome.storage.local.set({ kind: b.dataset.kind });
  });
}
for (const id of ['fps', 'audio', 'countdown', 'device']) {
  $('#' + id).addEventListener('change', (e) => {
    const el = e.target;
    chrome.storage.local.set({ [id]: el.type === 'checkbox' ? el.checked : el.value });
  });
}

for (const b of document.querySelectorAll('.mode')) {
  b.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const msg = kind === 'image'
      ? { type: 'capture-image', mode: b.dataset.mode, tabId: tab.id }
      : {
          type: 'record-start', mode: b.dataset.mode, tabId: tab.id,
          fps: Number($('#fps').value), audio: $('#audio').checked, countdown: $('#countdown').checked,
        };
    await chrome.runtime.sendMessage(msg);
    window.close();
  });
}
