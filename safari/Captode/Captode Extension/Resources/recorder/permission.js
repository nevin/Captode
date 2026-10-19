// Asks for the camera or microphone on Captode's behalf. Tab recordings run in an
// offscreen document, which can't show Chrome's prompt, so the popup opens this page
// once; Chrome then remembers the answer for all of Captode's pages.
import { t, localize } from '../lib/i18n.js';

localize();

const params = new URLSearchParams(location.search);
const camera = params.get('camera') === '1';
const mic = params.get('mic') === '1';
const $ = (id) => document.getElementById(id);
$('ask-title').textContent = camera && mic ? t('permission_title_both') : camera ? t('permission_title_camera') : t('permission_title_mic');

async function allow() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: camera, audio: mic });
  } catch {
    // Not allowed: the popup's switches go back off, so recordings aren't stopped by it.
    await chrome.storage.local.set({ ...(camera && { camera: false }), ...(mic && { mic: false }) });
    $('ask').classList.add('hidden');
    $('denied').classList.remove('hidden');
    return;
  }
  await chrome.storage.local.set({ ...(camera && { camera: true }), ...(mic && { mic: true }) });
  $('ask').classList.add('hidden');
  $('denied').classList.add('hidden');
  $('done').classList.remove('hidden');
  // A look at the bubble as it will appear, and the microphone's level.
  if (camera) {
    $('preview').srcObject = new MediaStream(stream.getVideoTracks());
    $('bubble').classList.remove('hidden');
  }
  if (mic) {
    const ac = new AudioContext();
    const an = ac.createAnalyser();
    ac.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(an);
    const data = new Uint8Array(an.fftSize);
    const bar = $('meter').firstElementChild;
    $('meter').classList.remove('hidden');
    const tick = () => {
      an.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      bar.style.width = `${Math.min(100, (peak / 64) * 100)}%`;
      requestAnimationFrame(tick);
    };
    tick();
  }
  setTimeout(() => {
    for (const tr of stream.getTracks()) tr.stop();
    window.close();
  }, 4000);
}

$('allow').addEventListener('click', allow);
$('retry').addEventListener('click', allow);
