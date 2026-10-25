// Tab recording's browser side: a stream id for the tab, and the offscreen document that
// records it (a service worker can't hold a media stream). The same document finishes
// exports queued in the background (recorder/exports.js), so they carry on after their
// page is closed. Browsers without tab capture get tools/tab-capture-none.js in this
// file's place in their package (tools/targets.mjs).

const OFFSCREEN = 'recorder/offscreen.html';

/** Whether this browser can record a single tab. */
export const canRecordTabs = !!(globalThis.chrome?.tabCapture && globalThis.chrome?.offscreen);

/** Whether exports can be queued to finish in the background (the offscreen document runs them). */
export const canQueueExports = !!globalThis.chrome?.offscreen;

async function openOffscreen(reasons, justification) {
  if (await chrome.offscreen.hasDocument?.()) return;
  try {
    await chrome.offscreen.createDocument({ url: OFFSCREEN, reasons, justification });
  } catch (e) {
    if (!/single offscreen|only a single/i.test(String(e?.message))) throw e; // made meanwhile
  }
}

/** A stream id for recording `tabId`, with the offscreen document ready to take it. */
export async function startTabCapture(tabId) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await openOffscreen(['USER_MEDIA', 'AUDIO_PLAYBACK'], 'Record the current tab after the user starts a recording.');
  return streamId;
}

/** Whether the offscreen document is finishing queued exports. */
const exporting = () => chrome.runtime.sendMessage({ target: 'exports', type: 'busy' }).then((r) => !!r?.busy, () => false);

/** Closes the offscreen document once a recording is saved, unless exports are still running in it. */
export async function endTabCapture() {
  if (await exporting()) return;
  await chrome.offscreen.closeDocument().catch(() => {});
}

/** Starts (or wakes) the exports queued in the background. */
export async function runExports() {
  await openOffscreen(['WORKERS'], 'Finish the exports the user queued, after their page is closed.');
  await chrome.runtime.sendMessage({ target: 'exports', type: 'run' }).catch(() => {});
}

/** Closes the offscreen document once the queue is empty, unless a recording is using it. */
export async function endExports(recording) {
  if (!recording) await chrome.offscreen.closeDocument().catch(() => {});
}
