"""Scene segments from frame differences. Speech pauses are not applied here."""

from collections.abc import Sequence

from app.contracts.pipeline import Keyframe, Segment


def segment(
    frames: Sequence[Keyframe],
    *,
    end_s: float,
    epsilon: float = 0.3,
    min_s: float = 2,
    max_s: float = 15,
) -> list[Segment]:
    cuts = {0.0, float(end_s)}
    for frame in frames:
        if frame.diff > epsilon and 0.0 < frame.t < end_s:
            cuts.add(float(frame.t))
    points = sorted(cuts)
    bounds = [(points[i], points[i + 1]) for i in range(len(points) - 1)]
    bounds = _merge_short(bounds, min_s)
    bounds = _split_long(bounds, min_s, max_s)
    return [_make(frames, i, start, end, epsilon) for i, (start, end) in enumerate(bounds)]


def _merge_short(bounds: list[tuple[float, float]], min_s: float) -> list[tuple[float, float]]:
    parts = list(bounds)
    i = 0
    while i < len(parts):
        start, end = parts[i]
        if end - start >= min_s or len(parts) == 1:
            i += 1
            continue
        if i == 0:
            parts[1] = (start, parts[1][1])
            del parts[0]
            continue
        parts[i - 1] = (parts[i - 1][0], end)
        del parts[i]
    return parts


def _split_long(bounds: list[tuple[float, float]], min_s: float, max_s: float) -> list[tuple[float, float]]:
    if max_s <= 0:
        return list(bounds)
    out: list[tuple[float, float]] = []
    for start, end in bounds:
        cursor = start
        while end - cursor > max_s:
            cut_at = cursor + max_s
            tail = (end - cursor) - max_s
            if tail < min_s and end - min_s - cursor >= min_s:
                cut_at = end - min_s
            if cut_at <= cursor:
                break
            out.append((cursor, cut_at))
            cursor = cut_at
        if cursor < end:
            out.append((cursor, end))
    return out


def _make(frames: Sequence[Keyframe], index: int, start: float, end: float, epsilon: float) -> Segment:
    # Half-open: a frame on the boundary belongs to the segment that starts there.
    owned = [frame for frame in frames if start <= frame.t < end]
    return Segment(
        seg_id=f"seg_{index + 1:02d}",
        start=start,
        end=end,
        frame_ids=[frame.frame_id for frame in owned],
        active=max((frame.diff for frame in owned), default=0.0) > epsilon,
    )
