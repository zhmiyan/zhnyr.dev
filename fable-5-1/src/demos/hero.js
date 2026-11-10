/* fable-5-1 / demos/hero.js
 * The opening sky. One full-screen WebGL fragment shader, no geometry beyond a
 * single triangle: a sinuous aurora ribbon (fbm-displaced path, fine vertical
 * rays, a hot green-white core that fades into violet at the top edge), three
 * hashed star fields at different parallax depths with twinkle and size
 * variance, a faint treeline silhouette and horizon glow. Every pixel is
 * computed from scratch each frame; the pointer gently drifts the camera.
 */
FABLE.register('hero', {
  mount(el) {
    const canvas = document.createElement('canvas');
    el.appendChild(canvas);
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
    if (!gl) { FABLE.fail(el, 'webgl is not available here'); return {}; }

    const vs = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
    const fs = `
      precision highp float;
      uniform vec2 u_res; uniform float u_time; uniform vec2 u_mouse;

      float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float noise(vec2 p){
        vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash21(i), hash21(i + vec2(1,0)), u.x), mix(hash21(i + vec2(0,1)), hash21(i + vec2(1,1)), u.x), u.y);
      }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; mat2 r = mat2(0.8, 0.6, -0.6, 0.8); for (int i = 0; i < 5; i++){ v += a * noise(p); p = r * p * 2.03 + 11.7; a *= 0.5; } return v; }

      // one layer of stars: grid cells, one star per cell at a hashed offset
      vec3 stars(vec2 uv, float scale, float t, float brightness, float density){
        vec2 g = uv * scale; vec2 id = floor(g); vec2 f = fract(g) - 0.5;
        float h = hash21(id);
        if (h < density) return vec3(0.0);
        vec2 off = vec2(hash21(id + 3.1), hash21(id + 7.7)) - 0.5;
        float d = length(f - off * 0.8);
        float size = mix(0.02, 0.09, pow(hash21(id + 9.3), 4.0));      // a few big ones
        float tw = 0.6 + 0.4 * sin(t * (1.0 + h * 3.0) + h * 40.0);
        float s = smoothstep(size, 0.0, d) * tw;
        s += smoothstep(size * 5.0, 0.0, d) * 0.07 * tw;                  // halo
        // cross flare on the biggest stars
        float big = step(0.085, size);
        s += big * tw * 0.35 * (smoothstep(0.012, 0.0, abs(f.x - off.x * 0.8)) * smoothstep(0.16, 0.0, d)
                              + smoothstep(0.012, 0.0, abs(f.y - off.y * 0.8)) * smoothstep(0.16, 0.0, d));
        float temp = hash21(id + 5.5);
        vec3 col = temp < 0.3 ? vec3(0.7, 0.82, 1.0) : (temp < 0.85 ? vec3(0.95, 0.97, 1.0) : vec3(1.0, 0.88, 0.75));
        return col * s * brightness;
      }

      void main(){
        vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
        float t = u_time;
        vec2 m = (u_mouse - 0.5) * 2.0;

        // sky: deep navy, slightly violet toward the zenith
        vec3 col = mix(vec3(0.012, 0.024, 0.07), vec3(0.03, 0.03, 0.09), smoothstep(-0.5, 0.6, uv.y));

        // --- aurora -------------------------------------------------------
        vec3 core = vec3(0.7, 1.0, 0.82);
        vec3 teal = vec3(0.2, 0.85, 0.75);
        vec3 saph = vec3(0.25, 0.5, 1.0);
        vec3 viol = vec3(0.6, 0.25, 0.85);
        float glow = 0.0;
        // two ribbons: the main curtain and a fainter, higher one behind it
        for (int k = 0; k < 2; k++) {
          float kk = float(k);
          float path = 0.08 + kk * 0.16
                     + 0.10 * sin(uv.x * (2.2 + kk) + t * 0.07 + kk * 2.0)
                     + 0.05 * sin(uv.x * 5.3 - t * 0.11 + kk)
                     + (fbm(vec2(uv.x * 1.3 + t * 0.04 + kk * 7.0, t * 0.02 + kk)) - 0.5) * 0.28 + m.y * 0.03;
          float band = uv.y - path;
          // rays: noise along x, sheared slightly so they drape instead of comb
          float shear = (fbm(vec2(uv.x * 2.0 + kk, t * 0.03)) - 0.5) * 0.6;
          float rays = fbm(vec2(uv.x * 9.0 - t * 0.15 + m.x * 0.3 + band * shear * 4.0, band * 1.2 + t * 0.02 + kk * 3.0));
          rays = pow(rays, 1.6) * 1.8;
          float lower = smoothstep(-0.10, 0.02, band);            // soft lower edge
          float upper = exp(-max(band, 0.0) * 4.5);
          float curtain = lower * upper * (0.3 + rays) * (1.0 - kk * 0.55);
          float hgt = clamp(band * 2.4, 0.0, 1.0);
          vec3 aurora = mix(core, teal, smoothstep(0.0, 0.2, hgt));
          aurora = mix(aurora, saph, smoothstep(0.15, 0.5, hgt));
          aurora = mix(aurora, viol, smoothstep(0.45, 1.0, hgt));
          col += aurora * curtain * 0.8;
          col += core * pow(curtain, 3.0) * 0.22;
          glow += curtain * 0.8;
        }

        // --- stars (dimmed behind the ribbon) --------------------------------
        float behind = 1.0 - clamp(glow * 1.6, 0.0, 0.85);
        col += stars(uv + m * 0.010, 14.0, t, 1.0, 0.72) * behind;
        col += stars(uv + m * 0.022 + 2.3, 30.0, t, 0.6, 0.78) * behind;
        col += stars(uv + m * 0.040 + 5.1, 60.0, t, 0.3, 0.80) * behind;

        // --- horizon: glow + a soft treeline silhouette -----------------------
        float horizon = -0.44 + m.y * 0.01;
        float hazeAmt = exp(-pow((uv.y - horizon) * 4.5, 2.0));
        col += vec3(0.12, 0.3, 0.6) * hazeAmt * 0.3;
        float trees = horizon + 0.02 + fbm(vec2(uv.x * 4.0 + 3.0, 1.0)) * 0.08 + noise(vec2(uv.x * 40.0, 2.0)) * 0.012;
        float ground = smoothstep(trees + 0.004, trees - 0.004, uv.y);
        col = mix(col, vec3(0.008, 0.012, 0.03), ground);

        // vignette + grain
        float vig = 1.0 - 0.32 * dot(uv * vec2(0.75, 1.1), uv * vec2(0.75, 1.1));
        col *= vig;
        col += (hash21(gl_FragCoord.xy + fract(t)) - 0.5) * 0.014;
        gl_FragColor = vec4(pow(max(col, 0.0), vec3(0.95)), 1.0);
      }`;

    function compile(type, src) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'u_res');
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uMouse = gl.getUniformLocation(prog, 'u_mouse');

    let scale = FABLE.dpr(1.25);
    let raf = 0, running = false, start = performance.now(), last = start, slow = 0, dirty = true;
    function resize() {
      const w = Math.max(1, Math.floor(el.clientWidth * scale));
      const h = Math.max(1, Math.floor(el.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); dirty = true; }
    }
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // pointer parallax, eased
    const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    const onMove = (e) => {
      mouse.tx = e.clientX / window.innerWidth;
      mouse.ty = 1 - e.clientY / window.innerHeight;
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    const t0 = Math.random() * 100;
    function draw(t) {
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, t);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function frame(now) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      const dt = now - last; last = now;
      if (dt > 24) { if (++slow > 30 && scale > 0.7) { scale *= 0.8; slow = 0; resize(); } } else slow = Math.max(0, slow - 1);
      mouse.x += (mouse.tx - mouse.x) * 0.04;
      mouse.y += (mouse.ty - mouse.y) * 0.04;
      if (FABLE.reducedMotion) {
        // static sky: only redraw when the pointer moved it or the size changed
        const moved = Math.abs(mouse.tx - mouse.x) > 0.0005;
        if (!dirty && !moved) return;
        dirty = false;
        draw(t0);
      } else {
        draw(t0 + (now - start) / 1000);
      }
    }
    return {
      resume() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); },
      pause() { running = false; cancelAnimationFrame(raf); },
      destroy() { this.pause(); ro.disconnect(); window.removeEventListener('pointermove', onMove); const ext = gl.getExtension('WEBGL_lose_context'); ext && ext.loseContext(); }
    };
  }
});
