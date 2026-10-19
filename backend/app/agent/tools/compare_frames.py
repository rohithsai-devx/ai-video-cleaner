"""Keyframe diff scores already stored on the recording. No model call."""

from typing import Any

from app.contracts.pipeline import Keyframe

TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "compare_frames",
        "description": "Return stored keyframe diff scores.",
        "parameters": {
            "type": "object",
            "properties": {"frame_ids": {"type": "array", "items": {"type": "string"}}},
        },
    },
}


def compare_frames(keyframes: list[Keyframe], frame_ids: list[str] | None = None) -> list[dict[str, Any]]:
    chosen = keyframes
    if frame_ids is not None:
        want = set(frame_ids)
        chosen = [frame for frame in keyframes if frame.frame_id in want]
    return [{"frame_id": frame.frame_id, "t": frame.t, "diff": frame.diff} for frame in chosen]
