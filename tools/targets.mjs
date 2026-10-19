// Everything that differs between the browsers Captode is published for. Each package
// gets the same files except two, made here for its browser alone:
//   manifest.json   from src/manifest.json, with that browser's keys and permissions
//   lib/target.js   that browser's store link, shortcut settings and protected pages
// so no package names another browser's store, ID or pages (checked by `leaks` below).
// src/ itself holds the Chrome versions of both, for loading unpacked while developing.

/** Firefox's add-on ID. It is permanent: AMO and every installed copy know Captode by it. */
export const GECKO_ID = 'captode@thecodersworld.com';

// Permissions only Chromium browsers have. Captode checks for the APIs before using them
// (src/lib/platform.js), and other browsers' validators reject permissions they don't know.
const CHROMIUM_ONLY_PERMISSIONS = ['tabCapture', 'offscreen'];

// Browsers without tab capture get a lib/tab-capture.js that offers none, and no offscreen
// recorder: their packages hold no code for APIs they don't have.
const WITHOUT_TAB_CAPTURE = {
  replace: { 'lib/tab-capture.js': 'tools/tab-capture-none.js' },
  drop: ['recorder/offscreen.html', 'recorder/offscreen.js'],
};

const withoutChromium = (m) => {
  m.permissions = m.permissions.filter((p) => !CHROMIUM_ONLY_PERMISSIONS.includes(p));
  delete m.minimum_chrome_version;
  return m;
};

/**
 * Each browser: how its package is made (`zip` for a store upload, or `folder` for one that
 * is converted first), its manifest, the settings Captode reads at run time, and what must
 * not appear in its package.
 */
export const TARGETS = {
  chrome: {
    name: 'Chrome Web Store',
    file: (v) => `captode-${v}-chrome.zip`,
    manifest: (m) => m,
    runtime: {
      storeUrl: 'https://chromewebstore.google.com/detail/mphigcddnecjbnkcpiaabheopepcmgce?utm_source=item-share-cb',
      shortcutsUrl: 'chrome://extensions/shortcuts',
      protectedSchemes: ['chrome', 'chrome-extension', 'chrome-search', 'chrome-untrusted', 'devtools', 'view-source', 'about'],
      protectedHosts: ['chromewebstore.google.com', 'chrome.google.com/webstore'],
    },
  },
  edge: {
    name: 'Microsoft Edge Add-ons',
    file: (v) => `captode-${v}-edge.zip`,
    manifest: (m) => m, // Edge reads Chromium's manifest, minimum_chrome_version included
    runtime: {
      storeUrl: null, // known once listed: https://microsoftedge.microsoft.com/addons/detail/<id>
      shortcutsUrl: 'edge://extensions/shortcuts',
      protectedSchemes: ['edge', 'extension', 'chrome-extension', 'devtools', 'view-source', 'about'],
      protectedHosts: ['microsoftedge.microsoft.com/addons'],
    },
  },
  firefox: {
    name: 'addons.mozilla.org',
    files: WITHOUT_TAB_CAPTURE,
    file: (v) => `captode-${v}-firefox.zip`,
    manifest: (m) => {
      withoutChromium(m);
      // Firefox runs the background as an event page (a script), not a service worker.
      m.background = { scripts: [m.background.service_worker], type: m.background.type };
      m.browser_specific_settings = {
        gecko: {
          id: GECKO_ID,
          // 140 (an ESR release) is the first to read data_collection_permissions, which
          // addons.mozilla.org requires of new add-ons.
          strict_min_version: '140.0',
          data_collection_permissions: { required: ['none'] }, // nothing leaves the device
        },
        // Android reads data_collection_permissions from 142. This only sets the minimum:
        // Captode is offered for Android only if that is chosen when uploading.
        gecko_android: { strict_min_version: '142.0' },
      };
      return m;
    },
    runtime: {
      storeUrl: 'https://addons.mozilla.org/firefox/addon/captode/',
      shortcutsUrl: null, // opened with commands.openShortcutSettings()
      protectedSchemes: ['about', 'moz-extension', 'view-source', 'resource', 'jar'],
      protectedHosts: ['addons.mozilla.org', 'accounts.firefox.com', 'support.mozilla.org'],
    },
  },
  safari: {
    name: 'Safari (App Store, through Xcode)',
    files: WITHOUT_TAB_CAPTURE,
    // Safari takes a web extension inside a Mac app: this folder is the input to
    // `xcrun safari-web-extension-converter` (see README, Publishing).
    folder: (v) => `captode-${v}-safari`,
    manifest: (m) => {
      withoutChromium(m);
      m.browser_specific_settings = { safari: { strict_min_version: '17.0' } };
      return m;
    },
    runtime: {
      storeUrl: null, // the App Store page, once listed
      shortcutsUrl: null, // Safari has no page for extension shortcuts
      protectedSchemes: ['safari-web-extension', 'about', 'view-source'],
      protectedHosts: ['apps.apple.com'],
    },
  },
};

