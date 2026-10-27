"""Pure chapter projection from the transcript analyst's ordered steps."""

from app.contracts.pipeline import Chapter, Proposal, Step


def chapters(proposal: Proposal) -> list[Chapter]:
    return chapters_from_steps(proposal.transcript_ctx.steps)


def chapters_from_steps(steps: list[Step]) -> list[Chapter]:
    steps = sorted(steps, key=lambda step: step.span[0])
    return [
        Chapter(
            title=step.title or " ".join(step.summary.split()[:4]),
            start=step.span[0],
            end=steps[index + 1].span[0] if index + 1 < len(steps) else step.span[1],
        )
        for index, step in enumerate(steps)
    ]
