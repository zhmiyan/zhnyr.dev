/* fable-5-1 / demos/cloth.js — interactive Verlet cloth on Canvas 2D.
 * Verlet integration: every point keeps its current and previous position; velocity is implicit
 * (x - ox) and a step is x' = x + (x - ox)·damp + a·dt². With no stored velocity, the solver below
 * can shove points around and the integrator simply inherits the result, which keeps it stable.
 * Constraint relaxation (Jakobsen): for each distance constraint move both ends along their segment
 * by half the length error so |a-b| → rest; 7 passes per fixed 1/60 s step converge well enough. */
(() => {
  'use strict';
  const COLS = 40, ROWS = 26, N = COLS * ROWS;
  const DT = 1 / 60, MAX_SUB = 4, ITER = 7;
  const GRAVITY = 90, DAMP = 0.985, WIND = 26; // sim units: grid spacing = 1
  const SHADES = 24, FILL_ALPHA = 0.62, IDLE_MS = 3000;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  // shade ramp: deep sapphire -> gem -> pale highlight (more stretched => lighter)
  const RAMP = [[16, 40, 140], [44, 92, 255], [169, 210, 255]];
  const FILLS = Array.from({ length: SHADES }, (_, i) => {
    const t = (i / (SHADES - 1)) * 2, s = Math.min(1, Math.floor(t)), f = t - s;
    const c = RAMP[s].map((v, k) => Math.round(v + (RAMP[s + 1][k] - v) * f));
    return `rgba(${c[0]},${c[1]},${c[2]},${FILL_ALPHA})`;
  });

  function segHit(p0x, p0y, p1x, p1y, q0x, q0y, q1x, q1y) {
    const rx = p1x - p0x, ry = p1y - p0y, sx = q1x - q0x, sy = q1y - q0y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-9) return false;
    const qx = q0x - p0x, qy = q0y - p0y;
    const u = (qx * sy - qy * sx) / den, v = (qx * ry - qy * rx) / den;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  }
  function pointSegDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
    const ex = ax + dx * t - px, ey = ay + dy * t - py;
    return ex * ex + ey * ey;
  }

  FABLE.register('cloth', {
    mount(el) {
      try { return mountCloth(el); }
      catch (err) {
        console.error('[cloth] mount failed', err);
        FABLE.fail(el, 'cloth could not start: ' + err.message);
        return {};
      }
    }
  });

  function mountCloth(el) {
    const reduced = !!FABLE.reducedMotion;
    const canvas = document.createElement('canvas');
    canvas.className = 'grab';
    el.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) { FABLE.fail(el, 'canvas 2d is not available here'); return {}; }
    el.insertAdjacentHTML('beforeend', `
      <div class="hud">
        <button class="btn sm" type="button" data-k="wind" aria-pressed="false">wind</button>
        <button class="btn sm" type="button" data-k="cut" aria-pressed="false">✂ scissors</button>
        <button class="btn sm" type="button" data-k="reset">reset</button>
        <span class="note">drag to pull · <span class="kbd">shift</span>+drag to cut</span>
      </div>
      <div class="hud top-right">
        <span class="chip">points <b data-k="points">0</b></span>
        <span class="chip">constraints <b data-k="cons">0</b></span>
      </div>`);
    const q = (k) => el.querySelector(`[data-k="${k}"]`);
    const windBtn = q('wind'), cutBtn = q('cut'), resetBtn = q('reset'), consChip = q('cons');
    q('points').textContent = N;

    // ---- state ---------------------------------------------------------
    const x = new Float32Array(N), y = new Float32Array(N);
    const ox = new Float32Array(N), oy = new Float32Array(N);
    const sx = new Float32Array(N), sy = new Float32Array(N);   // screen-space (css px)
    const pinned = new Uint8Array(N), hold = new Uint8Array(N); // hold = pinned | grabbed
    const CMAX = (COLS - 1) * ROWS + COLS * (ROWS - 1) + 2 * (COLS - 1) * (ROWS - 1);
    const ca = new Int32Array(CMAX), cb = new Int32Array(CMAX);
    const crest = new Float32Array(CMAX), alive = new Uint8Array(CMAX);
    const hIdx = new Int32Array(N).fill(-1), vIdx = new Int32Array(N).fill(-1); // cell edges
    const shade = new Uint8Array(N);
    let cCount = 0, aliveCount = 0, shownCount = -1;
    let t = 0, windOn = !reduced, windAmt = 0, scissors = false, shiftHeld = false;
    let grab = -1, gx = 0, gy = 0, tx = 0, ty = 0, mode = 0, lx = 0, ly = 0; // mode 0 idle,1 grab,2 cut
    let cssW = 0, cssH = 0, dpr = 1, scale = 10, offX = 0, offY = 0;

    function build() {
      cCount = 0;
      const add = (a, b, r) => { ca[cCount] = a; cb[cCount] = b; crest[cCount] = r; alive[cCount] = 1; return cCount++; };
      for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
        const k = j * COLS + i;
        x[k] = ox[k] = i; y[k] = oy[k] = j;
        pinned[k] = hold[k] = (j === 0 && (i % 4 === 0 || i === COLS - 1)) ? 1 : 0;
      }
      for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
        const k = j * COLS + i;
        if (i < COLS - 1) hIdx[k] = add(k, k + 1, 1);              // structural →
        if (j < ROWS - 1) vIdx[k] = add(k, k + COLS, 1);           // structural ↓
        if (i < COLS - 1 && j < ROWS - 1) {                        // shear ↘ ↙
          add(k, k + COLS + 1, Math.SQRT2);
          add(k + 1, k + COLS, Math.SQRT2);
        }
      }
      aliveCount = cCount; t = 0; grab = -1; mode = 0;
    }

    // ---- simulation ----------------------------------------------------
    function step(dt) {
      t += dt;
      windAmt += ((windOn ? 1 : 0) - windAmt) * Math.min(1, dt * 2.5);
      const g = GRAVITY * dt * dt, w = WIND * windAmt * dt * dt;
      const gust = 0.65 + 0.35 * Math.sin(t * 0.6);
      for (let k = 0; k < N; k++) {
        if (hold[k]) continue;
        const px = x[k], py = y[k];
        let nx = px + (px - ox[k]) * DAMP, ny = py + (py - oy[k]) * DAMP + g;
        if (w > 1e-7) { // curl of φ = sin(ax+ωt)·cos(by−ω₂t), plus a gusting base breeze
          const u = 0.28 * px + 1.1 * t, v = 0.22 * py - 0.7 * t;
          nx += w * (gust - 0.9 * Math.sin(u) * Math.sin(v));
          ny += w * (-0.5 * Math.cos(u) * Math.cos(v));
        }
        ox[k] = px; oy[k] = py; x[k] = nx; y[k] = ny;
      }
      if (grab >= 0) { // grabbed point eases toward the pointer and acts as a pin
        gx += (tx - gx) * 0.35; gy += (ty - gy) * 0.35;
        ox[grab] = x[grab]; oy[grab] = y[grab]; x[grab] = gx; y[grab] = gy;
      }
      for (let it = 0; it < ITER; it++) {
        for (let c = 0; c < cCount; c++) {
          if (!alive[c]) continue;
          const a = ca[c], b = cb[c], ha = hold[a], hb = hold[b];
          if (ha && hb) continue;
          const dx = x[b] - x[a], dy = y[b] - y[a];
          const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
          const diff = (d - crest[c]) / d;
          if (ha) { x[b] -= dx * diff; y[b] -= dy * diff; }
          else if (hb) { x[a] += dx * diff; y[a] += dy * diff; }
          else { const h = diff * 0.5; x[a] += dx * h; y[a] += dy * h; x[b] -= dx * h; y[b] -= dy * h; }
        }
      }
    }

    const quadAlive = (i, j) => { // a cell exists while its four structural edges do
      if (i < 0 || j < 0 || i >= COLS - 1 || j >= ROWS - 1) return false;
      const k = j * COLS + i;
      return alive[hIdx[k]] && alive[vIdx[k]] && alive[hIdx[k + COLS]] && alive[vIdx[k + 1]];
    };
    function cut(x0, y0, x1, y1) { // kill constraints the pointer sweep crosses (or brushes)
      const r = Math.min(0.35, Math.max(0.15, 6 / scale)), r2 = r * r;
      const minx = Math.min(x0, x1) - r, maxx = Math.max(x0, x1) + r;
      const miny = Math.min(y0, y1) - r, maxy = Math.max(y0, y1) + r;
      let killed = 0;
      for (let c = 0; c < cCount; c++) {
        if (!alive[c]) continue;
        const a = ca[c], b = cb[c];
        const ax = x[a], ay = y[a], bx = x[b], by = y[b];
        if ((ax < minx && bx < minx) || (ax > maxx && bx > maxx) || (ay < miny && by < miny) || (ay > maxy && by > maxy)) continue;
        if (segHit(x0, y0, x1, y1, ax, ay, bx, by) || pointSegDist2(x1, y1, ax, ay, bx, by) < r2) {
          alive[c] = 0; aliveCount--; killed++;
        }
      }
      if (!killed) return;
      for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) { // drop threads with no fabric left beside them
        const k = j * COLS + i, h = hIdx[k], v = vIdx[k];
        if (h >= 0 && alive[h] && !quadAlive(i, j) && !quadAlive(i, j - 1) && j > 0) { alive[h] = 0; aliveCount--; }
        if (v >= 0 && alive[v] && !quadAlive(i, j) && !quadAlive(i - 1, j)) { alive[v] = 0; aliveCount--; }
      }
    }

    function nearest(px, py) {
      const r = Math.max(2.2, 20 / scale);
      let best = -1, bd = r * r;
      for (let k = 0; k < N; k++) {
        if (pinned[k]) continue;
        const dx = x[k] - px, dy = y[k] - py, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = k; }
      }
      return best;
    }

    // ---- rendering -----------------------------------------------------
    function render() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      for (let k = 0; k < N; k++) { sx[k] = x[k] * scale + offX; sy[k] = y[k] * scale + offY; }
      // shade each quad: area (folds darken), facing sheen, stretch (lighter)
      for (let j = 0; j < ROWS - 1; j++) for (let i = 0; i < COLS - 1; i++) {
        const k = j * COLS + i;
        if (!alive[hIdx[k]] || !alive[vIdx[k]] || !alive[hIdx[k + COLS]] || !alive[vIdx[k + 1]]) { shade[k] = 255; continue; }
        const ax = x[k + 1] - x[k], ay = y[k + 1] - y[k], bx = x[k + COLS] - x[k], by = y[k + COLS] - y[k];
        const la = Math.sqrt(ax * ax + ay * ay) || 1e-6, lb = Math.sqrt(bx * bx + by * by);
        const lc = Math.hypot(x[k + COLS + 1] - x[k + COLS], y[k + COLS + 1] - y[k + COLS]);
        const ld = Math.hypot(x[k + COLS + 1] - x[k + 1], y[k + COLS + 1] - y[k + 1]);
        const area = ax * by - ay * bx, stretch = (la + lb + lc + ld) * 0.25;
        const sheen = Math.abs(ax * 0.94 + ay * 0.34) / la;
        const lum = 0.08 + 0.18 * clamp(area, 0, 1.3) + 0.14 * sheen + 1.6 * clamp(stretch - 1, 0, 0.6);
        shade[k] = clamp(Math.round(lum * (SHADES - 1)), 0, SHADES - 1);
      }
      for (let s = 0; s < SHADES; s++) {
        let any = false;
        ctx.beginPath();
        for (let j = 0; j < ROWS - 1; j++) for (let i = 0; i < COLS - 1; i++) {
          const k = j * COLS + i;
          if (shade[k] !== s) continue;
          any = true;
          ctx.moveTo(sx[k], sy[k]); ctx.lineTo(sx[k + 1], sy[k + 1]);
          ctx.lineTo(sx[k + COLS + 1], sy[k + COLS + 1]); ctx.lineTo(sx[k + COLS], sy[k + COLS]);
          ctx.closePath();
        }
        if (any) { ctx.fillStyle = FILLS[s]; ctx.fill(); }
      }
      // thin structural threads
      ctx.beginPath();
      for (let k = 0; k < N; k++) {
        if (hIdx[k] >= 0 && alive[hIdx[k]]) { ctx.moveTo(sx[k], sy[k]); ctx.lineTo(sx[k + 1], sy[k + 1]); }
        if (vIdx[k] >= 0 && alive[vIdx[k]]) { ctx.moveTo(sx[k], sy[k]); ctx.lineTo(sx[k + COLS], sy[k + COLS]); }
      }
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(169,210,255,0.22)'; ctx.stroke();
      // rod + pins
      ctx.beginPath(); ctx.moveTo(offX - 14, offY); ctx.lineTo(offX + (COLS - 1) * scale + 14, offY);
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(150,178,255,0.35)'; ctx.stroke();
      ctx.fillStyle = '#a9d2ff';
      for (let i = 0; i < COLS; i++) if (pinned[i]) { ctx.beginPath(); ctx.arc(sx[i], sy[i], 2.6, 0, Math.PI * 2); ctx.fill(); }
      if (grab >= 0) {
        ctx.beginPath(); ctx.arc(sx[grab], sy[grab], 7, 0, Math.PI * 2);
        ctx.lineWidth = 1.5; ctx.strokeStyle = '#e9efff'; ctx.stroke();
      }
      if (aliveCount !== shownCount) { shownCount = aliveCount; consChip.textContent = aliveCount; }
    }

    // ---- loop (fixed-step accumulator) ---------------------------------
    let raf = 0, last = 0, acc = 0, resumed = false, activeUntil = 0;
    function frame(now) {
      raf = 0;
      const fdt = Math.min(0.1, (now - last) / 1000 || DT); last = now;
      const simulating = !reduced || mode !== 0 || now < activeUntil;
      if (simulating) {
        acc += fdt; let n = 0;
        while (acc >= DT && n < MAX_SUB) { step(DT); acc -= DT; n++; }
        if (acc >= DT) acc = 0; // too far behind: drop time rather than spiral
      }
      render();
      if (resumed && simulating) raf = requestAnimationFrame(frame);
    }
    function wake() { // reduced-motion: simulate only around interaction
      activeUntil = performance.now() + IDLE_MS;
      if (resumed && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    }

    // ---- input ---------------------------------------------------------
    function toSim(e) {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left - offX) / scale, (e.clientY - r.top - offY) / scale];
    }
    function cursor() {
      const cutting = scissors || shiftHeld;
      canvas.classList.toggle('grabbing', mode === 1);
      canvas.classList.toggle('grab', mode !== 1 && !cutting);
      canvas.style.cursor = mode !== 1 && cutting ? 'crosshair' : '';
    }
    function release(e) {
      if (mode === 1 && grab >= 0) {
        hold[grab] = pinned[grab];
        ox[grab] = x[grab] - (gx - ox[grab]) * 0.6; oy[grab] = y[grab] - (gy - oy[grab]) * 0.6; // fling
        grab = -1;
      }
      mode = 0; cursor(); wake();
      try { if (e && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); } catch (_) { /* synthetic ids */ }
    }
    function onDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic ids */ }
      const [px, py] = toSim(e); lx = px; ly = py;
      if (scissors || e.shiftKey) { mode = 2; cut(px, py, px, py); }
      else {
        grab = nearest(px, py);
        if (grab >= 0) { mode = 1; hold[grab] = 1; gx = x[grab]; gy = y[grab]; tx = px; ty = py; }
      }
      cursor(); wake();
    }
    function onMove(e) {
      const [px, py] = toSim(e);
      if (mode === 1) { tx = px; ty = py; }
      else if (mode === 2) { cut(lx, ly, px, py); wake(); }
      if (shiftHeld !== e.shiftKey) { shiftHeld = e.shiftKey; cursor(); }
      lx = px; ly = py;
    }
    function onKey(e) { if (e.key === 'Shift') { shiftHeld = e.type === 'keydown'; cursor(); } }
    function onWind() { windOn = !windOn; windBtn.setAttribute('aria-pressed', String(windOn)); wake(); }
    function onCut() { scissors = !scissors; cutBtn.setAttribute('aria-pressed', String(scissors)); cursor(); }
    function onReset() { build(); windAmt = 0; shownCount = -1; cursor(); wake(); }

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    windBtn.addEventListener('click', onWind);
    cutBtn.addEventListener('click', onCut);
    resetBtn.addEventListener('click', onReset);
    windBtn.setAttribute('aria-pressed', String(windOn));

    // ---- layout --------------------------------------------------------
    function resize() {
      cssW = el.clientWidth || 640; cssH = el.clientHeight || 400; dpr = FABLE.dpr(2);
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      scale = Math.min((cssW * 0.8) / (COLS - 1), (cssH * 0.66) / (ROWS - 1));
      offX = (cssW - (COLS - 1) * scale) / 2; offY = Math.max(30, cssH * 0.1);
      render();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    build();
    resize();

    window.__cloth = {
      constraints: () => aliveCount, points: () => N,
      pos: (k) => [x[k], y[k]], layout: () => ({ scale, offX, offY, cssW, cssH }), active: () => !!raf,
      bench: (n = 60) => { const t0 = performance.now(); for (let i = 0; i < n; i++) { step(DT); render(); } return (performance.now() - t0) / n; },
      stretch: () => { // mean structural stretch ratio (1 = rest)
        let s = 0, n = 0;
        for (let c = 0; c < cCount; c++) if (alive[c] && crest[c] === 1) { s += Math.hypot(x[cb[c]] - x[ca[c]], y[cb[c]] - y[ca[c]]); n++; }
        return s / n;
      }
    };

    return {
      resume() { resumed = true; if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } },
      pause() { resumed = false; cancelAnimationFrame(raf); raf = 0; },
      destroy() {
        this.pause(); ro.disconnect();
        window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey);
        delete window.__cloth;
        el.innerHTML = '';
      }
    };
  }
})();
