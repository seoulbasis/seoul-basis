#!/usr/bin/env bash
set -euo pipefail
seoul_dir="$(cd "$(dirname "$0")" && pwd)"
giwa_dir="$(cd "$seoul_dir/../solgiwa-indigo" && pwd)"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
cp -R "$giwa_dir/src" "$giwa_dir/public" "$giwa_dir/index.html" "$giwa_dir/vite.config.ts" "$giwa_dir/package.json" "$build_dir/"
ln -s "$giwa_dir/node_modules" "$build_dir/node_modules"
cp "$seoul_dir/seoul-seal.svg" "$seoul_dir/seoul-engraving.jpg" "$build_dir/public/brand/"
cd "$build_dir"
python3 - <<'PY'
from pathlib import Path
files = [Path('index.html'), *Path('src').rglob('*')]
for path in files:
    if path.suffix not in {'.ts', '.tsx', '.css', '.html'}:
        continue
    content = path.read_text()
    updated = content.replace('/api/', '/launchpad/api/').replace('/brand/', '/launchpad/brand/')
    if path.name in {'Chrome.tsx', 'index.html'}:
        updated = updated.replace('launchongiwa', 'seoulbasis').replace('GIWA Markets on X', 'Seoul Basis on X')
    if path.name == 'Chrome.tsx':
        updated = updated.replace('indigo-roof.svg', 'seoul-seal.svg')
        updated = updated.replace('href="#/" aria-label="GIWA Markets home"', 'href="/" aria-label="Seoul Basis home"')
        updated = updated.replace('GIWA Markets <small lang="ko">기와</small>', 'Seoul Basis')
        updated = updated.replace('<nav className="hdr__nav launchpad-nav" aria-label="Primary navigation">', '<nav className="hdr__nav launchpad-nav" aria-label="Primary navigation"><a href="/trade">Spread trading</a>')
        updated = updated.replace('· GIWA Markets ·', '· Seoul Basis · GIWA Launchpad ·')
    if path.name == 'Hub.tsx':
        updated = updated.replace('indigo-roof.svg', 'seoul-seal.svg')
    if path.name == 'MarketActivity.tsx':
        updated = updated.replace('#83eab2', '#235a42').replace('#ffa18d', '#9b3d48').replace('#e9c780', '#7e3041')
    if path.name == 'index.html':
        updated = updated.replace('<html lang="en">', '<html lang="en" data-theme="light">').replace('/launchpad/brand/indigo-roof.svg', '/launchpad/brand/seoul-seal.svg')
        updated = updated.replace('<title>GIWA Markets — launch on GIWA with Solana</title>', '<title>GIWA Launchpad · Seoul Basis</title>')
    if path.name in {'main.tsx', 'strings.ts'}:
        updated = updated.replace('GIWA Markets · Markets on GIWA Sepolia', 'GIWA Launchpad · Seoul Basis').replace('GIWA Markets · GIWA Sepolia 토큰 시장', 'GIWA Launchpad · Seoul Basis')
    if updated != content:
        path.write_text(updated)
PY
cat "$seoul_dir/giwa-seoul-theme.css" >>src/indigo.css
./node_modules/.bin/vite build --base=/launchpad/ --assetsDir=giwa-assets --outDir "$seoul_dir/launchpad" --emptyOutDir
