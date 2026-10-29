// lib/speech.js for the packages that don't offer captions from speech (see
// tools/targets.mjs): they hold none of that code, and the button never shows.

export const canTranscribe = false;

export function mountSpeech() {
  return { sync() {} };
}
