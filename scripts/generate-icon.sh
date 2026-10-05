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
#   web-server/client/public/icon-maskable-512.png
#                              512x512 RGB, full-bleed, for the web manifest's
#                              `purpose: "maskable"` entry. A launcher crops a maskable
#                              icon to its own shape (circle, squircle, teardrop) and only
#                              promises the centre 80% survives, so this draws the same
#                              tile with square corners and the artwork pulled in to 80% —
#                              the frames sit inside the safe circle instead of having
#                              their corners shaved off, which is what happened when the
#                              manifest pointed `maskable` at the full-bleed icon-512.png.
#
# Requires rsvg-convert (brew install librsvg), ImageMagick (brew install
# imagemagick) and perl (macOS ships it).
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

# 3. Maskable web icon — square the tile, then shrink everything after it (the frames and
#    the horizon) to 80% about the canvas centre. The artwork's own centre is not the
#    canvas centre (it spans roughly x 112-391, y 108-424), so the translate re-centres it
#    on the way.
maskable="$(mktemp -t ptm-icon-maskable).svg"
trap 'rm -f "$tmp" "$maskable" "$maskable.png"' EXIT
perl -0pe '
  s/rx="115"/rx="0"/g;
  s/(  <!-- the frame behind)/  <g transform="translate(256 256) scale(0.8) translate(-251 -266)">\n$1/;
  s#</svg>#  </g>\n</svg>#;
' "$SRC" > "$maskable"
grep -q 'scale(0.8)' "$maskable" || { echo "maskable transform did not apply" >&2; exit 1; }
rsvg-convert -w 512 -h 512 -f png -o "$maskable.png" "$maskable"
magick "$maskable.png" -background "#061A23" -alpha remove -alpha off -type TrueColor \
  -strip -define png:exclude-chunks=date,time \
  PNG24:web-server/client/public/icon-maskable-512.png

echo "wrote assets/icon.png (RGBA), video/assets/app-icon.png (RGB) and web-server/client/public/icon-maskable-512.png (RGB)"
