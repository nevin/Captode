// lib/tab-capture.js for browsers without tab capture (see tools/targets.mjs): Captode
// offers only screen and window recording there, and exports run in their own page, so
// these are never called.

export const canRecordTabs = false;
export const canQueueExports = false;

export async function startTabCapture() {
  throw new Error('This browser cannot record a single tab.');
}

export const endTabCapture = async () => {};
export const runExports = async () => {};
export const endExports = async () => {};
