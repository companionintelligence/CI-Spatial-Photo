#!/usr/bin/env bash
# Build the viewer and deploy it, plus the API proxy, to Cloudflare.
#
#   scripts/deploy-cloudflare.sh                      # -> photo.ci.computer
#   scripts/deploy-cloudflare.sh --env staging        # -> the workers.dev staging Worker
#   scripts/deploy-cloudflare.sh --dry-run            # build + validate, publish nothing
#
# Needs a Cloudflare API token with Workers Scripts:Edit (plus Workers Routes:Edit the first
# time, to attach the custom domain). Either log in with `npx wrangler login`, or export
# CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
#
# ORIGIN_API_BASE — the processing server the Worker proxies to — is a Worker variable, not
# a build input. Pass it here to set it on this deploy, or leave it and manage it in the
# dashboard. Full walkthrough: docs/DEPLOY-CLOUDFLARE.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WRANGLER_ENV=""
DRY_RUN=0
EXTRA=()

while [ $# -gt 0 ]; do
  case "$1" in
    --env) WRANGLER_ENV="$2"; shift 2 ;;
    --env=*) WRANGLER_ENV="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

# ── 1. Build the viewer ───────────────────────────────────────────────────────
# REACT_APP_API_BASE empty = same-origin: the bundle requests /api/v1/... and the Worker
# proxies it. Exported empty rather than unset, which would bake in http://localhost:8000
# (see web-server/client/src/api.ts).
echo "==> Building the viewer (same-origin API base)"
(
  cd web-server/client
  [ -d node_modules ] || npm install --no-audit --no-fund --loglevel=error
  # CRA fails the build on lint warnings when CI=true, and this tree has warnings that are
  # noise; .github/workflows/ci.yml sets the same.
  REACT_APP_API_BASE="" CI=false npm run build
)

# ── 2. Deploy the Worker ──────────────────────────────────────────────────────
# `--env ""` targets the top-level config explicitly. Without it wrangler warns that the
# file defines environments and no target was named.
ARGS=(deploy --env "$WRANGLER_ENV")
[ "$DRY_RUN" -eq 1 ] && ARGS+=(--dry-run)
[ ${#EXTRA[@]} -gt 0 ] && ARGS+=("${EXTRA[@]}")

echo "==> wrangler ${ARGS[*]}"
npx wrangler "${ARGS[@]}"

if [ "$DRY_RUN" -eq 0 ] && [ -z "$WRANGLER_ENV" ]; then
  cat <<'NOTE'

Deployed. Two things the Worker cannot do for itself:

  * ORIGIN_API_BASE must point at the processing server, or every API call answers 503
    with that instruction. Set it with:
        npx wrangler deploy --env "" --var ORIGIN_API_BASE:https://<origin-host>
  * On that origin, set PUBLIC_BASE_URL=https://photo.ci.computer (so share links point
    at the edge, not at the origin) and MCP_ALLOWED_HOSTS=<origin-host> (or /mcp answers
    421 to every agent).

  Check it:  curl -s https://photo.ci.computer/healthz
NOTE
fi
