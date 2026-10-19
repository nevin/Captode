// The offscreen document records the current tab. The service worker cannot hold a
// MediaStream itself, so it hands this document a tab-capture stream id.
import { record, openCameraAndMic } from '../lib/recorder.js';
import { t } from '../lib/i18n.js';
import { putCapture } from '../lib/db.js';

let session = null;
let ticker = 0;
let audioContext = null;
let title = '';
let cssWidth = 0; // the recorded part of the page, in CSS pixels

async function start({ streamId, fps, audio, aspect, crop, size, pageWidth, title: tabTitle, camera: wantCamera, mic: wantMic }) {
  title = tabTitle || '';
  cssWidth = pageWidth ? pageWidth * (crop ? crop.w : 1) : 0;
  // The camera and microphone first: this document can't ask for them, so they must
  // have been allowed already (the popup sends the user to a page that asks).
  let extras;
  try {
    extras = await openCameraAndMic({ camera: wantCamera, mic: wantMic });
  } catch {
    throw new Error(t('error_camera_mic'));
  }
  const media = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { mandatory: { ...media, maxWidth: 3840, maxHeight: 2160, maxFrameRate: fps } },
    audio: audio ? { mandatory: media } : false,
  });
  // Capturing a tab's audio mutes it for the user; play it back so they still hear it.
  if (audio && stream.getAudioTracks().length) {
    audioContext = new AudioContext();
    audioContext.createMediaStreamSource(stream).connect(audioContext.destination);
  }
  // The page's shape lets the recorder find it within the tab's picture, and leave
  // out the black around it when the page is shown smaller (DevTools' device mode).
  session = await record(stream, { fps, aspect, crop, size, ...extras, onEnded: stop });
  ticker = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'rec-tick', elapsed: (performance.now() - session.started) / 1000 });
  }, 1000);
}

async function stop() {
  if (!session) return;
  const current = session;
  session = null;
  clearInterval(ticker);
  const { blob, meta } = await current.stop();
  audioContext?.close();
  audioContext = null;
  // Video pixels per CSS pixel of the page, for measuring on the video page.
  const dpr = cssWidth && current.width ? current.width / cssWidth : undefined;
  const id = await putCapture(blob, { ...meta, title, dpr });
  chrome.runtime.sendMessage({ type: 'rec-done', id, kind: 'offscreen' });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'recorder') return;
  if (msg.type === 'rec-start' && msg.to === 'offscreen') {
    start(msg).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: e.message || String(e) }),
    );
    return true;
  }
  if (msg.type === 'rec-stop' && session) {
    stop();
    sendResponse({ ok: true });
  }
});
