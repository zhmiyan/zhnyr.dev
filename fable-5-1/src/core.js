/* fable-5-1 / core.js
 * tiny exhibit runtime: demos register themselves, the page mounts them lazily
 * when they scroll into view and pauses them when they leave.
 *
 * CONTRACT for a demo module (src/demos/<name>.js):
 *
 *   FABLE.register('<name>', {
 *     mount(el) {
 *       // el is an empty <div class="stage"> that already has a size
 *       // (use el.clientWidth / el.clientHeight, watch it with ResizeObserver).
 *       // build your canvas / DOM inside el. nothing outside el.
 *       return {
 *         resume() {},   // called when the stage is on screen (start rAF loops here)
 *         pause()  {},   // called when it scrolls away (stop rAF loops, keep state)
 *         destroy() {}   // tear everything down (listeners, audio, GL contexts)
 *       };
 *     }
 *   });
 *
 * - no external libraries; vanilla JS, WebGL1/2, Canvas 2D, Web Audio only.
 * - respect FABLE.reducedMotion (boolean): if true, do not auto-animate; still
 *   render a static frame and let user interaction drive things.
 * - use FABLE.dpr() for canvas backing-store scale (capped for perf).
 * - never throw out of mount(); catch and show a friendly message with
 *   FABLE.fail(el, 'webgl is not available here') if something is unsupported.
 * - shared classes you may use inside el: .hud (absolute bottom-left bar),
 *   .hud.top-right, .btn, .btn.primary, .chip, .mono, .kbd.
 */
window.FABLE = (() => {
  const defs = new Map();
  const live = new Map(); // el -> handle
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function register(name, def) {
    defs.set(name, def);
    document.dispatchEvent(new CustomEvent('fable:registered', { detail: name }));
  }

  function dpr(max = 2) {
    return Math.min(max, window.devicePixelRatio || 1);
  }

  function fail(el, msg) {
    el.innerHTML = `<div class="stage-fail mono">${msg}</div>`;
  }

  function mountInto(el) {
    const name = el.dataset.demo;
    const def = defs.get(name);
    if (!def || live.has(el)) return null;
    let handle = null;
    try {
      handle = def.mount(el) || {};
    } catch (err) {
      console.error(`[fable] ${name} failed to mount`, err);
      fail(el, `${name} could not start: ${err.message}`);
      handle = {};
    }
    live.set(el, handle);
    el.classList.add('is-live');
    return handle;
  }

  function boot(root = document) {
    const stages = [...root.querySelectorAll('[data-demo]')];
    const io = new IntersectionObserver((entries) => {
      for (const { target, isIntersecting } of entries) {
        let h = live.get(target);
        if (isIntersecting) {
          if (!h) h = mountInto(target);
          h && h.resume && h.resume();
        } else if (h && h.pause) {
          h.pause();
        }
      }
    }, { rootMargin: '160px 0px' });
    stages.forEach((s) => io.observe(s));
    document.addEventListener('visibilitychange', () => {
      for (const h of live.values()) {
        if (document.hidden) h.pause && h.pause();
        else h.resume && h.resume();
      }
    });
  }

  return { register, mountInto, boot, dpr, fail, reducedMotion, defs, live };
})();
