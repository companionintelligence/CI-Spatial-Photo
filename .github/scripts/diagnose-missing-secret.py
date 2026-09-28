#!/usr/bin/env python3
"""Explain why a Cloudflare credential did not reach the deploy job.

"MISSING" on its own cannot tell a misspelled secret name apart from a secret stored
somewhere Actions does not read, and those have completely different fixes. Three
staging deploys failed on the same line before this existed; the fourth identified the
cause in one second.

Two facts settle it, and neither requires naming an unrelated secret:

  * whether ANY repository secret reaches this job. If none does, nothing is scoped
    here and the problem is where the secrets live. If some do, the store and its
    scoping are fine and the problem is the name or the repository.
  * whether a Cloudflare-shaped name is present under a different spelling.

Deliberately does NOT print the full list. Actions logs are readable by anyone with
repository read access, not just admins, so the names of unrelated secrets are not
ours to publish. Values are never read at all — only the keys of the secrets context.

Reads the JSON `toJSON(secrets)` from the VISIBLE_SECRETS environment variable.
"""

import json
import os
import sys

WANTED = ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")


def main() -> int:
    raw = os.environ.get("VISIBLE_SECRETS", "")
    try:
        names = sorted(json.loads(raw))
    except (ValueError, TypeError):
        print("Could not read the secrets context; skipping the diagnosis.")
        return 0

    # `github_token` is always present and tells us nothing about configuration.
    others = [n for n in names if n != "github_token"]
    close = [n for n in others if "cloud" in n.lower() or n.lower().startswith("cf_")]

    print(f"Secrets reaching this job: {len(others)} besides github_token.")
    if others:
        print("  -> Repository secrets DO reach this job, so the store and its scoping are fine.")
        print("  -> So the credential is absent from THIS repository, or spelled differently.")
    else:
        print("  -> No repository secret is scoped to this job at all.")

    print("Cloudflare-shaped names among them: " + (", ".join(close) if close else "none"))
    if close:
        missing = [w for w in WANTED if w not in names]
        print(f"  -> Rename to exactly: {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
