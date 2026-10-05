#!/usr/bin/env bash
# Build the viewer and deploy it, plus the API proxy, to Cloudflare.
#
#   scripts/deploy-cloudflare.sh                      # -> photo.ci.computer
#   scripts/deploy-cloudflare.sh --env staging        # -> the workers.dev staging Worker
#   scripts/deploy-cloudflare.sh --dry-run            # build + validate, publish nothing
#   scripts/deploy-cloudflare.sh --allow-dirty        # production from a tree with local edits
#
# Needs a Cloudflare API token with Workers Scripts:Edit (plus Workers Routes:Edit the first
# time, to attach the custom domain). Either log in with `npx wrangler login`, or export
# CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
#
# ORIGIN_API_BASE — the processing server the Worker proxies to — is a Worker variable, not
# a build input. Pass it here to set it on this deploy, or leave it and manage it in the
# dashboard. Full walkthrough: docs/DEPLOY-CLOUDFLARE.md.
#
# GA_MEASUREMENT_ID — export it to build Google Analytics 4 into this deploy (the GitHub
# workflow reads the repository variable of the same name). Unset, the build ships with no
# analytics tag. It is never committed anywhere.
#
# Production is traceable: the commit is passed to wrangler as the deployment's tag and
# message and written to /version.txt in the bundle, and a production deploy refuses a tree
# with uncommitted changes — a laptop deploy from a dirty tree is how the live bundle once
# came to differ from a clean build of main with nothing to say why.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WRANGLER_ENV=""
DRY_RUN=0
ALLOW_DIRTY=0
EXTRA=()

while [ $# -gt 0 ]; do
  case "$1" in
    --env) WRANGLER_ENV="$2"; shift 2 ;;
    --env=*) WRANGLER_ENV="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

# ── 0. Know what is being deployed ────────────────────────────────────────────
# The commit goes on the deployment (below) and into the bundle (/version.txt, written by
# web-server/client/scripts/postbuild.mjs). A production deploy from a dirty tree would put
# something on photo.ci.computer that no commit describes, so it needs saying out loud.
SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
DIRTY=0
if [ "$SHA" != "unknown" ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then DIRTY=1; fi
if [ "$DIRTY" -eq 1 ] && [ "$DRY_RUN" -eq 0 ] && [ -z "$WRANGLER_ENV" ] && [ "$ALLOW_DIRTY" -eq 0 ]; then
  echo "Refusing to deploy production from a tree with uncommitted changes:" >&2
  git status --short >&2
  echo >&2
  echo "Commit or stash them, deploy from a clean checkout of main, or pass --allow-dirty" >&2
  echo "(the bundle's /version.txt will then read <sha>-dirty)." >&2
  exit 1
fi

# ── 1. Build the viewer ───────────────────────────────────────────────────────
# REACT_APP_API_BASE is deliberately NOT set — not empty, unset. Empty would mean
# "same origin", which would point every visitor's browser at this static edge as if it
# were a processing server. Unset means the bundle ships with no server at all and asks
# on first run (web-server/client/src/utils/apiTarget.ts), which is the whole design:
# photo.ci.computer serves files and never sees a photo.
echo "==> Building the viewer (ships unconfigured; each browser names its own server)"
(
  cd web-server/client
  [ -d node_modules ] || npm install --no-audit --no-fund --loglevel=error
  # `env -u` rather than just omitting it: a developer with REACT_APP_API_BASE exported
  # in their shell would otherwise bake their own laptop's address into the deployed
  # bundle, and it would work perfectly for them and for nobody else.
  # CRA fails the build on lint warnings when CI=true, and this tree has warnings that are
  # noise; .github/workflows/ci.yml sets the same.
  env -u REACT_APP_API_BASE CI=false npm run build
)

# ── 1b. Check the links the page sends people to ──────────────────────────────
# The build proves the links are present and agree; only asking the destinations can say
# one is dead (docs.ci.computer/docs was a 404 that every other check agreed with). Needs
# the network, so it is here and not in `npm run build`.
echo "==> Checking Buy / Download / Docs / home answer"
(cd web-server/client && npm run --silent check:links)

# ── 2. Deploy the Worker ──────────────────────────────────────────────────────
# `--env ""` targets the top-level config explicitly. Without it wrangler warns that the
# file defines environments and no target was named.
ARGS=(deploy --env "$WRANGLER_ENV")
# What is live, on the deployment itself: `wrangler deployments list` shows it.
if [ "$SHA" != "unknown" ]; then
  LABEL="$SHA"
  if [ "$DIRTY" -eq 1 ]; then LABEL="$SHA-dirty"; fi
  ARGS+=(--tag "$SHA" --message "$LABEL")
fi
[ "$DRY_RUN" -eq 1 ] && ARGS+=(--dry-run)
[ ${#EXTRA[@]} -gt 0 ] && ARGS+=("${EXTRA[@]}")

echo "==> wrangler ${ARGS[*]}"
npx wrangler "${ARGS[@]}"

if [ "$DRY_RUN" -eq 0 ] && [ -z "$WRANGLER_ENV" ]; then
  cat <<'NOTE'

Deployed. The edge is static: it serves the viewer and holds no data. Each browser names
its own processing server on first visit, so there is nothing further to configure here.

On whichever machine runs the server, two settings are easy to miss:
  * PUBLIC_BASE_URL=https://photo.ci.computer  — share links are built from this.
  * MCP_ALLOWED_HOSTS=<the hostname the server is reached by> — or /mcp answers 421 to
    every agent while REST keeps working.

Reaching your own machine from the hosted page: docs/BRING-YOUR-OWN-SERVER.md.

  Check the page:  curl -sI https://photo.ci.computer | head -1
NOTE
fi
