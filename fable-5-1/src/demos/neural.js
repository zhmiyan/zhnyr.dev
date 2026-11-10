/* fable-5-1 / demos/neural.js — a neural network trained live in the browser, no libraries.
 * A 2→24→24→1 MLP (tanh hidden units, sigmoid output) stored as flat Float32Arrays with a
 * hand-written forward pass and backprop (binary cross-entropy), optimised with Adam on
 * minibatches of 32 drawn from 2D toy datasets. Each frame spends a CPU budget (2–9 ms,
 * adapted to the measured frame interval so the page holds ~60 fps) on training steps plus a
 * slice of the decision field: a coarse 96×60 grid upscaled with drawImage smoothing.
 */
(() => {
  const H = 24, BATCH = 32, MAX_STEPS = 64, GRID = 96;
  const BUDGET_MIN = 2, BUDGET_MAX = 9; // ms of CPU work per frame (train + field), adapts to frame rate
  const DATASETS = ['two spirals', 'rings', 'xor', 'moons'];
  const COL = { blue: '#4f8cff', peach: '#ffd9a8' };
  // field colours: deep blue (class 0) · dark neutral seam at p=0.5 · muted peach (class 1)
  const cA = [40, 76, 182], cN = [20, 28, 52], cB = [204, 146, 96];

  // ---- data ---------------------------------------------------------------
  const rnd = (a, b) => a + Math.random() * (b - a);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(6.2831853 * Math.random());
  function makeData(kind, n = 100) {
    const pts = [];
    const add = (x, y, c) => pts.push({ x, y, c });
    if (kind === 'two spirals') {
      for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) {
        const r = 0.08 + 0.87 * (i / n), t = 1.75 * (i / n) * 2 * Math.PI + c * Math.PI;
        add(r * Math.sin(t) + gauss() * 0.025, r * Math.cos(t) + gauss() * 0.025, c);
      }
    } else if (kind === 'rings') {
      for (let i = 0; i < n; i++) { const t = rnd(0, 6.2832), r = Math.sqrt(Math.random()) * 0.42; add(r * Math.cos(t), r * Math.sin(t), 0); }
      for (let i = 0; i < n; i++) { const t = rnd(0, 6.2832), r = rnd(0.62, 0.95); add(r * Math.cos(t), r * Math.sin(t), 1); }
    } else if (kind === 'xor') {
      for (let i = 0; i < 2 * n; i++) {
        let x = rnd(-0.9, 0.9), y = rnd(-0.9, 0.9);
        x += Math.sign(x) * 0.06; y += Math.sign(y) * 0.06;
        add(x, y, x * y > 0 ? 0 : 1);
      }
    } else { // moons
      for (let i = 0; i < n; i++) {
        const t = rnd(0, Math.PI), s = 0.62, nz = 0.045;
        add((Math.cos(t) - 0.5) * s + gauss() * nz, (Math.sin(t) - 0.25) * s + gauss() * nz, 0);
        add((0.5 - Math.cos(t)) * s + gauss() * nz, (0.25 - Math.sin(t)) * s + gauss() * nz, 1);
      }
    }
    return pts;
  }

  // ---- network: params P, grads G, Adam moments M/V, all flat Float32Arrays ----
  const SHAPES = [[H, 2], [H, 1], [H, H], [H, 1], [1, H], [1, 1]]; // W1 b1 W2 b2 W3 b3
  // Padé(7,6) tanh: ~5x faster than Math.tanh in V8, |err| < 1e-4, clamped past ±4.97
  function tanh(x) {
    if (x > 4.97) return 1; if (x < -4.97) return -1;
    const x2 = x * x;
    return x * (135135 + x2 * (17325 + x2 * (378 + x2))) / (135135 + x2 * (62370 + x2 * (3150 + 28 * x2)));
  }
  function makeNet() {
    const mk = () => SHAPES.map(([o, i]) => new Float32Array(o * i));
    const net = { P: mk(), G: mk(), M: mk(), V: mk(), t: 0 };
    const init = (arr, a) => { for (let k = 0; k < arr.length; k++) arr[k] = rnd(-a, a); };
    // wide first-layer init: the spirals need high-frequency features from the start
    init(net.P[0], 2.5); init(net.P[1], 1); init(net.P[2], Math.sqrt(3 / H)); init(net.P[4], Math.sqrt(3 / H));
    return net;
  }
  const h1 = new Float32Array(H), h2 = new Float32Array(H), d1 = new Float32Array(H), d2 = new Float32Array(H);
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));
  function forward(net, x, y) { // leaves hidden activations in h1/h2, returns the logit z
    const [W1, b1, W2, b2, W3, b3] = net.P;
    for (let j = 0; j < H; j++) h1[j] = tanh(W1[j * 2] * x + W1[j * 2 + 1] * y + b1[j]);
    for (let k = 0; k < H; k++) {
      let s = b2[k]; const o = k * H;
      for (let j = 0; j < H; j++) s += W2[o + j] * h1[j];
      h2[k] = tanh(s);
    }
    let z = b3[0];
    for (let k = 0; k < H; k++) z += W3[k] * h2[k];
    return z;
  }
  function step(net, pts, lr) { // one minibatch of BCE backprop + an Adam update
    const { P, G, M, V } = net;
    for (const g of G) g.fill(0);
    const W2 = P[2], W3 = P[4];
    const [gW1, gb1, gW2, gb2, gW3, gb3] = G;
    const B = Math.min(BATCH, pts.length);
    for (let s = 0; s < B; s++) {
      const q = pts[(Math.random() * pts.length) | 0];
      const dz = (sigmoid(forward(net, q.x, q.y)) - q.c) / B; // dL/dz for sigmoid+BCE
      gb3[0] += dz;
      for (let k = 0; k < H; k++) { gW3[k] += dz * h2[k]; d2[k] = dz * W3[k] * (1 - h2[k] * h2[k]); }
      d1.fill(0);
      for (let k = 0; k < H; k++) {
        const o = k * H, dk = d2[k]; gb2[k] += dk;
        for (let j = 0; j < H; j++) { gW2[o + j] += dk * h1[j]; d1[j] += dk * W2[o + j]; }
      }
      for (let j = 0; j < H; j++) {
        const dj = d1[j] * (1 - h1[j] * h1[j]);
        gb1[j] += dj; gW1[j * 2] += dj * q.x; gW1[j * 2 + 1] += dj * q.y;
      }
    }
    net.t++;
    const b1 = 0.9, b2 = 0.999, c1 = 1 - Math.pow(b1, net.t), c2 = 1 - Math.pow(b2, net.t);
    for (let i = 0; i < P.length; i++) {
      const p = P[i], g = G[i], m = M[i], v = V[i];
      for (let k = 0; k < p.length; k++) {
        m[k] = b1 * m[k] + (1 - b1) * g[k];
        v[k] = b2 * v[k] + (1 - b2) * g[k] * g[k];
        p[k] -= lr * (m[k] / c1) / (Math.sqrt(v[k] / c2) + 1e-8);
      }
    }
  }
  function evaluate(net, pts) {
    let loss = 0, correct = 0;
    for (const q of pts) {
      const p = sigmoid(forward(net, q.x, q.y)), pc = Math.min(Math.max(p, 1e-7), 1 - 1e-7);
      loss -= q.c ? Math.log(pc) : Math.log(1 - pc);
      if ((p > 0.5) === (q.c === 1)) correct++;
    }
    const n = Math.max(1, pts.length);
    return { loss: loss / n, acc: correct / n };
  }

  // ---- DOM helpers ------------------------------------------------------------
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const lrFromSlider = (t) => Math.pow(10, -3.3 + 2.3 * t);
  const sliderFromLr = (lr) => (Math.log10(lr) + 3.3) / 2.3;

  function mountInner(el) {
    el.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.className = 'pointer';
    const ctx = canvas.getContext('2d');
    if (!ctx) { FABLE.fail(el, 'canvas 2d is not available here'); return {}; }
    el.appendChild(canvas);
    const field = document.createElement('canvas'), fctx = field.getContext('2d');

    // ---- state
    let dataset = DATASETS[0], pts = makeData(dataset), net = makeNet();
    let playing = !FABLE.reducedMotion, lr = 0.01, addClass = 1, stepsPerFrame = 6;
    let W = 0, Hh = 0, dpr = 1, scale = 1, cx = 0, cy = 0, gw = 0, gh = 0, img = null;
    let fieldDirty = true, drawDirty = true, raf = 0, fieldRow = 0;
    let stats = { loss: 0, acc: 0 };
    const lossHist = [], pulses = [];

    // ---- hud: datasets (top-left)
    const hudTL = h('div', 'hud top-left');
    const dsBtns = DATASETS.map((name) => {
      const b = h('button', 'btn sm', name);
      b.setAttribute('aria-pressed', String(name === dataset));
      b.addEventListener('click', () => setDataset(name));
      hudTL.appendChild(b);
      return b;
    });
    // ---- hud: chips (top-right)
    const hudTR = h('div', 'hud top-right');
    const chip = (label) => { const c = h('span', 'chip'); c.append(label + ' '); const b = h('b', '', '–'); c.appendChild(b); hudTR.appendChild(c); return b; };
    const epochV = chip('epoch'), lossV = chip('loss'), accV = chip('acc');
    // ---- hud: controls (bottom-left)
    const hud = h('div', 'hud');
    const playBtn = h('button', 'btn primary');
    const resetBtn = h('button', 'btn', 'reset weights');
    const classBtn = h('button', 'btn sm');
    const dot = h('span'); dot.style.cssText = 'display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:-1px;border:1px solid rgba(6,10,20,.6)';
    const classTxt = h('span');
    classBtn.append(dot, classTxt);
    const lrWrap = h('label', 'chip'); lrWrap.append('lr ');
    const lrV = h('b', '', lr.toFixed(3));
    const lrIn = h('input'); lrIn.type = 'range'; lrIn.min = '0'; lrIn.max = '1'; lrIn.step = '0.01';
    lrIn.value = String(sliderFromLr(lr)); lrIn.style.cssText = 'width:84px;margin:0 0 0 6px;height:14px';
    lrIn.setAttribute('aria-label', 'learning rate');
    lrWrap.append(lrV, lrIn);
    const note = h('span', 'note', 'click: add point · right-click: add other class');
    hud.append(playBtn, resetBtn, classBtn, lrWrap, note);
    el.append(hudTL, hudTR, hud);

    function setPlaying(v) { playing = v; playBtn.textContent = playing ? '❚❚ pause' : '▶ play'; }
    function setAddClass(c) {
      addClass = c;
      dot.style.background = c ? COL.peach : COL.blue;
      classTxt.textContent = c ? 'adding: peach' : 'adding: blue';
    }
    function resetWeights() { net = makeNet(); lossHist.length = 0; fieldDirty = true; }
    function setDataset(name) {
      dataset = name; pts = makeData(name); pulses.length = 0;
      dsBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === name)));
      resetWeights();
    }
    playBtn.addEventListener('click', () => setPlaying(!playing));
    resetBtn.addEventListener('click', resetWeights);
    classBtn.addEventListener('click', () => setAddClass(1 - addClass));
    lrIn.addEventListener('input', () => { lr = lrFromSlider(+lrIn.value); lrV.textContent = lr.toFixed(lr < 0.01 ? 4 : 3); });
    setPlaying(playing); setAddClass(addClass);

    // ---- adding points: left click = current class, right click = the other class
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      const r = canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) * (W / r.width) - cx) / scale;
      const y = -((e.clientY - r.top) * (Hh / r.height) - cy) / scale;
      if (e.button === 2) setAddClass(1 - addClass);
      pts.push({ x, y, c: addClass });
      pulses.push({ x, y, c: addClass, t0: performance.now() });
      fieldDirty = true; drawDirty = true;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // ---- layout
    function resize() {
      W = el.clientWidth || 640; Hh = el.clientHeight || 400; dpr = FABLE.dpr(2);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hh * dpr);
      scale = Math.min(W, Hh) * 0.4; cx = W / 2; cy = Hh / 2 - 6;
      if (W >= Hh) { gw = GRID; gh = Math.max(8, Math.round(gw * Hh / W)); }
      else { gh = GRID; gw = Math.max(8, Math.round(gh * W / Hh)); }
      field.width = gw; field.height = gh; img = fctx.createImageData(gw, gh); fieldRow = 0;
      hudTR.style.top = W < 640 ? '52px' : '';
      fieldDirty = drawDirty = true;
    }
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // ---- rendering: the field is refreshed progressively, a few grid rows per frame
    // (rolling sweep) so the per-frame cost stays bounded; a sweep completes every ~3 frames.
    function computeField(budgetMs) { // returns true when a full sweep just completed
      const t0 = performance.now(), d = img.data;
      let done = false;
      do {
        const y = -(((fieldRow + 0.5) / gh) * Hh - cy) / scale;
        let o = fieldRow * gw * 4;
        for (let gx = 0; gx < gw; gx++) {
          const x = (((gx + 0.5) / gw) * W - cx) / scale;
          const z = forward(net, x, y), side = z < 0 ? cA : cB;
          const t = tanh(Math.abs(z) * 0.45); // blend on the logit: soft neutral seam at p = 0.5
          d[o++] = cN[0] + (side[0] - cN[0]) * t;
          d[o++] = cN[1] + (side[1] - cN[1]) * t;
          d[o++] = cN[2] + (side[2] - cN[2]) * t;
          d[o++] = 255;
        }
        if (++fieldRow >= gh) { fieldRow = 0; done = true; }
      } while (!done && performance.now() - t0 < budgetMs);
      fctx.putImageData(img, 0, 0);
      return done;
    }
    function refreshStats() {
      stats = evaluate(net, pts);
      if (playing) { lossHist.push(stats.loss); if (lossHist.length > 160) lossHist.shift(); }
      updateChips();
    }
    function drawPoints(cls, color) {
      ctx.beginPath();
      for (const q of pts) {
        if (q.c !== cls) continue;
        const px = cx + q.x * scale, py = cy - q.y * scale;
        ctx.moveTo(px + 4, py); ctx.arc(px, py, 4, 0, 6.2832);
      }
      ctx.fillStyle = color; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(6,10,20,0.9)'; ctx.stroke();
    }
    function drawSparkline() {
      const w = 124, hh = 38, x0 = W - 12 - w, y0 = hudTR.offsetTop + hudTR.offsetHeight + 8;
      ctx.fillStyle = 'rgba(10,16,34,0.72)'; ctx.strokeStyle = 'rgba(150,178,255,0.16)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(x0, y0, w, hh, 8); ctx.fill(); ctx.stroke();
      ctx.font = '600 10px "JetBrains Mono", Menlo, monospace'; ctx.fillStyle = '#8d9cc4';
      ctx.fillText('loss', x0 + 8, y0 + 12);
      if (lossHist.length < 2) return;
      let hi = 0.05;
      for (const v of lossHist) hi = Math.max(hi, v);
      const llo = Math.log(1e-3), lhi = Math.log(hi); // log scale, floor fixed so descent reads clearly
      ctx.beginPath();
      for (let i = 0; i < lossHist.length; i++) {
        const x = x0 + 8 + (w - 16) * (i / (lossHist.length - 1));
        const y = y0 + hh - 5 - (hh - 20) * Math.max(0, (Math.log(Math.max(lossHist[i], 1e-4)) - llo) / (lhi - llo));
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = '#6fe3b4'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
    }
    function draw(now) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(field, 0, 0, W, Hh);
      drawPoints(0, COL.blue); drawPoints(1, COL.peach);
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i], k = (now - p.t0) / 650;
        if (k >= 1) { pulses.splice(i, 1); continue; }
        ctx.beginPath(); ctx.arc(cx + p.x * scale, cy - p.y * scale, 5 + 18 * k, 0, 6.2832);
        ctx.strokeStyle = p.c ? COL.peach : COL.blue; ctx.globalAlpha = 1 - k; ctx.lineWidth = 2; ctx.stroke();
        ctx.globalAlpha = 1;
      }
      drawSparkline();
    }
    function updateChips() {
      epochV.textContent = String(Math.floor(net.t * BATCH / Math.max(1, pts.length)));
      lossV.textContent = stats.loss.toFixed(4);
      accV.textContent = (stats.acc * 100).toFixed(1) + '%';
    }

    // ---- frame loop: train (time-budgeted steps) → field slice (time-budgeted) → draw.
    // The work budget adapts to the measured frame interval so slower machines (or
    // software rasterisers) trade steps/second for a steady frame rate rather than jank.
    const timing = { train: 0, field: 0, draw: 0, budget: 6, dt: 16.7 };
    let lastNow = 0;
    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (lastNow) {
        const dt = Math.min(100, now - lastNow);
        timing.dt += (dt - timing.dt) * 0.1;
        if (timing.dt > 19) timing.budget = Math.max(BUDGET_MIN, timing.budget * 0.93);
        else if (timing.dt < 17.5) timing.budget = Math.min(BUDGET_MAX, timing.budget * 1.03);
      }
      lastNow = now;
      const t0 = performance.now();
      if (playing) {
        const trainUntil = t0 + timing.budget * 0.6; let n = 0;
        while (n < MAX_STEPS && (n < 2 || performance.now() < trainUntil)) { step(net, pts, lr); n++; }
        stepsPerFrame = n; timing.train = performance.now() - t0;
        const t1 = performance.now();
        if (computeField(timing.budget * 0.4)) refreshStats();
        timing.field = performance.now() - t1; fieldDirty = false; drawDirty = true;
      } else if (fieldDirty) { // paused: a point was added or the net reset → one full sweep
        fieldRow = 0; computeField(Infinity); refreshStats();
        fieldDirty = false; drawDirty = true;
      }
      if (drawDirty || pulses.length) { const t2 = performance.now(); draw(now); timing.draw = performance.now() - t2; drawDirty = false; }
    }

    window.__neural = {
      accuracy: () => stats.acc, loss: () => stats.loss,
      epoch: () => net.t * BATCH / Math.max(1, pts.length), steps: () => net.t,
      stepsPerFrame: () => stepsPerFrame, points: () => pts.length, timing: () => ({ ...timing }),
    };
    return {
      resume() { if (!raf) { lastNow = 0; raf = requestAnimationFrame(frame); } },
      pause() { if (raf) cancelAnimationFrame(raf); raf = 0; },
      destroy() { this.pause(); ro.disconnect(); el.innerHTML = ''; delete window.__neural; },
    };
  }

  FABLE.register('neural', {
    mount(el) {
      try { return mountInner(el); }
      catch (err) { console.error('[neural]', err); FABLE.fail(el, 'the neural demo could not start: ' + err.message); return {}; }
    },
  });
})();