/** lib/target.js for a browser: its own settings and nothing about the others. */
export function targetModule(id) {
  const r = TARGETS[id].runtime;
  const q = (v) => (v === null ? 'null' : `'${v}'`);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const pages = `^(${r.protectedSchemes.map(esc).join('|')}):|^https:\\/\\/(${r.protectedHosts.map(esc).join('|')})`;
  return `// Made by tools/targets.mjs for this browser's package: edit it there, not here.
export const TARGET = {
  /** Captode's page in this browser's add-on store, to share; null until listed. */
  storeUrl: ${q(r.storeUrl)},
  /** The browser's page for changing extension shortcuts, if it has one to open. */
  shortcutsUrl: ${q(r.shortcutsUrl)},
  /** Pages no extension may capture: the browser's own, and its add-on store. */
  protectedPages: /${pages}/,
};
`;
}

/** The manifest for a browser, from src/manifest.json. */
export const manifestFor = (id, manifest) => TARGETS[id].manifest(structuredClone(manifest));

// What each browser's package must not contain: other stores, IDs, internal pages and
// manifest keys. Checked in every file but the vendored codecs, and in every translation.
const MARKS = {
  chrome: [/chromewebstore\.google\.com|chrome\.google\.com\/webstore/i, /mphigcddnecjbnkcpiaabheopepcmgce/, /chrome:\/\//, /"minimum_chrome_version"/, /\bChrome\b/],
  edge: [/microsoftedge\.microsoft\.com/i, /edge:\/\//, /\bMicrosoft Edge\b/],
  firefox: [/addons\.mozilla\.org|accounts\.firefox\.com|support\.mozilla\.org/i, /moz-extension/, new RegExp(GECKO_ID.replace(/[.@]/g, '\\$&')), /"browser_specific_settings"[\s\S]*"gecko"/, /\bFirefox\b/],
  safari: [/apps\.apple\.com/i, /safari-web-extension/, /"safari"\s*:/, /\bSafari\b/],
};
// Chromium's manifest key is Edge's too.
const ALLOWED = { edge: ['"minimum_chrome_version"'] };

/**
 * Where a package for `id` mentions another browser: [file, what] pairs. `files` is
 * [name, Buffer] as zipped. User-visible text (translations, HTML) is checked for browser
 * names too; code only for stores, IDs, pages and manifest keys, since a comment may
 * explain how one browser behaves.
 */
export function leaks(id, files) {
  const found = [];
  for (const [name, data] of files) {
    if (name.startsWith('vendor/') || !/\.(js|json|html|css)$/.test(name)) continue;
    const text = data.toString('utf8');
    const visible = name.startsWith('_locales/') || name.endsWith('.html') || name === 'manifest.json';
    for (const [other, marks] of Object.entries(MARKS)) {
      if (other === id) continue;
      for (const mark of marks) {
        if (ALLOWED[id]?.includes(mark.source)) continue;
        const isName = /^\\b[A-Z]/.test(mark.source);
        if (isName && !visible) continue;
        if (mark.test(text)) found.push([name, `${other}: ${mark.source}`]);
      }
    }
  }
  return found;
}

/**
 * Makes an unpacked copy of src/ in `dir` into `id`'s package, as tools/package.mjs builds
 * it: its manifest, settings, and the files it replaces or leaves out. For tests and
 * screenshots that run one browser's package from a folder.
 */
export function makePackageIn(id, dir, root) {
  const { readFileSync, writeFileSync, rmSync } = process.getBuiltinModule('node:fs');
  const { join } = process.getBuiltinModule('node:path');
  const manifest = JSON.parse(readFileSync(join(root, 'src', 'manifest.json'), 'utf8'));
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifestFor(id, manifest), null, 2)}\n`);
  writeFileSync(join(dir, 'lib', 'target.js'), targetModule(id));
  const files = TARGETS[id].files || {};
  for (const [name, from] of Object.entries(files.replace || {})) writeFileSync(join(dir, name), readFileSync(join(root, from)));
  for (const name of files.drop || []) rmSync(join(dir, name), { force: true });
}
