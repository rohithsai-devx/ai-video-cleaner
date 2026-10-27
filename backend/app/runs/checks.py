"""Mechanical checks the review API re-runs on every edit and before approval.

Judgement stays with the agent. Only global limits live here.
"""

import re

from app.contracts.enums import ProposalSource, VoiceMode
from app.contracts.pipeline import (
    Agent,
    AgentState,
    CheckResult,
    EditPlan,
    EDLEntry,
    FixOptions,
    Script,
    ScriptBlock,
    SegContext,
    Segment,
    Spot,
    TranscriptContext,
    Word,
)

EDL_VALID = "edl_valid"
FIX_OPTIONS_RESPECTED = "fix_options_respected"
MAX_SPEED = 2.0
MIN_DUR = 0.3
# Stand-in until a measured voice rate is stored. 2.0 keeps the review fixture inside its targets.
VOICE_WPS = 2.0
_DUR_TOL = 0.5
_NUMBER = re.compile(r"\d+(?:\.\d+)?")
_URL = re.compile(r"https?://\S+|www\.\S+")
_QUOTE = re.compile(r'"([^"]+)"')
_INTERNAL_ID = re.compile(r"\b(?:seg|block|step|frame)_\w+\b", re.IGNORECASE)
_CHECK_NAMES = (
    "length_fit",
    "key_terms_kept",
    "coverage_order",
    "nothing_invented",
    "clean_only",
    EDL_VALID,
    "edl_covers_script",
    FIX_OPTIONS_RESPECTED,
    "reasons_plain",
)


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


def length_fit(script: Script, voice_wps: float) -> CheckResult:
    problems: list[str] = []
    ref: str | None = None
    # Speech is quantized to whole words (steps of 1/voice_wps), so a band finer than half a step
    # cannot be hit by any text; a single-value target (10.777..10.777) is checked with that slack.
    tolerance = 0.5 / voice_wps
    for block in script.blocks:
        duration = len(block.text.split()) / voice_wps
        if duration < block.target_min - tolerance or duration > block.target_max + tolerance:
            ref = ref or block.block_id
            problems.append(f"{block.block_id}: {duration}s outside {block.target_min}..{block.target_max}")
    return _script("length_fit", problems, ref)


def key_terms_kept(script: Script, key_terms: list[str], words: list[Word]) -> CheckResult:
    problems: list[str] = []
    ref: str | None = None
    for block in script.blocks:
        spoken = _span_text(words, block.source_span)
        missing = [term for term in key_terms if _has_term(term, spoken) and not _has_term(term, block.text)]
        if missing:
            ref = ref or block.block_id
            problems.append(f"{block.block_id}: missing {', '.join(missing)}")
    return _script("key_terms_kept", problems, ref)


def coverage_order(script: Script, segments: list[Segment]) -> CheckResult:
    problems: list[str] = []
    ref: str | None = None
    used: dict[str, int] = {}
    for block in script.blocks:
        for seg_id in set(block.seg_ids):
            used[seg_id] = used.get(seg_id, 0) + 1
    for seg in segments:
        if seg.active and used.get(seg.seg_id, 0) == 0:
            ref = ref or seg.seg_id
            problems.append(f"{seg.seg_id}: active segment unused")
    for seg_id, count in used.items():
        if count > 1:
            ref = ref or seg_id
            problems.append(f"{seg_id}: in two blocks")
    prev: float | None = None
    for block in script.blocks:
        start = block.source_span[0]
        if prev is not None and start < prev:
            ref = ref or block.block_id
            problems.append(f"{block.block_id}: out of source order")
        prev = start
    return _script("coverage_order", problems, ref)


def nothing_invented(script: Script, words: list[Word], seg_contexts: list[SegContext]) -> CheckResult:
    problems: list[str] = []
    ref: str | None = None
    contexts = {s.seg_id: s for s in seg_contexts}
    for block in script.blocks:
        transcript = _span_text(words, block.source_span)
        screen_parts: list[str] = []
        for seg_id in block.seg_ids:
            ctx = contexts.get(seg_id)
            if ctx is not None:
                screen_parts.extend(ctx.screen_text)
        screen = "\n".join(screen_parts)
        invented = [token for token in _claims(block.text) if token not in transcript and token not in screen]
        if invented:
            ref = ref or block.block_id
            problems.append(f"{block.block_id}: invented {', '.join(invented)}")
    return _script("nothing_invented", problems, ref)


def clean_only(script: Script, words: list[Word], voice: VoiceMode) -> CheckResult:
    if voice == "ai":
        return _script("clean_only", [], None)
    source = {token.casefold() for word in words for token in word.w.split()}
    problems: list[str] = []
    ref: str | None = None
    for block in script.blocks:
        missing = [token for token in block.text.split() if token.casefold() not in source]
        if missing:
            ref = ref or block.block_id
            problems.append(f"{block.block_id}: {', '.join(missing)} not in the source transcript")
    return _script("clean_only", problems, ref)


def fix_options_respected(state: AgentState, source: ProposalSource = "agent") -> CheckResult:
    """Check that agent decisions follow the run's allowed fixes; user edits are intentional overrides."""
    return _fix_options_check(
        state.transcript_ctx or TranscriptContext(steps=[], key_terms=[], drops=[]),
        state.edit_plan,
        state.pre.segments,
        state.fix_options,
        source,
    )


def reasons_plain(state: AgentState) -> CheckResult:
    return _plain_reasons(state.transcript_ctx, state.edit_plan, state.spots)


