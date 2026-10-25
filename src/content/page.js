// Functions injected into the captured page with chrome.scripting.executeScript.
// Each is serialised on its own, so none may refer to anything outside its body.

/** Lets the user drag out a rectangle. Resolves to the rectangle or null on Esc. */
export function pickArea(hint) {
  return new Promise((resolve) => {
    const old = document.getElementById('__captode_pick');
    if (old) old.remove();

    const root = document.createElement('div');
    root.id = '__captode_pick';
    root.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;user-select:none;touch-action:none;' +
      'background:rgba(15,15,25,.35);font:13px system-ui,sans-serif;';
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;display:none;border:2px solid #5b4bff;box-sizing:border-box;' +
      'box-shadow:0 0 0 9999px rgba(15,15,25,.35);background:transparent;';
    const label = document.createElement('div');
    label.style.cssText =
      'position:fixed;display:none;padding:3px 7px;border-radius:5px;background:#5b4bff;color:#fff;';
    const tip = document.createElement('div');
    tip.textContent = hint; // with how to cancel, in the browser's language
    tip.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:8px;' +
      'background:#17171c;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.3);pointer-events:none;';
    root.append(box, label, tip);
    document.documentElement.appendChild(root);

    let start = null;
    let rect = null;

    const finish = (value) => {
      window.removeEventListener('keydown', onKey, true);
      root.remove();
      // Two frames so the overlay is gone from the screen before anything is captured.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(value)));
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
    };
    window.addEventListener('keydown', onKey, true);

    // Pointer events, so a finger or pen works as well as a mouse (touchscreen
    // Chromebooks and Windows tablets).
    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || start) return;
      e.preventDefault();
      root.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      root.style.background = 'transparent';
      tip.style.display = 'none';
    });
    root.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const x = Math.min(start.x, e.clientX);
      const y = Math.min(start.y, e.clientY);
      const w = Math.abs(e.clientX - start.x);
      const h = Math.abs(e.clientY - start.y);
      rect = { x, y, w, h };
      Object.assign(box.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      label.textContent = Math.round(w) + ' × ' + Math.round(h);
      Object.assign(label.style, {
        display: 'block',
        left: x + 'px',
        top: (y > 30 ? y - 28 : y + h + 6) + 'px',
      });
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      if (e.type === 'pointercancel' || !rect || rect.w < 4 || rect.h < 4) {
        rect = null;
        box.style.display = label.style.display = 'none';
        root.style.background = 'rgba(15,15,25,.35)';
        tip.style.display = 'block';
        return;
      }
      finish({ ...rect, vw: window.innerWidth, vh: window.innerHeight });
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
  });
}

/**
 * Lets the user pick one element: the one under the pointer is outlined, ↑ chooses the
 * larger one around it and ↓ goes back; a click or Enter takes it, Esc cancels (null).
 * The element is scrolled into view if it fits; resolves to its box in the viewport
 * `{ x, y, w, h, vw, vh, top, left }` (top and left in the document, CSS pixels).
 */
