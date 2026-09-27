/**
 * photo.ci.computer — the Cloudflare edge in front of CI Spatial Photo.
 *
 * It does two jobs, and the reason it is one Worker rather than a static site plus a
 * separately published API is that the two must share an origin:
 *
 *   1. Serves the built viewer (`web-server/client/build`) from the `ASSETS` binding,
 *      with SPA not-found handling so a share link like `/view/:assetId` returns the
 *      app shell instead of a 404.
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

/** Response headers to add to everything we serve from the assets bundle. */
const ASSET_HEADERS = {
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
    },
  });

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
      return forwardToOrigin(request, url, env);
    }

    // Everything else is the viewer. `not_found_handling = "single-page-application"`
    // on the binding turns an unmatched path into index.html with a 200, which is what
    // /view/:assetId needs.
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [name, value] of Object.entries(ASSET_HEADERS)) {
      response.headers.set(name, value);
    }
    return response;
  },
};
