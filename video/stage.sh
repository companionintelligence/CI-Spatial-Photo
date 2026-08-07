#!/usr/bin/env bash
#
# Photo Time Machine's capture stage, for video/make.sh.
#
# Contract (see the header of make.sh, which is the fleet-wide runner and is
# byte-identical in every repo):
#   stage_up    start whatever the capture films, return once it answers
#   stage_down  stop it, safely, even when nothing is running
#   STAGE_LOG   a log worth printing when a run fails
#
# ── Why this repo needs a script and not a paragraph ─────────────────────────
# `tools/stages.json` records that this product has no automated stage entry.
# The reasons are structural, not neglect:
#
#   1. It is TWO processes (docker-compose.yml): a FastAPI server on :8000 that
#      needs `pip install -e ./server`, and a CRA bundle on :3000. The SPA is an
#      empty shell without the server — CreatePanel fills its Engine select from
#      GET /api/v1/engines on mount, and Explore / From Memory are pure API views.
#   2. `REACT_APP_API_BASE` is read at CRA **build** time (web-server/client/src/api.ts,
#      Dockerfile ARG), so moving the API port means rebuilding the bundle, not
#      restarting uvicorn.
#   3. Routing is a hand-rolled regex — `parseViewId()` in App.tsx matches only
#      `^/view/([A-Za-z0-9_]+)`. `serve -s` supplies the SPA fallback; without
#      it the two viewer shots 404.
#   4. Three shots need an asset to ALREADY EXIST. Without one, Explore films
#      "No 3D memories yet", the viewer has nothing to load, and the share
#      footer never mounts. So the stage seeds one through the real
#      POST /api/v1/jobs before capture starts.
#
# Re-deriving all of that from README prose, under time pressure, is how a
# re-shoot ends up half done.

# Ports. make.sh's pick_port relocates around anything already bound, which
# matters on a laptop running several product stages at once — and matters more
# than it looks: a stage that fails to bind while an OLD stage still answers
# every probe captures the previous run's bundle and reports success.
PTM_API_PORT="$(pick_port "${PTM_API_PORT:-8000}")"
PTM_VIEWER_PORT="$(pick_port "${PTM_VIEWER_PORT:-3000}")"

# capture.config.mjs reads these (PTM_VIEWER_URL falls back to APP_URL, the
# fleet-wide convention, so the cross-product runner needs no special case).
export PTM_API_URL="http://127.0.0.1:$PTM_API_PORT"
export PTM_VIEWER_URL="http://localhost:$PTM_VIEWER_PORT"
export APP_URL="$PTM_VIEWER_URL"

# Everything the stage writes lives outside the repo: a capture must not leave a
# venv, a node_modules or a directory of splats in the working tree.
PTM_WORK="${PTM_WORK_DIR:-${TMPDIR:-/tmp}/ptm-video-stage}"
STAGE_LOG="$PTM_WORK/stage.log"

PTM_SERVER_PID=""
PTM_VIEWER_PID=""

_ptm_wait_for() { # _ptm_wait_for <url> <label> <pid>
  for _ in $(seq 1 90); do
    kill -0 "$3" 2>/dev/null || die "$2 exited before it answered $1 — see $STAGE_LOG"
    curl -sf -o /dev/null "$1" && return 0
    sleep 1
  done
  die "$2 never came up at $1 — see $STAGE_LOG"
}

