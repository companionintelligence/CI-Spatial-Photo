/**
 * photo.ci.computer — the Cloudflare edge in front of CI Spatial Photo.
 *
 * It does two jobs, and the reason it is one Worker rather than a static site plus a
 * separately published API is that the two must share an origin:
 *
 *   1. Serves the built viewer (`web-server/client/build`) from the `ASSETS` binding.
 *      A share link like `/view/:assetId` is answered with the app shell here, by name;
 *      every other path that is not a file is a real 404, served from the static
 *      `404.html`. (The binding used to do SPA fallback for everything, which made
 *      /sitemap.xml, /llms.txt and /anything-at-all answer 200 with the app — soft
 *      404s that crawlers index and monitors cannot see through.)
 *   2. Reverse-proxies the API surface (`/api/*`, `/mcp*`, `/healthz`, `/docs`,
 *      `/openapi.json`) to the processing server at `ORIGIN_API_BASE`.
 *
 * The processing server cannot run here: engine inference needs a CUDA GPU and
 * multi-gigabyte weights, which is the opposite of a Worker. So it stays on hardware we
 * own (reachable over a Cloudflare Tunnel, or any HTTPS origin) and the edge fronts it.
 * Proxying rather than pointing the bundle at a second hostname buys three things:
 * no CORS preflight in front of every multipart upload, no mixed-content trap if the
 * origin is ever plain HTTP inside a tunnel, and share links that survive the backend
 * moving — only a Worker variable changes.
 *
 * Deployment, DNS and the variables: docs/DEPLOY-CLOUDFLARE.md.
 */

/**
 * Path prefixes that belong to the processing server.
 *
 * Matched as whole segments — `/api` and `/api/...` hit the origin, `/apiary` does not —
 * so a future client-side route is not silently swallowed by a prefix match. `/mcp` is
 * here because FastAPI mounts the streamable-HTTP MCP transport there (see
 * `server/app/main.py`); agents point at `https://photo.ci.computer/mcp`.
 */
const ORIGIN_PATHS = ['/api', '/mcp', '/healthz', '/docs', '/redoc', '/openapi.json'];

/**
 * The client-side route that is a page rather than a file: `/view/:assetId`, optionally
 * with a trailing slash. Mirrors `parseViewId()` in web-server/client/src/App.tsx (same
 * id alphabet), and is the ONLY path other than `/` that is answered with the app shell.
 */
const SHARE_LINK = /^\/view\/[A-Za-z0-9_]+\/?$/;

/**
 * Where /docs goes on a deployment with no processing server behind it. A visitor or a
 * crawler that tries /docs is looking for documentation, and the FastAPI docs it would
 * have found do not exist here. Keep in step with DOCS_URL in
 * web-server/client/src/siteLinks.ts — when a dedicated page for this service is
 * published, both change together.
 */
const DOCS_URL = 'https://docs.ci.computer/docs';

/**
 * Content-Security-Policy, in two parts.
 *
 * ENFORCED: only the directives that cannot break the app. `frame-ancestors 'none'` is
 * the one that matters — this page holds the camera and WebXR enable buttons, and a page
 * that can be framed by anyone is a clickjacking surface for them. The others are free:
 * the viewer has no <base>, no <object>, and submits no form.
 *
 * REPORT-ONLY: the full policy, so a browser's console says what it would block without
 * blocking it. It is not enforced yet because three things have to be measured against a
 * real browser first, and getting any of them wrong breaks the product, not a banner:
 *   - Cloudflare injects an inline JS-detections script into every HTML response, which
 *     `script-src 'self'` would block (it needs a nonce or a hash, or the feature off).
 *   - model-viewer, Spark and the MediaPipe runtime spawn blob: workers and compile WASM,
 *     hence `blob:` and `'wasm-unsafe-eval'`.
 *   - `connect-src` has to stay open to any https: and http: host. The visitor types
 *     their own server's address, and we cannot know it — so unlike a normal app this CSP
 *     does not limit where data can be sent, and says so rather than pretending to.
 * The third-party origins are exactly the ones the viewer already calls: jsDelivr
 * (MediaPipe WASM), storage.googleapis.com (face model), gstatic (Draco/Basis decoders),
 * and Google's tag host when GA4 is on (scripts/postbuild.mjs).
 */
