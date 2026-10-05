import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REQUIRED_LINKS, checkBuild, hrefs, noscriptBlock, pngSize } from './check-build.mjs';
import { injectGa } from './postbuild.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 1x1-header PNG with the size fields set; only the IHDR is ever read. */
function png(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const fallbackLinks = Object.values(REQUIRED_LINKS)
  .map((u) => `<li><a href="${u}">x</a></li>`)
  .join('');
const DESCRIPTION =
  'Turn any image or video into a 3D memory. Explore it in the browser, step into it in XR, and share it with a link to a server you run yourself.';

/** The smallest build directory that satisfies every check. */
function goodBuild(dir) {
  mkdirSync(join(dir, 'static', 'js'), { recursive: true });
  const bundleLinks = Object.values(REQUIRED_LINKS).map((u) => `"${u}"`).join(',');
  writeFileSync(join(dir, 'static', 'js', 'main.abc123.js'), `x=[${bundleLinks}]`);
  const ld = JSON.stringify({ '@type': 'WebApplication', url: 'https://photo.ci.computer/' });
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head>' +
      '<title>Photo Time Machine — turn a photo into a 3D memory | Companion Intelligence</title>' +
      `<meta name="description" content="${DESCRIPTION}">` +
      '<link rel="canonical" href="https://photo.ci.computer/">' +
      ['og:title', 'og:description', 'og:url']
        .map((p) => `<meta property="${p}" content="x">`)
        .join('') +
      '<meta property="og:image" content="https://photo.ci.computer/og-image.png">' +
      ['twitter:card', 'twitter:title', 'twitter:description']
        .map((n) => `<meta name="${n}" content="x">`)
        .join('') +
      '<meta name="twitter:image" content="https://photo.ci.computer/og-image.png">' +
      `<script type="application/ld+json">${ld}</script>` +
      `</head><body><noscript><ul>${fallbackLinks}</ul></noscript><div id="root"></div></body></html>`,
  );
  writeFileSync(join(dir, '404.html'), `<nav><ul>${fallbackLinks}</ul></nav>`);
  writeFileSync(join(dir, 'ci-lockup.svg'), '<svg/>');
  writeFileSync(join(dir, 'sitemap.xml'), '<urlset><url><loc>https://photo.ci.computer/</loc></url></urlset>');
  writeFileSync(join(dir, 'robots.txt'), 'User-agent: *\nDisallow:\n\nSitemap: https://photo.ci.computer/sitemap.xml\n');
  writeFileSync(join(dir, 'og-image.png'), png(1200, 630));
  writeFileSync(join(dir, 'icon-192.png'), png(192, 192));
  writeFileSync(join(dir, 'icon-maskable-512.png'), png(512, 512));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id: '/',
      icons: [
        { src: 'icon-192.png', purpose: 'any' },
        { src: 'icon-maskable-512.png', purpose: 'maskable' },
      ],
    }),
  );
  writeFileSync(join(dir, 'version.txt'), 'abc123\n');
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptm-build-'));
  goodBuild(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('helpers', () => {
  it('reads hrefs, the noscript block and a PNG size', () => {
    assert.deepEqual(hrefs('<a class="x" href="https://a.test/">a</a><a href="/b">b</a>'), ['https://a.test/', '/b']);
    assert.equal(noscriptBlock('<body><noscript><a href="/z">z</a></noscript></body>'), '<a href="/z">z</a>');
    assert.equal(noscriptBlock('<body></body>'), '');
    assert.deepEqual(pngSize(png(1200, 630)), { width: 1200, height: 630 });
    assert.equal(pngSize(Buffer.from('not a png at all, definitely not one')), null);
  });
});

describe('checkBuild', () => {
  it('passes a complete build, with and without GA4', () => {
    assert.deepEqual(checkBuild(dir), []);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    writeFileSync(join(dir, 'index.html'), injectGa(html, 'G-TEST123456'));
    writeFileSync(join(dir, 'ga-init.js'), "gtag('config','G-TEST123456',{page_path:'/view/:id'})");
    assert.deepEqual(checkBuild(dir), []);
  });

  it('fails when the Buy link disappears from the no-JS fallback', () => {
    const html = readFileSync(join(dir, 'index.html'), 'utf8').replace(
      `<li><a href="${REQUIRED_LINKS.buy}">x</a></li>`,
      '',
    );
    writeFileSync(join(dir, 'index.html'), html);
    assert.ok(checkBuild(dir).some((f) => f.includes(REQUIRED_LINKS.buy)));
  });

  it('fails when the app bundle stops rendering the Download link', () => {
    writeFileSync(join(dir, 'static', 'js', 'main.abc123.js'), 'x=[]');
    const failures = checkBuild(dir);
    assert.ok(failures.some((f) => f.includes('app bundle') && f.includes(REQUIRED_LINKS.download)));
  });

  it('fails on a duplicated canonical or a broken JSON-LD block', () => {
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    writeFileSync(join(dir, 'index.html'), html.replace('</head>', '<link rel="canonical" href="https://photo.ci.computer/"></head>'));
    assert.ok(checkBuild(dir).some((f) => f.includes('canonical')));
    writeFileSync(join(dir, 'index.html'), html.replace('"WebApplication"', '"WebApplication"}{'));
    assert.ok(checkBuild(dir).some((f) => f.includes('JSON-LD')));
  });

  it('fails on a doubled GA tag, or an init file with no tag', () => {
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    const once = injectGa(html, 'G-TEST123456');
    writeFileSync(join(dir, 'ga-init.js'), "gtag('config','G-TEST123456',{page_path:'/view/:id'})");
    writeFileSync(join(dir, 'index.html'), once.replace('</head>', '<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST123456"></script></head>'));
    assert.ok(checkBuild(dir).some((f) => f.includes('appears 2 times')));
    writeFileSync(join(dir, 'index.html'), html);
    assert.ok(checkBuild(dir).some((f) => f.includes('ga-init.js is present')));
  });

  it('fails on a wrong-sized social card and a manifest icon that is not there', () => {
    writeFileSync(join(dir, 'og-image.png'), png(1200, 600));
    rmSync(join(dir, 'icon-maskable-512.png'));
    const failures = checkBuild(dir);
    assert.ok(failures.some((f) => f.includes('1200x630')));
    assert.ok(failures.some((f) => f.includes('icon-maskable-512.png is missing')));
  });

  it('reads the real template, which must not carry a literal measurement ID', () => {
    const template = readFileSync(join(root, 'public', 'index.html'), 'utf8');
    assert.doesNotMatch(template, /G-[A-Z0-9]{6,}/);
  });
});
