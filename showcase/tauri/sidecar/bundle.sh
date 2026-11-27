#!/bin/bash
# Bundles the sidekick brain into dist/ so the app ships one JS file instead of node_modules.
# Optional voice deps stay external (never loaded).
set -euo pipefail
cd "$(dirname "$0")"
# esbuild: $ESBUILD, then PATH, then the one `npm ci` installs here (a devDependency).
ES="${ESBUILD:-}"
if [ -z "$ES" ]; then
  ES="$(command -v esbuild || true)"
  [ -n "$ES" ] || { [ -x node_modules/.bin/esbuild ] && ES=node_modules/.bin/esbuild; } || true
fi
[ -x "$ES" ] || { echo "esbuild not found; set ESBUILD=/path/to/esbuild" >&2; exit 1; }
rm -rf dist && mkdir -p dist/node_modules
# Dynamic imports for page and PDF readers stay external and are copied below when installed.
WEB_EXT=(--external:@mozilla/readability --external:turndown --external:turndown-plugin-gfm --external:unpdf)
bundle_entry() {
  local src="$1"
  "$ES" "$src" --bundle --platform=node --format=esm --target=node22 --outfile="dist/$src" \
    --external:@huggingface/transformers --external:ogg-opus-decoder "${WEB_EXT[@]}" \
    --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
    --log-level=warning
}
bundle_entry sidekick.mjs
for opt in agentrun.mjs mcp-desktop.mjs; do
  [ -f "$opt" ] && bundle_entry "$opt"
done
# The readers and their dependencies, laid out as npm installed them (a nested copy travels with its parent).
# One that's missing only costs web_fetch its Markdown: it falls back to plain text.
node - linkedom @mozilla/readability turndown turndown-plugin-gfm unpdf <<'EOF'
const fs = require('node:fs'), path = require('node:path');
const done = new Set();
function copy(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const src = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(src, 'package.json'))) {
      if (dir !== process.cwd() || done.has(name)) return; // nested ones travel with their parent
      done.add(name);
      fs.cpSync(src, path.join('dist/node_modules', name), { recursive: true, dereference: true });
      const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) copy(dep, src);
      return;
    }
    if (dir === process.cwd()) return console.error(`bundle: ${name} isn't installed; web_fetch will read pages as plain text`);
  }
}
for (const name of process.argv.slice(2)) copy(name, process.cwd());
EOF
echo '{"type":"module"}' > dist/package.json
