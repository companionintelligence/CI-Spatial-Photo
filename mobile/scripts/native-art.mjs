#!/usr/bin/env node
/**
 * Draws the Android launcher icons and launch screens from the app icon, assets/icon.svg,
 * which is also the source of the web icons and of the desktop icons (`tauri icon`).
 *
 *   npm run art        (from mobile/; writes into android/app/src/main/res)
 *
 * Rerun it after changing assets/icon.svg, and commit the PNGs it writes. Each density is
 * rendered from the vector, not scaled from another PNG.
 *
 * What it draws, per density:
 *   mipmap-<d>/ic_launcher.png             legacy icon (Android 7): the rounded tile as is
 *   mipmap-<d>/ic_launcher_round.png       legacy round icon: the same tile cut to a circle
 *   mipmap-<d>/ic_launcher_background.png  adaptive icon background (Android 8+): the tile's
 *                                          gradient, full bleed, no frames
 *   mipmap-<d>/ic_launcher_foreground.png  adaptive icon foreground: the two frames alone,
 *                                          scaled into the 66 dp safe circle of the 108 dp
 *                                          canvas, so no launcher mask can cut them
 *   drawable(-port|-land)-<d>/splash.png   launch screen: the icon on the viewer's ground
 *                                          colour, #041620
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const mobile = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(mobile, '..', 'assets', 'icon.svg');
const RES = join(mobile, 'android', 'app', 'src', 'main', 'res');

/** The viewer's ground colour: theme_color in web-server/client/public/manifest.json. */
export const GROUND = '#041620';

/** Launcher icon edge in px per density, legacy (48 dp) and adaptive (108 dp). */
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/** Launch screen sizes, as Capacitor's Android template ships them. */
const SPLASHES = [
  ['drawable', 480, 320],
  ['drawable-port-mdpi', 320, 480],
  ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280],
  ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
  ['drawable-land-mdpi', 480, 320],
  ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720],
  ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280],
];

/** The icon at this share of a launch screen's shorter side. */
const SPLASH_ICON_SHARE = 0.25;

/**
 * Bounds of the two frames in the icon's 512-unit space, strokes included: the back frame
 * (205..391 x 118..276, 19-unit stroke) and the front one (122..372 x 200..412, 25-unit
 * stroke). The adaptive foreground is scaled from these.
 */
const ART = { x0: 109.5, y0: 108.5, x1: 400.5, y1: 424.5 };

/** Split the icon into its parts. Fails loudly if assets/icon.svg changes shape. */
export function iconParts(svg) {
  const open = svg.match(/<svg\b[^>]*>/);
  const defs = svg.match(/<defs>[\s\S]*?<\/defs>/);
  const tile = svg.match(/<rect width="512" height="512" rx="115" fill="url\(#tile\)"\/>/);
  const sheen = svg.match(/<rect width="512" height="512" rx="115" fill="url\(#sheen\)"\/>/);
  if (!open || !defs || !tile || !sheen) {
    throw new Error('assets/icon.svg no longer has the <defs> and the two 512x512 tile rects this script expects');
  }
  const close = svg.lastIndexOf('</svg>');
  const art = svg.slice(sheen.index + sheen[0].length, close);
  return { defs: defs[0], art };
}

const SVG_OPEN = (w, h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;

/** The tile and its sheen at a corner radius: 115 is the icon, 256 a circle, 0 full bleed. */
const tile = (rx) =>
  `<rect width="512" height="512" rx="${rx}" fill="url(#tile)"/>` +
  `<rect width="512" height="512" rx="${rx}" fill="url(#sheen)"/>`;

/** The whole icon on a 512 canvas, with the tile's corners at `rx`. */
export function iconSvg(parts, rx = 115) {
  return `${SVG_OPEN(512, 512)}${parts.defs}${tile(rx)}${parts.art}</svg>`;
}

/** The adaptive background: the tile's gradient, full bleed, nothing on it. */
export function backgroundSvg(parts) {
  return `${SVG_OPEN(512, 512)}${parts.defs}${tile(0)}</svg>`;
}

/**
 * The adaptive foreground: the frames alone, centred, with their bounding box's diagonal
 * inside the 66 dp safe circle of the 108 dp canvas. Returns the svg and the scale used.
 */
export function foregroundSvg(parts) {
  const safeDiameter = (66 / 108) * 512;
  const w = ART.x1 - ART.x0;
  const h = ART.y1 - ART.y0;
  const scale = safeDiameter / Math.hypot(w, h);
  const cx = (ART.x0 + ART.x1) / 2;
  const cy = (ART.y0 + ART.y1) / 2;
  const transform = `translate(256 256) scale(${scale.toFixed(4)}) translate(${-cx} ${-cy})`;
  return { svg: `${SVG_OPEN(512, 512)}${parts.defs}<g transform="${transform}">${parts.art}</g></svg>`, scale };
}

/** A launch screen: the icon, centred, on the ground colour. */
export function splashSvg(parts, width, height) {
  const size = Math.round(Math.min(width, height) * SPLASH_ICON_SHARE);
  const x = Math.round((width - size) / 2);
  const y = Math.round((height - size) / 2);
  return (
    `${SVG_OPEN(width, height)}<rect width="${width}" height="${height}" fill="${GROUND}"/>` +
    `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 512 512">` +
    `${parts.defs}${tile(115)}${parts.art}</svg></svg>`
  );
}

function render(svg, width) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } })
    .render()
    .asPng();
}

function write(relative, png) {
  const file = join(RES, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
  return relative;
}

function main() {
  const parts = iconParts(readFileSync(SOURCE, 'utf8'));
  const written = [];
  const foreground = foregroundSvg(parts);
  for (const [density, factor] of Object.entries(DENSITIES)) {
    const legacy = Math.round(48 * factor);
    const adaptive = Math.round(108 * factor);
    written.push(write(`mipmap-${density}/ic_launcher.png`, render(iconSvg(parts, 115), legacy)));
    written.push(write(`mipmap-${density}/ic_launcher_round.png`, render(iconSvg(parts, 256), legacy)));
    written.push(write(`mipmap-${density}/ic_launcher_background.png`, render(backgroundSvg(parts), adaptive)));
    written.push(write(`mipmap-${density}/ic_launcher_foreground.png`, render(foreground.svg, adaptive)));
  }
  for (const [dir, width, height] of SPLASHES) {
    written.push(write(`${dir}/splash.png`, render(splashSvg(parts, width, height), width)));
  }
  console.log(`native-art: ${written.length} files from assets/icon.svg (foreground scale ${foreground.scale.toFixed(3)})`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
