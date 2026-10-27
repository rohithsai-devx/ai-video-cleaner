"""Fail when backend/app drifts from the layout in docs/design/hld-lld.md ("LLD: backend modules").

Mechanical rules only: allowed top-level packages, conventional file names, and who may import whom.
Run: uv run python scripts/check_layout.py  (also run by tests/test_layout.py and CI).
"""

import ast
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
APP = BACKEND / "app"
TESTS = BACKEND / "tests"

DOMAINS = {"auth", "videos", "runs", "shares", "search"}
# pipeline: plain-code stages; agent: the LangGraph package; providers: the provider factory
TOP_LEVEL = DOMAINS | {"shared", "contracts", "pipeline", "agent", "providers", "main.py", "__init__.py"}
# names that hide what a file holds, or the pre-restructure layer folders
FORBIDDEN = {"api", "infra", "models", "core", "features", "data", "deps", "helpers", "misc", "common"}
DOMAIN_REQUIRED = {"router.py", "schemas.py", "__init__.py"}
AGENT_REQUIRED = ("agent.py", "state.py", ("nodes.py", "nodes"), ("tools.py", "tools"))
TEST_ROOT_FILES = {"__init__.py", "conftest.py", "factories.py", "test_layout.py"}
TEST_AREAS = DOMAINS | {"shared", "contracts", "pipeline", "agent", "providers", "e2e"}


def _module(path: Path) -> str:
    rel = path.relative_to(BACKEND).with_suffix("")
    parts = list(rel.parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _imports(path: Path) -> list[tuple[int, str]]:
    """Absolute app.* modules imported by ``path``, as (line, module). ``from app.x import y`` yields both."""
    out: list[tuple[int, str]] = []
    for node in ast.walk(ast.parse(path.read_text(), str(path))):
        if isinstance(node, ast.Import):
            out += [(node.lineno, a.name) for a in node.names if a.name.startswith("app")]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and (node.module or "").startswith("app"):
            assert node.module is not None
            out.append((node.lineno, node.module))
            out += [(node.lineno, f"{node.module}.{a.name}") for a in node.names]
    return out


def _top(module: str) -> str | None:
    parts = module.split(".")
    return parts[1] if len(parts) > 1 and parts[0] == "app" else None


def violations() -> list[str]:
    errs: list[str] = []
    if not APP.is_dir():
        return [f"{APP} is missing"]

    # 1. top level
    for entry in sorted(APP.iterdir()):
        if entry.name == "__pycache__":
            continue
        if entry.name not in TOP_LEVEL:
            errs.append(f"app/{entry.name}: not an allowed top-level package (allowed: {sorted(TOP_LEVEL)})")

    # 2. names that hide intent, anywhere under app/ (agent/utils is LangGraph's own convention)
    for p in APP.rglob("*"):
        if "__pycache__" in p.parts:
            continue
        stem = p.stem if p.is_file() else p.name
        rel = p.relative_to(APP)
        if stem in FORBIDDEN or (stem == "utils" and rel.parts[0] != "agent"):
            errs.append(f"app/{rel}: forbidden name '{stem}'; name the file after what it holds")

    # 3. every package has __init__.py; every domain has router.py + schemas.py
    packages = [
        p for p in APP.rglob("*") if p.is_dir() and "__pycache__" not in p.parts and p.name != "fixtures"
    ]
    for d in sorted(packages):
        if any(d.glob("*.py")) and not (d / "__init__.py").exists():
            errs.append(f"app/{d.relative_to(APP)}: package without __init__.py")
    for name in sorted(DOMAINS):
        d = APP / name
        if d.is_dir():
            missing = sorted(f for f in DOMAIN_REQUIRED if not (d / f).exists())
            if missing:
                errs.append(f"app/{name}: domain package missing {missing}")

    # 4. agent package follows LangGraph's application structure, and is registered in langgraph.json
    agent = APP / "agent"
    if agent.is_dir():
        for req in AGENT_REQUIRED:
            options = req if isinstance(req, tuple) else (req,)
            if not any((agent / o).exists() for o in options):
                errs.append(f"app/agent: missing {' or '.join(options)} (LangGraph application structure)")
        if not (BACKEND / "langgraph.json").exists():
            errs.append("backend/langgraph.json: required once app/agent exists")

    # 5. import direction
    routers_in_main: set[str] = set()
    for path in sorted(APP.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        mod = _module(path)
        here = _top(mod)
        for line, imp in _imports(path):
            there = _top(imp)
            where = f"app/{path.relative_to(APP)}:{line}"
            if there is None or there == here:
                continue
            if here == "contracts":
                errs.append(f"{where}: contracts imports {imp}; contracts depend on nothing else in app")
            if here == "shared" and there != "contracts":
                errs.append(f"{where}: shared imports {imp}; shared is infrastructure only, no domain code")
            if imp.split(".")[2:3] == ["router"]:
                if mod == "app.main":
                    routers_in_main.add(there)
                else:
                    errs.append(f"{where}: imports {imp}; routers are mounted by app.main only")
            if there == "pipeline" and mod != "app.main":
                errs.append(f"{where}: imports {imp}; the pipeline is started by app.main only")
    for name in sorted(DOMAINS):
        if (APP / name / "router.py").exists() and name not in routers_in_main:
            errs.append(f"app/main.py: does not mount app.{name}.router")

    # 6. tests mirror the app: tests/<area>/test_*.py
    if TESTS.is_dir():
        for p in sorted(TESTS.iterdir()):
            if p.name in ("__pycache__", "fixtures"):
                continue
            if p.is_file() and p.suffix == ".py" and p.name not in TEST_ROOT_FILES:
                errs.append(f"tests/{p.name}: move it under tests/<area>/ (areas: {sorted(TEST_AREAS)})")
            if p.is_dir() and p.name not in TEST_AREAS:
                errs.append(f"tests/{p.name}: not a test area (areas: {sorted(TEST_AREAS)})")
    return errs


def main() -> int:
    errs = violations()
    for e in errs:
        print(e)
    print(f"{len(errs)} layout violation(s)" if errs else "layout ok")
    return 1 if errs else 0


if __name__ == "__main__":
    raise SystemExit(main())
