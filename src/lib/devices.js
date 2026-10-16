// Real devices for device mode, from their published specifications: the screen's
// resolution and pixel density, the browser viewport (CSS pixels, which are iOS
// points and Android dp), and the body's size in millimetres. The bezels follow from
// those, so every frame has the device's real proportions.
//
// Corner radii, cut-outs and button positions are close approximations: they are
// drawn, not traced from photographs.
//
// Sources, checked October 2026: resolution, density and body size from apple.com
// (iPhone and iPad compare and spec pages), Google's Pixel hardware specifications
// (support.google.com/pixelphone/answer/7158570) and samsung.com (UK spec pages; density
// worked out from the published diagonal). Galaxy and Pixel tablets: retailer listings,
// which agree. Viewports: as Chrome's DevTools has them where it lists the device, else
// the pixels divided by the platform's usual scale (which manufacturers don't publish).

import { t } from './i18n.js';

/**
 * Families: what devices of one design share. Lengths are in points (dp on Android).
 * - radius: the screen's corner radius
 * - cutout: { kind: 'island' | 'notch' | 'punch', w, h, top, x? ('center' | 'right') }
 * - status: status bar height; home: 'indicator' | 'button' | 'gesture' | null
 * - buttons: [side, from, length] as fractions of the body's height (portrait)
 * - camera: a front camera in the bezel, on the 'short' or 'long' edge (tablets)
 */
const FAMILY = {
  island: {
    os: 'ios', type: 'phone', radius: 55, status: 54, home: 'indicator',
    cutout: { kind: 'island', w: 125, h: 37, top: 11 },
    buttons: [['left', 0.13, 0.04], ['left', 0.2, 0.075], ['left', 0.29, 0.075], ['right', 0.23, 0.12]],
  },
  notch: {
    os: 'ios', type: 'phone', radius: 47.33, status: 47, home: 'indicator',
    cutout: { kind: 'notch', w: 162, h: 32, top: 0 },
    buttons: [['left', 0.13, 0.035], ['left', 0.2, 0.075], ['left', 0.29, 0.075], ['right', 0.23, 0.12]],
  },
  homeButton: {
    os: 'ios', type: 'phone', radius: 0, status: 20, home: 'button', cutout: null, bodyRadius: 0.125,
    buttons: [['left', 0.12, 0.035], ['left', 0.19, 0.06], ['left', 0.27, 0.06], ['right', 0.18, 0.08]],
  },
  ipad: {
    os: 'ipados', type: 'tablet', radius: 18, status: 24, home: 'indicator', cutout: null, camera: 'short',
    buttons: [['top', 0.8, 0.07], ['right', 0.1, 0.06], ['right', 0.17, 0.06]],
  },
  pixel: {
    os: 'android', type: 'phone', radius: 44, status: 40, home: 'gesture',
    cutout: { kind: 'punch', w: 12, h: 12, top: 13 },
    buttons: [['right', 0.22, 0.07], ['right', 0.33, 0.13]],
  },
  galaxy: {
    os: 'android', type: 'phone', radius: 32, status: 36, home: 'gesture',
    cutout: { kind: 'punch', w: 10, h: 10, top: 11 },
    buttons: [['right', 0.21, 0.12], ['right', 0.36, 0.07]],
  },
  galaxyTab: {
    os: 'android', type: 'tablet', radius: 18, status: 28, home: 'gesture', cutout: null, camera: 'long',
    buttons: [['top', 0.62, 0.06], ['top', 0.72, 0.09]],
  },
};