def _plain_reasons(
    transcript: TranscriptContext | None, plan: EditPlan | None, spots: list[Spot] | None = None
) -> CheckResult:
    problem: str | None = None
    target: Agent = "transcript_context"
    if transcript is not None:
        copy = next(
            (
                text
                for text in [
                    *(step.title for step in transcript.steps),
                    *(drop.reason for drop in transcript.drops),
                ]
                if _contains_internal_copy(text)
            ),
            None,
        )
        problem = copy
    if problem is None and plan is not None:
        target = "video_editor"
        problem = next(
            (entry.reasoning for entry in plan.entries if _contains_internal_copy(entry.reasoning)), None
        )
    if problem is None and spots:
        target = "spot_writer"
        problem = next(
            (
                text
                for text in [
                    *(spot.question for spot in spots),
                    *(fix.label for spot in spots for fix in spot.fixes),
                ]
                if _contains_internal_copy(text)
            ),
            None,
        )
    return CheckResult(
        name="reasons_plain",
        passed=problem is None,
        target=target,
        message="" if problem is None else "Write reasons for the viewer, without ids.",
    )


def _contains_internal_copy(text: str) -> bool:
    folded = text.casefold()
    return _INTERNAL_ID.search(text) is not None or any(name in folded for name in _CHECK_NAMES)


def _fix_options_check(
    transcript: TranscriptContext,
    plan: EditPlan | None,
    segments: list[Segment],
    options: FixOptions,
    source: ProposalSource,
) -> CheckResult:
    target: Agent = "script_writer"
    problems: list[str] = []
    if source == "agent":
        for drop in transcript.drops:
            if drop.kind == "filler" and not options.filler:
                problems.append("Filler removal is off for this run; keep filler words in the transcript.")
                break
            if drop.kind in ("false_start", "retake") and not options.retakes:
                problems.append(
                    "Retake removal is off for this run; keep restarts and retakes in the transcript."
                )
                break
        if not problems and plan is not None:
            target = "video_editor"
            by_id = {segment.seg_id: segment for segment in segments}
            for entry in plan.entries:
                segment = by_id.get(entry.seg_id)
                if (
                    entry.action == "cut"
                    and segment is not None
                    and not segment.active
                    and not options.pauses
                ):
                    problems.append("Removing long pauses is off for this run; keep idle segments.")
                    break
                if entry.action == "speed" and not options.slow_parts:
                    problems.append("Speed-ups are turned off for this run; use keep or cut.")
                    break
    elif plan is not None:
        target = "video_editor"
    return CheckResult(
        name=FIX_OPTIONS_RESPECTED,
        passed=not problems,
        target=target,
        message="; ".join(problems),
    )


def edl_covers_script(script: Script, plan: EditPlan) -> CheckResult:
    problems: list[str] = []
    ref: str | None = None
    entries: dict[str, list[EDLEntry]] = {}
    for entry in plan.entries:
        entries.setdefault(entry.seg_id, []).append(entry)
    for block in script.blocks:
        edited = _edited(block, entries)
        if edited is None or abs(edited - block.est_dur) > _DUR_TOL:
            ref = ref or block.block_id
            shown = "unknown" if edited is None else edited
            problems.append(f"{block.block_id}: edited {shown}s vs estimated {block.est_dur}s")
    return CheckResult(
        name="edl_covers_script",
        passed=not problems,
        target="video_editor",
        message="; ".join(problems),
        ref_id=ref,
    )


def recheck(
    script: Script,
    plan: EditPlan,
    seg_contexts: list[SegContext],
    transcript: TranscriptContext,
    words: list[Word],
    segments: list[Segment],
    duration_s: float | None,
    voice: VoiceMode,
    voice_wps: float,
    fix_options: FixOptions | None = None,
    source: ProposalSource = "agent",
) -> list[CheckResult]:
    """Recompute every check from the current proposal. Stale script checks are not kept."""
    return [
        length_fit(script, voice_wps),
        key_terms_kept(script, transcript.key_terms, words),
        coverage_order(script, segments),
        nothing_invented(script, words, seg_contexts),
        clean_only(script, words, voice),
        edl_valid(plan, seg_contexts, duration_s),
        edl_covers_script(script, plan),
        _fix_options_check(transcript, plan, segments, fix_options or FixOptions(), source),
        _plain_reasons(transcript, plan),
    ]


def _script(name: str, problems: list[str], ref: str | None) -> CheckResult:
    return CheckResult(
        name=name, passed=not problems, target="script_writer", message="; ".join(problems), ref_id=ref
    )


def _span_text(words: list[Word], span: tuple[float, float]) -> str:
    start, end = span
    return " ".join(word.w for word in words if start <= word.start < end)


def _has_term(term: str, text: str) -> bool:
    return re.compile(rf"\b{re.escape(term)}\b", re.IGNORECASE).search(text) is not None


def _claims(text: str) -> list[str]:
    return [*_NUMBER.findall(text), *_URL.findall(text), *_QUOTE.findall(text)]


def _edited(block: ScriptBlock, entries: dict[str, list[EDLEntry]]) -> float | None:
    total = 0.0
    for seg_id in dict.fromkeys(block.seg_ids):
        for entry in entries.get(seg_id, []):
            if entry.action == "cut":
                continue
            if entry.speed <= 0:
                return None
            start, end = entry.src
            total += (end - start) / entry.speed + entry.freeze_s
    return total
