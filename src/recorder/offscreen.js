// The offscreen document records the current tab. The service worker cannot hold a
// MediaStream itself, so it hands this document a tab-capture stream id.
import { record } from '../lib/recorder.js';
import { putCapture } from '../lib/db.js';

let session = null;
let ticker = 0;
let audioContext = null;

async function start({ streamId, fps, audio, crop }) {
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
  session = record(stream, { fps, crop, onEnded: stop });
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
  const id = await putCapture(blob, meta);
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
