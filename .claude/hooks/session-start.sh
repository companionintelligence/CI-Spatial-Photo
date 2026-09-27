#!/bin/bash
# SessionStart hook — prepare a Claude Code on the web container for this repo.
#
# Installs exactly what the checks in docs/CI.md need and nothing more:
#   * the FastAPI processing server in editable mode with its dev + mcp extras
#     (`cd server && pytest` — no GPU, no torch)
#   * ruff + mypy, the two linters .pre-commit-config.yaml runs on Python
#   * the web viewer's npm dependencies (`npm run build`, `npm test`)
#
# Deliberately NOT installed: the root pyproject.toml (Apple SHARP — torch, gsplat,
# timm) and server's `[depth]` extra. Both pull multi-gigabyte wheels, neither is
# needed to run a single test in this repo, and a GPU container is where they belong.
set -euo pipefail

# Local machines already have a developer's own environment; don't touch it.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  echo "session-start: not a remote session, skipping dependency install."
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

VENV="$ROOT/.venv"

# ── Python: the server, its dev extras, and the linters ───────────────────────
# A project-local venv rather than the system interpreter: /usr/local/bin/python is
# externally managed (pip refuses without --break-system-packages), and the venv is
# cached with the container after this hook completes.
if command -v uv >/dev/null 2>&1; then
  [ -x "$VENV/bin/python" ] || uv venv "$VENV"
  # `uv pip install` is idempotent; re-running resolves against the existing venv.
  VIRTUAL_ENV="$VENV" uv pip install --quiet -e "$ROOT/server[dev,mcp]" ruff mypy
else
  [ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
  "$VENV/bin/python" -m pip install --quiet --upgrade pip
  "$VENV/bin/python" -m pip install --quiet -e "$ROOT/server[dev,mcp]" ruff mypy
fi

# Put the venv on PATH for the session so `pytest`, `ruff`, `mypy` and `uvicorn`
# resolve without anyone having to remember to activate it.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export VIRTUAL_ENV=\"$VENV\""
    echo "export PATH=\"$VENV/bin:\$PATH\""
  } >> "$CLAUDE_ENV_FILE"
fi

# ── Node: the React + Three.js + Spark viewer ─────────────────────────────────
# `npm install` over `npm ci`: it reuses whatever node_modules the cached container
# already has instead of deleting the tree and refetching every package.
if command -v npm >/dev/null 2>&1; then
  npm install --prefix "$ROOT/web-server/client" --no-audit --no-fund --loglevel=error
fi

echo "session-start: ready — server (dev,mcp) + ruff/mypy in .venv, viewer deps installed."
