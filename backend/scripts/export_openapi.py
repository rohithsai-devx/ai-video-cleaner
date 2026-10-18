"""Write backend/openapi.json from the FastAPI app.

uv run python scripts/export_openapi.py          # write
uv run python scripts/export_openapi.py --check  # fail if stale or an API-table path is missing
"""

import argparse
import json
import re
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

OUT = BACKEND / "openapi.json"

# The API table in docs/design/hld-lld.md plus "Auth (phase 1)"; path params normalised to {}.
REQUIRED: set[tuple[str, str]] = {
    ("post", "/auth/signup"),
    ("post", "/auth/signin"),
    ("post", "/videos"),
    ("post", "/videos/{}/uploaded"),
    ("get", "/videos"),
    ("get", "/videos/{}"),
    ("post", "/videos/{}/runs"),
    ("get", "/runs/{}"),
    ("get", "/runs/{}/events"),
    ("get", "/runs/{}/proposal"),
    ("put", "/runs/{}/proposal"),
    ("post", "/runs/{}/approve"),
    ("post", "/runs/{}/cancel"),
    ("post", "/videos/{}/shares"),
    ("get", "/s/{}"),
    ("get", "/workspaces/{}/glossary"),
    ("put", "/workspaces/{}/glossary"),
}


def render() -> tuple[str, dict[str, object]]:
    # The schema needs no settings; avoid requiring a .env just to export it.
    from app.main import create_app

    spec = create_app(manage_pool=False).openapi()
    return json.dumps(spec, indent=2, sort_keys=True) + "\n", spec


def missing(spec: dict[str, object]) -> list[str]:
    paths = spec.get("paths", {})
    assert isinstance(paths, dict)
    have = {(m.lower(), re.sub(r"\{[^}]+\}", "{}", p)) for p, ops in paths.items() for m in ops}
    return sorted(f"{m.upper()} {p}" for m, p in REQUIRED - have)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    text, spec = render()
    gaps = missing(spec)
    if gaps:
        print("missing API-table paths:\n  " + "\n  ".join(gaps), file=sys.stderr)
        return 1
    if args.check:
        if not OUT.exists() or OUT.read_text() != text:
            print(f"{OUT.name} is stale; run scripts/export_openapi.py", file=sys.stderr)
            return 1
        print(f"{OUT.name} is up to date")
        return 0
    OUT.write_text(text)
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
