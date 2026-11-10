/* gem — a sapphire ray-traced live in a GLSL fragment shader, one pass, no textures.
 * The stone is a round brilliant built from 58 half-space planes (table, stars, bezels, girdle, pavilion, culet) that
 * JS generates and uploads; being convex, it needs no sphere tracing: every ray does an exact slab test against all
 * planes (~60 dot products) and gets a crisp entry point + facet normal. Red, green and blue are traced separately
 * with their own refractive index (1.752 / 1.770 / 1.800) so facet edges split into fire; inside the stone each channel
 * bounces up to 3 times with exact dielectric Fresnel (total internal reflection falls out of the equations) and
 * Beer–Lambert absorption tints long paths deep blue. Lights are soft discs on a procedural sky; ACES tone-maps the HDR. */
(() => {
  'use strict';

  // ---- brilliant cut: half-space planes as vec4(normal.xyz, offset) -----------------------------------------------
  // angles are the facet's slope from horizontal, like gem-cutting diagrams; (r, y) is a point the facet passes through.
  function buildPlanes() {
    const P = [];
    const push = (x, y, z, d) => P.push(x, y, z, d);
    const ring = (n, phase, deg, r, y, down) => {
      const a = (deg * Math.PI) / 180, nr = Math.sin(a), ny = Math.cos(a) * (down ? -1 : 1);
      for (let i = 0; i < n; i++) {
        const ph = phase + (i * 2 * Math.PI) / n;
        push(nr * Math.cos(ph), ny, nr * Math.sin(ph), nr * r + ny * y);
      }
    };
    const H = Math.PI / 8; // half a sector of the 8-fold cut
    push(0, 1, 0, 0.33);                       // table
    push(0, -1, 0, 0.89);                      // culet (tiny flat at the tip)
    ring(16, 0, 90, 1.0, 0.0, false);          // girdle, a thin vertical 16-gon band
    ring(8, 0, 34.5, 1.0, 0.04, false);        // crown mains (bezels), kite shaped
    ring(8, H, 42, 1.0, 0.04, false);          // upper girdle facets, between the bezels
    ring(8, H, 24, 0.7355, 0.26, false);       // star facets, shallow triangles at the table rim
    ring(8, 0, 41, 1.0, -0.04, true);          // pavilion mains, meeting at the culet
    ring(8, H, 42, 1.0, -0.04, true);          // lower girdle facets
    return new Float32Array(P);
  }
  const PLANES = buildPlanes();
  const NP = PLANES.length / 4; // 58

  const VERT = 'attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }';
  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform mat3 uInv;      // world -> gem space rotation
uniform float uBob;     // vertical float offset
uniform vec4 uPl[${NP}];
const int NP = ${NP};
const int NB = 3;       // internal bounces per colour channel

// a soft-edged disc light on the sky dome
float disc(vec3 d, vec3 L, float c, float s) { return smoothstep(c - s, c + s, dot(d, L)); }

// procedural jewellery-studio environment: mostly dark, one big softbox, one hot pinpoint, a cool rim, a warm card.
// high contrast is what makes facets flip between deep blue and blazing white as the stone turns.
vec3 env(vec3 d) {
  float h = d.y;
  vec3 c = mix(vec3(0.004, 0.006, 0.016), vec3(0.05, 0.10, 0.26), smoothstep(-0.4, 1.0, h));
  c += vec3(0.03, 0.06, 0.16) * pow(max(0.0, 1.0 - abs(h)), 6.0);                                 // horizon haze
  c += vec3(1.00, 0.97, 0.92) * 5.0  * disc(d, normalize(vec3(-0.50, 0.70, 0.50)), 0.940, 0.020);  // key softbox
  c += vec3(1.00, 1.00, 1.00) * 40.0 * disc(d, normalize(vec3(0.60, 0.60, 0.55)), 0.995, 0.004);   // hot pinpoint
  c += vec3(0.70, 0.84, 1.00) * 4.0  * disc(d, normalize(vec3(0.90, 0.20, -0.30)), 0.970, 0.015);  // cool rim
  c += vec3(1.00, 0.78, 0.58) * 1.2  * disc(d, normalize(vec3(0.20, -0.70, 0.60)), 0.900, 0.060);  // warm bounce card
  c += vec3(0.80, 0.90, 1.00) * 0.8  * disc(d, normalize(vec3(-0.30, 0.30, -1.00)), 0.750, 0.200); // broad back fill
  return c;
}

// exact unpolarised dielectric Fresnel; returns 1.0 past the critical angle (total internal reflection)
float fres(float cosI, float ni, float nt) {
  float r = ni / nt, s2 = r * r * (1.0 - cosI * cosI);
  if (s2 >= 1.0) return 1.0;
  float cosT = sqrt(1.0 - s2);
  float rs = (ni * cosI - nt * cosT) / (ni * cosI + nt * cosT);
  float rp = (nt * cosI - ni * cosT) / (nt * cosI + ni * cosT);
  return 0.5 * (rs * rs + rp * rp);
}

// ray vs convex polytope from outside: slab test over all planes, entry distance + facet normal
bool enter(vec3 ro, vec3 rd, out float tN, out vec3 nN) {
  tN = -1e9; float tF = 1e9; nN = vec3(0.0, 1.0, 0.0);
  for (int i = 0; i < NP; i++) {
    vec4 pl = uPl[i];
    float dn = dot(rd, pl.xyz);
    float t = (pl.w - dot(ro, pl.xyz)) / dn;
    if (dn < -1e-6) { if (t > tN) { tN = t; nN = pl.xyz; } }
    else if (dn > 1e-6) tF = min(tF, t);
  }
  return tN < tF && tN > 0.0;
}

// ray vs convex polytope from inside: nearest front-facing plane = exit point + its normal
float leave(vec3 p, vec3 d, out vec3 n) {
  float tF = 1e9; n = vec3(0.0, 1.0, 0.0);
  for (int i = 0; i < NP; i++) {
    vec4 pl = uPl[i];
    float dn = dot(d, pl.xyz);
    if (dn > 1e-6) { float t = (pl.w - dot(p, pl.xyz)) / dn; if (t < tF) { tF = t; n = pl.xyz; } }
  }
  return max(tF, 0.0);
}

vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

void main() {
  vec2 uv = (2.0 * gl_FragCoord.xy - uRes) / uRes.y;
  vec3 ro = vec3(0.0, 0.0, 3.6);
  vec3 rd = normalize(vec3(uv, -2.2));

  // backdrop: page-navy gradient, a faint gem-blue halo, a soft pool of scattered light under the stone
  float r2 = dot(uv, uv);
  vec3 col = mix(vec3(0.004, 0.008, 0.024), vec3(0.010, 0.020, 0.052), clamp(uv.y * 0.6 + 0.5, 0.0, 1.0));
  col += vec3(0.17, 0.36, 1.0) * 0.045 * exp(-r2 * 1.6);
  vec2 pool = uv - vec2(0.0, -0.78 + uBob * 0.5);
  col += vec3(0.25, 0.45, 1.0) * 0.05 * exp(-(pool.x * pool.x * 2.0 + pool.y * pool.y * 28.0));
  col *= 1.0 - 0.5 * smoothstep(0.4, 2.6, r2);

  vec3 roo = uInv * (ro - vec3(0.0, uBob, 0.0));
  vec3 rdo = uInv * rd;
  float b = dot(roo, rdo), cc = dot(roo, roo) - 1.1025; // bounding sphere r=1.05 skips most pixels
  float tN; vec3 n;
  if (b * b - cc > 0.0 && enter(roo, rdo, tN, n)) {
    vec3 p = roo + rdo * tN;
    float cosI = -dot(rdo, n);
    vec3 acc = env(reflect(rdo, n) * uInv) * fres(cosI, 1.0, 1.77); // outer mirror reflection (v*M == transpose(M)*v)
    for (int c = 0; c < 3; c++) {
      float ior = c == 0 ? 1.752 : (c == 1 ? 1.770 : 1.800);         // dispersion, slightly exaggerated
      float k   = c == 0 ? 2.40  : (c == 1 ? 1.10  : 0.10);          // absorption per unit path: sapphire blue
      vec3 mask = vec3(c == 0 ? 1.0 : 0.0, c == 1 ? 1.0 : 0.0, c == 2 ? 1.0 : 0.0);
      float thr = 1.0 - fres(cosI, 1.0, ior);
      vec3 d = refract(rdo, n, 1.0 / ior), q = p;
      float dist = 0.0, sum = 0.0;
      for (int i = 0; i < NB; i++) {
        vec3 nx; float t = leave(q, d, nx);
        q += d * t; dist += t;
        float Fi = fres(dot(d, nx), ior, 1.0);
        vec3 outD = refract(d, -nx, ior);
        sum += thr * (1.0 - Fi) * exp(-k * dist) * dot(env(outD * uInv), mask);
        thr *= Fi;
        d = reflect(d, nx);
      }
      sum += thr * exp(-k * dist) * dot(env(d * uInv), mask) * 0.6; // energy still trapped after NB bounces
      acc += mask * sum;
    }
    col = acc;
  }
  gl_FragColor = vec4(pow(aces(col), vec3(1.0 / 2.2)), 1.0);
}`;

  FABLE.register('gem', {
    mount(el) {
      const reduced = !!FABLE.reducedMotion;
      const canvas = document.createElement('canvas');
      canvas.className = 'grab';
      canvas.setAttribute('aria-label', 'ray-traced sapphire, drag to rotate');
      el.appendChild(canvas);

      const hud = document.createElement('div');
      hud.className = 'hud';
      hud.innerHTML =
        `<span class="chip">fps <b data-fps>${reduced ? 'static' : '--'}</b></span>` +
        `<span class="chip">render <b data-res>--</b></span>` +
        `<span class="chip">drag to rotate</span>` +
        `<button class="btn sm" type="button" data-reset>reset</button>`;
      el.appendChild(hud);
      const fpsEl = hud.querySelector('[data-fps]');
      const resEl = hud.querySelector('[data-res]');
      const resetBtn = hud.querySelector('[data-reset]');

      const noop = { resume() {}, pause() {}, destroy() {} };
      const glOpts = { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' };
      let gl = null;
      try {
        gl = canvas.getContext('webgl2', glOpts) || canvas.getContext('webgl', glOpts) || canvas.getContext('experimental-webgl', glOpts);
      } catch (_) { gl = null; }
      if (!gl) { FABLE.fail(el, 'webgl is not available here'); return noop; }

      // ---- GL resources (rebuilt on context restore) ----------------------------------------------------------------
      let prog = null, loc = null, vbo = null;
      function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
        return s;
      }
      function initGL() {
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'program link failed');
        gl.useProgram(prog);
        vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(prog, 'aPos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        loc = { res: gl.getUniformLocation(prog, 'uRes'), inv: gl.getUniformLocation(prog, 'uInv'), bob: gl.getUniformLocation(prog, 'uBob') };
        gl.uniform4fv(gl.getUniformLocation(prog, 'uPl'), PLANES);
      }
      try { initGL(); } catch (err) {
        console.error('[gem]', err);
        FABLE.fail(el, 'webgl is not available here');
        return noop;
      }

      // ---- state -----------------------------------------------------------------------------------------------------
      const HOME_PITCH = 0.55, AUTO_SPIN = 0.22; // rad, rad/s
      let yaw = 0.6, pitch = HOME_PITCH, spinVel = 0, pitchVel = 0;
      let dragging = false, pointerId = null, lastX = 0, lastY = 0, lastMoveT = 0;
      let raf = 0, visible = false, lost = false;
      let lastT = 0, elapsed = 0;
      let scale = 1, emaDt = 16, slowFor = 0, fastFor = 0, cooldown = 0;
      let fpsAcc = 0, fpsN = 0, fpsClock = 0;
      const inv = new Float32Array(9);

      function resize() {
        const w = el.clientWidth, h = el.clientHeight;
        if (!w || !h) return;
        const s = FABLE.dpr(1.5) * scale;
        const bw = Math.max(1, Math.round(w * s)), bh = Math.max(1, Math.round(h * s));
        if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
        resEl.textContent = `${s.toFixed(2).replace(/\.?0+$/, '')}×`;
        if (reduced) render();
      }

      function render() {
        if (lost || !gl || canvas.width === 0) return;
        // gem->world is Rx(pitch)*Ry(yaw); we need world->gem = Ry(-yaw)*Rx(-pitch), uploaded column-major
        const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
        inv[0] = cy;        inv[1] = 0;   inv[2] = sy;        // column 0 = image of x
        inv[3] = sy * sp;   inv[4] = cp;  inv[5] = -cy * sp;  // column 1 = image of y
        inv[6] = -sy * cp;  inv[7] = sp;  inv[8] = cy * cp;   // column 2 = image of z
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(loc.res, canvas.width, canvas.height);
        gl.uniformMatrix3fv(loc.inv, false, inv);
        gl.uniform1f(loc.bob, reduced ? 0 : Math.sin(elapsed * 1.1) * 0.035);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      // adaptive internal resolution: step down when frames run long, creep back up when there is headroom
      function adapt(dt) {
        emaDt += (dt * 1000 - emaDt) * 0.1;
        if (cooldown > 0) { cooldown -= dt; return; }
        if (emaDt > 20) { slowFor += dt; fastFor = 0; } else if (emaDt < 13) { fastFor += dt; slowFor = 0; } else { slowFor = fastFor = 0; }
        if (slowFor > 0.6 && scale > 0.5) { scale = Math.max(0.5, scale * 0.8); slowFor = 0; cooldown = 1.5; resize(); }
        else if (fastFor > 4 && scale < 1) { scale = Math.min(1, scale / 0.8); fastFor = 0; cooldown = 2; resize(); }
      }

      function frame(now) {
        raf = requestAnimationFrame(frame);
        const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 1 / 60;
        lastT = now;
        elapsed += dt;
        if (!dragging) {
          const damp = Math.pow(0.08, dt); // inertia after a fling
          spinVel *= damp; pitchVel *= damp;
          yaw += (spinVel + AUTO_SPIN) * dt;
          pitch = clampPitch(pitch + pitchVel * dt);
        }
        adapt(dt);
        fpsAcc += dt; fpsN++;
        if (now - fpsClock > 500) { fpsEl.textContent = String(Math.round(fpsN / fpsAcc)); fpsAcc = fpsN = 0; fpsClock = now; }
        render();
      }
      const clampPitch = (v) => Math.max(-1.35, Math.min(1.35, v));

      function start() {
        if (raf || lost || !visible) return;
        if (reduced) { render(); return; }
        lastT = 0;
        raf = requestAnimationFrame(frame);
      }
      function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

      // ---- interaction: one pointer rotates; wheel and pinch are deliberately left alone ------------------------------
      const onDown = (e) => {
        if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
        pointerId = e.pointerId; dragging = true; spinVel = pitchVel = 0;
        lastX = e.clientX; lastY = e.clientY; lastMoveT = e.timeStamp;
        try { canvas.setPointerCapture(pointerId); } catch (_) { /* ignore */ }
        canvas.classList.add('grabbing');
      };
      const onMove = (e) => {
        if (e.pointerId !== pointerId) return;
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        const dt = Math.max(1, e.timeStamp - lastMoveT) / 1000;
        lastX = e.clientX; lastY = e.clientY; lastMoveT = e.timeStamp;
        const k = 0.0085;
        yaw += dx * k; pitch = clampPitch(pitch + dy * k);
        spinVel = (dx * k) / dt; pitchVel = (dy * k) / dt;
        if (reduced) render();
      };
      const onUp = (e) => {
        if (e.pointerId !== pointerId) return;
        pointerId = null; dragging = false;
        if (reduced) spinVel = pitchVel = 0;
        const cap = Math.max(-6, Math.min(6, spinVel)); spinVel = cap; pitchVel = Math.max(-6, Math.min(6, pitchVel));
        canvas.classList.remove('grabbing');
      };
      const onReset = () => { yaw = 0.6; pitch = HOME_PITCH; spinVel = pitchVel = 0; if (reduced) render(); };
      const onLost = (e) => { e.preventDefault(); lost = true; stop(); };
      const onRestored = () => {
        try { initGL(); lost = false; resize(); start(); } catch (err) { console.error('[gem]', err); FABLE.fail(el, 'webgl is not available here'); }
      };
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);
      canvas.addEventListener('webglcontextlost', onLost);
      canvas.addEventListener('webglcontextrestored', onRestored);
      resetBtn.addEventListener('click', onReset);

      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();

      return {
        resume() { visible = true; start(); },
        pause() { visible = false; stop(); },
        destroy() {
          stop(); visible = false;
          ro.disconnect();
          canvas.removeEventListener('pointerdown', onDown);
          canvas.removeEventListener('pointermove', onMove);
          canvas.removeEventListener('pointerup', onUp);
          canvas.removeEventListener('pointercancel', onUp);
          canvas.removeEventListener('webglcontextlost', onLost);
          canvas.removeEventListener('webglcontextrestored', onRestored);
          resetBtn.removeEventListener('click', onReset);
          try { const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (_) { /* ignore */ }
          gl = null;
          if (hud.parentNode === el) el.removeChild(hud);
          if (canvas.parentNode === el) el.removeChild(canvas);
        }
      };
    }
  });
})();