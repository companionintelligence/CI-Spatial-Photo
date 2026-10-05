#!/usr/bin/env node
/**
 * Build-time checks on the OUTPUT of `react-scripts build` + postbuild.mjs. They run as the
 * last step of `npm run build`, so a deploy of a build that has lost its cross-links or its
 * SEO basics fails before it publishes rather than after someone notices.
 *
 * What is checked is what has actually gone missing before, or is cheap to lose:
 *   - the four ways back to the Companion Intelligence site (home, docs, Download, Buy)
 *     exist in the no-JavaScript fallback AND in the bundle the app renders them from,
 *     with the exact destinations;
 *   - one canonical, parseable JSON-LD, absolute social URLs, a title and description;
 *   - sitemap.xml, robots.txt (with its Sitemap line), a real 404.html, the manifest's
 *     icons, and a 1200x630 social card all ship;
 *   - GA4 is either fully present (tag once, init file with the ID) or fully absent, and no
 *     measurement ID is hard-coded in the template.
 *
 * Exit code 1 and a list of failures; 0 and a one-line summary otherwise.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');

export const REQUIRED_LINKS = {
  home: 'https://ci.computer',
  buy: 'https://ci.computer/core',
  download: 'https://ci.computer/download',
  docs: 'https://docs.ci.computer/docs',
};

const SITE = 'https://photo.ci.computer';

const count = (haystack, needle) => haystack.split(needle).length - 1;

/** Every href in a chunk of HTML. */
export function hrefs(html) {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
}

/** The inside of the first <noscript> in <body>. */
export function noscriptBlock(html) {
  const m = html.match(/<noscript>([\s\S]*?)<\/noscript>/);
  return m ? m[1] : '';
}

