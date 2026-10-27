"""The only router. Code checks, then a yes/no verdict, then a critique only on rejection."""

from typing import Any

from langgraph.graph import END
from langgraph.runtime import Runtime
from langgraph.types import Command
from pydantic import BaseModel

from app.agent.state import Ctx, make_call
from app.contracts.pipeline import Agent, AgentState, CheckResult
from app.runs import checks as code_checks

_QUESTION = {
    "script_writer": "Is this cleaned script ready for the editor?",
    "video_editor": "Is this edit plan ready to render?",
}


class Critique(BaseModel):
    text: str


def orchestrator(state: AgentState, runtime: Runtime[Ctx]) -> Command[Any]:
    if state.stage == "context":
        return Command(goto=["vlm_context", "transcript_context"], update={"stage": "script"})
    if state.stage == "done":
        return Command(goto=END)
    if state.stage == "script" and state.script is None:
        return Command(goto="script_writer")
    if state.stage == "edit" and state.edit_plan is None:
        return Command(goto="video_editor")
    return _review(state, runtime)


def _review(state: AgentState, runtime: Runtime[Ctx]) -> Command[Any]:
    if state.script is None or state.transcript_ctx is None:
        raise RuntimeError("review before the script exists")
    results = _results(state)
    failed = [item for item in results if not item.passed]
    if failed:
        notes = [item.message for item in failed if item.message]
        # Route to a responsible node that still has attempts: a capped writer must not swallow
        # the editor's own feedback loop when the plan is what failed.
        alive = next(
            (item for item in failed if state.attempts.get(item.target, 0) < runtime.context.max_attempts),
            failed[0],
        )
        return _redo(state, alive.target, notes, results, runtime)

    target: Agent = "script_writer" if state.stage == "script" else "video_editor"
    call = make_call(runtime.context.workspace_id, state.run_id, target)
    verdict = runtime.context.bundle.yes_no(call, _QUESTION[target], _summary(state))
    if verdict.p_yes >= runtime.context.accept_threshold:
        return _accept(state, results)
    critique = runtime.context.bundle.complete(
        call,
        [{"role": "user", "content": f"Critique this {target}. {_summary(state)}"}],
        Critique,
    )
    return _redo(state, target, [critique.text], results, runtime)


def _results(state: AgentState) -> list[CheckResult]:
    assert state.script is not None and state.transcript_ctx is not None
    if state.stage == "edit":
        assert state.edit_plan is not None
        return code_checks.recheck(
            state.script,
            state.edit_plan,
            state.seg_contexts,
            state.transcript_ctx,
            state.pre.words,
            state.pre.segments,
            state.pre.duration,
            state.voice,
            state.voice_wps,
        )
    return [
        code_checks.length_fit(state.script, state.voice_wps),
        code_checks.key_terms_kept(state.script, state.transcript_ctx.key_terms, state.pre.words),
        code_checks.coverage_order(state.script, state.pre.segments),
        code_checks.nothing_invented(state.script, state.pre.words, state.seg_contexts),
        code_checks.clean_only(state.script, state.pre.words, state.voice),
    ]


def _accept(state: AgentState, results: list[CheckResult]) -> Command[Any]:
    if state.stage == "script":
        return Command(goto="video_editor", update={"stage": "edit", "checks": results})
    return Command(goto=END, update={"stage": "done", "checks": results})


def _redo(
    state: AgentState, target: Agent, notes: list[str], results: list[CheckResult], runtime: Runtime[Ctx]
) -> Command[Any]:
    attempts = dict(state.attempts)
    attempts[target] = attempts.get(target, 0) + 1
    feedback = dict(state.feedback)
    feedback[target] = notes
    update: dict[str, Any] = {"attempts": attempts, "feedback": feedback, "checks": results}
    if attempts[target] >= runtime.context.max_attempts:
        if "max_attempts" not in state.flags:
            update["flags"] = ["max_attempts"]
        # END is only legal from the edit stage: a proposal leaving the graph must be complete,
        # so a capped script still gets its cut list from the editor, flagged for review.
        if state.stage == "script":
            update["stage"] = "edit"
            return Command(goto="video_editor", update=update)
        return Command(goto=END, update=update)
    update["stage"] = "script" if target == "script_writer" else "edit"
    return Command(goto=target, update=update)


def _summary(state: AgentState) -> str:
    if state.stage == "edit" and state.edit_plan is not None:
        return state.edit_plan.model_dump_json()
    if state.script is not None:
        return state.script.model_dump_json()
    return ""