stage_up() {
  mkdir -p "$PTM_WORK"
  : > "$STAGE_LOG"

  # ── the processing server ──────────────────────────────────────────────────
  # AUTH_DISABLED defaults to true (server/app/config.py), so no token is needed.
  if [ ! -x "$PTM_WORK/venv/bin/uvicorn" ]; then
    say "installing server/ into $PTM_WORK/venv"
    if command -v uv >/dev/null 2>&1; then
      uv venv "$PTM_WORK/venv" >>"$STAGE_LOG" 2>&1
      VIRTUAL_ENV="$PTM_WORK/venv" uv pip install -q -e "$REPO_ROOT/server" >>"$STAGE_LOG" 2>&1
    else
      python3 -m venv "$PTM_WORK/venv" >>"$STAGE_LOG" 2>&1
      "$PTM_WORK/venv/bin/pip" install -q -e "$REPO_ROOT/server" >>"$STAGE_LOG" 2>&1
    fi
  fi

  say "server  $PTM_API_URL"
  # `exec` so $! is uvicorn itself. Without it $! is the subshell, stage_down
  # kills a shell that has already gone, and the server survives as an orphan
  # that will answer the NEXT run's probes.
  ( cd "$REPO_ROOT" \
      && ASSET_DIR="$PTM_WORK/assets" PUBLIC_BASE_URL="$PTM_VIEWER_URL" \
         exec "$PTM_WORK/venv/bin/uvicorn" app.main:app --app-dir server \
           --host 127.0.0.1 --port "$PTM_API_PORT" >>"$STAGE_LOG" 2>&1 ) &
  PTM_SERVER_PID=$!
  _ptm_wait_for "$PTM_API_URL/healthz" "server" "$PTM_SERVER_PID"

  # ── the viewer ─────────────────────────────────────────────────────────────
  say "building the viewer against :$PTM_API_PORT"
  [ -d "$REPO_ROOT/web-server/client/node_modules" ] \
    || ( cd "$REPO_ROOT/web-server/client" && npm ci --no-audit --no-fund >>"$STAGE_LOG" 2>&1 )
  ( cd "$REPO_ROOT/web-server/client" \
      && CI=false REACT_APP_API_BASE="$PTM_API_URL" npx react-scripts build >>"$STAGE_LOG" 2>&1 ) \
    || die "CRA build failed — see $STAGE_LOG"

  say "viewer  $PTM_VIEWER_URL"
  ( cd "$REPO_ROOT" \
      && exec npx --yes serve@14 -s web-server/client/build -l "$PTM_VIEWER_PORT" >>"$STAGE_LOG" 2>&1 ) &
  PTM_VIEWER_PID=$!
  _ptm_wait_for "$PTM_VIEWER_URL/" "viewer" "$PTM_VIEWER_PID"
  curl -sf -o /dev/null "$PTM_VIEWER_URL/view/probe" \
    || die "no SPA fallback at /view/:assetId — the static server needs -s"

  # ── one real asset ─────────────────────────────────────────────────────────
  # gallery-assets, viewer-shared and viewer-orbit are the genuine article: the
  # tile thumbnail and the orbited splat stream from this asset. capture.config.mjs
  # rewrites only its created_at and share_url, so no localhost URL reaches a
  # frame. `preview` is the one engine needing neither CUDA nor downloaded weights.
  local count
  count="$(curl -sf "$PTM_API_URL/api/v1/assets" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).assets.length')"
  if [ "$count" = "0" ]; then
    say "seeding one asset through POST /api/v1/jobs (engine=preview)"
    local job jid status
    job="$(curl -sf -X POST "$PTM_API_URL/api/v1/jobs" \
        -F "files=@$VIDEO_DIR/assets/media/porch-1998.png" -F engine=preview -F intent=auto)"
    jid="$(printf '%s' "$job" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).job_id')"
    for _ in $(seq 1 60); do
      status="$(curl -sf "$PTM_API_URL/api/v1/jobs/$jid" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).status')"
      [ "$status" = "done" ] && break
      [ "$status" = "failed" ] && die "seed job failed: $(curl -sf "$PTM_API_URL/api/v1/jobs/$jid")"
      sleep 1
    done
    [ "$status" = "done" ] || die "seed job never finished (last status: $status)"
  fi
  say "asset   $(curl -sf "$PTM_API_URL/api/v1/assets" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).assets[0].asset_id')"
}

stage_down() {
  local pid
  for pid in "$PTM_VIEWER_PID" "$PTM_SERVER_PID"; do
    [ -n "$pid" ] || continue
    # children first: npx re-spawns, so killing only the pid we launched can
    # leave a listener behind.
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  done
  PTM_VIEWER_PID=""
  PTM_SERVER_PID=""
}