export function pickElement(hint) {
  return new Promise((resolve) => {
    document.getElementById('__captode_pick')?.remove();
    const root = document.createElement('div');
    root.id = '__captode_pick';
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:pointer;font:13px system-ui,sans-serif;';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;display:none;border:2px solid #5b4bff;background:rgba(91,75,255,.12);box-sizing:border-box;pointer-events:none;border-radius:2px;';
    const label = document.createElement('div');
    label.style.cssText = 'position:fixed;display:none;padding:3px 7px;border-radius:5px;background:#5b4bff;color:#fff;pointer-events:none;white-space:nowrap;';
    const tip = document.createElement('div');
    tip.textContent = hint;
    tip.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:8px;' +
      'background:#17171c;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.3);pointer-events:none;';
    root.append(box, label, tip);
    document.documentElement.appendChild(root);

    let chain = []; // the element under the pointer, then its ancestors as ↑ chooses them
    let level = 0;
    const current = () => chain[level];
    const under = (x, y) => {
      root.style.pointerEvents = 'none';
      const el = document.elementFromPoint(x, y);
      root.style.pointerEvents = '';
      return el && el !== document.documentElement ? el : null;
    };
    const show = () => {
      const el = current();
      if (!el) { box.style.display = label.style.display = 'none'; return; }
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '';
      label.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : cls) + '  ' + Math.round(r.width) + ' × ' + Math.round(r.height);
      Object.assign(label.style, { display: 'block', left: Math.max(4, r.left) + 'px', top: (r.top > 30 ? r.top - 26 : Math.min(innerHeight - 26, r.bottom + 4)) + 'px' });
    };
    const finish = (el) => {
      removeEventListener('keydown', onKey, true);
      removeEventListener('scroll', show, true);
      root.remove();
      if (!el) return resolve(null);
      // Bring it into view when it fits, so one screenshot holds it.
      const r0 = el.getBoundingClientRect();
      if (r0.height <= innerHeight && r0.width <= innerWidth) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        resolve({ x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, top: r.top + scrollY, left: r.left + scrollX });
      }));
    };
    const onKey = (e) => {
      const keys = {
        Escape: () => finish(null),
        Enter: () => current() && finish(current()),
        ArrowUp: () => {
          const parent = current()?.parentElement;
          if (!parent || parent === document.documentElement) return;
          if (level === chain.length - 1) chain.push(parent);
          level++;
          show();
        },
        ArrowDown: () => { if (level > 0) { level--; show(); } },
      };
      if (!keys[e.key]) return;
      e.preventDefault();
      e.stopPropagation();
      keys[e.key]();
    };
    addEventListener('keydown', onKey, true);
    addEventListener('scroll', show, true);
    root.addEventListener('pointermove', (e) => {
      const el = under(e.clientX, e.clientY);
      if (el && el !== chain[0]) { chain = [el]; level = 0; show(); }
    });
    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const el = under(e.clientX, e.clientY);
      if (!current() && el) { chain = [el]; level = 0; }
      if (current()) finish(current());
    });
  });
}

/**
 * Prepares the page for a scrolling capture and reports its size. Many web apps (mail,
 * chat, documents, dashboards) don't scroll the window but a panel inside it; then the
 * largest such panel is captured instead, at its full height:
 * `{ panel: { x, y, w, h }, height }` in CSS pixels, the panel's box in the viewport.
 */
export function fullPagePrepare() {
  const de = document.documentElement;
  const body = document.body || de;
  const style = document.createElement('style');
  style.id = '__captode_fp';
  style.textContent =
    'html::-webkit-scrollbar,body::-webkit-scrollbar,[data-captode-panel]::-webkit-scrollbar{display:none!important}' +
    'html,body,[data-captode-panel]{scrollbar-width:none!important;scroll-behavior:auto!important}';
  const vw = window.innerWidth, vh = window.innerHeight;
  const docHeight = Math.max(de.scrollHeight, body.scrollHeight, de.clientHeight);

  // The panel that scrolls furthest among those covering a good part of the window,
  // if it scrolls further than the window itself does.
  let panel = null, panelArea = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (el.scrollHeight - el.clientHeight < 40 || el.clientHeight < 100) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
    const r = el.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (area < vw * vh * 0.3 || area <= panelArea) continue;
    panel = el;
    panelArea = area;
  }
  if (panel && panel.scrollHeight - panel.clientHeight <= docHeight - vh) panel = null;

  window.__captodeState = { x: window.scrollX, y: window.scrollY, behavior: de.style.scrollBehavior, panel, top: panel?.scrollTop };
  de.style.scrollBehavior = 'auto';
  if (panel) panel.setAttribute('data-captode-panel', '');
  de.appendChild(style);
  const dpr = window.devicePixelRatio || 1;
  if (panel) {
    // The panel's inside, without borders or a scrollbar (hidden above), on screen.
    const r = panel.getBoundingClientRect();
    const x = Math.max(0, r.left + panel.clientLeft), y = Math.max(0, r.top + panel.clientTop);
    const w = Math.min(panel.clientWidth, vw - x), h = Math.min(panel.clientHeight, vh - y);
    return { panel: { x, y, w, h }, width: w, height: panel.scrollHeight, vw, vh, dpr };
  }
  return { width: Math.max(de.scrollWidth, body.scrollWidth, de.clientWidth), height: docHeight, vw, vh, dpr };
}

