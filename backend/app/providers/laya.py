"""Yes/no through Laya on MLX. ``laya_mlx`` is imported inside ``load``."""

import importlib
from typing import Any

from pydantic import BaseModel

from app.providers.errors import ProviderError

CHECKPOINT = "aac6fef/laya-typed-decisions-mlx"
_QUESTION_ID = "yes"
_loaded: Any = None


class Decision(BaseModel):
    p_yes: float
    raw: dict[str, Any] = {}


def load() -> Any:
    global _loaded
    if _loaded is not None:
        return _loaded
    try:
        laya = importlib.import_module("laya_mlx")
    except ImportError as exc:
        raise ProviderError("yes_no needs the laya plugin", retryable=False) from exc
    _loaded = laya.load(CHECKPOINT)
    return _loaded


def decide(question: str, ctx: str, model: Any | None = None) -> Decision:
    agent = model if model is not None else load()
    questions = {_QUESTION_ID: {"type": "noul", "instructions": question}}
    try:
        result = agent.predict(ctx, questions)
        answers = result["answers"] if isinstance(result, dict) else result.answers
        answer = answers[_QUESTION_ID]
        noul = answer["noul"] if isinstance(answer, dict) else answer.noul
        raw = result if isinstance(result, dict) else {}
        return Decision(p_yes=float(noul), raw=raw)
    except ProviderError:
        raise
    except Exception as exc:
        raise ProviderError("laya yes_no failed", retryable=False) from exc
