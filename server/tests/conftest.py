"""Test configuration: pin every setting the suite assumes, before the app reads any of them.

`Settings` is a pydantic-settings model, so **every field it is not handed explicitly comes
from the developer's environment**. This file used to use `os.environ.setdefault`, which by
definition leaves an exported value in place — so a shell with `SHARP_ENABLE_RESEARCH=1`,
`DEPTH_AUTO_ROUTE=1`, `DEPTH_MODEL=depth-pro` or a real `MODEL_WEIGHTS_DIR` silently changed
what the tests were testing: routing moved to a different engine, licence gates opened, and
`weights_cached` began finding checkpoints the tests describe as absent. Seven tests across
four modules failed that way, and only ever on the machine that had the variable set.

`MODEL_WEIGHTS_DIR` deserves its own note. `depth_models.cache_roots` consults it *before*
the ambient `~/.cache/huggingface/hub`, so pinning it is as necessary as the `HF_HOME`
isolation the depth modules already do — and it is the door that isolation does not cover.
It is pointed at a path that does not exist, matching the shipped `/models` default (which is
real in the container and absent on a laptop) so that `_cache_dir` keeps returning None.

Everything below is assigned unconditionally. A test that wants a different value passes it to
`Settings(...)` or `monkeypatch.setenv` itself, which is what every test here already does.
"""

import os
import tempfile

# Storage: never write into a real asset directory, even if one is configured.
os.environ["ASSET_DIR"] = tempfile.mkdtemp(prefix="ptm-test-")

# Auth and Companion memory off. Both are tested explicitly, via Settings(...) and
# FastAPI dependency overrides, rather than by whatever the host happens to have.
os.environ["AUTH_DISABLED"] = "1"
os.environ["CI_MEMORY_MCP_URL"] = ""

# Engine gates at their shipped defaults; every routing assertion is written against these.
os.environ["DEFAULT_ENGINE"] = "triposplat"
os.environ["SHARP_ENABLE_RESEARCH"] = "0"
os.environ["DEPTH_AUTO_ROUTE"] = "0"
os.environ["DEPTH_ALLOW_NONCOMMERCIAL"] = "0"
os.environ["DEPTH_MODEL"] = "depth-anything-v2-small"
os.environ["DEPTH_VIDEO_MODEL"] = "depth-anything-v2-small"

# Weight discovery: an empty, non-existent mount plus an empty HuggingFace cache, so no test
# can accidentally depend on what this machine has downloaded. The per-module autouse fixtures
# in test_depth_models.py and test_registry_routing.py still re-apply the HF half — they run
# per test, so they also undo a monkeypatch made earlier in the same module.
os.environ["MODEL_WEIGHTS_DIR"] = os.path.join(
    tempfile.mkdtemp(prefix="ptm-test-weights-"), "models"
)
os.environ["HF_HOME"] = tempfile.mkdtemp(prefix="ptm-test-hf-")
os.environ.pop("HF_HUB_CACHE", None)
os.environ.pop("TRANSFORMERS_CACHE", None)

# Offline switches: `downloads_disabled()` is a global read, and the tests that care about it
# set it themselves. Inheriting HF_HUB_OFFLINE=1 from the shell would gate every checkpoint.
for _offline_var in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "PTM_NO_DOWNLOAD"):
    os.environ.pop(_offline_var, None)