/** id: [name, family, [width, height] px, [width, height] viewport, ppi, [width, height] mm, extra] */
const LIST = {
  // Apple iPhone
  'iphone-18-pro-max': ['iPhone 18 Pro Max', 'island', [1320, 2868], [440, 956], 460, [78.0, 163.4], { radius: 62 }],
  'iphone-18-pro': ['iPhone 18 Pro', 'island', [1206, 2622], [402, 874], 460, [71.9, 150.0], { radius: 62 }],
  // Opens to a wide 7.6″ screen (under-display camera) from a 5.4″ cover screen.
  'iphone-duo': ['iPhone Duo (open)', 'island', [1878, 2670], [626, 890], 430, [117.8, 164.6], { radius: 30, cutout: null }],
  'iphone-duo-cover': ['iPhone Duo (folded)', 'island', [1398, 2034], [466, 678], 460, [84.1, 117.8], { radius: 48 }],
  'iphone-17e': ['iPhone 17e', 'notch', [1170, 2532], [390, 844], 460, [71.5, 146.7]],
  'iphone-17-pro-max': ['iPhone 17 Pro Max', 'island', [1320, 2868], [440, 956], 460, [78.0, 163.4], { radius: 62 }],
  'iphone-17-pro': ['iPhone 17 Pro', 'island', [1206, 2622], [402, 874], 460, [71.9, 150.0], { radius: 62 }],
  'iphone-air': ['iPhone Air', 'island', [1260, 2736], [420, 912], 460, [74.7, 156.2], { radius: 62, buttons: [['left', 0.15, 0.075], ['left', 0.24, 0.075], ['right', 0.23, 0.12]] }],
  'iphone-17': ['iPhone 17', 'island', [1206, 2622], [402, 874], 460, [71.5, 149.6], { radius: 62 }],
  'iphone-16-pro-max': ['iPhone 16 Pro Max', 'island', [1320, 2868], [440, 956], 460, [77.6, 163.0], { radius: 62 }],
  'iphone-16-pro': ['iPhone 16 Pro', 'island', [1206, 2622], [402, 874], 460, [71.5, 149.6], { radius: 62 }],
  'iphone-16-plus': ['iPhone 16 Plus', 'island', [1290, 2796], [430, 932], 460, [77.8, 160.9]],
  'iphone-16': ['iPhone 16', 'island', [1179, 2556], [393, 852], 460, [71.6, 147.6]],
  'iphone-16e': ['iPhone 16e', 'notch', [1170, 2532], [390, 844], 460, [71.5, 146.7]],
  'iphone-15-pro-max': ['iPhone 15 Pro Max', 'island', [1290, 2796], [430, 932], 460, [76.7, 159.9]],
  'iphone-15-pro': ['iPhone 15 Pro', 'island', [1179, 2556], [393, 852], 460, [70.6, 146.6]],
  'iphone-15': ['iPhone 15', 'island', [1179, 2556], [393, 852], 460, [71.6, 147.6]],
  'iphone-14': ['iPhone 14', 'notch', [1170, 2532], [390, 844], 460, [71.5, 146.7]],
  'iphone-13-mini': ['iPhone 13 mini', 'notch', [1080, 2340], [375, 812], 476, [64.2, 131.5], { radius: 44, status: 50 }],
  'iphone-se': ['iPhone SE (3rd gen)', 'homeButton', [750, 1334], [375, 667], 326, [67.3, 138.4]],
  // Apple iPad (the current M5 Pro and M4 Air are the same size as the models before)
  'ipad-pro-13': ['iPad Pro 13″', 'ipad', [2064, 2752], [1032, 1376], 264, [215.5, 281.6], { camera: 'long' }],
  'ipad-pro-11': ['iPad Pro 11″', 'ipad', [1668, 2420], [834, 1210], 264, [177.5, 249.7], { camera: 'long' }],
  'ipad-air-13': ['iPad Air 13″', 'ipad', [2048, 2732], [1024, 1366], 264, [214.9, 280.6], { camera: 'long' }],
  'ipad-air-11': ['iPad Air 11″', 'ipad', [1640, 2360], [820, 1180], 264, [178.5, 247.6], { camera: 'long' }],
  'ipad': ['iPad (A16)', 'ipad', [1640, 2360], [820, 1180], 264, [179.5, 248.6], { camera: 'long' }],
  'ipad-mini': ['iPad mini (A17 Pro)', 'ipad', [1488, 2266], [744, 1133], 326, [134.8, 195.4], { radius: 21.5 }],
  // Google Pixel
  'pixel-11-pro-xl': ['Pixel 11 Pro XL', 'pixel', [1344, 2992], [448, 997], 486, [76.5, 162.7]],
  'pixel-11-pro': ['Pixel 11 Pro', 'pixel', [1280, 2856], [410, 914], 495, [71.9, 152.7]],
  'pixel-11': ['Pixel 11', 'pixel', [1080, 2424], [412, 924], 422, [72.0, 152.8]],
  'pixel-11-pro-fold': ['Pixel 11 Pro Fold (open)', 'pixel', [2076, 2152], [791, 820], 372, [150.4, 155.2], { radius: 24, cutout: { kind: 'punch', w: 10, h: 10, top: 12, x: 'right' } }],
  'pixel-11-pro-fold-cover': ['Pixel 11 Pro Fold (folded)', 'pixel', [1080, 2342], [412, 893], 399, [76.0, 155.2]],
  'pixel-10a': ['Pixel 10a', 'pixel', [1080, 2424], [412, 924], 422, [73.0, 153.9], { radius: 36 }],
  'pixel-10-pro-xl': ['Pixel 10 Pro XL', 'pixel', [1344, 2992], [448, 997], 486, [76.6, 162.8]],
  'pixel-10-pro': ['Pixel 10 Pro', 'pixel', [1280, 2856], [410, 914], 495, [72.0, 152.8]],
  'pixel-10': ['Pixel 10', 'pixel', [1080, 2424], [412, 924], 422, [72.0, 152.8]],
  'pixel-9-pro-xl': ['Pixel 9 Pro XL', 'pixel', [1344, 2992], [448, 997], 486, [76.6, 162.8]],
  'pixel-9-pro': ['Pixel 9 Pro', 'pixel', [1280, 2856], [410, 914], 495, [72.0, 152.8]],
  'pixel-9': ['Pixel 9', 'pixel', [1080, 2424], [412, 924], 422, [72.0, 152.8]],
  'pixel-8-pro': ['Pixel 8 Pro', 'pixel', [1344, 2992], [448, 998], 489, [76.5, 162.6]],
  'pixel-8': ['Pixel 8', 'pixel', [1080, 2400], [412, 915], 428, [70.8, 150.5]],
  'pixel-7': ['Pixel 7', 'pixel', [1080, 2400], [412, 915], 416, [73.2, 155.6], { radius: 36 }],
  'pixel-tablet': ['Pixel Tablet', 'galaxyTab', [1600, 2560], [800, 1280], 276, [169.0, 258.0], { radius: 24 }],
  // Samsung Galaxy
  'galaxy-s26-ultra': ['Galaxy S26 Ultra', 'galaxy', [1440, 3120], [412, 893], 499, [78.1, 163.6], { radius: 22 }],
  'galaxy-s26-plus': ['Galaxy S26+', 'galaxy', [1440, 3120], [384, 832], 516, [75.8, 158.4]],
  'galaxy-s26': ['Galaxy S26', 'galaxy', [1080, 2340], [360, 780], 411, [71.7, 149.6]],
  'galaxy-s25-ultra': ['Galaxy S25 Ultra', 'galaxy', [1440, 3120], [412, 893], 501, [77.6, 162.8], { radius: 20 }],
  'galaxy-s25-plus': ['Galaxy S25+', 'galaxy', [1440, 3120], [384, 832], 516, [75.8, 158.4]],
  'galaxy-s25': ['Galaxy S25', 'galaxy', [1080, 2340], [360, 780], 419, [70.5, 146.9]],
  'galaxy-s24-ultra': ['Galaxy S24 Ultra', 'galaxy', [1440, 3120], [384, 832], 506, [79.0, 162.3], { radius: 12 }],
  'galaxy-s24': ['Galaxy S24', 'galaxy', [1080, 2340], [360, 780], 419, [70.6, 147.0]],
  'galaxy-a55': ['Galaxy A55', 'galaxy', [1080, 2340], [384, 832], 390, [77.4, 161.1], { radius: 28 }],
  'galaxy-z-fold8-ultra': ['Galaxy Z Fold8 Ultra (open)', 'galaxy', [2256, 2504], [802, 890], 422, [143.2, 158.4], { radius: 16, cutout: { kind: 'punch', w: 9, h: 9, top: 10, x: 'right' }, buttons: [['right', 0.25, 0.12], ['right', 0.4, 0.07]] }],
  'galaxy-z-fold8-ultra-cover': ['Galaxy Z Fold8 Ultra (folded)', 'galaxy', [1080, 2520], [360, 840], 423, [72.8, 158.4], { radius: 28 }],
  // The Fold8 is wide: open, its screen is landscape.
  'galaxy-z-fold8': ['Galaxy Z Fold8 (open)', 'galaxy', [1848, 2448], [657, 870], 403, [123.9, 161.4], { radius: 16, cutout: { kind: 'punch', w: 9, h: 9, top: 10, x: 'right' }, buttons: [['right', 0.25, 0.12], ['right', 0.4, 0.07]] }],
  'galaxy-z-fold8-cover': ['Galaxy Z Fold8 (folded)', 'galaxy', [1248, 1972], [444, 701], 428, [81.9, 123.9], { radius: 28 }],
  'galaxy-z-flip8': ['Galaxy Z Flip8 (open)', 'galaxy', [1080, 2520], [360, 840], 400, [75.4, 166.9], { radius: 28 }],
  'galaxy-z-flip6': ['Galaxy Z Flip6 (open)', 'galaxy', [1080, 2640], [360, 880], 425, [71.9, 165.1], { radius: 28 }],
  'galaxy-z-fold6-cover': ['Galaxy Z Fold6 (folded)', 'galaxy', [968, 2376], [344, 845], 410, [68.1, 153.5], { radius: 24 }],
  'galaxy-z-fold6': ['Galaxy Z Fold6 (open)', 'galaxy', [1856, 2160], [660, 768], 374, [132.6, 153.5], { radius: 16, cutout: { kind: 'punch', w: 9, h: 9, top: 10, x: 'right' }, buttons: [['right', 0.25, 0.12], ['right', 0.4, 0.07]] }],
  'galaxy-tab-s10-ultra': ['Galaxy Tab S10 Ultra', 'galaxyTab', [1848, 2960], [924, 1480], 239, [208.6, 326.4]],
  'galaxy-tab-s10-plus': ['Galaxy Tab S10+', 'galaxyTab', [1752, 2800], [876, 1400], 266, [185.4, 285.4]],
  'galaxy-tab-s9': ['Galaxy Tab S9', 'galaxyTab', [1600, 2560], [800, 1280], 274, [165.8, 254.3]],
  'galaxy-tab-a9-plus': ['Galaxy Tab A9+', 'galaxyTab', [1200, 1920], [800, 1280], 206, [168.7, 257.1]],
};

