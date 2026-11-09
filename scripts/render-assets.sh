#!/usr/bin/env bash
# Render an SVG asset to PNG using whatever is available locally.
#
#   scripts/render-assets.sh docs/assets/social-preview.svg docs/assets/social-preview.png
#
# Chrome is preferred in CI and on macOS because it is usually already present;
# rsvg-convert and Inkscape are accepted fallbacks on Linux. The output is
# committed, so this only runs when an asset changes.
set -euo pipefail

src="${1:?usage: render-assets.sh <input.svg> <output.png>}"
out="${2:?usage: render-assets.sh <input.svg> <output.png>}"

if [ ! -f "$src" ]; then
  echo "no such file: $src" >&2
  exit 1
fi

# Read the intrinsic size so the raster matches the SVG viewBox exactly.
width="$(grep -o 'width="[0-9]*"' "$src" | head -1 | tr -dc '0-9')"
height="$(grep -o 'height="[0-9]*"' "$src" | head -1 | tr -dc '0-9')"
width="${width:-1280}"
height="${height:-640}"

if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w "$width" -h "$height" -o "$out" "$src"
elif command -v inkscape >/dev/null 2>&1; then
  inkscape "$src" --export-type=png --export-filename="$out" -w "$width" -h "$height" >/dev/null
else
  chrome="${CHROME:-}"
  if [ -z "$chrome" ]; then
    for candidate in \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "$(command -v google-chrome || true)" \
      "$(command -v chromium || true)" \
      "$(command -v chromium-browser || true)"; do
      if [ -n "$candidate" ] && [ -x "$candidate" ]; then chrome="$candidate"; break; fi
    done
  fi
  if [ -z "$chrome" ]; then
    echo "need rsvg-convert, inkscape, or Chrome (set CHROME=/path/to/chrome)" >&2
    exit 1
  fi
  abs_src="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"
  "$chrome" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 \
    --window-size="$width,$height" \
    --screenshot="$out" "file://$abs_src" >/dev/null 2>&1
fi

echo "rendered $out (${width}x${height})"
