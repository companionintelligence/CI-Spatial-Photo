#!/usr/bin/env bash
#
# Regenerate the Photo Time Machine app icon from assets/icon.svg.
#
#   ./scripts/generate-icon.sh
#
# Writes two PNGs from the one vector source, because the two consumers want
# different encodings:
#
#   assets/icon.png            512x512 RGBA, rounded tile with transparent
#                              corners. This is what companion-app.json's
#                              "icon" field points at — a store/app icon, so it
#                              keeps its squircle silhouette.
#
#   video/assets/app-icon.png  512x512 RGB, full-bleed square, NO alpha. The
#                              product film's intro card reads the PNG colour
#                              type (video-kit src/assets.mjs `hasAlpha`) to
#                              decide whether to put a glowing halo behind the
#                              mark: a transparent mark gets one, because it
#                              reads as the mark itself glowing; an opaque
#                              raster does not, because behind a solid
#                              rectangle the same halo is just a lit box. The
#                              mark is drawn uncropped either way.
#
#                              The film has always shown this icon as an opaque
#                              raster with no halo, and this script keeps it
#                              that way. Shipping a transparent file here would
#                              add a halo to the first frame of the film as a
#                              side effect of a recolour.
#
# Requires rsvg-convert (brew install librsvg) and ImageMagick (brew install
# imagemagick).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SRC="assets/icon.svg"

command -v rsvg-convert >/dev/null || { echo "rsvg-convert not found — brew install librsvg" >&2; exit 1; }
command -v magick >/dev/null || { echo "magick not found — brew install imagemagick" >&2; exit 1; }

[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

# 1. Store/app icon — keep the rounded corners and the alpha channel.
rsvg-convert -w 512 -h 512 -f png -o assets/icon.png "$SRC"

# 2. Film mark — square off the tile so nothing is lost to the disc crop, then
#    flatten to RGB so `hasAlpha` reports false and the intro keeps its disc.
tmp="$(mktemp -t ptm-icon-flat).svg"
trap 'rm -f "$tmp"' EXIT
sed 's/rx="115"/rx="0"/g' "$SRC" > "$tmp"
rsvg-convert -w 512 -h 512 -f png -o "$tmp.png" "$tmp"
# -strip and the excluded date/time chunks matter: without them ImageMagick
# stamps date:create/date:modify into the PNG, so re-running this script emits a
# byte-different file every time and the icon shows up as a spurious diff in
# every branch that happens to run it.
magick "$tmp.png" -background "#061A23" -alpha remove -alpha off -type TrueColor \
  -strip -define png:exclude-chunks=date,time \
  PNG24:video/assets/app-icon.png
rm -f "$tmp.png"

echo "wrote assets/icon.png (RGBA) and video/assets/app-icon.png (RGB)"
