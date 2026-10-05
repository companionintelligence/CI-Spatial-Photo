# Bring your own server

The viewer does not ship pointing at a processing server. On first visit it asks for one,
and remembers the answer in that browser's local storage. `photo.ci.computer` is a static
page: it serves the bundle and nothing else — it never proxies a request, never sees a
photo, and has no idea where your server is.

That is the point. "Nothing leaves your hardware" is only true if the server is yours.

```
  https://photo.ci.computer            your machine
  ┌──────────────────────────┐        ┌───────────────────────────┐
  │ static viewer            │        │ FastAPI + engines         │
  │                          │        │ /api/v1  /mcp  /healthz   │
  │ server address ──────────┼───────►│                           │
  │ (this browser only)      │        │ photos never leave here   │
  └──────────────────────────┘        └───────────────────────────┘
        no data, no proxy                   all of the data
```

Change it any time from the **server button** in the top bar, which also shows which
server is in play — the question you will actually want answered when something looks
wrong.

## The four ways to be reachable

| | Works from phone / headset | Browser caveats | Good for |
| --- | --- | --- | --- |
| **Tunnel** — `https://my-server.example.com` | Yes | None | The normal answer |
| **ci-hub or another HTTPS host** | Yes | None | An always-on shared instance |
| **`http://localhost:8000`** | No | Chrome permission prompt; Safari refuses | Sitting at the machine |
| **Everything local** — viewer *and* server on your machine | No | None | Development |

### Tunnel to your own machine (recommended)

The server stays entirely on your hardware; Cloudflare only fronts TLS. No mixed content,
no CORS, no local-network permission, and it works on a phone and in a headset.

```bash
brew install cloudflared          # or your platform's package
cloudflared tunnel login          # opens a browser; pick the zone your hostname lives in
cloudflared tunnel create photo-server
cloudflared tunnel route dns photo-server my-server.example.com
cloudflared tunnel run --url http://localhost:8000 photo-server
```

The first two lines are not optional and are the ones people skip: `create` needs the
origin certificate that `login` writes to `~/.cloudflared/cert.pem`, and without it fails
with a credentials error rather than anything that mentions logging in.

Then enter `https://my-server.example.com` in the viewer. `my-server.example.com` stands
for a hostname on a domain you own — `example.com` is reserved and can never be anyone's
server, so substitute your own.

### ci-hub or another always-on host

Anything with its own HTTPS hostname behaves like a normal origin — enter the URL and you
are done. This is the right shape when more than one person uses the same instance.

### `http://localhost:8000`

Start the server — `docker compose up` from the repo root, or the venv recipe under
[Everything local](#everything-local) — then choose **This machine** in the setup card.
Sitting at the machine running the server, this is the whole setup: no tunnel needed. Two things are true about it, and the viewer
says both out loud rather than letting you find out:

- **Chrome 142 and later will ask permission.** Reaching loopback or a LAN address from a
  public HTTPS page is gated behind [Local Network
  Access](https://developer.chrome.com/blog/local-network-access). Grant it once and it
  sticks. Safari and Firefox have not implemented that permission and may refuse the
  request outright.
- **"localhost" means whichever device is showing the page.** Configure it on your laptop,
  open the app on your phone, and the phone looks for a server on *itself*. Use a tunnel
  for anything not at that desk.

A **plain-HTTP LAN address** (`http://192.168.1.50:8000`) half-works, which is worse than
failing: splats load and thumbnails and meshes do not. Splats are fetched, and a `fetch`
can be annotated `targetAddressSpace: "local"` so the browser exempts it from
mixed-content blocking. Thumbnails are `<img src>` and meshes are `<model-viewer src>` —
element loads, which cannot carry that annotation and stay blocked. Use HTTPS or a tunnel.

### Everything local

```bash
# Server. A venv, not a bare `pip install`: macOS ships no `pip` on PATH, and its system
# Python refuses to install into itself (PEP 668) with a message about being externally
# managed. `docker compose up` from the repo root avoids Python entirely.
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
uvicorn app.main:app --port 8000

# Viewer, in another shell.
cd web-server/client && npm start                 # http://localhost:3000
```

The dev server passes `REACT_APP_API_BASE=http://localhost:8000`, so this comes up already
connected — no setup card. Page and server are in the same address space, so there is no
permission prompt and no mixed content at all.

## Configuring the server

Two settings on the machine running the server matter once it is reachable from anywhere
but itself (`.env`, read by `server/app/config.py`):

| Variable | Value | Why |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `https://photo.ci.computer` | Share links are built from this. Left at the default, every link the API hands out points at `localhost:3000` and is dead everywhere else. |
| `MCP_ALLOWED_HOSTS` | the hostname the server is reached by | The MCP transport validates `Host` against a loopback-only allowlist. Behind a tunnel the inbound Host is the public name, so `/mcp` answers **421 Invalid Host header** to every agent while REST keeps working. |

CORS is handled by the server (`Settings.cors_policy` in `server/app/config.py`), and what it
allows depends on whether auth is on:

- **`AUTH_DISABLED=0`** — any origin. Auth is a bearer token in a header, not a cookie, so
  the wildcard is safe: an arbitrary page cannot do anything it could not do with the token.
- **`AUTH_DISABLED=1`** (the default, for local use) — there is no token, so the origin is
  the only gate, and a wildcard would let any web page you visit read everything on a server
  listening on `localhost:8000`. The server therefore allows loopback origins, `https://photo.ci.computer`,
  the origin of `PUBLIC_BASE_URL`, and whatever you list in `ALLOWED_ORIGINS`
  (comma-separated). Viewing from `https://photo.ci.computer`, from `localhost`, or from
  the viewer behind your own `PUBLIC_BASE_URL` needs nothing; a viewer served from some
  other address — a LAN IP, say — needs that origin in `ALLOWED_ORIGINS`. This is a *read*
  gate, not a write gate: the browser enforces CORS on the response, so another page's
  simple cross-origin request (a multipart POST, say) is still sent and processed — that
  page just cannot read the answer. If that matters, turn auth on.

If you put the server behind your own reverse proxy, that proxy has to preserve these
headers, including on `OPTIONS` preflights.

## Share links, when the server is personal

A share link is `PUBLIC_BASE_URL/view/:assetId` — a page plus an asset id. The asset lives
on your server, so the link resolves **only for someone whose viewer points at that same
server**. Send it to a colleague pointed at their own machine and they will get a "failed
to load" against an id they do not have.

That is inherent to a personal server rather than a bug to route around: the alternative
is putting the server's address in the link, which would make any link able to aim a
recipient's browser — and their bearer token — at an arbitrary host. If you want links
that work for other people, the server needs to be one they also use: a tunnel they can
reach, or ci-hub.

## Running as a single shared origin instead

The opposite trade is supported and is one variable: set `ORIGIN_API_BASE` on the Worker
and the edge reverse-proxies `/api/*` and `/mcp` to one server, so every browser talks
only to `photo.ci.computer`.

```bash
npx wrangler deploy --env "" --var ORIGIN_API_BASE:https://my-server.example.com
```

Then choose **Same host as this page** in the viewer. No CORS, no local-network
permissions, works everywhere — at the cost of every user's photos passing through one
machine, and the edge being in the path. Reasonable for a team instance; wrong for a
personal one, which is why it is not the default.

See [`docs/DEPLOY-CLOUDFLARE.md`](DEPLOY-CLOUDFLARE.md) for the deployment itself.
