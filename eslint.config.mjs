// Captode's code checks: `npm run lint`. JavaScript's recommended rules, for the
// browser, workers and extensions, with the newer browser APIs Captode uses.
import js from '@eslint/js';
import globals from 'globals';

const newer = ['VideoEncoder', 'VideoDecoder', 'VideoFrame', 'AudioEncoder', 'AudioDecoder', 'AudioData', 'EncodedVideoChunk',
  'EncodedAudioChunk', 'MediaStreamTrackProcessor', 'MediaStreamTrackGenerator', 'LanguageDetector', 'Translator', 'SpeechRecognition',
  'ImageDecoder', 'CropTarget', 'RestrictionTarget'];

export default [
  // Tests aren't checked: much of their code runs inside the extension's pages (page.evaluate).
  { ignores: ['src/vendor/**', 'dist/**', 'node_modules/**', 'test/**', 'safari/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'tools/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker, ...globals.webextensions, ...Object.fromEntries(newer.map((g) => [g, 'readonly'])) },
    },
  },
  // Tools run in Node, and some of their code in pages they open.
  { files: ['tools/**/*.mjs', '*.mjs'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, ...globals.browser, ...globals.webextensions } } },
  {
    rules: {
      // Leaving a field out by destructuring the rest is how fields are dropped here.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },
];
