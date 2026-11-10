/* fable-5-1 / demos/meowlisp.js — a tiny scheme that purrs, with an in-page REPL.
 * tokenize() turns source into flat tokens (parens, quote, strings, atoms; comments dropped)
 * -> read() nests them into JS arrays (lists), interned Sym objects, numbers/strings/booleans
 * -> evaluate(x, env) walks the tree with a chain of Env scopes (Map + parent) giving lexical
 *    closures; special forms are a switch, and tail positions (if/cond/begin/let/and/or and
 *    lambda calls) rebind x/env and `continue` one while-loop instead of recursing, so
 *    (loop 100000) runs in constant JS stack. All failures are MeowError, caught by the REPL. */
(() => {
  'use strict';
  // ---- data ---------------------------------------------------------------
  class Sym { constructor(name) { this.name = name; } }
  const symtab = new Map();
  const sym = (n) => { let s = symtab.get(n); if (!s) symtab.set(n, (s = new Sym(n))); return s; };
  const S = { quote: sym('quote'), else: sym('else'), dot: sym('.') };
  const UNSPEC = Symbol('unspecified');
  class MeowError extends Error { constructor(msg, kind) { super(msg); this.kind = kind || 'error'; } }
  const fail = (msg, kind) => { throw new MeowError(msg, kind); };
  const truthy = (v) => v !== false;

  class Env {
    constructor(parent) { this.vars = new Map(); this.parent = parent || null; }
    find(name) { for (let e = this; e; e = e.parent) if (e.vars.has(name)) return e; return null; }
    get(name) { const e = this.find(name); return e ? e.vars.get(name) : fail(`unbound symbol: ${name}`, 'unbound'); }
    update(name, v) { const e = this.find(name) || fail(`set!: unbound symbol: ${name}`, 'unbound'); e.vars.set(name, v); }
  }

  class Lambda {
    constructor(params, body, env, name) {
      if (!body.length) fail('lambda needs a body', 'syntax');
      this.body = body; this.env = env; this.name = name || null; this.rest = null;
      const pname = (p) => (p instanceof Sym ? p.name : fail('lambda parameters must be symbols', 'syntax'));
      if (params instanceof Sym) { this.fixed = []; this.rest = params.name; return; }
      if (!Array.isArray(params)) fail('lambda parameters must be a list', 'syntax');
      const d = params.indexOf(S.dot);
      this.fixed = (d < 0 ? params : params.slice(0, d)).map(pname);
      if (d >= 0) { if (params.length !== d + 2) fail('bad rest parameter after "."', 'syntax'); this.rest = pname(params[d + 1]); }
    }
    bind(args) {
      const n = this.fixed.length;
      if (args.length < n || (!this.rest && args.length > n)) {
        fail(`wrong arity: ${this.name || 'lambda'} expects ${this.rest ? 'at least ' : ''}${n} argument${n === 1 ? '' : 's'}, got ${args.length}`, 'arity');
      }
      const e = new Env(this.env);
      for (let i = 0; i < n; i++) e.vars.set(this.fixed[i], args[i]);
      if (this.rest) e.vars.set(this.rest, args.slice(n));
      return e;
    }
  }

  // ---- reader -------------------------------------------------------------
  const NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
  function tokenize(src) {
    const toks = []; const n = src.length; let i = 0;
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r') { i++; continue; }
      if (c === ';') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '(' || c === ')' || c === "'") { toks.push({ t: c }); i++; continue; }
      if (c === '"') {
        let j = i + 1, s = '';
        while (j < n && src[j] !== '"') {
          if (src[j] === '\\' && j + 1 < n) { j++; const e = src[j]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; } else s += src[j];
          j++;
        }
        if (j >= n) fail('unterminated string literal', 'syntax');
        toks.push({ t: 'str', v: s }); i = j + 1; continue;
      }
      let j = i; while (j < n && !/[\s()'";]/.test(src[j])) j++;
      toks.push({ t: 'atom', v: src.slice(i, j) }); i = j;
    }
    return toks;
  }
  function atom(v) {
    if (v === '#t' || v === '#true') return true;
    if (v === '#f' || v === '#false') return false;
    if (NUM.test(v)) return Number(v);
    return sym(v);
  }
  function read(toks) {
    let i = 0, depth = 0;
    const missing = () => `unbalanced parens: missing ${depth} closing ")"`;
    function form() {
      if (i >= toks.length) fail(missing(), 'syntax');
      const tk = toks[i++];
      if (tk.t === '(') {
        depth++; const list = [];
        for (;;) {
          if (i >= toks.length) fail(missing(), 'syntax');
          if (toks[i].t === ')') { i++; depth--; return list; }
          list.push(form());
        }
      }
      if (tk.t === ')') fail('unbalanced parens: unexpected ")"', 'syntax');
      if (tk.t === "'") return [S.quote, form()];
      if (tk.t === 'str') return tk.v;
      return atom(tk.v);
    }
    const forms = []; while (i < toks.length) forms.push(form()); return forms;
  }

  // ---- printer ------------------------------------------------------------
  function show(v, raw) {
    if (v === true) return '#t';
    if (v === false) return '#f';
    if (v === UNSPEC) return '';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return raw ? v : JSON.stringify(v);
    if (v instanceof Sym) return v.name;
    if (Array.isArray(v)) return '(' + v.map((e) => show(e, raw)).join(' ') + ')';
    if (v instanceof Lambda) return `#<lambda ${v.name || 'anonymous'}>`;
    if (typeof v === 'function') return `#<builtin ${v.lispName}>`;
    return String(v);
  }
  function equal(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
    return false;
  }

  // ---- evaluator (one loop; tail positions `continue`) --------------------
  let deadline = Infinity, steps = 0;
  const need = (x, lo, hi, what) => { if (x.length - 1 < lo || x.length - 1 > hi) fail(`bad syntax: ${what}`, 'syntax'); };
  function evaluate(x, env) {
    for (;;) {
      if ((++steps & 4095) === 0 && performance.now() > deadline) fail('evaluation took more than 3 seconds — infinite loop? (stopped)', 'timeout');
      if (x instanceof Sym) return env.get(x.name);
      if (!Array.isArray(x)) return x;
      if (x.length === 0) fail('cannot evaluate the empty list (); did you mean \'()?', 'syntax');
      const head = x[0];
      if (head instanceof Sym) {
        switch (head.name) {
          case 'quote': need(x, 1, 1, "(quote datum)"); return x[1];
          case 'if': {
            need(x, 2, 3, '(if test then [else])');
            if (truthy(evaluate(x[1], env))) { x = x[2]; continue; }
            if (x.length === 3) return UNSPEC;
            x = x[3]; continue;
          }
          case 'define': {
            const t = x[1];
            if (Array.isArray(t)) { // (define (f . params) body...)
              if (!(t[0] instanceof Sym)) fail('bad syntax: (define (name params...) body...)', 'syntax');
              env.vars.set(t[0].name, new Lambda(t.slice(1), x.slice(2), env, t[0].name)); return UNSPEC;
            }
            if (!(t instanceof Sym) || x.length !== 3) fail('bad syntax: (define name value)', 'syntax');
            const v = evaluate(x[2], env);
            if (v instanceof Lambda && !v.name) v.name = t.name;
            env.vars.set(t.name, v); return UNSPEC;
          }
          case 'set!': {
            if (!(x[1] instanceof Sym) || x.length !== 3) fail('bad syntax: (set! name value)', 'syntax');
            env.update(x[1].name, evaluate(x[2], env)); return UNSPEC;
          }
          case 'lambda': need(x, 2, Infinity, '(lambda (params...) body...)'); return new Lambda(x[1], x.slice(2), env, null);
          case 'begin': {
            if (x.length === 1) return UNSPEC;
            for (let i = 1; i < x.length - 1; i++) evaluate(x[i], env);
            x = x[x.length - 1]; continue;
          }
          case 'let': {
            need(x, 2, Infinity, '(let ((name value)...) body...)');
            if (!Array.isArray(x[1])) fail('bad syntax: let bindings must be a list', 'syntax');
            const inner = new Env(env);
            for (const b of x[1]) {
              if (!Array.isArray(b) || b.length !== 2 || !(b[0] instanceof Sym)) fail('bad syntax: let binding must be (name value)', 'syntax');
              inner.vars.set(b[0].name, evaluate(b[1], env));
            }
            env = inner;
            for (let i = 2; i < x.length - 1; i++) evaluate(x[i], env);
            x = x[x.length - 1]; continue;
          }
          case 'cond': {
            let next = UNSPEC, hit = false;
            for (let i = 1; i < x.length && !hit; i++) {
              const c = x[i];
              if (!Array.isArray(c) || !c.length) fail('bad syntax: cond clause must be (test body...)', 'syntax');
              const v = c[0] === S.else ? true : evaluate(c[0], env);
              if (!truthy(v)) continue;
              hit = true;
              if (c.length === 1) return v;
              for (let j = 1; j < c.length - 1; j++) evaluate(c[j], env);
              next = c[c.length - 1];
            }
            if (!hit) return UNSPEC;
            x = next; continue;
          }
          case 'and': {
            if (x.length === 1) return true;
            for (let i = 1; i < x.length - 1; i++) { const v = evaluate(x[i], env); if (!truthy(v)) return v; }
            x = x[x.length - 1]; continue;
          }
          case 'or': {
            if (x.length === 1) return false;
            for (let i = 1; i < x.length - 1; i++) { const v = evaluate(x[i], env); if (truthy(v)) return v; }
            x = x[x.length - 1]; continue;
          }
        }
      }
      // application
      const fn = evaluate(head, env);
      const args = new Array(x.length - 1);
      for (let i = 1; i < x.length; i++) args[i - 1] = evaluate(x[i], env);
      if (fn instanceof Lambda) {
        env = fn.bind(args);
        const body = fn.body;
        for (let i = 0; i < body.length - 1; i++) evaluate(body[i], env);
        x = body[body.length - 1]; continue;
      }
      if (typeof fn === 'function') return fn(args);
      fail(`not a procedure: ${show(fn)}`, 'type');
    }
  }
  function callProc(fn, args) {
    if (typeof fn === 'function') return fn(args);
    if (fn instanceof Lambda) { const env = fn.bind(args); let v = UNSPEC; for (const b of fn.body) v = evaluate(b, env); return v; }
    return fail(`not a procedure: ${show(fn)}`, 'type');
  }

  // ---- builtins -----------------------------------------------------------
  function globalEnv(emit) {
    const env = new Env(null);
    const def = (name, min, max, f) => {
      const g = (args) => {
        if (args.length < min || args.length > max) {
          const want = max === Infinity ? `at least ${min}` : min === max ? `${min}` : `${min} to ${max}`;
          fail(`wrong arity: ${name} expects ${want} argument${want === '1' ? '' : 's'}, got ${args.length}`, 'arity');
        }
        return f(args);
      };
      g.lispName = name; env.vars.set(name, g);
    };
    const num = (who, v) => (typeof v === 'number' ? v : fail(`${who}: expected a number, got ${show(v)}`, 'type'));
    const str = (who, v) => (typeof v === 'string' ? v : fail(`${who}: expected a string, got ${show(v)}`, 'type'));
    const lst = (who, v) => (Array.isArray(v) ? v : fail(`${who}: expected a list, got ${show(v)}`, 'type'));
    const cmp = (name, ok) => def(name, 2, Infinity, (a) => { for (let i = 0; i < a.length - 1; i++) if (!ok(num(name, a[i]), num(name, a[i + 1]))) return false; return true; });

    def('+', 0, Infinity, (a) => a.reduce((s, x) => s + num('+', x), 0));
    def('*', 0, Infinity, (a) => a.reduce((s, x) => s * num('*', x), 1));
    def('-', 1, Infinity, (a) => (a.length === 1 ? -num('-', a[0]) : a.slice(1).reduce((s, x) => s - num('-', x), num('-', a[0]))));
    def('/', 1, Infinity, (a) => {
      const div = (s, x) => (num('/', x) === 0 ? fail('division by zero', 'math') : s / x);
      return a.length === 1 ? div(1, a[0]) : a.slice(1).reduce(div, num('/', a[0]));
    });
    cmp('=', (p, q) => p === q); cmp('<', (p, q) => p < q); cmp('>', (p, q) => p > q);
    cmp('<=', (p, q) => p <= q); cmp('>=', (p, q) => p >= q);
    def('not', 1, 1, ([v]) => v === false);
    def('modulo', 2, 2, ([p, q]) => (num('modulo', q) === 0 ? fail('modulo: division by zero', 'math') : ((num('modulo', p) % q) + q) % q));
    def('abs', 1, 1, ([v]) => Math.abs(num('abs', v)));
    def('min', 1, Infinity, (a) => Math.min(...a.map((v) => num('min', v))));
    def('max', 1, Infinity, (a) => Math.max(...a.map((v) => num('max', v))));
    def('sqrt', 1, 1, ([v]) => Math.sqrt(num('sqrt', v)));

    def('car', 1, 1, ([l]) => (lst('car', l).length ? l[0] : fail('car: the empty list has no car', 'type')));
    def('cdr', 1, 1, ([l]) => (lst('cdr', l).length ? l.slice(1) : fail('cdr: the empty list has no cdr', 'type')));
    def('cadr', 1, 1, ([l]) => (lst('cadr', l).length > 1 ? l[1] : fail('cadr: list too short', 'type')));
    def('cons', 2, 2, ([a, b]) => (Array.isArray(b) ? [a, ...b] : fail(`cons: second argument must be a list (meowlisp has no dotted pairs), got ${show(b)}`, 'type')));
    def('list', 0, Infinity, (a) => a);
    def('list?', 1, 1, ([v]) => Array.isArray(v));
    def('null?', 1, 1, ([v]) => Array.isArray(v) && v.length === 0);
    def('pair?', 1, 1, ([v]) => Array.isArray(v) && v.length > 0);
    def('length', 1, 1, ([l]) => lst('length', l).length);
    def('append', 0, Infinity, (a) => a.reduce((acc, l) => acc.concat(lst('append', l)), []));
    def('reverse', 1, 1, ([l]) => lst('reverse', l).slice().reverse());
    def('range', 1, 3, (a) => {
      const [lo, hi, st] = a.length === 1 ? [0, a[0], 1] : [a[0], a[1], a.length === 3 ? a[2] : 1];
      [lo, hi, st].forEach((v) => num('range', v));
      if (st === 0) fail('range: step must not be 0', 'math');
      const out = [];
      for (let v = lo; st > 0 ? v < hi : v > hi; v += st) { if (out.length >= 100000) fail('range: more than 100000 elements', 'limit'); out.push(v); }
      return out;
    });
    def('map', 2, Infinity, ([f, ...ls]) => {
      const n = Math.min(...ls.map((l) => lst('map', l).length)); const out = [];
      for (let i = 0; i < n; i++) out.push(callProc(f, ls.map((l) => l[i])));
      return out;
    });
    def('for-each', 2, 2, ([f, l]) => { for (const v of lst('for-each', l)) callProc(f, [v]); return UNSPEC; });
    def('filter', 2, 2, ([f, l]) => lst('filter', l).filter((v) => truthy(callProc(f, [v]))));
    def('reduce', 3, 3, ([f, init, l]) => lst('reduce', l).reduce((acc, v) => callProc(f, [acc, v]), init));
    def('assoc', 2, 2, ([k, l]) => lst('assoc', l).find((e) => Array.isArray(e) && e.length && equal(e[0], k)) || false);
    def('apply', 2, Infinity, (a) => callProc(a[0], a.slice(1, -1).concat(lst('apply', a[a.length - 1]))));

    def('eq?', 2, 2, ([p, q]) => p === q || (Array.isArray(p) && Array.isArray(q) && !p.length && !q.length));
    def('equal?', 2, 2, ([p, q]) => equal(p, q));
    def('number?', 1, 1, ([v]) => typeof v === 'number');
    def('string?', 1, 1, ([v]) => typeof v === 'string');
    def('symbol?', 1, 1, ([v]) => v instanceof Sym);
    def('boolean?', 1, 1, ([v]) => typeof v === 'boolean');
    def('procedure?', 1, 1, ([v]) => v instanceof Lambda || typeof v === 'function');

    def('string-append', 0, Infinity, (a) => a.map((v) => str('string-append', v)).join(''));
    def('string-length', 1, 1, ([v]) => str('string-length', v).length);
    def('number->string', 1, 1, ([v]) => String(num('number->string', v)));
    def('string->number', 1, 1, ([v]) => { const n = Number(str('string->number', v).trim()); return v.trim() === '' || Number.isNaN(n) ? false : n; });
    def('symbol->string', 1, 1, ([v]) => (v instanceof Sym ? v.name : fail(`symbol->string: expected a symbol, got ${show(v)}`, 'type')));
    def('string->symbol', 1, 1, ([v]) => sym(str('string->symbol', v)));

    def('display', 1, 1, ([v]) => { emit(show(v, true)); return UNSPEC; });
    def('newline', 0, 0, () => { emit('\n'); return UNSPEC; });
    def('meow', 1, 1, ([v]) => { emit('meow: ' + show(v, true) + '\n'); return UNSPEC; });
    def('nya', 0, 0, () => 'nya~');
    def('error', 1, Infinity, (a) => fail(a.map((v, i) => show(v, i === 0)).join(' '), 'user'));
    return env;
  }

  // ---- interpreter instance: evalForms(src) -> [{type:'out'|'val'|'err', text}] ----
  function createInterp() {
    let out = '';
    const env = globalEnv((s) => { out += s; });
    const describe = (e) => {
      if (e instanceof MeowError) return e.message;
      if (e instanceof RangeError) return 'recursion too deep (JS stack overflow) — only tail calls are free in meowlisp';
      return 'internal error: ' + (e && e.message ? e.message : String(e));
    };
    function evalForms(src) {
      const recs = []; let forms;
      const flush = () => { if (out) recs.push({ type: 'out', text: out.replace(/\n$/, '') }); out = ''; };
      try { forms = read(tokenize(src)); } catch (e) { return [{ type: 'err', text: describe(e) }]; }
      for (const f of forms) {
        deadline = performance.now() + 3000; steps = 0;
        try { const v = evaluate(f, env); flush(); if (v !== UNSPEC) recs.push({ type: 'val', text: show(v) }); }
        catch (e) { flush(); recs.push({ type: 'err', text: describe(e) }); }
      }
      return recs;
    }
    const runText = (src) => evalForms(src).map((r) => (r.type === 'err' ? 'error: ' + r.text : r.text)).join('\n');
    return { env, evalForms, runText };
  }
  let testInterp = null;
  window.__meowlisp = {
    run(src) { if (!testInterp) testInterp = createInterp(); return testInterp.runText(src); },
    fresh() { testInterp = createInterp(); }, createInterp, tokenize, read, show,
  };

  // ---- UI -----------------------------------------------------------------
  const KEYWORDS = new Set(['define', 'lambda', 'if', 'cond', 'let', 'quote', 'begin', 'set!', 'and', 'or', 'else']);
  const HL = /;[^\n]*|"(?:[^"\\]|\\.)*"?|[()']|[^\s()'";]+|\s+/g;
  function highlight(src) {
    const frag = document.createDocumentFragment(); let m;
    HL.lastIndex = 0;
    while ((m = HL.exec(src))) {
      const t = m[0]; let cls = null;
      if (t[0] === ';') cls = 'ml-c';
      else if (t[0] === '"') cls = 'ml-s';
      else if (t === '(' || t === ')') cls = 'ml-p';
      else if (t === "'") cls = 'ml-q';
      else if (NUM.test(t)) cls = 'ml-n';
      else if (t === '#t' || t === '#f') cls = 'ml-b';
      else if (KEYWORDS.has(t)) cls = 'ml-k';
      if (cls) { const s = document.createElement('span'); s.className = cls; s.textContent = t; frag.appendChild(s); }
      else frag.appendChild(document.createTextNode(t));
    }
    return frag;
  }

  const EXAMPLES = [
    { label: 'fib', src: [
      ';; memoized fib — the cache lives inside a closure, invisible from outside\n(define (make-fib)\n  (let ((cache \'()))\n    (define (fib n)\n      (let ((hit (assoc n cache)))\n        (cond (hit (cadr hit))\n              ((< n 2) n)\n              (else (let ((v (+ (fib (- n 1)) (fib (- n 2)))))\n                      (set! cache (cons (list n v) cache))\n                      v)))))\n    fib))\n(define fib (make-fib))\n(fib 20)\n(fib 60)\n(map fib (range 0 15))',
    ] },
    { label: 'squares', src: ['(map (lambda (x) (* x x)) (range 1 10))'] },
    { label: 'Y fact', src: [
      ';; Y-combinator-ish: recursion with no define in sight\n(define Y\n  (lambda (f)\n    ((lambda (x) (f (lambda (v) ((x x) v))))\n     (lambda (x) (f (lambda (v) ((x x) v)))))))\n(define fact\n  (Y (lambda (self)\n       (lambda (n) (if (< n 2) 1 (* n (self (- n 1))))))))\n(fact 10)',
    ] },
    { label: 'counter', src: [
      ';; let-over-lambda: every counter owns a private n\n(define (make-counter)\n  (let ((n 0))\n    (lambda () (set! n (+ n 1)) n)))\n(define a (make-counter))\n(define b (make-counter))\n(a) (a) (a)\n(b)\n(list (a) (b))',
    ] },
    { label: 'quicksort', src: [
      '(define (qsort xs)\n  (if (null? xs) \'()\n      (let ((p (car xs)) (rest (cdr xs)))\n        (append (qsort (filter (lambda (x) (< x p)) rest))\n                (list p)\n                (qsort (filter (lambda (x) (>= x p)) rest))))))\n(qsort \'(3 1 4 1 5 9 2 6 5 3 5))',
    ] },
    { label: '100k loop', src: [
      ';; tail call in if-position: 100000 deep, constant stack\n(define (loop n) (if (= n 0) \'done (loop (- n 1))))\n(loop 100000)',
    ] },
    { label: 'errors', src: [
      ';; four ways to make a cat hiss (the REPL keeps going)\n(define (purr x) (string-append "purr~ " x))\n(purr "a" "b")',
      '(scratch sofa)',
      '(+ 1 (* 2 3)',
      '(car \'())',
    ] },
  ];

  const CSS = `
.ml-root{position:absolute;inset:0;display:flex;flex-direction:column;font:400 13px/1.55 var(--font-mono);font-variant-ligatures:none;color:var(--ink);background:linear-gradient(180deg,var(--surface) 0%,#0b1226 100%)}
.ml-bar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);flex:none}
.ml-right{margin-left:auto;display:flex;align-items:center;gap:10px}
.ml-hint{color:var(--faint);font-size:11.5px;display:flex;gap:5px;align-items:center;white-space:nowrap}
.ml-log{flex:1 1 0;min-height:0;overflow-y:auto;padding:12px 14px;touch-action:pan-y;scrollbar-width:thin;scrollbar-color:var(--faint) transparent}
.ml-e{margin:0 0 3px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.ml-e.ml-in{margin-top:10px}
.ml-pr{color:var(--accent);font-weight:600;user-select:none;margin-right:.5em}
.ml-sys{color:var(--muted)}
.ml-out{color:var(--ink);padding-left:1.6em}
.ml-val{color:var(--ink);padding-left:1.6em}
.ml-val .ml-arrow{color:var(--faint);margin-right:.5em}
.ml-err{color:var(--danger);padding-left:1.6em}
.ml-p{color:var(--faint)}.ml-n{color:var(--warm)}.ml-s{color:var(--ok)}.ml-k{color:var(--accent2);font-weight:600}
.ml-c{color:var(--faint);font-style:italic}.ml-b{color:var(--accent2)}.ml-q{color:var(--muted)}
.ml-ex{display:flex;flex-wrap:wrap;gap:6px;padding:8px 14px 0;border-top:1px solid var(--line);flex:none;align-items:center}
.ml-ex .ml-lbl{color:var(--faint);font-size:11.5px;margin-right:2px}
.ml-in-row{display:flex;align-items:flex-start;gap:8px;padding:8px 14px 12px;flex:none}
.ml-field{position:relative;flex:1;min-width:0}
.ml-ta{display:block;width:100%;min-height:44px;max-height:170px;padding:11px 12px 11px 30px;border:1px solid var(--line2);border-radius:10px;background:rgba(6,10,20,.6);color:var(--ink);font:inherit;line-height:1.5;resize:none;outline:none;caret-color:var(--accent2)}
.ml-ta::placeholder{color:var(--faint);text-indent:12px}
.ml-ta:focus-visible{outline:2px solid var(--accent2);outline-offset:2px;border-color:var(--accent)}
.ml-pr2{position:absolute;left:11px;top:11px;color:var(--accent);font-weight:600;pointer-events:none;line-height:1.5}
.ml-caret{position:absolute;left:30px;top:13px;width:8px;height:1.15em;background:var(--accent2);opacity:.85;pointer-events:none;animation:ml-blink 1.1s steps(1,end) infinite}
.ml-field:not(.idle) .ml-caret{display:none}
.ml-root.paused .ml-caret,.ml-root.still .ml-caret{animation:none}
.ml-root .btn.ml-run{min-height:44px;flex:none}
@keyframes ml-blink{50%{opacity:0}}
@media (max-width:640px){.ml-root{font-size:12px}.ml-hint{display:none}}`;

  function mount(el) {
    const root = document.createElement('div');
    root.className = 'ml-root' + (FABLE.reducedMotion ? ' still' : '');
    root.innerHTML = `<style>${CSS}</style>
<div class="ml-bar"><span class="chip"><b>meowlisp</b> tiny scheme</span>
  <div class="ml-right"><span class="ml-hint"><span class="kbd">Enter</span> eval · <span class="kbd">Shift</span>+<span class="kbd">Enter</span> newline · <span class="kbd">↑</span><span class="kbd">↓</span> history</span>
  <button class="btn sm ml-clear" type="button">clear</button></div></div>
<div class="ml-log" role="log" aria-label="meowlisp transcript"></div>
<div class="ml-ex"><span class="ml-lbl">examples</span></div>
<div class="ml-in-row"><div class="ml-field idle"><span class="ml-pr2" aria-hidden="true">λ›</span><span class="ml-caret" aria-hidden="true"></span>
  <textarea class="ml-ta" rows="1" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" aria-label="meowlisp input" placeholder="(meow &quot;hello&quot;)"></textarea></div>
  <button class="btn sm primary ml-run" type="button">run</button></div>`;
    el.appendChild(root);
    const log = root.querySelector('.ml-log'), ta = root.querySelector('.ml-ta'), field = root.querySelector('.ml-field');
    const exRow = root.querySelector('.ml-ex');
    const interp = createInterp();
    const history = []; let histIdx = 0, draft = '';

    const entry = (cls, nodes) => {
      const d = document.createElement('div'); d.className = 'ml-e ' + cls;
      for (const n of nodes) d.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
      log.appendChild(d);
      while (log.childElementCount > 400) log.removeChild(log.firstChild);
      return d;
    };
    const tag = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
    const scrollEnd = () => { log.scrollTop = log.scrollHeight; };
    const sys = (text) => entry('ml-sys', [text]);

    function submit(src) {
      src = src.trim(); if (!src) return;
      if (history[history.length - 1] !== src) history.push(src);
      if (history.length > 200) history.shift();
      histIdx = history.length; draft = '';
      entry('ml-in', [tag('ml-pr', 'λ›'), highlight(src)]);
      for (const r of interp.evalForms(src)) {
        if (r.type === 'out') entry('ml-out', [r.text]);
        else if (r.type === 'val') entry('ml-val', [tag('ml-arrow', '⇒'), highlight(r.text)]);
        else entry('ml-err', ['✗ ' + r.text]);
      }
      scrollEnd();
    }
    const autosize = () => { ta.rows = Math.min(6, Math.max(1, ta.value.split('\n').length)); };
    const idle = () => field.classList.toggle('idle', document.activeElement !== ta && ta.value === '');
    const runInput = () => { const v = ta.value; ta.value = ''; autosize(); idle(); submit(v); };
    const setInput = (v) => { ta.value = v; autosize(); idle(); ta.setSelectionRange(v.length, v.length); };

    const onKey = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runInput(); return; }
      if (e.key === 'ArrowUp' && ta.value.lastIndexOf('\n', ta.selectionStart - 1) === -1 && histIdx > 0) {
        e.preventDefault(); if (histIdx === history.length) draft = ta.value; setInput(history[--histIdx]);
      } else if (e.key === 'ArrowDown' && ta.value.indexOf('\n', ta.selectionEnd) === -1 && histIdx < history.length) {
        e.preventDefault(); histIdx++; setInput(histIdx === history.length ? draft : history[histIdx]);
      }
    };
    const onInput = () => { autosize(); idle(); };
    const onClear = () => { log.textContent = ''; sys(';; transcript cleared. the environment still remembers your defines.'); };
    const onExample = (e) => {
      const b = e.target.closest('button[data-ex]'); if (!b) return;
      for (const s of EXAMPLES[+b.dataset.ex].src) { setInput(s); runInput(); }
      ta.focus({ preventScroll: true });
    };
    ta.addEventListener('keydown', onKey); ta.addEventListener('input', onInput);
    ta.addEventListener('focus', idle); ta.addEventListener('blur', idle);
    root.querySelector('.ml-run').addEventListener('click', runInput);
    root.querySelector('.ml-clear').addEventListener('click', onClear);
    exRow.addEventListener('click', onExample);
    EXAMPLES.forEach((ex, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm'; b.dataset.ex = i; b.textContent = ex.label; exRow.appendChild(b);
    });

    sys(';; meowlisp — a tiny scheme that purrs. =^.^=');
    sys(';; type an expression below, or poke an example button. try (nya) or (meow "hi")');
    entry('ml-in', [tag('ml-pr', 'λ›'), highlight('(meow (string-append "hello, " "world"))')]);
    for (const r of interp.evalForms('(meow (string-append "hello, " "world"))')) entry('ml-out', [r.text]);

    return {
      resume() { root.classList.remove('paused'); },
      pause() { root.classList.add('paused'); },
      destroy() {
        ta.removeEventListener('keydown', onKey); ta.removeEventListener('input', onInput);
        ta.removeEventListener('focus', idle); ta.removeEventListener('blur', idle);
        exRow.removeEventListener('click', onExample);
        root.remove();
      },
    };
  }

  FABLE.register('meowlisp', { mount });
})();
