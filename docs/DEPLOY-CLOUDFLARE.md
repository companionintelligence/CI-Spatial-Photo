# Deploying to Cloudflare — photo.ci.computer

`photo.ci.computer` is a Cloudflare Worker that serves the built React viewer from
Cloudflare's static-asset store — and, by default, nothing else. It holds no data and
proxies no requests: each browser names its own processing server on first visit
([`BRING-YOUR-OWN-SERVER.md`](BRING-YOUR-OWN-SERVER.md)).

The Worker *can* also reverse-proxy the API to one shared server, which turns the
deployment into a single-origin team instance. That is opt-in, via `ORIGIN_API_BASE`, and
the section at the end covers it.

```
                        ┌────────────────────────────────────────────┐
  browser ──────────────► photo.ci.computer  (Cloudflare Worker)     │
                        │  /                 ─┐                      │
                        │  /view/:assetId     ├─► ASSETS binding     │
                        │  /static/*         ─┘   (client build;     │
                        │                          anything else     │
                        │                          that is not a     │
                        │                          file is a 404)    │
                        │                                            │
                        │  /api/*  /mcp*  ───► 503 unless            │
                        │                      ORIGIN_API_BASE is set│
                        └────────────────────────────────────────────┘
        │
        └── the browser talks to its own server directly ──► FastAPI + engines
                                                             (your machine, a tunnel,
                                                              ci-hub, localhost)
```

**Why the server is not here.** Engine inference needs a CUDA GPU and multi-gigabyte
weights, which is the opposite of a Worker — so the server always lives elsewhere. Given
that, the choice is whether the edge stands between the browser and that server. It does
not, by default: the product claim is that photos never leave your hardware, and an edge
that proxies them is an edge that handles them.

Files: `wrangler.toml`, `worker/index.js`, `scripts/deploy-cloudflare.sh`,
`.github/workflows/deploy-cloudflare.yml`, and `web-server/client/src/utils/apiTarget.ts`
for the client half.

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

Not a deployment step at all any more — the edge does not need to reach it. Each user points
their own browser at their own server, and
[`BRING-YOUR-OWN-SERVER.md`](BRING-YOUR-OWN-SERVER.md) is the guide for that.

The one thing still worth doing here is giving your machine a stable HTTPS name, because
that is what makes it reachable from a phone or a headset. A [Cloudflare
Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) is
the path of least resistance — no inbound ports, no public IP:

```bash
brew install cloudflared          # or your platform's package
cloudflared tunnel login          # opens a browser; pick the zone your hostname lives in
cloudflared tunnel create photo-server
cloudflared tunnel route dns photo-server my-server.example.com
cloudflared tunnel run --url http://localhost:8000 photo-server
```

`login` before `create`: the latter needs the origin certificate the former writes, and
says so only obliquely.

Three settings on **that** server matter (`.env`, read by `server/app/config.py`):

| Variable | Value | Why |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `https://photo.ci.computer` | Share links are built from this. Left at the default, the API hands out `http://localhost:3000/view/...` links — the API answers correctly and every link it returns is dead. |
| `MCP_ALLOWED_HOSTS` | `my-server.example.com` | The MCP transport validates the `Host` header against a loopback-only allowlist. Behind a proxy the inbound Host is the public name, so unset this and `/mcp` returns **421 Invalid Host header** to every agent while REST keeps working. |
| `AUTH_DISABLED` | `0` | Anything on a public domain wants Companion OIDC. Also set `COMPANION_OIDC_ISSUER` and `COMPANION_OIDC_AUDIENCE`. |

## Deploying

```bash
npm run deploy                    # build the viewer, publish to photo.ci.computer
npm run deploy:staging            # -> ci-spatial-photo-staging on workers.dev
npm run deploy:dry-run            # build + validate config, publish nothing
```

That is the whole deployment. There is no origin to point it at — the viewer asks each
visitor. From CI:

```bash
gh workflow run deploy-cloudflare.yml --repo companionintelligence/CI-Spatial-Photo \
  --ref main -f environment=production
```

Actions triggers in this repo are gated (`docs/CI.md`), so nothing deploys on push — the
workflow is `workflow_dispatch` only, and `scripts/deploy-cloudflare.sh` does the same job
from a laptop with no Actions minutes at all.