/**
 * Every device, by id: `{ id, name, brand, os, type, px, viewport, screen (points),
 * dpr, ppi, mm, bezel: { x, y } (points), radius, ... }`, portrait.
 */
export const DEVICES = Object.fromEntries(Object.entries(LIST).map(([id, [name, family, px, viewport, ppi, mm, extra = {}]]) => {
  const f = FAMILY[family];
  const dpr = px[0] / viewport[0];
  // Millimetres per point: a point is `dpr` pixels, at `ppi` pixels an inch.
  const mmPerPt = (25.4 * dpr) / ppi;
  // The screen in points, from its pixels: the viewport is rounded to whole points.
  const screen = [px[0] / dpr, px[1] / dpr];
  const bezel = {
    x: Math.max(2, (mm[0] / mmPerPt - screen[0]) / 2),
    y: Math.max(2, (mm[1] / mmPerPt - screen[1]) / 2),
  };
  const brand = family === 'pixel' || id === 'pixel-tablet' ? 'Google' : f.os === 'android' ? 'Samsung' : 'Apple';
  return [id, { id, name, brand, family, ...f, ...extra, px, viewport, screen, dpr, ppi, mm, bezel }];
}));

/** Menu groups, in order. */
export const GROUPS = [
  ['iPhone', (d) => d.os === 'ios'],
  ['iPad', (d) => d.os === 'ipados'],
  ['Google Pixel', (d) => d.brand === 'Google' && d.type === 'phone'],
  ['Samsung Galaxy', (d) => d.brand === 'Samsung' && d.type === 'phone'],
  [t('group_android_tablets'), (d) => d.os === 'android' && d.type === 'tablet'],
];

