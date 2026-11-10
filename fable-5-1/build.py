#!/usr/bin/env python3
"""build.py — inline src/*.css, src/core.js, src/demos/*.js and src/page.js into one index.html.

usage: python3 build.py            -> writes ./index.html (+ copies assets/)
The template is index.src.html; markers:
  <!-- @css -->        all stylesheets
  <!-- @build -->      window.__FABLE_BUILD json (timestamps, sizes)
  <!-- @js -->         core + demos (in DEMO_ORDER) + page
"""
import json, os, re, subprocess, sys, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / 'src'
DEMO_ORDER = ['hero', 'gem', 'fractal', 'reaction', 'neural', 'cloth', 'meowlisp', 'music']
STARTED = '2026-11-10T03:54:55Z'   # when the ask landed (UTC)


def read(p):
    return pathlib.Path(p).read_text(encoding='utf-8')


def git(*args):
    try:
        return subprocess.check_output(['git', *args], cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return ''


def main():
    tpl = read(ROOT / 'index.src.html')
    css = '\n'.join(read(SRC / f) for f in ['style.css', 'page.css'])
    demos = []
    missing = []
    for name in DEMO_ORDER:
        p = SRC / 'demos' / f'{name}.js'
        if not p.exists():
            missing.append(name)
            continue
        chk = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
        if chk.returncode != 0:
            print(f'warning: {name}.js does not parse, skipping:\n{chk.stderr.strip()[:400]}', file=sys.stderr)
            missing.append(name)
            continue
        demos.append((name, read(p)))
    if missing:
        print('warning: missing demos:', ', '.join(missing), file=sys.stderr)
    js = read(SRC / 'core.js') + '\n' + '\n'.join(f'/* ===== demo: {n} ===== */\n{s}' for n, s in demos) + '\n' + read(SRC / 'page.js')

    built = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    lines = sum(s.count('\n') for _, s in demos) + read(SRC / 'core.js').count('\n') + read(SRC / 'page.js').count('\n') + css.count('\n') + tpl.count('\n')
    build = {
        'started': STARTED,
        'built': built,
        'commit': git('rev-parse', '--short', 'HEAD') or None,
        'demos': [n for n, _ in demos],
        'lines': lines,
    }
    out = tpl
    out = out.replace('<!-- @css -->', f'<style>\n{css}\n</style>')
    out = out.replace('<!-- @build -->', f'<script>window.__FABLE_BUILD = {json.dumps(build)};</script>')
    out = out.replace('<!-- @js -->', f'<script>\n{js}\n</script>')
    words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
    n = len(demos)
    out = (out.replace('{{BUILT}}', built).replace('{{LINES}}', f'{lines:,}')
              .replace('{{DEMOS_WORD}}', words[n]).replace('{{DEMOS}}', str(n))
              .replace('{{EXHIBITS_WORD}}', words[n - 1]).replace('{{EXHIBITS}}', str(n - 1)))
    # sanity: no leftover markers
    left = re.findall(r'<!-- @\w+ -->|\{\{\w+\}\}', out)
    if left:
        print('error: unreplaced markers', left, file=sys.stderr)
        sys.exit(1)
    (ROOT / 'index.html').write_text(out, encoding='utf-8')
    (ROOT / 'build.json').write_text(json.dumps(build, indent=2) + '\n', encoding='utf-8')
    size = os.path.getsize(ROOT / 'index.html')
    print(f'index.html  {size/1024:.0f} KB  ·  {len(demos)} demos  ·  {lines:,} lines of source  ·  built {built}')


if __name__ == '__main__':
    main()
