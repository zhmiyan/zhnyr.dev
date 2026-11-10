/* fable-5-1 / demos/reaction.js — Gray-Scott reaction-diffusion on the GPU, paintable with the pointer.
 * Two chemicals share one texture (A in .x, B in .y); one fragment pass advances both by one step:
 *   A' = A + Da·∇²A − A·B² + f·(1−A)      B' = B + Db·∇²B + A·B² − (f+k)·B
 * (A is fed in at rate f, B is washed out at rate k, and A·B² turns A into B wherever B already exists.)
 * A texture can't be read and written in the same draw, so the state ping-pongs between two framebuffers
 * (read N → write N+1 → swap) ~10×/frame; a display pass maps B to navy→sapphire→ice, embossed by its gradient. */
(() => {
  const PRESETS = { coral: [0.0545, 0.062], mitosis: [0.0367, 0.0649], worms: [0.078, 0.061], spots: [0.030, 0.062] };

  function build(el, canvas, gl) {
    const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

    // ---- pick a renderable state-texture format: float > half-float > 8-bit packed 16-bit fixed point ----
    const cands = isGL2 ? [
      { name: 'webgl2 RG32F float (EXT_color_buffer_float)', internal: gl.RG32F, format: gl.RG, type: gl.FLOAT, exts: ['EXT_color_buffer_float'] },
      { name: 'webgl2 RG16F half-float', internal: gl.RG16F, format: gl.RG, type: gl.HALF_FLOAT, exts: ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'] },
      { name: 'webgl2 RGBA16F half-float', internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, exts: ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'] },
    ] : [
      { name: 'webgl1 RGBA float (OES_texture_float)', internal: gl.RGBA, format: gl.RGBA, type: gl.FLOAT, exts: ['OES_texture_float'] },
      { name: 'webgl1 RGBA half-float (OES_texture_half_float)', internal: gl.RGBA, format: gl.RGBA, type: 0x8d61 /* HALF_FLOAT_OES */, exts: ['OES_texture_half_float'] },
    ];
    cands.push({ name: (isGL2 ? 'webgl2' : 'webgl1') + ' RGBA8 packed 16-bit fixed point', internal: gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE, packed: true, exts: [] });

    const makeTex = (c, w, h) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, c.internal, w, h, 0, c.format, c.type, null);
      return t;
    };
    const makeFbo = (t) => {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return f;
    };
    let fmt = null;
    for (const c of cands) {
      if (c.exts.length && !c.exts.some((n) => gl.getExtension(n))) continue;
      while (gl.getError()) { /* drain stale errors so the probe below is meaningful */ }
      const t = makeTex(c, 4, 4), f = makeFbo(t);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE && gl.getError() === gl.NO_ERROR;
      gl.deleteFramebuffer(f); gl.deleteTexture(t);
      if (ok) { fmt = c; break; }
    }
    while (gl.getError()) { /* drain */ }
    if (!fmt) throw new Error('no renderable texture format');

    // ---- shaders (GLSL ES 1.00 so the same source runs on WebGL1 and WebGL2) ----
    const VS = 'attribute vec2 p; varying vec2 v_uv; void main(){ v_uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';
    const PRE = `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif
      #define PACKED ${fmt.packed ? 1 : 0}
      varying vec2 v_uv;
      uniform sampler2D u_state;
      uniform vec2 u_texel;   // 1 / simulation size
      uniform vec2 u_size;    // simulation size in texels
      // 8-bit fallback: each concentration is stored as 16-bit fixed point spread over two bytes
      vec2 pack(float v){ float s = floor(clamp(v, 0.0, 1.0) * 65535.0 + 0.5); float hi = floor(s / 256.0); return vec2(hi, s - hi * 256.0) / 255.0; }
      float unpack(vec2 p){ return dot(floor(p * 255.0 + 0.5), vec2(256.0, 1.0)) / 65535.0; }
      vec2 readAB(vec4 t){
      #if PACKED
        return vec2(unpack(t.rg), unpack(t.ba));
      #else
        return t.rg;
      #endif
      }
      vec4 writeAB(vec2 ab){
      #if PACKED
        return vec4(pack(ab.x), pack(ab.y));
      #else
        return vec4(ab, 0.0, 1.0);
      #endif
      }
      vec2 fetch(vec2 uv){ return readAB(texture2D(u_state, fract(uv))); }   // fract: toroidal wrap
    `;
    const SIM_FS = PRE + `
      uniform float u_f, u_k;
      uniform vec3 u_brush;   // xy: brush centre (uv), z: radius in texels (0 = no brush)
      void main(){
        vec2 c = fetch(v_uv);
        vec2 tx = vec2(u_texel.x, 0.0), ty = vec2(0.0, u_texel.y);
        // 9-point Laplacian: 0.2 on edges, 0.05 on corners, -1 in the centre (weights sum to zero)
        vec2 lap = 0.2 * (fetch(v_uv + tx) + fetch(v_uv - tx) + fetch(v_uv + ty) + fetch(v_uv - ty))
                 + 0.05 * (fetch(v_uv + tx + ty) + fetch(v_uv - tx + ty) + fetch(v_uv + tx - ty) + fetch(v_uv - tx - ty))
                 - c;
        float a = c.x, b = c.y, abb = a * b * b;
        a += lap.x - abb + u_f * (1.0 - a);           // Da = 1.0, dt = 1
        b += 0.5 * lap.y + abb - (u_f + u_k) * b;     // Db = 0.5
        if (u_brush.z > 0.0) {
          float d = length((v_uv - u_brush.xy) * u_size);
          b = max(b, smoothstep(u_brush.z, u_brush.z * 0.5, d));
        }
        gl_FragColor = writeAB(clamp(vec2(a, b), 0.0, 1.0));
      }`;
    const DISPLAY_FS = PRE + `
      // manual bilinear sample of B (the state may be packed bytes, which hardware filtering would corrupt)
      float B(vec2 uv){
        vec2 p = uv * u_size - 0.5, i = floor(p), f = p - i, o = (i + 0.5) * u_texel;
        float b00 = fetch(o).y, b10 = fetch(o + vec2(u_texel.x, 0.0)).y;
        float b01 = fetch(o + vec2(0.0, u_texel.y)).y, b11 = fetch(o + u_texel).y;
        return mix(mix(b00, b10, f.x), mix(b01, b11, f.x), f.y);
      }
      void main(){
        float b = B(v_uv);
        vec2 tx = vec2(u_texel.x, 0.0), ty = vec2(0.0, u_texel.y);
        vec2 g = vec2(B(v_uv + tx) - B(v_uv - tx), B(v_uv + ty) - B(v_uv - ty));
        // fake lighting: treat B as a height field, normal from its gradient, light from the upper left
        vec3 n = normalize(vec3(-g * 7.0, 1.0));
        vec3 L = normalize(vec3(-0.45, 0.65, 0.62));
        float diff = max(dot(n, L), 0.0);
        float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 32.0);
        float t = smoothstep(0.0, 0.36, b);
        vec3 navy = vec3(0.027, 0.047, 0.125), saph = vec3(0.17, 0.36, 1.0);
        vec3 ice = vec3(0.66, 0.82, 1.0), white = vec3(0.93, 0.97, 1.0);
        vec3 col = mix(navy, saph, smoothstep(0.0, 0.55, t));
        col = mix(col, ice, smoothstep(0.45, 0.95, t));
        col = mix(col, white, 0.6 * smoothstep(0.85, 1.0, t));
        col *= 0.72 + 0.45 * diff;                          // flat areas stay at ~1.0
        col += spec * 0.3 * ice * smoothstep(0.03, 0.2, b);
        vec2 q = (v_uv - 0.5) * vec2(1.0, 0.85);
        col *= 1.0 - 0.3 * dot(q, q);                       // soft vignette
        gl_FragColor = vec4(col, 1.0);
      }`;
    const BLIT_FS = PRE + `
      uniform float u_copy;   // 1: nearest-resample the bound state texture, 0: blank field (A = 1, B = 0)
      void main(){ gl_FragColor = u_copy > 0.5 ? texture2D(u_state, v_uv) : writeAB(vec2(1.0, 0.0)); }`;

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    function program(fs) {
      const p = gl.createProgram(), v = compile(gl.VERTEX_SHADER, VS), f = compile(gl.FRAGMENT_SHADER, fs);
      gl.attachShader(p, v); gl.attachShader(p, f);
      gl.bindAttribLocation(p, 0, 'p');
      gl.linkProgram(p);
      gl.deleteShader(v); gl.deleteShader(f);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {};
      for (let i = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) - 1; i >= 0; i--) {
        const name = gl.getActiveUniform(p, i).name;
        u[name] = gl.getUniformLocation(p, name);
      }
      return { p, u };
    }
    const sim = program(SIM_FS), display = program(DISPLAY_FS), blit = program(BLIT_FS);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- simulation state ----
    let tex = null, fbo = null, cur = 0, simW = 0, simH = 0, brushR = 12;
    let preset = 'coral', f = PRESETS.coral[0], k = PRESETS.coral[1];
    let steps = 10, slow = 0, fast = 0, dirty = true;
    const pointer = { down: false, x: 0, y: 0, px: 0, py: 0 };

    function useSim() {
      gl.useProgram(sim.p);
      gl.viewport(0, 0, simW, simH);
      gl.uniform2f(sim.u.u_texel, 1 / simW, 1 / simH);
      gl.uniform2f(sim.u.u_size, simW, simH);
      gl.uniform1f(sim.u.u_f, f);
      gl.uniform1f(sim.u.u_k, k);
    }
    // one Gray-Scott step: read tex[cur], write the other one, swap
    function step() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[1 - cur]);
      gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
      draw();
      cur = 1 - cur;
    }
    // overwrite the current state with a resampled copy of `src` (resize) or a blank field (clear)
    function fill(src) {
      gl.useProgram(blit.p);
      gl.viewport(0, 0, simW, simH);
      gl.uniform1f(blit.u.u_copy, src ? 1 : 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[cur]);
      gl.bindTexture(gl.TEXTURE_2D, src || tex[1 - cur]);   // never sample the texture we render into
      draw();
      dirty = true;
    }
    function seed() {
      fill(null);
      useSim();
      const n = 6 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n; i++) {
        gl.uniform3f(sim.u.u_brush, 0.1 + Math.random() * 0.8, 0.1 + Math.random() * 0.8, 5 + Math.random() * 9);
        step();
      }
      gl.uniform3f(sim.u.u_brush, 0, 0, 0);
      for (let i = 0; i < 80; i++) step();   // warm up so the first frame already has structure
      dirty = true;
    }
    function simulate(n) {
      useSim();
      for (let i = 0; i < n; i++) {
        if (pointer.down) {   // spread the brush along last frame's drag segment so fast strokes stay continuous
          const t = (i + 1) / n;
          gl.uniform3f(sim.u.u_brush, pointer.px + (pointer.x - pointer.px) * t, pointer.py + (pointer.y - pointer.py) * t, brushR);
        } else gl.uniform3f(sim.u.u_brush, 0, 0, 0);
        step();
      }
      pointer.px = pointer.x; pointer.py = pointer.y;
    }
    function render() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(display.p);
      gl.uniform2f(display.u.u_texel, 1 / simW, 1 / simH);
      gl.uniform2f(display.u.u_size, simW, simH);
      gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
      draw();
    }

    // ---- sizing: canvas at dpr ≤ 1.5, simulation at half the canvas pixels, capped at 1024×640 ----
    const scale = FABLE.dpr(1.5);
    function resize() {
      const w = Math.max(1, Math.floor(el.clientWidth * scale)), h = Math.max(1, Math.floor(el.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
      const s = Math.min(0.5, 1024 / w, 640 / h);
      const sw = Math.max(16, Math.round(w * s)), sh = Math.max(16, Math.round(h * s));
      if (sw === simW && sh === simH) return;
      const oldTex = tex, oldFbo = fbo, old = tex && tex[cur];
      tex = [0, 1].map(() => makeTex(fmt, sw, sh));
      fbo = tex.map(makeFbo);
      cur = 0; simW = sw; simH = sh;
      brushR = Math.min(16, Math.max(8, Math.round(sw / 60)));
      if (old) {   // keep the living pattern across a resize
        fill(old);
        oldTex.forEach((t) => gl.deleteTexture(t));
        oldFbo.forEach((o) => gl.deleteFramebuffer(o));
      } else seed();
    }

    // ---- hud ----
    const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const hud = h('div', 'hud'), top = h('div', 'hud top-right');
    const presetEl = h('b', null, preset), fpsEl = h('b', null, '–');
    const chipP = h('span', 'chip'), chipF = h('span', 'chip');
    chipP.append('preset ', presetEl); chipF.append('fps ', fpsEl);
    top.append(chipP, chipF);
    const btns = {};
    for (const name of Object.keys(PRESETS)) {
      const b = h('button', 'btn sm', name);
      b.type = 'button'; b.title = `f = ${PRESETS[name][0]}, k = ${PRESETS[name][1]}`;
      b.setAttribute('aria-pressed', String(name === preset));
      b.addEventListener('click', () => setPreset(name));
      btns[name] = b; hud.appendChild(b);
    }
    const clearBtn = h('button', 'btn sm', 'clear');
    clearBtn.type = 'button'; clearBtn.title = 'empty the dish, then paint';
    clearBtn.addEventListener('click', () => fill(null));
    hud.append(clearBtn, h('span', 'note', 'drag to paint'));
    el.append(hud, top);
    function setPreset(name) {
      if (name === preset) { seed(); return; }   // tapping the active preset re-seeds the dish
      preset = name; [f, k] = PRESETS[name];
      presetEl.textContent = name;
      for (const n in btns) btns[n].setAttribute('aria-pressed', String(n === name));
      dirty = true;
    }

    // ---- pointer painting ----
    const toUV = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height]; };
    const onDown = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      [pointer.x, pointer.y] = toUV(e); pointer.px = pointer.x; pointer.py = pointer.y;
      pointer.down = true; dirty = true;
    };
    const onMove = (e) => { if (pointer.down) [pointer.x, pointer.y] = toUV(e); };
    const onUp = () => { pointer.down = false; };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    // ---- frame loop ----
    let raf = 0, running = false, last = 0, fpsT = 0, fpsAcc = 0, fpsN = 0;
    function frame(now) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      const dt = Math.min(100, now - last); last = now;
      fpsAcc += dt; fpsN++;
      if (now - fpsT > 500) { fpsEl.textContent = fpsAcc > 0 ? String(Math.round(1000 * fpsN / fpsAcc)) : '–'; fpsT = now; fpsAcc = 0; fpsN = 0; }
      // adaptive step count: back off quickly when a frame runs long, creep back up when there is headroom
      if (dt > 20) { fast = 0; if (++slow >= 3) { steps = Math.max(2, steps - 1); slow = 0; } }
      else { slow = 0; if (dt < 15 && ++fast >= 90) { steps = Math.min(12, steps + 1); fast = 0; } }
      const n = FABLE.reducedMotion ? (pointer.down ? 1 : 0) : steps;
      if (n > 0) simulate(n);
      else if (!dirty) return;
      render();
      dirty = false;
    }
    const handle = {
      resume() { if (running) return; running = true; last = fpsT = performance.now(); slow = fast = 0; raf = requestAnimationFrame(frame); },
      pause() { running = false; cancelAnimationFrame(raf); },
      destroy() {
        this.pause(); ro.disconnect();
        canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('webglcontextlost', onLost);
        [sim, display, blit].forEach((q) => gl.deleteProgram(q.p));
        gl.deleteBuffer(vbo);
        if (tex) tex.forEach((t) => gl.deleteTexture(t));
        if (fbo) fbo.forEach((o) => gl.deleteFramebuffer(o));
        const lc = gl.getExtension('WEBGL_lose_context'); lc && lc.loseContext();
        if (window.__reaction && window.__reaction.el === el) delete window.__reaction;
        el.replaceChildren();
      }
    };
    const onLost = (e) => { e.preventDefault(); handle.pause(); FABLE.fail(el, 'webgl context was lost'); };
    canvas.addEventListener('webglcontextlost', onLost);
    const ro = new ResizeObserver(() => resize());
    ro.observe(el);
    resize();
    render();   // a static first frame even before resume() (reduced motion, lazy mount)
    window.__reaction = { el, glError: () => gl.getError(), format: () => fmt.name, steps: () => steps, size: () => [simW, simH], pointer };
    return handle;
  }

  FABLE.register('reaction', {
    mount(el) {
      const canvas = document.createElement('canvas');
      canvas.className = 'pointer';
      el.appendChild(canvas);
      const opts = { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance' };
      let gl = null;
      try { gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts); } catch (_) { gl = null; }
      if (!gl) { FABLE.fail(el, 'webgl is not available here'); return {}; }
      try {
        return build(el, canvas, gl);
      } catch (err) {
        console.error('[fable] reaction failed to start', err);
        FABLE.fail(el, 'reaction could not start: ' + err.message);
        return {};
      }
    }
  });
})();