/** Pixel size of a PNG, from its IHDR. */
export function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Run every check against a build directory; returns a list of failure messages. */
export function checkBuild(dir) {
  const failures = [];
  const fail = (msg) => failures.push(msg);
  const read = (rel) => readFileSync(join(dir, rel), 'utf8');
  const has = (rel) => existsSync(join(dir, rel));

  if (!has('index.html')) return [`${dir}/index.html is missing — nothing was built`];
  const html = read('index.html');

  // ── Cross-links ────────────────────────────────────────────────────────────
  const fallbackLinks = hrefs(noscriptBlock(html));
  for (const [name, url] of Object.entries(REQUIRED_LINKS)) {
    if (!fallbackLinks.includes(url)) fail(`<noscript> fallback has no link to ${url} (${name})`);
  }
  const jsDir = join(dir, 'static', 'js');
  const mainJs = existsSync(jsDir) ? readdirSync(jsDir).filter((f) => /^main\..+\.js$/.test(f)) : [];
  if (mainJs.length !== 1) {
    fail(`expected exactly one static/js/main.*.js, found ${mainJs.length}`);
  } else {
    const bundle = readFileSync(join(jsDir, mainJs[0]), 'utf8');
    for (const [name, url] of Object.entries(REQUIRED_LINKS)) {
      if (!bundle.includes(`"${url}"`)) fail(`app bundle never renders a link to ${url} (${name})`);
    }
  }
  for (const file of ['404.html']) {
    if (!has(file)) {
      fail(`${file} is missing`);
    } else {
      const links = hrefs(read(file));
      for (const url of [REQUIRED_LINKS.home, REQUIRED_LINKS.buy, REQUIRED_LINKS.download, REQUIRED_LINKS.docs]) {
        if (!links.includes(url)) fail(`${file} has no link to ${url}`);
      }
    }
  }
  if (!has('ci-lockup.svg')) fail('ci-lockup.svg (the header logo) is missing');

  // ── SEO and metadata ───────────────────────────────────────────────────────
  // The HTML minifier writes `<link ... />`, the template `<link ... >`; accept both.
  const canonicals = [...html.matchAll(/<link\s+rel="canonical"\s+href="([^"]*)"\s*\/?>/g)];
  if (canonicals.length !== 1 || canonicals[0][1] !== `${SITE}/`) {
    fail(`index.html must have exactly one <link rel="canonical" href="${SITE}/"> (found ${canonicals.length})`);
  }
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  if (title.length < 30 || title.length > 80) fail(`<title> is ${title.length} characters (want 30-80): "${title}"`);
  const description = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
  if (description.length < 110 || description.length > 170) {
    fail(`meta description is ${description.length} characters (want 110-170)`);
  }
  for (const tag of ['og:title', 'og:description', 'og:url', 'og:image']) {
    if (!html.includes(`property="${tag}"`)) fail(`missing <meta property="${tag}">`);
  }
  for (const tag of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) {
    if (!html.includes(`name="${tag}"`)) fail(`missing <meta name="${tag}">`);
  }
  for (const m of html.matchAll(/(?:og:image|twitter:image)"\s+content="([^"]+)"/g)) {
    if (!/^https:\/\//.test(m[1])) fail(`social image URL is not absolute: ${m[1]}`);
  }
  if (/http-equiv="Permissions-Policy"/i.test(html)) {
    fail('<meta http-equiv="Permissions-Policy"> is back; browsers ignore it, the Worker sends the header');
  }
  const ld = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  if (ld.length !== 1) {
    fail(`expected exactly one JSON-LD block, found ${ld.length}`);
  } else {
    try {
      const data = JSON.parse(ld[0][1]);
      if (data['@type'] !== 'WebApplication' || data.url !== `${SITE}/`) fail('JSON-LD is not a WebApplication for the home URL');
    } catch (e) {
      fail(`JSON-LD does not parse: ${e.message}`);
    }
  }
  if (!has('sitemap.xml') || !read('sitemap.xml').includes(`<loc>${SITE}/</loc>`)) {
    fail('sitemap.xml is missing or does not list the home page');
  }
  if (!has('robots.txt') || !read('robots.txt').includes(`Sitemap: ${SITE}/sitemap.xml`)) {
    fail('robots.txt is missing or has no Sitemap line');
  }
  if (has('og-image.png')) {
    const size = pngSize(readFileSync(join(dir, 'og-image.png')));
    if (!size || size.width !== 1200 || size.height !== 630) fail('og-image.png must be a 1200x630 PNG');
  } else {
    fail('og-image.png is missing');
  }
  if (has('manifest.json')) {
    const manifest = JSON.parse(read('manifest.json'));
    if (!manifest.id) fail('manifest.json has no id');
    for (const icon of manifest.icons || []) {
      if (!has(icon.src)) fail(`manifest icon ${icon.src} is missing`);
    }
    if (!(manifest.icons || []).some((i) => i.purpose === 'maskable')) fail('manifest.json has no maskable icon');
  } else {
    fail('manifest.json is missing');
  }

  // ── GA4: all of it or none of it, and never a literal ID in the template ───
  const gtagTags = count(html, 'googletagmanager.com/gtag/js');
  if (gtagTags > 1) fail(`GA4 tag appears ${gtagTags} times in index.html (must be 0 or 1)`);
  if (count(html, '<!-- ga4:start -->') !== gtagTags || count(html, '<!-- ga4:end -->') !== gtagTags) {
    fail('GA4 markers and GA4 tags disagree');
  }
  if (gtagTags === 1) {
    const id = (html.match(/gtag\/js\?id=(G-[A-Z0-9]+)/) || [])[1];
    if (!id) fail('GA4 tag has no valid G- measurement ID');
    if (!has('ga-init.js')) fail('GA4 tag is present but ga-init.js is missing');
    else if (id && !read('ga-init.js').includes(`'${id}'`)) fail('ga-init.js does not configure the injected ID');
    if (has('ga-init.js') && !read('ga-init.js').includes('/view/:id')) fail('ga-init.js does not redact the share-link asset id');
  } else if (has('ga-init.js')) {
    fail('ga-init.js is present but index.html has no GA4 tag');
  }
  const template = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  if (/G-[A-Z0-9]{6,}/.test(template)) fail('public/index.html contains a hard-coded measurement ID');

  if (!has('version.txt') || read('version.txt').trim() === '') fail('version.txt is missing or empty');

  return failures;
}

function main() {
  const failures = checkBuild(build);
  if (failures.length) {
    console.error(`check-build: ${failures.length} problem${failures.length === 1 ? '' : 's'} in ${build}`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('check-build: cross-links, SEO files, manifest and GA4 state all check out');
}

// Only when run directly (the tests import checkBuild). Real-path compare: /tmp is a symlink on macOS.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
