#!/usr/bin/env python3
"""
Journey Audit Tool — Bundler
=================================================================
Bundles the multi-file source into a single self-contained HTML
that can be emailed to anyone.

Usage:
  python3 scripts/build.py

Output:
  dist/journey-audit-tool.html

The output is functionally identical to opening index.html locally,
but everything is inlined into one file — no folder structure needed
for sharing.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'dist'
OUT_DIR.mkdir(exist_ok=True)
OUT_FILE = OUT_DIR / 'journey-audit-tool.html'


def read(rel_path: str) -> str:
    return (ROOT / rel_path).read_text(encoding='utf-8')


def main():
    html = read('index.html')
    css = read('styles.css')
    papaparse = read('vendor/papaparse.min.js')
    demo = read('data/demo.js')
    flags = read('flags.js')
    app = read('app.js')

    # Inline the stylesheet
    css_link = '<link rel="stylesheet" href="styles.css">'
    if css_link not in html:
        raise RuntimeError("Could not find the stylesheet link to inline")
    html = html.replace(css_link, f'<style>\n{css}\n</style>', 1)

    # Inline each script tag, in order
    def inline_script(src_path: str, content: str) -> None:
        nonlocal html
        tag = f'<script src="{src_path}"></script>'
        if tag not in html:
            raise RuntimeError(f'Could not find <script src="{src_path}"> to inline')
        html = html.replace(tag, f'<script>\n{content}\n</script>', 1)

    inline_script('vendor/papaparse.min.js', papaparse)
    inline_script('data/demo.js', demo)
    inline_script('flags.js', flags)
    inline_script('app.js', app)

    OUT_FILE.write_text(html, encoding='utf-8')
    size_kb = OUT_FILE.stat().st_size / 1024
    print(f"Bundled → {OUT_FILE.relative_to(ROOT)} ({size_kb:.1f} KB)")
    print()
    print("This single file is what you email to your team. They open it")
    print("in any browser, drop their CSVs, and the dashboard rebuilds.")


if __name__ == '__main__':
    main()
