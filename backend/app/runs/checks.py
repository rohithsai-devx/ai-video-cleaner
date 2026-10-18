"""The mechanical EDL check the API re-runs on every edit and before approval (renders must not break).

Only global limits live here (design: "EDL valid"); judgement calls stay with the agent.
"""

from app.contracts.pipeline import CheckResult, EditPlan, SegContext

EDL_VALID = "edl_valid"
MAX_SPEED = 2.0
MIN_DUR = 0.3


def edl_valid(plan: EditPlan, seg_contexts: list[SegContext], duration_s: float | None) -> CheckResult:
    problems: list[str] = []
    ref: str | None = None
    known = {s.seg_id for s in seg_contexts}
    prev_end = 0.0
    for e in sorted(plan.entries, key=lambda e: e.src[0]):
        start, end = e.src
        bad: list[str] = []
        if e.seg_id not in known:
            bad.append("unknown segment")
        if start < 0 or end <= start or (duration_s is not None and end > duration_s + 1e-6):
            bad.append(f"span {start}-{end} outside the video")
        if start < prev_end - 1e-6:
            bad.append("overlaps the previous entry")
        if e.action != "cut":
            if not 0 < e.speed <= MAX_SPEED:
                bad.append(f"speed {e.speed} outside (0, {MAX_SPEED}]")
            elif (end - start) / e.speed + e.freeze_s < MIN_DUR:
                bad.append(f"edited duration below {MIN_DUR}s")
        if bad:
            ref = ref or e.seg_id
            problems.append(f"{e.seg_id}: {', '.join(bad)}")
        prev_end = max(prev_end, end)
    if not plan.entries:
        problems.append("edit plan is empty")
    return CheckResult(
        name=EDL_VALID, passed=not problems, target="video_editor", message="; ".join(problems), ref_id=ref
    )


def recheck(
    previous: list[CheckResult], plan: EditPlan, seg_contexts: list[SegContext], duration_s: float | None
) -> list[CheckResult]:
    """Keep the agent's script checks, replace edit-plan checks with a fresh EDL check."""
    kept = [c for c in previous if c.target != "video_editor"]
    return [*kept, edl_valid(plan, seg_contexts, duration_s)]
