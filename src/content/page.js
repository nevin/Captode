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