const CSP_ENFORCED = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net https://www.googletagmanager.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' https: http: blob: data:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  CSP_ENFORCED,
].join('; ');

/** Response headers to add to everything we serve from the assets bundle. */
const ASSET_HEADERS = {
  'Content-Security-Policy': CSP_ENFORCED,
  'Content-Security-Policy-Report-Only': CSP_REPORT_ONLY,
  // Same max-age the main site sends (ci.computer: 15552000, 180 days). No includeSubDomains
  // and no preload: this host should not be able to commit its siblings to anything.
  'Strict-Transport-Security': 'max-age=15552000',
  // The head-tracked "magic portal" needs the camera, and the XR viewer needs pose data.
  // Both are same-origin-only by default under Permissions-Policy; say so explicitly so
  // the grant does not depend on a browser's default.
  'Permissions-Policy': 'camera=(self), xr-spatial-tracking=(self), fullscreen=(self)',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  // Deliberately NOT set: Cross-Origin-Embedder-Policy. The head tracker fetches the
  // MediaPipe WASM runtime and the face-landmarker model from cdn.jsdelivr.net and
  // storage.googleapis.com (web-server/client/src/utils/headTrackingConfig.ts).
  // `require-corp` would block both and XR would fail to start. To get COEP, self-host
  // those two assets first — see the doc.
};

/** Hop-by-hop headers: meaningful to one connection, wrong to forward to another. */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

const isOriginPath = (pathname) =>
  ORIGIN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

const problem = (status, title, detail) =>
  new Response(JSON.stringify({ error: title, detail }, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // Machine answers, not pages. Never worth indexing.
      'x-robots-tag': 'noindex',
    },
  });

/**
 * Cache policy for what the assets binding serves.
 *
 * Workers static assets answer every file `max-age=0, must-revalidate`, content-hashed
 * bundles included, so every return visit paid a round trip per file — about ten of them,
 * the lazy viewer chunks at 460-625 KB raw among them — before it could use any. The
 * files under /static/ are named by content hash (CRA), so a given URL never changes and
 * can be cached for a year; icons and the social card are not hashed, so they get a day.
 * HTML (the shell, 404.html) and everything else keep the binding's revalidate default,
 * which is what lets a deploy take effect immediately.
 */
function cacheControlFor(pathname) {
  if (pathname.startsWith('/static/')) return 'public, max-age=31536000, immutable';
  if (/^\/(?:favicon\.ico|icon[^/]*\.(?:png|svg)|apple-touch-icon\.png|og-image\.png|ci-lockup\.svg)$/.test(pathname)) {
    return 'public, max-age=86400';
  }
  return null;
}

/**
 * What a deployment with no processing server says to a path that belongs to one.
 *
 * Returns null for the paths that keep their 503 (`/api`, `/mcp`, `/healthz`): those are
 * the ones the viewer and agents genuinely probe, and the 503 body is how the viewer
 * learns this is a static page (`origin_not_configured`; see probeServer in apiTarget.ts).
 * The two doc paths are different. /docs is where anyone would look for documentation,
 * so it goes there rather than to an error page; /redoc and /openapi.json describe an
 * API that is not here, so they are a plain 404 — a 503 would tell a crawler "come back
 * later", which is a promise this deployment will never keep.
 */
