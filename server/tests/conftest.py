"""Test configuration: isolate storage and disable auth before the app imports settings."""

import os
import tempfile

os.environ.setdefault("ASSET_DIR", tempfile.mkdtemp(prefix="ptm-test-"))
os.environ.setdefault("AUTH_DISABLED", "1")
os.environ.setdefault("CI_MEMORY_MCP_URL", "")
os.environ.setdefault("SHARP_ENABLE_RESEARCH", "0")
