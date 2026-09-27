# Deploying to Cloudflare — photo.ci.computer

The viewer and the API share one hostname. `photo.ci.computer` is a Cloudflare Worker that
serves the built React viewer from Cloudflare's static-asset store and reverse-proxies the
API paths to the processing server running on our own GPU hardware.

```
                        ┌────────────────────────────────────────────┐
  browser / agent ──────► photo.ci.computer  (Cloudflare Worker)     │
                        │                                            │
                        │  /                 ─┐                      │
                        │  /view/:assetId     ├─► ASSETS binding     │
                        │  /static/*         ─┘   (client build,     │
                        │                          SPA fallback)     │
                        │                                            │
                        │  /api/*   /mcp*    ─┐                      │
                        │  /healthz /docs     ├─► ORIGIN_API_BASE ───┼──► FastAPI + engines
                        │  /openapi.json     ─┘                      │     (CUDA GPU, weights)
                        └────────────────────────────────────────────┘
```

**Why the Worker proxies instead of the bundle calling a second hostname.** Engine inference
needs a CUDA GPU and multi-gigabyte weights, so the processing server cannot run on Workers
and has to live elsewhere. Given that, pointing the viewer at `api.photo.ci.computer`
directly would mean: a CORS preflight in front of every multipart upload, a mixed-content
failure the moment the origin is plain HTTP inside a tunnel, and share links that break when
the backend moves. Same-origin removes all three — moving the backend is one Worker variable.

Files: `wrangler.toml`, `worker/index.js`, `scripts/deploy-cloudflare.sh`,
`.github/workflows/deploy-cloudflare.yml`.

## One-time setup

### 1. Cloudflare credentials

Either `npx wrangler login`, or export a scoped token:

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...   # Workers Scripts:Edit + Workers Routes:Edit
```

For the GitHub workflow, the same two values go in repository secrets as
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

### 2. DNS

`ci.computer` must be a zone in the same Cloudflare account. `wrangler.toml` claims the
hostname as a **custom domain**, which makes wrangler create the proxied DNS record itself on
first deploy — do not pre-create a conflicting `photo` record:

```toml
[[routes]]
pattern = "photo.ci.computer"
custom_domain = true
```

### 3. The processing server

It needs a stable HTTPS URL the Worker can reach. A [Cloudflare
Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) from
the GPU box is the path of least resistance — no inbound ports, no public IP:

```bash
cloudflared tunnel create ptm-origin
cloudflared tunnel route dns ptm-origin ptm-origin.ci.computer
cloudflared tunnel run --url http://localhost:8000 ptm-origin
```

Three settings on **that** server matter (`.env`, read by `server/app/config.py`):

| Variable | Value | Why |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `https://photo.ci.computer` | Share links are built from this. Left at the default, the API hands out `http://localhost:3000/view/...` links — the API answers correctly and every link it returns is dead. |
| `MCP_ALLOWED_HOSTS` | `ptm-origin.ci.computer` | The MCP transport validates the `Host` header against a loopback-only allowlist. Behind a proxy the inbound Host is the public name, so unset this and `/mcp` returns **421 Invalid Host header** to every agent while REST keeps working. |
| `AUTH_DISABLED` | `0` | Anything on a public domain wants Companion OIDC. Also set `COMPANION_OIDC_ISSUER` and `COMPANION_OIDC_AUDIENCE`. |

## Deploying

```bash
npm run deploy                    # build the viewer, publish to photo.ci.computer
npm run deploy:staging            # -> ci-spatial-photo-staging on workers.dev
npm run deploy:dry-run            # build + validate config, publish nothing
```

Point the Worker at the origin (a Worker variable, not a build input, so this does not need
a rebuild):

```bash
npx wrangler deploy --env "" --var ORIGIN_API_BASE:https://ptm-origin.ci.computer
```

Or from CI:

```bash
gh workflow run deploy-cloudflare.yml --repo companionintelligence/CI-Spatial-Photo \
  --ref main -f environment=production -f origin_api_base=https://ptm-origin.ci.computer
```

Actions triggers in this repo are gated (`docs/CI.md`), so nothing deploys on push — the
workflow is `workflow_dispatch` only, and `scripts/deploy-cloudflare.sh` does the same job
from a laptop with no Actions minutes at all.

### Verify

```bash
curl -s https://photo.ci.computer/healthz                    # {"status":"ok",...}
curl -so /dev/null -w '%{http_code}\n' https://photo.ci.computer/view/anything   # 200, the SPA shell
curl -s https://photo.ci.computer/api/v1/engines | head -c 200
```

`/healthz` returning **503 `origin_not_configured`** means the viewer is live but
`ORIGIN_API_BASE` is unset — the Worker says so in the response body rather than failing
opaquely. **502 `origin_unreachable`** means the variable is set but the tunnel is down.

## Operational notes

- **Upload size.** Cloudflare caps request bodies at 100 MB on Free and Pro, 200 MB on
  Business, 500 MB on Enterprise. Video uploads are the realistic way to hit that; the limit
  applies to the proxied POST, not to anything in our code, and shows as a 413 from the edge.
- **The viewer build is same-origin on purpose.** `scripts/deploy-cloudflare.sh` exports
  `REACT_APP_API_BASE=""` — *empty, not unset*. Unset bakes in `http://localhost:8000` (see
  `web-server/client/src/api.ts`); empty makes every request a relative `/api/v1/...`.
  CRA inlines this at build time, so changing it always means a rebuild.
- **The Worker runs on every request** (`run_worker_first = true`), then falls through to
  `env.ASSETS.fetch()`. That is what lets the API prefixes be matched before Cloudflare looks
  for a file by that name.
- **Head tracking still calls out to two CDNs.** The MediaPipe WASM runtime
  (`cdn.jsdelivr.net`) and the face-landmarker model (`storage.googleapis.com`) are fetched
  by the browser, not by us, and only when XR is enabled. This is why the Worker does *not*
  send `Cross-Origin-Embedder-Policy: require-corp` — it would block both. To self-host them
  and get COEP, set `REACT_APP_MEDIAPIPE_WASM_BASE` and
  `REACT_APP_FACE_LANDMARKER_MODEL_URL` at build time (recipe in `docs/UI-GUIDE.md`) and add
  the header in `worker/index.js`.
- **Staging cannot steal the domain.** `[env.staging]` carries `routes = []`, because a
  wrangler environment otherwise *inherits* the top-level routes and a staging deploy would
  reassign `photo.ci.computer` to it.
- **Rollback** is a dashboard action (Workers → the Worker → Deployments → Rollback), or
  re-run a deploy from the previous commit.

## What does not run at the edge

Engine inference, the job queue, and asset storage all live on the origin. The Worker is
stateless: no KV, no D1, no R2, no Durable Objects. If assets ever need to be served from
the edge rather than the GPU box, R2 behind the same Worker is the natural next step — the
routing table in `worker/index.js` is the only thing that would change.
