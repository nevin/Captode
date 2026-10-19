// lib/tab-capture.js for browsers without tab capture (see tools/targets.mjs): Captode
// offers only screen and window recording there, so these are never called.

export const canRecordTabs = false;

export async function startTabCapture() {
  throw new Error('This browser cannot record a single tab.');
}

export const endTabCapture = async () => {};
