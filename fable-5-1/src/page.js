/* fable-5-1 / page.js — mounts exhibits, chapter rail, reveal, small touches */
(() => {
  // boot every [data-demo] stage (lazy, pauses off-screen)
  FABLE.boot();

  // reveal-on-scroll for copy blocks
  const rv = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); rv.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal').forEach((n) => rv.observe(n));

  // chapter rail: shows after the hero, highlights the current section
  const rail = document.querySelector('.rail');
  const sections = [...document.querySelectorAll('[data-chapter]')];
  if (rail && sections.length) {
    const links = new Map();
    for (const s of sections) {
      const a = document.createElement('a');
      a.href = `#${s.id}`;
      a.innerHTML = `<span>${s.dataset.chapter}</span>`;
      a.setAttribute('aria-label', s.dataset.chapter);
      rail.appendChild(a);
      links.set(s, a);
    }
    const spy = new IntersectionObserver((es) => {
      for (const e of es) {
        if (e.isIntersecting) { links.forEach((a) => a.classList.remove('on')); links.get(e.target).classList.add('on'); }
      }
    }, { rootMargin: '-40% 0px -55% 0px' });
    sections.forEach((s) => spy.observe(s));
    const hero = document.querySelector('.hero');
    const heroWatch = new IntersectionObserver(([e]) => rail.classList.toggle('show', !e.isIntersecting), { threshold: 0.2 });
    hero && heroWatch.observe(hero);
  }

  // the kitten in the footer purrs
  const kitten = document.querySelector('.kitten');
  if (kitten) {
    const words = ['purrr', 'mrrp', 'nya~', 'zzz…', ':3', 'meow'];
    let i = 0;
    kitten.addEventListener('click', (e) => {
      const p = document.createElement('span');
      p.className = 'purr';
      p.textContent = words[i++ % words.length];
      p.style.left = `${e.clientX}px`;
      p.style.top = `${e.clientY - 10}px`;
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 1700);
    });
  }

  // build facts: time since the ask, if build.json was inlined
  const b = window.__FABLE_BUILD;
  if (b) {
    const el = document.getElementById('elapsed');
    if (el && b.started && b.built) {
      const ms = new Date(b.built) - new Date(b.started);
      const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
      el.textContent = h ? `${h} h ${m} min` : `${m} min`;
    }
  }
})();