Before it publishes, a deploy checks two things about the page it is about to ship. The
build's own checks (`scripts/check-build.mjs`) prove the Buy, Download, Docs and home links
are present and that the Worker's `/docs` redirect and the viewer name the same Docs URL.
`npm run check:links` (in `web-server/client`, and run by both deploy paths) then fetches
those four destinations and fails on anything that does not answer 2xx, because agreeing
with itself is all the first set can do — `docs.ci.computer/docs` agreed with every one of
them and was a 404. After publishing, the workflow's smoke test replays its requests
against the Worker's own tests (`worker/index.test.mjs`), so a path the Worker would not
answer as the workflow expects fails before a deploy, not after one.

Two things travel with every deploy so that "what is live?" has an answer:

- the commit is passed to wrangler as the deployment's `--tag` and `--message`
  (`npx wrangler deployments list` shows it), and written to `/version.txt` in the bundle
  (`<sha>`, or `<sha>-dirty` if it was built from a tree with local edits);
- `npm run deploy` **refuses a production deploy from a dirty tree** — pass `--allow-dirty`
  to override it knowingly. A dry run and a staging deploy are not blocked.

**Google Analytics 4** is built in only when `GA_MEASUREMENT_ID` is set at build time: the
repository variable of that name in the workflow (Settings → Secrets and variables →
Actions → **Variables**), or an exported shell variable for `npm run deploy`. It is never
committed, and unset means no analytics tag at all. The tag is injected by
`web-server/client/scripts/postbuild.mjs` (idempotent, so a rebuild never doubles it), and
the page path it reports redacts the asset id of a share link to `/view/:id`.

> **One setting lives in Google, not in this repo, and it matters for that promise.** The
> redaction covers the page view sent when the page loads. The viewer also rewrites the
> address bar to `/view/<assetId>` (a `history.replaceState`, no reload) when you create or
> open a memory, and a GA4 web stream with **Enhanced measurement → Page changes based on
> browser history events** switched on (it is on by default) may send a page view for that
> change with the real URL. The asset link is a capability link, so turn that option **off**
> for this property: Admin → Data streams → the web stream → Enhanced measurement → the gear
> on *Page views* → untick it. The first page view is still counted. This could not be
> checked from the repo, because the setting is delivered by the property, not the tag.

### Verify

```bash
curl -sI https://photo.ci.computer | head -1                                      # 200
curl -so /dev/null -w '%{http_code}\n' https://photo.ci.computer/view/anything   # 200, the SPA shell
curl -so /dev/null -w '%{http_code}\n' https://photo.ci.computer/definitely-missing  # 404, not the shell
curl -s https://photo.ci.computer/version.txt                                     # the commit that is live
```

The Worker answers every path that is not a file, and is not `/` or `/view/:assetId`, with a
real 404 (`not_found_handling = "404-page"`). It used to answer them all 200 with the app,
which made `/sitemap.xml` and `/llms.txt` and any typo a soft 404 that crawlers index.
`/docs` redirects to the public docs, `/redoc` and `/openapi.json` are 404, and
`/view/*` carries `X-Robots-Tag: noindex, nofollow` — a shared memory is private by design.

A 503 `origin_not_configured` from `/healthz` or `/api/*` is **correct** for a static
deployment: nothing is behind the edge, and the Worker says so in the body rather than
failing opaquely. **502 `origin_unreachable`** only happens if you set `ORIGIN_API_BASE`
and that server is down.

## Operational notes

- **Upload size is not the edge's problem any more.** Cloudflare caps proxied request
  bodies at 100 MB on Free and Pro, and video uploads are the realistic way to hit that —
  but uploads now go browser-to-server directly, so the cap applies only if you opt into
  `ORIGIN_API_BASE`.
- **The viewer is built with `REACT_APP_API_BASE` unset** — not empty. `scripts/deploy-cloudflare.sh`
  uses `env -u` to strip it even if a developer has it exported, because empty means
  *same-origin* and would point every visitor at this static edge as if it were a server.
  Unset means the bundle ships with no server and asks. CRA inlines the value at build time,
  so it is a rebuild either way.
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

## Running as a single shared origin instead

Set `ORIGIN_API_BASE` and the Worker reverse-proxies `/api/*`, `/mcp*`, `/healthz` and
`/docs` to one server, so every browser talks only to `photo.ci.computer`:

```bash
npx wrangler deploy --env "" --var ORIGIN_API_BASE:https://my-server.example.com
```

Users then choose **Same host as this page** in the viewer. This buys a single origin — no
CORS, no local-network permission prompts, works on every device — and costs the thing the
default is protecting: every user's photos pass through one machine, with the edge in the
path. Reasonable for a team instance, wrong for a personal one.

## What does not run at the edge

Engine inference, the job queue, and asset storage never run here. The Worker is stateless:
no KV, no D1, no R2, no Durable Objects. It serves files and, if you ask it to, forwards
bytes.