function staticDeploymentAnswer(pathname) {
  if (pathname === '/docs' || pathname.startsWith('/docs/')) {
    // 302, not 301: the target is an interim (the docs index) and a browser caches a 301
    // for good, which would pin visitors to it after the real page exists.
    return new Response(null, {
      status: 302,
      headers: { location: DOCS_URL, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
    });
  }
  if (pathname === '/redoc' || pathname.startsWith('/redoc/') || pathname === '/openapi.json') {
    return problem(
      404,
      'not_found',
      'This deployment serves the viewer only; there is no API documentation here.',
    );
  }
  return null;
}

/**
 * Forward a request to the processing server, streaming both ways.
 *
 * `redirect: 'manual'` keeps a 3xx from the origin as a 3xx the browser resolves against
 * photo.ci.computer, rather than the Worker chasing it to an origin-hostname URL the
 * client may not be able to reach.
 */
async function forwardToOrigin(request, url, env) {
  const base = (env.ORIGIN_API_BASE || '').trim().replace(/\/+$/, '');
  if (!base) {
    return problem(
      503,
      'origin_not_configured',
      'This deployment serves the viewer but has no processing server behind it yet. ' +
        'Set the ORIGIN_API_BASE Worker variable to the API base URL (see ' +
        'docs/DEPLOY-CLOUDFLARE.md) and redeploy.',
    );
  }

  let target;
  try {
    target = new URL(url.pathname + url.search, `${base}/`);
  } catch {
    return problem(500, 'origin_misconfigured', `ORIGIN_API_BASE is not a valid URL: ${base}`);
  }

  const headers = new Headers(request.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  // Host is derived from the target URL by fetch(); leaving the inbound one on would make
  // the origin build absolute URLs against the wrong name.
  headers.delete('host');
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) headers.set('X-Forwarded-For', clientIp);

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const upstream = new Request(target.toString(), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
  });

  let response;
  try {
    response = await fetch(upstream);
  } catch (err) {
    // A tunnel that is down is the single most likely failure here, and a bare 502 from
    // the edge reads as "the app is broken". Name the actual cause.
    return problem(
      502,
      'origin_unreachable',
      `Could not reach the processing server at ${base}: ${err && err.message ? err.message : err}`,
    );
  }

  const out = new Response(response.body, response);
  out.headers.delete('transfer-encoding');
  // Generated assets (splats, meshes, thumbnails) are addressed by immutable asset id, but
  // that is the origin's call to make — it already sets cache headers. Don't second-guess.
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (isOriginPath(url.pathname)) {
      if (!(env.ORIGIN_API_BASE || '').trim()) {
        const answer = staticDeploymentAnswer(url.pathname);
        if (answer) return answer;
      }
      return forwardToOrigin(request, url, env);
    }

    // Everything else is the viewer. The one route that is a page and not a file is a
    // share link, and it is named here: the shell is fetched from `/`, so the app boots on
    // whatever /view/:assetId the address bar holds. Any other path the binding cannot find
    // comes back as its own 404.html with a 404 status (`not_found_handling = "404-page"`).
    const shareLink = SHARE_LINK.test(url.pathname);
    // The 404 page is itself a file, so asking for it by name would be answered 200 (and
    // `/404.html` with a redirect to `/404`) — a soft 404 for exactly the path that says
    // "not found". Asking for it by either name serves it, with the status it describes.
    const errorPage = url.pathname === '/404' || url.pathname === '/404.html';
    const assetRequest = shareLink
      ? new Request(new URL('/', url), request)
      : errorPage
        ? new Request(new URL('/404', url), request)
        : request;
    const asset = await env.ASSETS.fetch(assetRequest);
    const response = new Response(asset.body, {
      status: errorPage && asset.ok ? 404 : asset.status,
      statusText: errorPage && asset.ok ? 'Not Found' : asset.statusText,
      headers: asset.headers,
    });
    for (const [name, value] of Object.entries(ASSET_HEADERS)) {
      response.headers.set(name, value);
    }
    if (shareLink) {
      // A shared memory is private by the product's own design. A header rather than a
      // robots.txt Disallow, because a crawler that is told not to fetch the page never
      // sees a noindex on it — and can still list the bare URL.
      response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    } else if (asset.status === 200) {
      const cacheControl = cacheControlFor(url.pathname);
      if (cacheControl) response.headers.set('Cache-Control', cacheControl);
    }
    return response;
  },
};
