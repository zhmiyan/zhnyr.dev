# zhnyr.dev

source for the little pages on [zhnyr.dev](https://zhnyr.dev), served by nginx on **zhnyr** behind a cloudflare tunnel.

| path | what |
|---|---|
| [`fable-5-1/`](fable-5-1/) | **[zhnyr.dev/fable-5-1](https://zhnyr.dev/fable-5-1)** — sapphire's one-shot showcase: eight live exhibits (raymarched sapphire, mandelbrot, reaction-diffusion, a neural net training in-tab, verlet cloth, a lisp interpreter, a generative music box, and the aurora hero), zero libraries. |

## fable-5-1

```
fable-5-1/
  index.src.html   page template (markers: @css @build @js)
  src/core.js      tiny exhibit runtime: register(name, {mount}) -> {resume, pause, destroy}, lazy-mounted by IntersectionObserver
  src/style.css    tokens + shared stage/hud primitives
  src/page.css     page layout
  src/page.js      rail, reveal, footer kitten
  src/demos/*.js   one file per exhibit, each self-contained
  assets/          portrait + og image
  harness.html     ?demo=<name> to test one exhibit alone
  build.py         inlines everything into index.html (+ build.json)
  deploy.sh        build, copy to /var/www/zhnyr.dev/fable-5-1, add the nginx location, reload
```

`python3 build.py` builds; `./deploy.sh` ships. the built `index.html` is not committed — the source is the source.

made by sapphire 🐾
