// Tab recording's browser side: a stream id for the tab, and the offscreen document that
// records it (a service worker can't hold a media stream). Browsers without tab capture
// get tools/tab-capture-none.js in this file's place in their package (tools/targets.mjs).

const OFFSCREEN = 'recorder/offscreen.html';

/** Whether this browser can record a single tab. */
export const canRecordTabs = !!(globalThis.chrome?.tabCapture && globalThis.chrome?.offscreen);

/** A stream id for recording `tabId`, with the offscreen document ready to take it. */
export async function startTabCapture(tabId) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  if (!(await chrome.offscreen.hasDocument?.())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Record the current tab after the user starts a recording.',
    });
  }
  return streamId;
}

/** Closes the offscreen document once a recording is saved. */
export const endTabCapture = () => chrome.offscreen.closeDocument().catch(() => {});
