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
    tip.textContent = hint + '  ·  Esc to cancel';
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

/** Prepares the page for a scrolling capture and reports its size. */
export function fullPagePrepare() {
  const de = document.documentElement;
  const state = {
    x: window.scrollX,
    y: window.scrollY,
    behavior: de.style.scrollBehavior,
  };
  window.__captodeState = state;
  de.style.scrollBehavior = 'auto';
  const style = document.createElement('style');
  style.id = '__captode_fp';
  style.textContent =
    'html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}' +
    'html,body{scrollbar-width:none!important}';
  document.documentElement.appendChild(style);
  const body = document.body || de;
  return {
    width: Math.max(de.scrollWidth, body.scrollWidth, de.clientWidth),
    height: Math.max(de.scrollHeight, body.scrollHeight, de.clientHeight),
    vw: window.innerWidth,
    vh: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  };
}

/** Scrolls to (x, y), hiding fixed and sticky elements after the first tile. */
export function fullPageScroll(x, y, hideFixed) {
  return new Promise((resolve) => {
    if (hideFixed && !window.__captodeHidden) {
      window.__captodeHidden = [];
      for (const el of document.querySelectorAll('body *')) {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          window.__captodeHidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
          el.style.setProperty('visibility', 'hidden', 'important');
        }
      }
    }
    window.scrollTo(x, y);
    // Give lazy content and repaint a moment before the tile is captured.
    setTimeout(() => requestAnimationFrame(() => resolve({ x: window.scrollX, y: window.scrollY })), 120);
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
    window.scrollTo(s.x, s.y);
    document.documentElement.style.scrollBehavior = s.behavior;
  }
}

/** Shows a 3-2-1 countdown and resolves once it has left the screen. */
export function countdown(seconds) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
      'pointer-events:none;font:700 140px system-ui,sans-serif;color:#fff;text-shadow:0 8px 40px rgba(0,0,0,.5);' +
      'background:rgba(15,15,25,.25);';
    document.documentElement.appendChild(el);
    let n = seconds;
    const tick = () => {
      if (n === 0) {
        el.remove();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
        return;
      }
      el.textContent = n--;
      setTimeout(tick, 1000);
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
