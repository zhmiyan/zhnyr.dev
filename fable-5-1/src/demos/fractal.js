/* fable-5-1 / demos/fractal.js — smooth Mandelbrot / Julia explorer (WebGL1/2, zero deps)
 * Smooth coloring: instead of the integer escape count n we use the continuous estimate
 * nu = n + 4 - log2(log2|z|^2) (bailout radius 256), which kills banding; sqrt(nu) then drives
 * a cyclic navy -> sapphire -> ice -> peach palette. Supersampling: once the camera is still we
 * render 3 more frames with 2x2 sub-pixel jitter and blend each into an RGBA8 target with
 * alpha 1/(k+1) (a running mean = 4 samples/pixel) before blitting, so edges stay clean. */
(() => {
  'use strict';

  const VERT = 'attribute vec2 aPos;void main(){gl_Position=vec4(aPos,0.,1.);}';
  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes, uCenter, uJulia, uJitter;
uniform float uScale, uMode;
uniform int uIter;
const int MAXI = 1500;
const vec3 INSIDE = vec3(0.016, 0.024, 0.062);
vec3 pal(float t) {
  vec3 navy = vec3(0.027, 0.047, 0.118), gem = vec3(0.173, 0.361, 1.0), sky = vec3(0.663, 0.824, 1.0),
       ice = vec3(0.945, 0.965, 1.0), peach = vec3(1.0, 0.851, 0.659), dusk = vec3(0.30, 0.15, 0.30);
  vec3 c = mix(navy, gem, smoothstep(0.0, 0.26, t));
  c = mix(c, sky, smoothstep(0.26, 0.44, t));
  c = mix(c, ice, smoothstep(0.44, 0.53, t));
  c = mix(c, peach, smoothstep(0.53, 0.66, t));
  c = mix(c, dusk, smoothstep(0.66, 0.84, t));
  return mix(c, navy, smoothstep(0.84, 1.0, t));
}
void main() {
  vec2 p = (gl_FragCoord.xy + uJitter - 0.5 * uRes) * uScale + uCenter;
  vec2 c, z;
  if (uMode < 0.5) {
    c = p; z = vec2(0.0);
    float x = c.x - 0.25, q = x * x + c.y * c.y;   // main cardioid + period-2 bulb: skip the loop
    if (q * (q + x) < 0.25 * c.y * c.y || (c.x + 1.0) * (c.x + 1.0) + c.y * c.y < 0.0625) {
      gl_FragColor = vec4(INSIDE, 1.0); return;
    }
  } else { c = uJulia; z = p; }
  float n = -1.0;
  for (int i = 0; i < MAXI; i++) {
    if (i >= uIter) break;
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    if (dot(z, z) > 65536.0) { n = float(i); break; }
  }
  if (n < 0.0) { gl_FragColor = vec4(INSIDE, 1.0); return; }
  float nu = n + 4.0 - log2(log2(dot(z, z)));
  gl_FragColor = vec4(pal(fract(sqrt(max(nu, 0.0)) * 0.09)), 1.0);
}`;
  const BLIT = 'precision mediump float;uniform sampler2D uTex;uniform vec2 uRes;' +
    'void main(){gl_FragColor=texture2D(uTex,gl_FragCoord.xy/uRes);}';

  const BASE = 2.6;                        // view height in complex units at 1x
  const MAX_ZOOM = 1e5, MIN_ZOOM = 0.45;   // beyond ~1e5 float32 pixels get blocky
  const JITTER = [[-0.25, -0.25], [0.25, 0.25], [0.25, -0.25], [-0.25, 0.25]];
  const HOME = { m: [-0.6, 0], j: [0, 0] };
  const TOURS = [                           // [re, im, zoom]
    [-0.743643887037151, 0.131825904205330, 1.6e4],  // seahorse valley
    [-0.1011, 0.9563, 5e3],                           // Misiurewicz point
    [-0.7746806106269039, -0.1374168856037867, 2e4],  // triple spiral
  ];
  const COARSE = matchMedia('(pointer: coarse)').matches;
  const HINT_CSS = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;' +
    'pointer-events:none;width:max-content;max-width:calc(100% - 32px);text-align:center;padding:10px 16px;border-radius:999px;' +
    'background:rgba(10,16,34,.74);border:1px solid var(--line2);color:var(--muted);font:500 12.5px/1.5 var(--font-mono);' +
    'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:opacity .5s ease';
  const HUD_HTML = `
    <div class="hud">
      <button class="btn sm" data-btn="mode" aria-pressed="false" title="toggle julia mode (J)">julia <span class="kbd">J</span></button>
      <button class="btn sm" data-btn="home" title="reset the view">home</button>
      <button class="btn sm" data-btn="tour" aria-pressed="false" title="fly to a pretty spot">tour</button>
    </div>
    <div class="hud top-right">
      <span class="chip" data-chip="prec" style="display:none;color:var(--warm)">float precision limit</span>
      <span class="chip">zoom <b data-chip="zoom">1.0×</b></span>
      <span class="chip">iter <b data-chip="iter">200</b></span>
      <span class="chip">fps <b data-chip="fps">—</b></span>
    </div>
    <div class="hint mono" style="${HINT_CSS}">${COARSE
      ? 'tap to take control · pinch to zoom · drag to pan · tap in julia mode to pick c'
      : 'click to take control · scroll to zoom · drag to pan · press <span class="kbd">J</span> for julia'}</div>`;

  const fmtZoom = (z) => (z >= 1000 ? z.toExponential(1).replace('e+', 'e') : z >= 10 ? z.toFixed(0) : z.toFixed(1)) + '×';

  function link(gl, vs, fs) {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    return p;
  }

  function build(el) {
    el.insertAdjacentHTML('beforeend', HUD_HTML);
    const canvas = document.createElement('canvas');
    canvas.className = 'grab';
    el.prepend(canvas);
    const attrs = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' };
    const gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    if (!gl) { FABLE.fail(el, 'webgl is not available here'); return {}; }

    // ---- GL resources: fractal program, blit program, one big triangle, RGBA8 accumulation target
    const prog = link(gl, VERT, FRAG), blit = link(gl, VERT, BLIT);
    const U = {};
    for (const n of ['uRes', 'uCenter', 'uJulia', 'uJitter', 'uScale', 'uMode', 'uIter']) U[n] = gl.getUniformLocation(prog, n);
    const UB = { tex: gl.getUniformLocation(blit, 'uTex'), res: gl.getUniformLocation(blit, 'uRes') };
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const p of [prog, blit]) {
      const a = gl.getAttribLocation(p, 'aPos');
      gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    }
    const tex = gl.createTexture(), fbo = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // ---- DOM handles
    const btns = {}, chips = {};
    el.querySelectorAll('[data-btn]').forEach((b) => { btns[b.dataset.btn] = b; });
    el.querySelectorAll('[data-chip]').forEach((c) => { chips[c.dataset.chip] = c; });
    const hint = el.querySelector('.hint');

    // ---- state
    const minS = BASE / MAX_ZOOM, maxS = BASE / MIN_ZOOM;
    let W = 1, H = 1, cx = HOME.m[0], cy = HOME.m[1], s = BASE, mode = 'm', iter = 200;
    let jc = [-0.7435, 0.1314], jt = jc.slice();          // julia constant: current, target
    let dirty = true, sample = 0, raf = 0, lastT = 0, lastR = -1e9, fps = 0, fpsShown = 0;
    let tour = null, tourIdx = 0, focused = false;
    const ptrs = new Map();                               // active pointers (for drag + pinch)

    const zoom = () => BASE / s;
    const mark = () => { dirty = true; };
    const setScale = (ns) => { s = Math.min(maxS, Math.max(minS, ns)); };
    const rect = () => canvas.getBoundingClientRect();

    function zoomAt(x, y, f) {                            // x,y css px inside canvas; f > 1 zooms in
      const r = rect(), ox = (x - r.width / 2) / r.height, oy = (r.height / 2 - y) / r.height;
      const s0 = s; setScale(s / f);
      cx += ox * (s0 - s); cy += oy * (s0 - s); mark();
    }
    function pan(dx, dy) {
      const h = rect().height || 1;
      cx -= dx * s / h; cy += dy * s / h; mark();
    }
    function home() { stopTour(); [cx, cy] = HOME[mode]; s = BASE; mark(); }
    function setMode(m) {
      mode = m === 'j' ? 'j' : 'm';
      btns.mode.setAttribute('aria-pressed', String(mode === 'j'));
      home();
    }
    function juliaFromPointer(e) {
      const r = rect(), u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
      jt = [-0.5 + (u - 0.5) * 1.8, (0.5 - v) * 1.5];
    }
    function takeFocus() {
      if (focused) return;
      focused = true; hint.style.opacity = '0';
      setTimeout(() => hint.remove(), 600);
    }

    // ---- tour: exponential zoom toward a landmark, landmark drifts to screen centre
    function startTour() {
      if (tour) { stopTour(); return; }
      if (mode !== 'm') setMode('m');
      const [tx, ty, tz] = TOURS[tourIdx++ % TOURS.length];
      const to = { cx: tx, cy: ty, s: BASE / tz };
      if (FABLE.reducedMotion) { cx = to.cx; cy = to.cy; setScale(to.s); mark(); return; }
      tour = { from: { cx, cy, s }, to, t0: performance.now(), dur: 8000 };
      btns.tour.setAttribute('aria-pressed', 'true');
    }
    function stopTour() { if (!tour) return; tour = null; btns.tour.setAttribute('aria-pressed', 'false'); }
    function stepTour(now) {
      const { from, to, t0, dur } = tour;
      const u = Math.min(1, (now - t0) / dur), e = u * u * (3 - 2 * u);
      s = from.s * Math.pow(to.s / from.s, e);
      const k = (s / from.s) * (1 - e);
      cx = to.cx + (from.cx - to.cx) * k; cy = to.cy + (from.cy - to.cy) * k;
      mark(); if (u >= 1) stopTour();
    }

    // ---- hud
    function hud() {
      const z = zoom();
      iter = Math.round(200 + 1300 * Math.min(1, Math.max(0, Math.log10(Math.max(1, z)) / Math.log10(MAX_ZOOM))));
      chips.zoom.textContent = fmtZoom(z);
      chips.iter.textContent = iter;
      chips.prec.style.display = s <= minS * 1.0001 ? '' : 'none';
    }

    // ---- render one jittered sample into the accumulation target, then blit
    function render(k) {
      const j = JITTER[k];
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, W, H);
      gl.useProgram(prog);
      gl.uniform2f(U.uRes, W, H); gl.uniform2f(U.uCenter, cx, cy); gl.uniform2f(U.uJulia, jc[0], jc[1]);
      gl.uniform2f(U.uJitter, j[0], j[1]); gl.uniform1f(U.uScale, s / H);
      gl.uniform1f(U.uMode, mode === 'j' ? 1 : 0); gl.uniform1i(U.uIter, iter);
      if (k) {                                               // running mean: dst = src/(k+1) + dst*k/(k+1)
        gl.enable(gl.BLEND); gl.blendColor(0, 0, 0, 1 / (k + 1));
        gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
      } else gl.disable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
      gl.useProgram(blit); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(UB.tex, 0); gl.uniform2f(UB.res, W, H);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - lastT) / 1000) || 0; lastT = now;
      if (tour) stepTour(now);
      if (mode === 'j' && Math.hypot(jt[0] - jc[0], jt[1] - jc[1]) > 1e-4) {   // 1e-4 ≈ 0.02px at 1×
        const a = 1 - Math.exp(-dt * 6);
        jc[0] += (jt[0] - jc[0]) * a; jc[1] += (jt[1] - jc[1]) * a; mark();
      }
      if (dirty) { dirty = false; sample = 0; hud(); }
      if (sample >= JITTER.length) return;                  // still + fully accumulated: idle, no GPU work
      const gap = now - lastR; lastR = now;
      render(sample++);
      if (gap < 200) fps = fps ? fps * 0.85 + 150 / gap : 1000 / gap;   // EMA over consecutive frames only
      if (fps && (now - fpsShown > 400 || sample === JITTER.length)) { chips.fps.textContent = Math.round(fps); fpsShown = now; }
    }

    // ---- sizing
    function resize() {
      const d = FABLE.dpr(1.5);
      const w = Math.max(1, Math.round(el.clientWidth * d)), h = Math.max(1, Math.round(el.clientHeight * d));
      if (w === W && h === H) return;
      W = canvas.width = w; H = canvas.height = h;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      mark();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(el); resize();

    // ---- input: wheel only once focused (so the page keeps scrolling until the user opts in)
    canvas.addEventListener('wheel', (e) => {
      if (!focused) return;
      e.preventDefault(); stopTour();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const r = rect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0022));
    }, { passive: false });
    canvas.addEventListener('pointerdown', (e) => {
      stopTour(); canvas.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, type: e.pointerType });
      canvas.classList.add('grabbing');
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) { if (mode === 'j') { juliaFromPointer(e); } return; }   // hover: julia c follows the pointer
      if (ptrs.size === 1) pan(e.clientX - p.x, e.clientY - p.y);
      else if (ptrs.size === 2) {                                     // pinch: pan by midpoint, zoom by spread
        const o = [...ptrs.values()].find((q) => q !== p), r = rect();
        const d0 = Math.hypot(p.x - o.x, p.y - o.y), d1 = Math.hypot(e.clientX - o.x, e.clientY - o.y);
        const mx = (e.clientX + o.x) / 2, my = (e.clientY + o.y) / 2;
        pan(mx - (p.x + o.x) / 2, my - (p.y + o.y) / 2);
        zoomAt(mx - r.left, my - r.top, d1 / Math.max(1, d0));
      }
      p.x = e.clientX; p.y = e.clientY;
    });
    const up = (e) => {
      const p = ptrs.get(e.pointerId);
      if (p && p.type !== 'mouse' && mode === 'j' && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 8) juliaFromPointer(e);
      ptrs.delete(e.pointerId);
      if (!ptrs.size) canvas.classList.remove('grabbing');
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    el.addEventListener('pointerdown', takeFocus);
    btns.mode.addEventListener('click', () => setMode(mode === 'm' ? 'j' : 'm'));
    btns.home.addEventListener('click', home);
    btns.tour.addEventListener('click', startTour);

    const onKey = (e) => {
      if (e.key === 'Escape') { focused = false; return; }
      const t = e.target;
      if (!focused || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (e.key === 'j' || e.key === 'J') { e.preventDefault(); setMode(mode === 'm' ? 'j' : 'm'); }
      else if (e.key === 'h' || e.key === 'H') home();
    };
    const onDocDown = (e) => { if (!el.contains(e.target)) focused = false; };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDocDown, true);
    let dead = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); pause();
      if (!dead) FABLE.fail(el, 'webgl context was lost — reload to continue');
    });

    function resume() { if (!raf && !dead) { lastT = performance.now(); raf = requestAnimationFrame(frame); } }
    function pause() { cancelAnimationFrame(raf); raf = 0; }
    function destroy() {
      dead = true; pause(); ro.disconnect();
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDocDown, true);
      const lc = gl.getExtension('WEBGL_lose_context'); if (lc) lc.loseContext();
      if (window.__fractal === api) delete window.__fractal;
      el.innerHTML = '';
    }
    const api = window.__fractal = {
      glError: () => gl.getError(), zoom, tour: startTour, home, setMode,
      jump(x, y, z) { stopTour(); cx = x; cy = y; setScale(BASE / z); mark(); },
      state: () => ({ cx, cy, s, mode, iter, focused, tour: !!tour, jc: jc.slice() }),
    };
    return { resume, pause, destroy };
  }

  FABLE.register('fractal', {
    mount(el) {
      try { return build(el); } catch (err) {
        console.error('[fractal]', err);
        FABLE.fail(el, /webgl/i.test(err.message) ? 'webgl is not available here' : 'fractal could not start: ' + err.message);
        return {};
      }
    },
  });
})();
