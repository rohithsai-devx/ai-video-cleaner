"""publish_all: events go out in order, and a Redis failure is logged, never raised."""

import uuid
from typing import Any

import pytest

from app.contracts.events import RunDoneEvent, RunProposalReadyEvent, RunStatusEvent
from app.shared import events

pytestmark = pytest.mark.asyncio(loop_scope="session")


class _Recorder:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[str, str]] = []

    async def publish(self, channel: str, message: str) -> int:
        if self.fail:
            raise ConnectionError("redis is down")
        import json

        self.calls.append((channel, json.loads(message)["event"]))
        return 1


@pytest.fixture
def redis_stub(monkeypatch: pytest.MonkeyPatch) -> Any:
    def install(recorder: _Recorder) -> _Recorder:
        monkeypatch.setattr(events, "get_redis", lambda: recorder)
        return recorder

    return install


def _three_events() -> list[events.Event]:
    return [
        ("run.status", RunStatusEvent(status="awaiting_review", stage="review")),
        ("run.proposal_ready", RunProposalReadyEvent(version=1, flags=[], auto_approved=False)),
        ("run.done", RunDoneEvent(video_id="v", output_uri="https://example.test/out.mp4")),
    ]


async def test_publish_all_keeps_order(redis_stub: Any) -> None:
    run_id = uuid.uuid4()
    rec = redis_stub(_Recorder())
    await events.publish_all(run_id, _three_events())
    assert rec.calls == [
        (f"run:{run_id}", "run.status"),
        (f"run:{run_id}", "run.proposal_ready"),
        (f"run:{run_id}", "run.done"),
    ]


async def test_publish_all_empty_list_publishes_nothing(redis_stub: Any) -> None:
    rec = redis_stub(_Recorder())
    await events.publish_all(uuid.uuid4(), [])
    assert rec.calls == []


async def test_redis_failure_does_not_raise(redis_stub: Any) -> None:
    rec = redis_stub(_Recorder(fail=True))
    # every event is attempted and every failure is swallowed
    await events.publish_all(uuid.uuid4(), _three_events())
    assert rec.calls == []
