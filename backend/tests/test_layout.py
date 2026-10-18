"""The backend layout rules (scripts/check_layout.py) hold."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from check_layout import violations  # noqa: E402


def test_layout_has_no_violations() -> None:
    assert violations() == []