/**
 * Where the page shows details that may be private: email addresses, phone numbers and
 * card numbers, in text or in form fields. Boxes are in CSS pixels from the top left of
 * `region`, which is in the viewport ('viewport'), the whole page ('document') or the
 * panel being captured at full height ('panel'). Nothing leaves the page but the boxes.
 */
export function findPrivate(region, space) {
  const panel = space === 'panel' ? window.__captodeState?.panel : null;
  if (space === 'panel' && !panel) return [];
  let ox = 0, oy = 0;
  if (space === 'document') { ox = window.scrollX; oy = window.scrollY; }
  if (panel) {
    const r = panel.getBoundingClientRect();
    ox = -(r.left + panel.clientLeft);
    oy = panel.scrollTop - (r.top + panel.clientTop);
  }
  const out = [];
  const add = (rect, kind) => {
    if (out.length >= 300 || rect.width < 2 || rect.height < 2) return;
    let x = rect.left + ox - region.x, y = rect.top + oy - region.y, w = rect.width, h = rect.height;
    if (x + w <= 0 || y + h <= 0 || x >= region.w || y >= region.h) return;
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    w = Math.min(region.w, x + w) - x0; h = Math.min(region.h, y + h) - y0;
    out.push({ x: x0, y: y0, w, h, kind });
  };

  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
  // Whole numbers only: not the start or end of a longer one ("4242 4242 4242" in a
  // 16-digit tracking number isn't a phone number).
  const CARD = /(?<![\d.,]|\d[ -])\d(?:[ -]?\d){12,18}(?![\d.,]|[ -]\d)/g;
  const PHONE = /(?<![\w.,/-]|\d[\s.-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,5}(?:[\s.-]\d{2,5}){1,4}(?![\w.,/-]|[\s.-]\d)/g;
  const digits = (m) => m.replace(/\D/g, '');
  const luhn = (d) => {
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    return sum % 10 === 0;
  };
  const isCard = (m) => { const d = digits(m); return d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d); };
  // A phone number has a country code, an area code in brackets, or 10 to 12 digits in
  // groups; dates, times, years and sums of money don't count.
  const isPhone = (m) => {
    const d = digits(m);
    if (d.length < 8 || d.length > 15 || isCard(m)) return false;
    if (/^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/.test(m.trim())) return false;
    return /^\s*[+(]/.test(m) || (d.length >= 10 && d.length <= 12);
  };
  const scan = (text) => {
    const found = [];
    for (const m of text.matchAll(EMAIL)) found.push([m.index, m[0].length, 'email']);
    for (const m of text.matchAll(CARD)) if (isCard(m[0])) found.push([m.index, m[0].length, 'card']);
    for (const m of text.matchAll(PHONE)) {
      const at = m.index, len = m[0].length;
      if (isPhone(m[0]) && !found.some(([i, l]) => at < i + l && i < at + len)) found.push([at, len, 'phone']);
    }
    return found;
  };

  const root = panel || document.body;
  if (!root) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const el = n.parentElement;
      if (!el || n.nodeValue.trim().length < 6) return NodeFilter.FILTER_REJECT;
      if (el.closest('script,style,noscript,template,textarea,[id^="__captode"]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const range = document.createRange();
  for (let n = walker.nextNode(); n && out.length < 300; n = walker.nextNode()) {
    for (const [at, len, kind] of scan(n.nodeValue)) {
      range.setStart(n, at);
      range.setEnd(n, at + len);
      for (const rect of range.getClientRects()) add(rect, kind);
    }
  }
  // Form fields: by their type or autofill purpose, or by what is typed in them.
  for (const el of root.querySelectorAll('input:not([type=hidden]):not([type=password]), textarea')) {
    const ac = el.getAttribute('autocomplete') || '';
    const typed = el.value || '';
    const kind = el.type === 'email' || /email/.test(ac) ? 'email'
      : el.type === 'tel' || /\btel/.test(ac) ? 'phone'
      : /cc-number/.test(ac) ? 'card'
      : scan(typed)[0]?.[2];
    if (kind && typed.trim()) add(el.getBoundingClientRect(), kind);
  }
  return out;
}

/**
 * The words the page shows inside `region` (as for findPrivate), to copy from the
 * screenshot later: [[x, y, w, h, text], …] in CSS pixels from the region's top left.
 * A run of text on one line is one box; text that wraps is split into words. Kept with
 * the capture on this device, like the picture itself.
 */
export function findText(region, space) {
  const panel = space === 'panel' ? window.__captodeState?.panel : null;
  if (space === 'panel' && !panel) return [];
  let ox = 0, oy = 0;
  if (space === 'document') { ox = window.scrollX; oy = window.scrollY; }
  if (panel) {
    const r = panel.getBoundingClientRect();
    ox = -(r.left + panel.clientLeft);
    oy = panel.scrollTop - (r.top + panel.clientTop);
  }
  const MAX = 40000;
  const out = [];
  const inside = (rect) => {
    const cx = rect.left + ox - region.x + rect.width / 2, cy = rect.top + oy - region.y + rect.height / 2;
    return rect.width >= 1 && rect.height >= 1 && cx >= 0 && cy >= 0 && cx <= region.w && cy <= region.h;
  };
  const add = (rect, text) => {
    out.push([rect.left + ox - region.x, rect.top + oy - region.y, rect.width, rect.height, text]);
  };
  const root = panel || document.body;
  if (!root) return out;
  const seen = new Map(); // element → shown, checked once
  const shown = (el) => {
    if (!seen.has(el)) seen.set(el, el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true);
    return seen.get(el);
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const el = n.parentElement;
      if (!el || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (el.closest('script,style,noscript,template,textarea,select,[id^="__captode"]') || !shown(el)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const range = document.createRange();
  for (let n = walker.nextNode(); n && out.length < MAX; n = walker.nextNode()) {
    range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter((r) => r.width >= 1 && r.height >= 1);
    if (!rects.length || !rects.some(inside)) continue;
    if (rects.length === 1) { add(rects[0], n.nodeValue.replace(/\s+/g, ' ').trim()); continue; }
    for (const m of n.nodeValue.matchAll(/\S+/g)) {
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      const r = range.getBoundingClientRect();
      if (inside(r)) add(r, m[0]);
      if (out.length >= MAX) break;
    }
  }
  return out.filter((b) => inside({ left: b[0] - ox + region.x, top: b[1] - oy + region.y, width: b[2], height: b[3] }));
}

/**
 * Scrolls to (x, y), the window or the panel being captured. After the first tile it
 * hides what would repeat on every tile: fixed and sticky elements (inside the panel,
 * or floating over it), but never one that holds the panel.
 */
export function fullPageScroll(x, y, hideFixed) {
  return new Promise((resolve) => {
    const panel = window.__captodeState?.panel;
    if (hideFixed && !window.__captodeHidden) {
      window.__captodeHidden = [];
      for (const el of document.querySelectorAll('body *')) {
        if (panel && el.contains(panel)) continue;
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          window.__captodeHidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
          el.style.setProperty('visibility', 'hidden', 'important');
        }
      }
    }
    if (panel) panel.scrollTop = y;
    else window.scrollTo(x, y);
    // Give lazy content and repaint a moment before the tile is captured.
    setTimeout(() => requestAnimationFrame(() => resolve(panel ? { x: 0, y: panel.scrollTop } : { x: window.scrollX, y: window.scrollY })), 120);
  });
}

export function fullPageRestore() {
  for (const [el, value, prio] of window.__captodeHidden || []) {
    if (value) el.style.setProperty('visibility', value, prio);
    else el.style.removeProperty('visibility');
  }
  window.__captodeHidden = null;
  document.getElementById('__captode_fp')?.remove();
  const s = window.__captodeState;
  if (s) {
    if (s.panel) {
      s.panel.removeAttribute('data-captode-panel');
      s.panel.scrollTop = s.top;
    }
    window.scrollTo(s.x, s.y);
    document.documentElement.style.scrollBehavior = s.behavior;
  }
  window.__captodeState = null;
}

/**
 * Shows a countdown (…3, 2, 1) and resolves true once it has left the screen, or
 * false if the user pressed Esc to cancel.
 */
export function countdown(seconds, hintText = 'Recording starts soon · Esc to cancel') {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.id = '__captode_countdown';
    el.setAttribute('role', 'timer');
    el.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'pointer-events:none;font:700 140px system-ui,sans-serif;color:#fff;text-shadow:0 8px 40px rgba(0,0,0,.5);' +
      'background:rgba(15,15,25,.25);';
    const num = document.createElement('div');
    const hint = document.createElement('div');
    hint.textContent = hintText;
    hint.style.cssText = 'font:500 15px system-ui,sans-serif;margin-top:8px;padding:6px 12px;border-radius:999px;background:rgba(0,0,0,.45);text-shadow:none;';
    el.append(num, hint);
    document.documentElement.appendChild(el);
    let n = seconds;
    let timer;
    const finish = (started) => {
      clearTimeout(timer);
      removeEventListener('keydown', onKey, true);
      el.remove();
      if (started) requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      else resolve(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    addEventListener('keydown', onKey, true);
    const tick = () => {
      if (n === 0) return finish(true);
      num.textContent = n--;
      timer = setTimeout(tick, 1000);
    };
    tick();
  });
}

/**
 * Waits `seconds` before a screenshot, so a menu or tooltip can be opened first. A small
 * pill in the corner counts down (it ignores the pointer, so hovering isn't disturbed)
 * and is gone from the screen before resolving true; Esc cancels (false). If another tab
 * is showing when the time is up, it resolves 'hidden' at once: hidden pages draw no
 * frames, and the screenshot must not be taken later, by surprise.
 * `text` has {n} where the seconds go.
 */
export function captureDelay(seconds, text) {
  return new Promise((resolve) => {
    document.getElementById('__captode_delay')?.remove();
    const el = document.createElement('div');
    el.id = '__captode_delay';
    el.setAttribute('role', 'timer');
    el.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:2147483647;pointer-events:none;padding:7px 12px;border-radius:999px;' +
      'background:rgba(23,23,28,.88);color:#fff;font:600 13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);';
    document.documentElement.appendChild(el);
    let n = seconds;
    let timer;
    const finish = (result) => {
      clearTimeout(timer);
      removeEventListener('keydown', onKey, true);
      el.remove();
      if (result === true) requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      else resolve(result);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    addEventListener('keydown', onKey, true);
    const tick = () => {
      if (n === 0 && document.hidden) return finish('hidden');
      if (n === 0) return finish(true);
      el.textContent = text.replace('{n}', n--);
      timer = setTimeout(tick, 1000);
    };
    tick();
  });
}

/**
 * While a tab is recorded: a ripple where each click lands, and a label for keyboard
 * shortcuts (⌘K, Ctrl+Shift+P) and named keys (Enter, Tab, Esc, arrows). Plain typing
 * is never shown, and nothing at all while a password field has focus. With `cursor`,
 * a soft circle also follows the mouse. Drawn in the page, so the recording shows it;
 * `on` false removes it.
 */
export function showInputs(on, { clicks = true, cursor = false } = {}) {
  window.__captodeInputs?.();
  if (!on || (!clicks && !cursor)) return;
  const host = document.createElement('div');
  host.id = '__captode_inputs';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' }); // the page's styles can't reach it
  root.innerHTML = `<style>
    .ripple{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #5b4bff;background:rgba(91,75,255,.25);box-sizing:border-box;animation:r .6s ease-out forwards}
    @keyframes r{from{transform:scale(.35);opacity:1}to{transform:scale(1.5);opacity:0}}
    .keys{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);padding:8px 16px;border-radius:10px;background:rgba(23,23,28,.88);color:#fff;font:600 20px system-ui,sans-serif;letter-spacing:.02em;box-shadow:0 6px 20px rgba(0,0,0,.25);transition:opacity .25s}
    .keys.out{opacity:0}
    .cursor{position:fixed;left:0;top:0;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;background:rgba(255,214,10,.35);border:2px solid rgba(255,190,0,.75);box-sizing:border-box;opacity:0;transition:opacity .2s;will-change:transform}
    .cursor.on{opacity:1}
  </style>`;
  document.documentElement.appendChild(host);

  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const NAMED = {
    Enter: 'Enter', Tab: 'Tab', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', ' ': 'Space',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PageUp: 'Page Up', PageDown: 'Page Down', Home: 'Home', End: 'End',
  };
  let pill = null, fade = 0;
  const onDown = (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.left = e.clientX + 'px';
    r.style.top = e.clientY + 'px';
    root.append(r);
    setTimeout(() => r.remove(), 650);
  };
  const onKey = (e) => {
    if (e.repeat || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    const field = e.composedPath()[0];
    if (field?.type === 'password' || document.activeElement?.type === 'password') return;
    const mods = e.ctrlKey || e.metaKey || e.altKey;
    const name = NAMED[e.key] || (/^F\d{1,2}$/.test(e.key) ? e.key : null);
    if (!mods && !name) return; // typing: never shown
    if (!mods && e.key === ' ') return; // a space while typing
    const key = name || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    const parts = mac
      ? [e.ctrlKey && '⌃', e.altKey && '⌥', e.shiftKey && '⇧', e.metaKey && '⌘', key].filter(Boolean).join('')
      : [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win', key].filter(Boolean).join('+');
    if (!pill) { pill = document.createElement('div'); pill.className = 'keys'; root.append(pill); }
    pill.textContent = parts;
    pill.classList.remove('out');
    clearTimeout(fade);
    fade = setTimeout(() => pill.classList.add('out'), 1200);
  };
  let dot = null;
  const onMove = (e) => {
    if (e.pointerType !== 'mouse') return;
    dot.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    dot.classList.add('on');
  };
  const onLeave = (e) => { if (!e.relatedTarget) dot.classList.remove('on'); };
  if (cursor) {
    dot = document.createElement('div');
    dot.className = 'cursor';
    root.append(dot);
    addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerout', onLeave, true);
  }
  if (clicks) {
    addEventListener('pointerdown', onDown, true);
    addEventListener('keydown', onKey, true);
  }
  window.__captodeInputs = () => {
    removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerout', onLeave, true);
    removeEventListener('pointerdown', onDown, true);
    removeEventListener('keydown', onKey, true);
    clearTimeout(fade);
    host.remove();
    window.__captodeInputs = null;
  };
}

/**
 * While the tab is recorded: tells the background where each click lands (as
 * fractions of the view, with the time), so the video page can zoom in on clicks.
 * Nothing else about the page is sent. `on` false stops it.
 */
export function trackClicks(on) {
  window.__captodeClicks?.();
  if (!on) return;
  // What was clicked, in the page's own words, for the step-by-step guide: a button's or
  // link's text, or a field's name. Never what is typed in a field, and nothing for
  // password fields or Captode's own drawing layer.
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const labelOf = (target) => {
    const el = target instanceof Element ? target : null;
    if (!el) return {};
    const field = el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    if (field) {
      if (field.type === 'password' || field.autocomplete?.includes('password')) return {};
      if (['button', 'submit', 'reset'].includes(field.type)) return { label: clean(field.value || field.getAttribute('aria-label')) };
      const named = field.getAttribute('aria-label') || field.labels?.[0]?.innerText || field.getAttribute('placeholder') || field.getAttribute('title');
      return { label: clean(named), field: true };
    }
    const hit = el.closest('button, a, summary, label, [role=button], [role=link], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=switch], [role=radio]');
    if (!hit) return {};
    return { label: clean(hit.getAttribute('aria-label') || hit.innerText || hit.getAttribute('title') || hit.querySelector('img[alt]')?.alt) };
  };
  const down = (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target?.closest?.('#__captode_draw')) return;
    chrome.runtime.sendMessage({ type: 'rec-click', x: e.clientX / innerWidth, y: e.clientY / innerHeight, at: Date.now(), ...labelOf(e.target) }).catch(() => {});
  };
  addEventListener('pointerdown', down, true);
  window.__captodeClicks = () => { removeEventListener('pointerdown', down, true); window.__captodeClicks = null; };
}

/** Draws a dashed outline just outside the recorded area, so it is never recorded. */
export function showOutline(rect) {
  document.getElementById('__captode_outline')?.remove();
  if (!rect) return;
  const el = document.createElement('div');
  el.id = '__captode_outline';
  el.style.cssText =
    'position:fixed;z-index:2147483646;pointer-events:none;border:2px dashed #e5484d;' +
    `left:${rect.x - 3}px;top:${rect.y - 3}px;width:${rect.w + 6}px;height:${rect.h + 6}px;box-sizing:border-box;`;
  document.documentElement.appendChild(el);
}

export function hideOutline() {
  document.getElementById('__captode_outline')?.remove();
}

/**
 * Puts a screenshot (PNG, as base64) on the clipboard from the page it was taken of,
 * which has the focus the clipboard needs, and says so for a moment. Resolves false if
 * the page can't (an insecure page, say): the editor then copies it instead.
 */
export async function copyImageHere(base64, label) {
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  } catch {
    return false;
  }
  const note = document.createElement('div');
  note.textContent = label;
  note.setAttribute('role', 'status');
  note.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;border-radius:10px;background:rgba(23,23,28,.92);color:#fff;font:500 14px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);pointer-events:none;';
  document.documentElement.appendChild(note);
  setTimeout(() => note.remove(), 1800);
  return true;
}

/**
 * Turns drawing on the page on or off while recording (`on` left out: the other way):
 * strokes in red that fade a moment after each is drawn, so they show in the recording
 * without anything to clear. Esc stops drawing. `on`: true, false or 'toggle'. Returns
 * whether drawing is on.
 */
export function drawLayer(on, hint) {
  const old = document.getElementById('__captode_draw');
  if (on !== true && on !== false) on = !old; // 'toggle'
  if (!on) { old?.__stop?.(); return false; }
  if (old) return true;
  const dpr = devicePixelRatio || 1;
  const c = document.createElement('canvas');
  c.id = '__captode_draw';
  c.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;cursor:crosshair;touch-action:none;background:transparent;';
  const ctx = c.getContext('2d');
  const size = () => { c.width = Math.round(innerWidth * dpr); c.height = Math.round(innerHeight * dpr); };
  size();
  const strokes = []; // { points: [[x, y]], end: time it was finished, or 0 while drawn }
  let current = null;
  let frame = 0;
  const HOLD = 1500, FADE = 800;
  const paint = () => {
    frame = 0;
    const now = performance.now();
    ctx.clearRect(0, 0, c.width, c.height);
    for (let i = strokes.length - 1; i >= 0; i--) if (strokes[i].end && now - strokes[i].end > HOLD + FADE) strokes.splice(i, 1);
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const s of strokes) {
      const a = s.end ? Math.max(0, Math.min(1, 1 - (now - s.end - HOLD) / FADE)) : 1;
      ctx.globalAlpha = a;
      const p = s.points;
      // A white edge under the red, so it shows on dark and red pages alike.
      for (const [style, width] of [['rgba(255,255,255,.9)', 7], ['#e5484d', 4]]) {
        ctx.strokeStyle = style;
        ctx.lineWidth = width * dpr;
        ctx.beginPath();
        ctx.moveTo(p[0][0], p[0][1]);
        if (p.length === 1) ctx.lineTo(p[0][0] + 0.1, p[0][1]);
        for (let i = 1; i < p.length - 1; i++) ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
        if (p.length > 1) ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    if (strokes.length) frame = requestAnimationFrame(paint);
  };
  const again = () => { if (!frame) frame = requestAnimationFrame(paint); };
  const at = (e) => [e.clientX * dpr, e.clientY * dpr];
  c.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { c.setPointerCapture(e.pointerId); } catch { /* a pen lifted already */ }
    current = { points: [at(e)], end: 0 };
    strokes.push(current);
    again();
  });
  c.addEventListener('pointermove', (e) => {
    if (!current) return;
    for (const ev of e.getCoalescedEvents?.() || [e]) current.points.push(at(ev));
    again();
  });
  const finish = () => { if (current) { current.end = performance.now(); current = null; again(); } };
  c.addEventListener('pointerup', finish);
  c.addEventListener('pointercancel', finish);
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); } };
  addEventListener('keydown', key, true);
  addEventListener('resize', size);
  // A short hint, which fades before it gets in the way.
  const tip = document.createElement('div');
  tip.textContent = hint || '';
  tip.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;' +
    'background:rgba(20,20,26,.85);color:#fff;font:600 13px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:8px 12px;border-radius:999px;transition:opacity .4s;';
  const tipTimer = setTimeout(() => { tip.style.opacity = '0'; }, 1800);
  function stop() {
    cancelAnimationFrame(frame);
    clearTimeout(tipTimer);
    removeEventListener('keydown', key, true);
    removeEventListener('resize', size);
    c.remove();
    tip.remove();
  }
  c.__stop = stop;
  document.documentElement.append(c, ...(hint ? [tip] : []));
  return true;
}
