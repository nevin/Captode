// Records the whole screen or a window. This runs in a normal extension tab because
// picking a screen needs a page the browser can show its picker over.
import { record } from '../lib/recorder.js';
import { putCapture } from '../lib/db.js';

const params = new URLSearchParams(location.search);
const fps = Number(params.get('fps')) || 30;
const audio = params.get('audio') === '1';
const $ = (id) => document.getElementById(id);

let session = null;
let ticker = 0;

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function choose() {
  $('err').classList.add('hidden');
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps }, width: { max: 3840 }, height: { max: 2160 } },
      audio,
      systemAudio: audio ? 'include' : 'exclude',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') {
      $('err').textContent = e.message;
      $('err').classList.remove('hidden');
    }
    return;
  }
  session = record(stream, { fps, onEnded: stop });
  $('pick').classList.add('hidden');
  $('live').classList.remove('hidden');
  document.title = '● Recording — TabReel';
  chrome.runtime.sendMessage({ type: 'rec-started', kind: 'page' });
  ticker = setInterval(() => {
    const elapsed = (performance.now() - session.started) / 1000;
    $('time').textContent = fmt(elapsed);
    chrome.runtime.sendMessage({ type: 'rec-tick', elapsed });
  }, 1000);
}

async function stop() {
  if (!session) return;
  const current = session;
  session = null;
  clearInterval(ticker);
  $('live').classList.add('hidden');
  $('saving').classList.remove('hidden');
  const { blob, meta } = await current.stop();
  const id = await putCapture(blob, meta);
  await chrome.runtime.sendMessage({ type: 'rec-done', id, kind: 'page' });
  location.replace(chrome.runtime.getURL(`video/video.html?id=${id}`));
}

$('choose').addEventListener('click', choose);
$('stop').addEventListener('click', stop);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target === 'recorder' && msg.type === 'rec-stop' && session) stop();
});
window.addEventListener('beforeunload', (e) => { if (session) e.preventDefault(); });
