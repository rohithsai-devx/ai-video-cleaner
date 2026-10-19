"""Laya yes/no with a fake model. These tests never import laya_mlx."""

import sys
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from app.providers import Call, CallLog, ProviderError, build, laya
from app.providers.laya import CHECKPOINT, Decision, decide
from app.shared.config import Settings


def _settings() -> Settings:
    return Settings(
        database_url_api="postgresql://app_api@localhost/avc",
        jwt_secret="k" * 16,
        openai_api_key="test-key",
    )


def _call() -> Call:
    return Call(workspace_id="ws", run_id="run", stage="script_writer")


def _transport() -> tuple[httpx.MockTransport, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=b"")

    return httpx.MockTransport(handler), seen


class _Model:
    def __init__(self, noul: float, *, style: str = "dict") -> None:
        self.noul = noul
        self.style = style
        self.calls: list[tuple[Any, dict[str, Any]]] = []

    def predict(self, state: Any, questions: dict[str, Any]) -> Any:
        self.calls.append((state, questions))
        qid = next(iter(questions))
        if self.style == "attr":
            return SimpleNamespace(answers={qid: SimpleNamespace(noul=self.noul)})
        return {"answers": {qid: {"noul": self.noul}}}


def test_importing_the_plugin_does_not_import_mlx() -> None:
    assert "laya_mlx" not in sys.modules
    assert "mlx" not in sys.modules


@pytest.mark.parametrize("style", ["dict", "attr"])
def test_decide_maps_one_noul_answer(style: str) -> None:
    model = _Model(0.64, style=style)
    got = decide("is this done?", "the state", model)
    assert got == Decision(p_yes=0.64, raw={"answers": {"yes": {"noul": 0.64}}} if style == "dict" else {})
    assert model.calls == [
        ("the state", {"yes": {"type": "noul", "instructions": "is this done?"}}),
    ]
    assert "laya_mlx" not in sys.modules


def test_load_imports_laya_mlx_once_inside_the_call(monkeypatch: pytest.MonkeyPatch) -> None:
    imported: list[str] = []
    loaded: list[str] = []
    model = _Model(0.5)

    class _Laya:
        @staticmethod
        def load(checkpoint: str) -> _Model:
            loaded.append(checkpoint)
            return model

    def _import(name: str) -> type[_Laya]:
        imported.append(name)
        if name != "laya_mlx":
            raise ImportError(name)
        return _Laya

    monkeypatch.setattr(laya, "_loaded", None)
    monkeypatch.setattr(laya.importlib, "import_module", _import)
    assert decide("q", "state").p_yes == 0.5
    assert decide("q", "state").p_yes == 0.5
    assert imported == ["laya_mlx"]
    assert loaded == [CHECKPOINT]
    assert len(model.calls) == 2
    assert "laya_mlx" not in sys.modules


def test_missing_install_is_not_retryable(monkeypatch: pytest.MonkeyPatch) -> None:
    def _import(name: str) -> Any:
        raise ImportError(name)

    monkeypatch.setattr(laya, "_loaded", None)
    monkeypatch.setattr(laya.importlib, "import_module", _import)
    rows: list[CallLog] = []
    transport, seen = _transport()
    with pytest.raises(ProviderError, match="laya") as exc:
        build(_settings(), transport=transport, recorder=rows.append).yes_no(_call(), "q", "state")
    assert exc.value.retryable is False
    assert seen == []
    assert rows == [
        CallLog(
            provider="laya",
            model=CHECKPOINT,
            stage="script_writer",
            workspace_id="ws",
            run_id="run",
            ok=False,
            latency_ms=rows[0].latency_ms,
        )
    ]
    assert rows[0].latency_ms >= 0


def test_yes_no_logs_laya_and_the_checkpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    model = _Model(0.81)
    monkeypatch.setattr(laya, "_loaded", model)
    rows: list[CallLog] = []
    transport, seen = _transport()
    got = build(_settings(), transport=transport, recorder=rows.append).yes_no(
        _call(), "is this done?", "the state"
    )
    assert got.p_yes == 0.81
    assert seen == []
    assert len(model.calls) == 1
    assert rows[0].provider == "laya"
    assert rows[0].model == CHECKPOINT
    assert rows[0].ok is True
    assert rows[0].stage == "script_writer"


def test_predict_failure_is_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Boom:
        def __init__(self) -> None:
            self.calls = 0

        def predict(self, state: Any, questions: dict[str, Any]) -> Any:
            del state, questions
            self.calls += 1
            raise RuntimeError("mlx")

    boom = _Boom()
    monkeypatch.setattr(laya, "_loaded", boom)
    with pytest.raises(ProviderError, match="laya") as exc:
        build(_settings(), transport=_transport()[0]).yes_no(_call(), "q", "state")
    assert exc.value.retryable is False
    assert boom.calls == 1
