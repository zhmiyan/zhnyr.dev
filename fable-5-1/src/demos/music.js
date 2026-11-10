/* fable-5-1 / demos/music.js — generative night-sky music box (Web Audio only; no samples, no libraries).
 * SYNTHESIS: pad = detuned saw+triangle pair per chord tone → shared lowpass swept by a 0.07 Hz LFO; sub bass = sine + quiet
 * triangle octave; music-box lead = 2-op FM bell (4.02× modulator, index decays in 300 ms) + short octave partial; drums = one
 * white-noise buffer through highpass (hat) / bandpass (brushed snare) with ms envelopes; per-instrument sends into a Convolver
 * whose IR is lowpassed exponentially-decaying noise; everything → compressor → analyser (drives the starfield) → destination.
 * SCHEDULER: 16th-note grid booked ≤150 ms ahead by a 25 ms setTimeout lookahead loop at exact AudioContext times; one seeded
 * mulberry32 PRNG drives key, progressions, the chord-tone-weighted Markov melody walk and humanisation → a seed replays a piece. */
(() => {
  'use strict';
  const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const SCALES = {
    minor:  { steps: [0, 2, 3, 5, 7, 8, 10], roman: ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'],
              progs: [[0, 5, 2, 6], [0, 3, 6, 2], [0, 6, 5, 6], [0, 2, 6, 3], [5, 6, 0, 0], [0, 5, 3, 6]] },
    dorian: { steps: [0, 2, 3, 5, 7, 9, 10], roman: ['i', 'ii', 'III', 'IV', 'v', 'vi°', 'VII'],
              progs: [[0, 3, 0, 6], [0, 1, 3, 0], [0, 3, 6, 3], [0, 1, 0, 3], [2, 3, 0, 6]] },
  };
  const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24]; // minor pentatonic, two octaves
  const TONICS = [55, 57, 58, 60, 62];                    // G3 A3 Bb3 C4 D4
  const LOOKAHEAD = 0.15, TICK_MS = 25, TAU = Math.PI * 2;
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- composition ---------------- */
  function makePiece(seed) {
    const rnd = mulberry32(seed);
    const modeName = rnd() < 0.55 ? 'minor' : 'dorian';
    const tonic = TONICS[Math.floor(rnd() * TONICS.length)];
    const p = { rnd, mode: SCALES[modeName], tonic, bpm: 68 + Math.floor(rnd() * 9),
      keyName: `${NOTE_NAMES[tonic % 12]} ${modeName}`, prog: null, progIdx: -1, chord: null, melIdx: 5, lastMel: -9 };
    pickProg(p);
    return p;
  }
  function pickProg(p) {
    let i;
    do { i = Math.floor(p.rnd() * p.mode.progs.length); } while (i === p.progIdx);
    p.progIdx = i; p.prog = p.mode.progs[i];
  }
  function chordFor(p, deg) {
    const st = p.mode.steps, notes = [];
    for (let k = 0; k < 4; k++) {           // root, 3rd, 5th, 7th from the scale, folded into a mid register
      const d = deg + k * 2;
      let n = p.tonic + st[d % 7] + 12 * Math.floor(d / 7);
      if (n > p.tonic + 11) n -= 12;
      notes.push(n);
    }
    notes.sort((a, b) => a - b);
    let bass = p.tonic - 24 + st[deg];
    if (bass > p.tonic - 17) bass -= 12;
    return { deg, notes, bass, pcs: new Set(notes.map((n) => n % 12)), label: p.mode.roman[deg] };
  }
  // Markov-ish walk over the pentatonic pool: small steps preferred, chord tones ×2.8, pulled toward the middle.
  function walkMelody(p, ch) {
    const base = [1, 2, 4, 1.2, 4, 2, 1], ws = [];
    let sum = 0;
    for (let k = -3; k <= 3; k++) {
      const j = p.melIdx + k;
      let w = (j < 0 || j >= PENTA.length) ? 0 : base[k + 3] * (1 - Math.abs(j - 5) / 9);
      if (w && ch.pcs.has((p.tonic + PENTA[j]) % 12)) w *= 2.8;
      ws.push(w); sum += w;
    }
    let r = p.rnd() * sum, k = 0;
    while (k < 6 && r >= ws[k]) { r -= ws[k]; k++; }
    p.melIdx += k - 3;
    return p.tonic + 12 + PENTA[p.melIdx];
  }

  /* ---------------- audio graph ---------------- */
  function noiseBuffer(ac, seed, seconds) {
    const r = mulberry32(seed), len = Math.floor(ac.sampleRate * seconds);
    const buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
    return buf;
  }
  function impulseResponse(ac) {               // 2.6 s of lowpassed, exponentially decaying stereo noise
    const len = Math.floor(ac.sampleRate * 2.6), buf = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++) {
      const r = mulberry32(700 + c), d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        lp += 0.22 * ((r() * 2 - 1) - lp);
        d[i] = lp * Math.exp(-7 * i / len) * Math.min(1, i / 240);
      }
    }
    return buf;
  }
  function createGraph(ac) {
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 18; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.3;
    const master = ac.createGain(); master.gain.value = 0.85;
    const analyser = ac.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.82;
    comp.connect(master); master.connect(analyser); analyser.connect(ac.destination);
    const verb = ac.createConvolver(); verb.buffer = impulseResponse(ac);
    const verbGain = ac.createGain(); verbGain.gain.value = 0.42; verb.connect(verbGain); verbGain.connect(comp);
    const bus = (send) => {
      const g = ac.createGain(), s = ac.createGain();
      s.gain.value = send; g.connect(comp); g.connect(s); s.connect(verb);
      return g;
    };
    const g = { comp, master, analyser, pad: bus(0.5), bass: bus(0.06), lead: bus(0.7), drums: bus(0.3) };
    g.padFilter = ac.createBiquadFilter(); g.padFilter.type = 'lowpass'; g.padFilter.frequency.value = 820; g.padFilter.Q.value = 0.8;
    g.padFilter.connect(g.pad);
    g.lfo = ac.createOscillator(); g.lfo.frequency.value = 0.07;
    const lfoG = ac.createGain(); lfoG.gain.value = 300; g.lfo.connect(lfoG); lfoG.connect(g.padFilter.frequency); g.lfo.start();
    g.vib = ac.createOscillator(); g.vib.frequency.value = 0.33;
    g.vibG = ac.createGain(); g.vibG.gain.value = 4; g.vib.connect(g.vibG); g.vib.start(); // cents, into pad osc detune
    g.leadFilter = ac.createBiquadFilter(); g.leadFilter.type = 'lowpass'; g.leadFilter.frequency.value = 5200; g.leadFilter.connect(g.lead);
    g.noise = noiseBuffer(ac, 99, 2);
    g.hiss = ac.createBufferSource(); g.hiss.buffer = g.noise; g.hiss.loop = true;    // tape-hiss floor, very quiet
    const hf = ac.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 2800;
    const hg = ac.createGain(); hg.gain.value = 0.003; g.hiss.connect(hf); hf.connect(hg); hg.connect(comp); g.hiss.start();
    return g;
  }

  /* ---------------- voices ---------------- */
  function releasePads(S, t, len = 2.4) {
    for (const v of S.padVoices) {
      const gp = v.gain.gain;
      if (gp.cancelAndHoldAtTime) gp.cancelAndHoldAtTime(t); else { gp.cancelScheduledValues(t); gp.setValueAtTime(gp.value, t); }
      gp.linearRampToValueAtTime(0, t + len);
      v.oscs.forEach((o) => o.stop(t + len + 0.1));
    }
    S.padVoices = [];
  }
  function playPad(S, ch, t) {
    const { ac, g } = S;
    releasePads(S, t);
    ch.notes.forEach((n, i) => {
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(0.038, t + 1.7);
      gain.connect(g.padFilter);
      const oscs = [['sawtooth', -7], ['triangle', 7]].map(([type, det]) => {
        const o = ac.createOscillator();
        o.type = type; o.frequency.value = mtof(n); o.detune.value = det + (i - 1.5) * 2;
        g.vibG.connect(o.detune); o.connect(gain); o.start(t);
        return o;
      });
      S.padVoices.push({ gain, oscs });
    });
    S.counts.total++;
  }
  function playBass(S, f, t, vel) {
    const { ac, g } = S, env = ac.createGain();
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.5 * vel, t + 0.03);
    env.gain.exponentialRampToValueAtTime(0.001, t + 1.8); env.connect(g.bass);
    const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(env);
    const o2 = ac.createOscillator(); o2.type = 'triangle'; o2.frequency.value = f * 2;
    const g2 = ac.createGain(); g2.gain.value = 0.1; o2.connect(g2); g2.connect(env);
    o.start(t); o2.start(t); o.stop(t + 1.9); o2.stop(t + 1.9);
    S.counts.total++;
  }
  function playBell(S, f, t, vel) {   // music-box: FM bell + short octave partial
    const { ac, g } = S;
    const car = ac.createOscillator(); car.frequency.value = f;
    const mod = ac.createOscillator(); mod.frequency.value = f * 4.02;
    const idx = ac.createGain();
    idx.gain.setValueAtTime(f * 1.4, t); idx.gain.exponentialRampToValueAtTime(f * 0.02, t + 0.3);
    mod.connect(idx); idx.connect(car.frequency);
    const env = ac.createGain();
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.2 * vel, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0004, t + 2.2);
    car.connect(env); env.connect(g.leadFilter);
    const p2 = ac.createOscillator(); p2.frequency.value = f * 2.003;
    const e2 = ac.createGain(); e2.gain.setValueAtTime(0.05 * vel, t); e2.gain.exponentialRampToValueAtTime(0.0004, t + 0.5);
    p2.connect(e2); e2.connect(g.leadFilter);
    [car, mod, p2].forEach((o) => { o.start(t); o.stop(t + 2.3); });
    S.counts.total++; S.counts.melody++;
  }
  function playNoise(S, t, vel, type, freq, q, peak, tau, len) {
    const { ac, g } = S, src = ac.createBufferSource(); src.buffer = g.noise;
    const flt = ac.createBiquadFilter(); flt.type = type; flt.frequency.value = freq; flt.Q.value = q;
    const env = ac.createGain();
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(peak * vel, t + 0.005); env.gain.setTargetAtTime(0, t + 0.01, tau);
    src.connect(flt); flt.connect(env); env.connect(g.drums);
    src.start(t, S.piece.rnd() * 1.5, len); src.stop(t + len + 0.05);
    S.counts.total++;
  }
  const playHat = (S, t, v) => playNoise(S, t, v, 'highpass', 7500, 0.7, 0.07, 0.03, 0.25);
  const playSnare = (S, t, v) => playNoise(S, t, v, 'bandpass', 1700, 0.6, 0.13, 0.07, 0.4);

  /* ---------------- one 16th-note step ---------------- */
  function scheduleStep(S, step, t) {
    const p = S.piece, rnd = p.rnd, pos = step % 16, bar = Math.floor(step / 16), dur = S.stepDur;
    if (pos === 0) {
      if (bar > 0 && bar % 16 === 0) pickProg(p);        // new progression every 16 bars
      const ch = chordFor(p, p.prog[bar % 4]);            // one chord per bar
      if (!p.chord || p.chord.deg !== ch.deg) playPad(S, ch, t);
      p.chord = ch;
      S.events.push({ t, kind: 'chord', label: ch.label });
    }
    const ch = p.chord;
    const tt = t + (pos % 2 ? dur * 0.14 : 0) + (rnd() - 0.5) * 0.008;   // lazy swing + humanise
    if (pos === 0) playBass(S, mtof(ch.bass), tt, 1);
    else if (pos === 10 && rnd() < 0.45) playBass(S, mtof(ch.bass + (rnd() < 0.5 ? 7 : 0)), tt, 0.55);
    let pm = pos % 4 === 0 ? 0.5 : pos % 2 === 0 ? 0.3 : 0.07;
    if (bar % 16 >= 8) pm *= 1.3;                          // second half of each 16-bar block is busier
    if (step - p.lastMel < 2) pm *= 0.3;
    if (rnd() < pm) {
      const note = walkMelody(p, ch), vel = 0.5 + rnd() * 0.5;
      playBell(S, mtof(note), tt, vel);
      p.lastMel = step;
      S.events.push({ t: tt, kind: 'note', pitch: p.melIdx / (PENTA.length - 1), vel });
    }
    if (pos % 4 === 2 && rnd() < 0.85) playHat(S, tt, 0.5 + rnd() * 0.4);
    else if (pos % 2 === 1 && rnd() < 0.1) playHat(S, tt, 0.25 + rnd() * 0.2);
    if ((pos === 4 || pos === 12) && rnd() < 0.92) playSnare(S, tt, 0.7 + rnd() * 0.3);
    else if ((pos === 7 || pos === 15) && rnd() < 0.18) playSnare(S, tt, 0.3);
  }

  /* ---------------- demo ---------------- */
  FABLE.register('music', {
    mount(el) {
      try { return mountMusic(el); } catch (err) {
        console.error('[music]', err);
        FABLE.fail(el, 'the music box could not start here');
        return {};
      }
    },
  });

  function mountMusic(el) {
    const reduced = !!FABLE.reducedMotion;
    el.innerHTML = '';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const hud = document.createElement('div'); hud.className = 'hud';
    hud.innerHTML = '<button class="btn primary" data-act="play" aria-pressed="false">▶ play</button>' +
      '<button class="btn sm" data-act="seed">new seed</button>' +
      '<button class="btn sm" data-act="drums" aria-pressed="false">mute drums</button>';
    const info = document.createElement('div'); info.className = 'hud top-right';
    info.innerHTML = '<span class="chip">seed <b data-k="seed"></b></span><span class="chip">key <b data-k="key"></b></span>' +
      '<span class="chip"><b data-k="bpm"></b> bpm</span><span class="chip">chord <b data-k="chord">–</b></span>';
    el.append(canvas, hud, info);
    const playBtn = hud.querySelector('[data-act=play]'), drumBtn = hud.querySelector('[data-act=drums]');
    const chip = (k) => info.querySelector(`[data-k=${k}]`);
    const font = (getComputedStyle(document.documentElement).getPropertyValue('--font-display') || 'Georgia, serif').trim();

    let seed = (Math.random() * 0xffffffff) >>> 0;
    let piece = makePiece(seed);
    let ac = null, g = null, S = null;
    const counts = { total: 0, melody: 0 };
    let playing = false, pausedByScroll = false, visible = false, drumsMuted = false, timer = 0, raf = 0;

    function showPiece() {
      chip('seed').textContent = seed.toString(16).padStart(8, '0');
      chip('key').textContent = piece.keyName;
      chip('bpm').textContent = piece.bpm;
      chip('chord').textContent = '–';
      makeStars();
    }

    /* --- audio lifecycle --- */
    function ensureAudio() {
      if (ac) return true;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try { ac = new AC(); g = createGraph(ac); } catch (e) { console.warn('[music] no audio', e); ac = null; return false; }
      S = { ac, g, piece, stepDur: 60 / piece.bpm / 4, step: 0, next: 0, padVoices: [], counts, events: [] };
      return true;
    }
    function stopScheduler() { clearTimeout(timer); timer = 0; }
    function startScheduler() {
      stopScheduler();
      S.next = Math.max(S.next || 0, ac.currentTime + 0.08);
      const tick = () => {
        while (S.next < ac.currentTime + LOOKAHEAD) { scheduleStep(S, S.step, S.next); S.step++; S.next += S.stepDur; }
        timer = setTimeout(tick, TICK_MS);
      };
      tick();
    }
    function togglePlay() {
      if (!playing) {
        if (!ensureAudio()) {
          playBtn.disabled = true; playBtn.textContent = 'no audio';
          const n = document.createElement('span'); n.className = 'note'; n.textContent = 'web audio is not available here'; hud.appendChild(n);
          return;
        }
        playing = true; pausedByScroll = false;
        playBtn.textContent = '■ stop'; playBtn.setAttribute('aria-pressed', 'true');
        g.master.gain.cancelScheduledValues(ac.currentTime); g.master.gain.setTargetAtTime(0.85, ac.currentTime, 0.05);
        if (ac.state !== 'running') ac.resume().catch(() => {});
        S.step = Math.ceil(S.step / 16) * 16; piece.chord = null;   // restart on a bar line so the pad re-enters
        startScheduler();
        if (visible && !raf) raf = requestAnimationFrame(loop);
      } else {
        playing = false; stopScheduler();
        playBtn.textContent = '▶ play'; playBtn.setAttribute('aria-pressed', 'false');
        const t = ac.currentTime;
        releasePads(S, t, 0.8); g.master.gain.setTargetAtTime(0, t, 0.12);
        S.events = []; sparks.length = 0; chip('chord').textContent = '–';
        setTimeout(() => { if (!playing && ac && ac.state === 'running') ac.suspend().catch(() => {}); }, 900);
      }
    }
    function newSeed() {
      seed = (Math.random() * 0xffffffff) >>> 0;
      piece = makePiece(seed);
      showPiece();
      if (S) {
        releasePads(S, ac.currentTime, 1.2);
        S.piece = piece; S.stepDur = 60 / piece.bpm / 4; S.step = 0; S.events = []; sparks.length = 0;
        if (playing) startScheduler();
      }
    }
    function toggleDrums() {
      drumsMuted = !drumsMuted;
      drumBtn.setAttribute('aria-pressed', String(drumsMuted));
      if (g) g.drums.gain.setTargetAtTime(drumsMuted ? 0 : 1, ac.currentTime, 0.1);
    }
    const onClick = (e) => {
      const act = e.target.closest('[data-act]') && e.target.closest('[data-act]').dataset.act;
      if (act === 'play') togglePlay(); else if (act === 'seed') newSeed(); else if (act === 'drums') toggleDrums();
    };
    hud.addEventListener('click', onClick);

    /* --- visuals --- */
    let W = 0, H = 0, bgGrad = null, last = performance.now(), bassSm = 0;
    const stars = [], sparks = [];
    const freq = new Uint8Array(512), wave = new Float32Array(1024);
    function makeStars() {
      stars.length = 0;
      const r = mulberry32(seed ^ 0x9e3779b9);
      for (let i = 0; i < 190; i++) {
        stars.push({ x: r(), y: r() * 0.8, r: 0.4 + r() * r() * 1.7, b: 0.3 + r() * 0.7, ph: r() * TAU,
          sp: 0.3 + r() * 1.1, blue: r() < 0.35, drift: 0.003 + r() * 0.008 });
      }
    }
    function resize() {
      const w = el.clientWidth || 640, h = el.clientHeight || 400, d = FABLE.dpr(2);
      if (w === W && h === H && canvas.width === Math.round(w * d)) return;
      W = w; H = h; canvas.width = Math.round(w * d); canvas.height = Math.round(h * d);
      ctx.setTransform(d, 0, 0, d, 0, 0);
      bgGrad = ctx.createLinearGradient(0, 0, 0, H);
      bgGrad.addColorStop(0, '#050913'); bgGrad.addColorStop(0.55, '#0a1124'); bgGrad.addColorStop(1, '#121d3c');
      if (!raf) draw(performance.now());
    }
    function draw(now) {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      let bass = 0;
      if (playing && g) {
        g.analyser.getByteFrequencyData(freq);
        for (let i = 1; i <= 8; i++) bass += freq[i];
        bass /= 8 * 255;
        if (g.analyser.getFloatTimeDomainData) g.analyser.getFloatTimeDomainData(wave); else wave.fill(0);
      } else wave.fill(0);
      bassSm += (bass - bassSm) * (bass > bassSm ? 0.35 : 0.07);

      ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);
      const moon = ctx.createRadialGradient(W * 0.78, H * 0.16, 0, W * 0.78, H * 0.16, W * 0.32);   // faint moon haze
      moon.addColorStop(0, `rgba(169,210,255,${0.07 + bassSm * 0.05})`); moon.addColorStop(1, 'rgba(169,210,255,0)');
      ctx.fillStyle = moon; ctx.fillRect(0, 0, W, H);

      const tw = now / 1000;
      for (const s of stars) {
        if (!reduced) { s.x += s.drift * dt; if (s.x > 1.01) s.x -= 1.02; }
        const tk = 0.72 + 0.28 * Math.sin(tw * s.sp + s.ph);
        const a = Math.min(1, s.b * tk * (0.7 + bassSm * 1.2)), x = s.x * W, y = s.y * H, r = s.r * (1 + bassSm * 0.5);
        ctx.fillStyle = s.blue ? `rgba(169,210,255,${a})` : `rgba(240,244,255,${a})`;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
        if (s.r > 1.4) { ctx.fillStyle = `rgba(169,210,255,${a * 0.12})`; ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, TAU); ctx.fill(); }
      }

      const yc = H * 0.7, amp = H * 0.11;                 // thin waveform line
      ctx.beginPath();
      for (let i = 0; i < wave.length; i += 2) {
        const x = (i / (wave.length - 1)) * W, y = yc + wave[i] * amp;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = `rgba(169,210,255,${playing ? 0.45 : 0.14})`; ctx.lineWidth = 1; ctx.stroke();

      if (S) {                                            // fire due events; draw melody sparkles
        const t = ac.currentTime;
        while (S.events.length && S.events[0].t <= t + 0.02) {
          const e = S.events.shift();
          if (e.kind === 'chord') chip('chord').textContent = e.label;
          else sparks.push({ x: 0.1 + e.pitch * 0.8 + (Math.random() - 0.5) * 0.05, y: 0.1 + (1 - e.pitch) * 0.32, t0: t, life: 2.6, size: 1.6 + e.vel * 2.4 });
        }
        for (let i = sparks.length - 1; i >= 0; i--) {
          const sp = sparks[i], age = t - sp.t0;
          if (age > sp.life) { sparks.splice(i, 1); continue; }
          const k = age / sp.life, a = (1 - k) * (1 - k), x = sp.x * W, y = (sp.y + (reduced ? 0 : k * 0.3)) * H, r = sp.size * (1 + k * 0.5);
          const gr = ctx.createRadialGradient(x, y, 0, x, y, r * 6);
          gr.addColorStop(0, `rgba(255,217,168,${a * 0.5})`); gr.addColorStop(1, 'rgba(255,217,168,0)');
          ctx.fillStyle = gr; ctx.fillRect(x - r * 6, y - r * 6, r * 12, r * 12);
          ctx.fillStyle = `rgba(255,243,226,${Math.min(1, a * 1.5)})`; ctx.beginPath(); ctx.arc(x, y, r * 0.9, 0, TAU); ctx.fill();
          ctx.strokeStyle = `rgba(255,217,168,${a * 0.6})`; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x - r * 3, y); ctx.lineTo(x + r * 3, y); ctx.moveTo(x, y - r * 3); ctx.lineTo(x, y + r * 3); ctx.stroke();
        }
      }
      if (!playing) {
        ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(233,239,255,0.9)';
        ctx.font = `italic 300 ${Math.round(Math.max(18, Math.min(W, H) * 0.052))}px ${font}`;
        ctx.fillText('a generative night-sky music box', W / 2, H * 0.44);
        ctx.fillStyle = 'rgba(141,156,196,0.9)'; ctx.font = `12px ${(getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || 'monospace').trim()}`;
        ctx.fillText('press play · every seed is a different night', W / 2, H * 0.44 + 26);
      }
    }
    function loop(now) {
      draw(now);
      if (reduced && !playing) { raf = 0; return; }       // reduced motion: static frame unless the user started music
      raf = requestAnimationFrame(loop);
    }

    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(el); } else window.addEventListener('resize', resize);
    showPiece(); resize();

    window.__music = {
      notesScheduled: () => counts.total, melodyNotes: () => counts.melody,
      state: () => (ac ? ac.state : 'none'), seed: () => seed.toString(16).padStart(8, '0'), playing: () => playing,
    };

    return {
      resume() {
        visible = true;
        if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); }
        if (pausedByScroll && playing && ac) { pausedByScroll = false; ac.resume().catch(() => {}); startScheduler(); }
      },
      pause() {
        visible = false;
        cancelAnimationFrame(raf); raf = 0;
        if (playing && ac) { pausedByScroll = true; stopScheduler(); ac.suspend().catch(() => {}); }
      },
      destroy() {
        stopScheduler(); cancelAnimationFrame(raf); raf = 0; playing = false;
        if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
        hud.removeEventListener('click', onClick);
        if (ac) { ac.close().catch(() => {}); ac = null; }
        delete window.__music;
        el.innerHTML = '';
      },
    };
  }
})();
