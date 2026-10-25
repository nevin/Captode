// Records the whole screen or a window. This runs in a normal extension tab because
// picking a screen needs a page the browser can show its picker over.
import { record, openCameraAndMic } from '../lib/recorder.js';
import { putCapture, dropParts } from '../lib/db.js';
import { t, localize } from '../lib/i18n.js';

localize();

const params = new URLSearchParams(location.search);
const fps = Number(params.get('fps')) || 30;
const audio = params.get('audio') === '1';
const size = params.get('size') || 'page';
const camera = params.get('camera') === '1';
const mic = params.get('mic') === '1';
const autoStop = Math.max(0, Number(params.get('stop')) || 0); // Settings → Stop recording after
const countdownFrom = Math.max(0, Math.min(30, Number(params.get('countdown') ?? 3) || 0));
const $ = (id) => document.getElementById(id);

let session = null;
let ticker = 0;
let stopTimer = 0;
let limit = ''; // ' / 0:30' with a time limit
let cancelCountdown = null;

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
    // NotAllowedError is a cancelled picker, or (on macOS) Chrome lacking the
    // system's Screen Recording permission, which looks the same from here.
    const mac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
    $('err').textContent = e.name === 'NotAllowedError'
      ? t('screen_nothing_shared') + (mac ? ' ' + t('screen_mac_permission') : '')
      : e.message;
    $('err').classList.remove('hidden');
    return;
  }
  // The camera and microphone, if asked for; this page can ask the user for them.
  let extras;
  try {
    extras = await openCameraAndMic({ camera, mic });
  } catch {
    for (const t of stream.getTracks()) t.stop();
    $('err').textContent = t('error_camera_mic');
    $('err').classList.remove('hidden');
    return;
  }
  const dropExtras = () => { extras.camera?.stop(); extras.mic?.stop(); };
  // Sound was asked for, but not every browser or picker choice shares any: say so.
  $('no-sound').classList.toggle('hidden', !audio || stream.getAudioTracks().length > 0);
  $('pick').classList.add('hidden');
  if (countdownFrom && !(await countdown(countdownFrom, stream))) {
    for (const t of stream.getTracks()) t.stop();
    dropExtras();
    $('pick').classList.remove('hidden');
    return;
  }
  session = await record(stream, { fps, size, ...extras, onEnded: stop, backup: {} });
  $('live').classList.remove('hidden');
  document.title = t('screen_title_recording');
  chrome.runtime.sendMessage({ type: 'rec-started', kind: 'page' });
  // With a time limit, the clock shows it too: 0:12 / 0:30.
  limit = autoStop ? ` / ${fmt(autoStop)}` : '';
  $('time').textContent = fmt(0) + limit;
  ticker = setInterval(() => {
    const elapsed = session.elapsed();
    $('time').textContent = fmt(elapsed) + limit;
    chrome.runtime.sendMessage({ type: 'rec-tick', elapsed, paused: session.paused });
  }, 1000);
  armStop();
}

/** The time limit counts recorded time only, so it waits while paused. */
function armStop() {
  clearTimeout(stopTimer);
  if (autoStop && session && !session.paused) stopTimer = setTimeout(stop, Math.max(0, autoStop - session.elapsed()) * 1000);
}

/** Pauses or resumes (`pause` true or false; toggles if left out), here and on the toolbar. */
function setPaused(pause = !session.paused) {
  if (!session || !(pause ? session.pause() : session.resume())) return;
  armStop();
  const paused = session.paused;
  $('live').classList.toggle('paused', paused);
  $('live-title').textContent = t(paused ? 'screen_recording_paused' : 'video_recording');
  $('pause').textContent = t(paused ? 'rec_resume' : 'rec_pause');
  $('pause').setAttribute('aria-pressed', String(paused));
  $('time').textContent = fmt(session.elapsed()) + limit;
  document.title = t(paused ? 'screen_title_paused' : 'screen_title_recording');
  chrome.runtime.sendMessage({ type: 'rec-paused', paused, elapsed: session.elapsed() });
}

/**
 * Counts down on this page and on the toolbar badge (the user is usually looking at
 * the screen or window they picked). Resolves false if cancelled, or if sharing
 * ended in the meantime.
 */
function countdown(seconds, stream) {
  $('counting').classList.remove('hidden');
  return new Promise((resolve) => {
    let n = seconds;
    let timer = 0;
    const [track] = stream.getVideoTracks();
    const finish = (go) => {
      clearTimeout(timer);
      track.removeEventListener('ended', onEnded);
      cancelCountdown = null;
      chrome.action.setBadgeText({ text: '' });
      $('counting').classList.add('hidden');
      document.title = t('screen_title');
      resolve(go);
    };
    const onEnded = () => finish(false);
    track.addEventListener('ended', onEnded);
    cancelCountdown = () => finish(false);
    chrome.action.setBadgeBackgroundColor({ color: '#6c56ff' });
    const tick = () => {
      if (n === 0) return finish(true);
      $('count').textContent = n;
      document.title = t('screen_title_countdown', n);
      chrome.action.setBadgeText({ text: String(n) });
      n--;
      timer = setTimeout(tick, 1000);
    };
    tick();
  });
}

async function stop() {
  if (!session) return;
  const current = session;
  session = null;
  clearInterval(ticker);
  clearTimeout(stopTimer);
  $('live').classList.add('hidden');
  $('saving').classList.remove('hidden');
  const { blob, meta } = await current.stop();
  const id = await putCapture(blob, meta);
  await dropParts(current.backup).catch(() => {});
  await chrome.runtime.sendMessage({ type: 'rec-done', id, kind: 'page' });
  location.replace(chrome.runtime.getURL(`video/video.html?id=${id}`));
}

$('choose').addEventListener('click', choose);
$('stop').addEventListener('click', stop);
$('pause').addEventListener('click', () => setPaused());
$('cancel').addEventListener('click', () => cancelCountdown?.());
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'recorder' || !session) return;
  if (msg.type === 'rec-stop') stop();
  if (msg.type === 'rec-pause') setPaused(msg.pause);
});
window.addEventListener('beforeunload', (e) => { if (session) e.preventDefault(); });