/** Earlier versions' generic devices. */
export const LEGACY = { phone: 'iphone-17-pro', android: 'pixel-10', tablet: 'ipad-air-11' };

export const DEFAULT_DEVICE = 'iphone-17-pro';

/**
 * The device that best fits a `w` × `h` capture: one whose screen is exactly that
 * many pixels (a screenshot taken on it, or in DevTools' device mode), else one as
 * wide in pixels, else the closest shape (the first such device, so the newest). Returns
 * `{ id, landscape, exact }`.
 */
export function matchDevice(w, h) {
  let best = null;
  for (const d of Object.values(DEVICES)) {
    for (const landscape of [false, true]) {
      const [pw, ph] = landscape ? [d.px[1], d.px[0]] : d.px;
      const [vw, vh] = landscape ? [d.viewport[1], d.viewport[0]] : d.viewport;
      const exact = Math.abs(pw - w) <= 2 && Math.abs(ph - h) <= 2;
      // As wide as the screen and at least as tall: a full-page screenshot taken on it.
      const sameWidth = Math.abs(pw - w) <= 2 && h >= ph - 2;
      const shape = Math.abs(Math.log((w / h) / (vw / vh)));
      const score = exact ? -2 : sameWidth ? -1 + shape / 100 : shape;
      if (!best || score < best.score) best = { id: d.id, landscape, exact, score };
    }
  }
  return { id: best.id, landscape: best.landscape, exact: best.exact };
}
