// Worker tests: `npm test` from the repo root (node's built-in runner, no dependency).
//
// The Worker is a pure function of (request, env), so these drive it directly with a
// stand-in for the ASSETS binding. What they pin is the behaviour that was wrong live:
// every unknown path answering 200 with the app, share links indexable, the docs paths
// answering 503, and static assets revalidated on every visit.
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import worker from './index.js';

const SHELL = '<!doctype html><title>shell</title>';
const NOT_FOUND_PAGE = '<!doctype html><title>404</title>';

/** An ASSETS binding backed by a small fake file tree, 404.html for everything else. */
function makeAssets(files) {
  const calls = [];
  return {
    calls,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      calls.push(pathname);
      if (pathname === '/') {
        return new Response(SHELL, {
          headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=0, must-revalidate' },
        });
      }
      if (files[pathname] !== undefined) {
        return new Response(files[pathname], {
          headers: { 'cache-control': 'public, max-age=0, must-revalidate' },
        });
      }
      return new Response(NOT_FOUND_PAGE, { status: 404, headers: { 'content-type': 'text/html' } });
    },
  };
}

const FILES = {
  '/static/js/main.abc123.js': 'console.log(1)',
  '/static/css/main.abc123.css': 'body{}',
  '/og-image.png': 'png',
  '/icon-192.png': 'png',
  '/404': NOT_FOUND_PAGE,
  '/robots.txt': 'User-agent: *',
  '/sitemap.xml': '<urlset/>',
};

const call = (path, env = { ORIGIN_API_BASE: '' }, init) =>
  worker.fetch(new Request(`https://photo.ci.computer${path}`, init), { ASSETS: makeAssets(FILES), ...env });

afterEach(() => mock.restoreAll());

describe('static deployment (no ORIGIN_API_BASE)', () => {
  it('serves the app shell at /', async () => {
    const res = await call('/');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), SHELL);
  });

  it('serves the app shell for a share link, fetched from /, and marks it noindex', async () => {
    const assets = makeAssets(FILES);
    const res = await worker.fetch(new Request('https://photo.ci.computer/view/a_7989c36d0900288d'), {
      ORIGIN_API_BASE: '',
      ASSETS: assets,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), SHELL);
    assert.deepEqual(assets.calls, ['/']);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  });

  it('accepts a trailing slash on a share link, and nothing deeper', async () => {
    assert.equal((await call('/view/abc/')).status, 200);
    assert.equal((await call('/view/abc/extra')).status, 404);
    assert.equal((await call('/view/')).status, 404);
    assert.equal((await call('/view')).status, 404);
  });

  it('answers an unknown path with a real 404, not the app', async () => {
    for (const path of ['/definitely-missing', '/llms.txt', '/humans.txt', '/ads.txt', '/404', '/this/does/not/exist']) {
      const res = await call(path);
      assert.equal(res.status, 404, path);
      assert.equal(await res.text(), NOT_FOUND_PAGE, path);
      assert.equal(res.headers.get('x-robots-tag'), null, `${path} is not a share link`);
    }
  });

  it('answers /404 and /404.html with the 404 page AND a 404 status, not a soft 200', async () => {
    for (const path of ['/404', '/404.html']) {
      const res = await call(path);
      assert.equal(res.status, 404, path);
      assert.equal(await res.text(), NOT_FOUND_PAGE, path);
    }
  });

  it('serves real files from the bundle: robots.txt and sitemap.xml are files, not the shell', async () => {
    assert.equal(await (await call('/robots.txt')).text(), 'User-agent: *');
    assert.equal(await (await call('/sitemap.xml')).text(), '<urlset/>');
  });

  it('redirects /docs and /docs/* to the public docs instead of failing with 503', async () => {
    for (const path of ['/docs', '/docs/', '/docs/anything']) {
      const res = await call(path);
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get('location'), 'https://docs.ci.computer/docs', path);
    }
  });

  it('answers /redoc and /openapi.json with 404, which a crawler will not retry', async () => {
    for (const path of ['/redoc', '/openapi.json']) {
      const res = await call(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    }
  });

  it('keeps the 503 origin_not_configured answer for /healthz, /api and /mcp', async () => {
    // The viewer reads this body to learn the host is a static page (probeServer).
    for (const path of ['/healthz', '/api/v1/engines', '/mcp']) {
      const res = await call(path);
      assert.equal(res.status, 503, path);
      assert.equal((await res.json()).error, 'origin_not_configured', path);
    }
  });
});

describe('with ORIGIN_API_BASE set', () => {
  const env = { ORIGIN_API_BASE: 'https://origin.example.test/' };

  it('proxies every origin path, /docs and /openapi.json included', async () => {
    const seen = [];
    mock.method(globalThis, 'fetch', async (req) => {
      seen.push(new URL(req.url).pathname);
      return new Response('from origin', { status: 200 });
    });
    for (const path of ['/docs', '/docs/x', '/redoc', '/openapi.json', '/api/v1/jobs', '/healthz']) {
      const res = await call(path, env);
      assert.equal(res.status, 200, path);
      assert.equal(await res.text(), 'from origin', path);
    }
    assert.deepEqual(seen, ['/docs', '/docs/x', '/redoc', '/openapi.json', '/api/v1/jobs', '/healthz']);
  });

  it('reports an unreachable origin as 502, not as a missing deployment', async () => {
    mock.method(globalThis, 'fetch', async () => {
      throw new Error('connect refused');
    });
    const res = await call('/healthz', env);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'origin_unreachable');
  });

  it('still serves the viewer and share links from the bundle', async () => {
    assert.equal(await (await call('/', env)).text(), SHELL);
    assert.equal(await (await call('/view/abc', env)).text(), SHELL);
  });
});

describe('response headers', () => {
  it('enforces frame-ancestors none and sends HSTS and the report-only policy', async () => {
    const res = await call('/');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'self'/);
    // Enforced policy must stay free of script-src: Cloudflare's injected inline script
    // would be blocked by it. That belongs in the report-only header until measured.
    assert.doesNotMatch(csp, /script-src/);
    assert.match(res.headers.get('content-security-policy-report-only'), /script-src 'self'/);
    assert.match(res.headers.get('strict-transport-security'), /^max-age=\d+$/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.match(res.headers.get('permissions-policy'), /camera=\(self\)/);
  });

  it('allows Google tag hosts in the report-only policy so GA4 does not read as a violation', async () => {
    const policy = (await call('/')).headers.get('content-security-policy-report-only');
    assert.match(policy, /https:\/\/www\.googletagmanager\.com/);
    assert.match(policy, /connect-src [^;]*https:/);
  });

  it('puts the security headers on the 404 page too', async () => {
    const res = await call('/nope');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });

  it('caches content-hashed bundles for a year and marks them immutable', async () => {
    for (const path of ['/static/js/main.abc123.js', '/static/css/main.abc123.css']) {
      const res = await call(path);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable', path);
    }
  });

  it('caches unhashed icons and the social card for a day, and leaves HTML alone', async () => {
    assert.equal((await call('/og-image.png')).headers.get('cache-control'), 'public, max-age=86400');
    assert.equal((await call('/icon-192.png')).headers.get('cache-control'), 'public, max-age=86400');
    assert.equal(
      (await call('/')).headers.get('cache-control'),
      'public, max-age=0, must-revalidate',
    );
    assert.equal(
      (await call('/robots.txt')).headers.get('cache-control'),
      'public, max-age=0, must-revalidate',
    );
  });

  it('never gives a long cache lifetime to an error response', async () => {
    const res = await call('/static/js/missing.js');
    assert.equal(res.status, 404);
    assert.notEqual(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });
});
