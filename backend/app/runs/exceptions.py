"""Run errors. lifecycle and review re-export them, so callers keep importing them from there."""

from app.contracts.pipeline import CheckResult


class Lost(Exception):
    """The compare-and-set changed 0 rows: another writer won."""


class LiveRunExists(Exception):
    """runs_one_live_per_video: the video already has a live run."""


class VideoNotFound(Exception):
    """No such video, or RLS hides it."""


class VideoNotStartable(Exception):
    """The video has no raw upload or is in a status that cannot start a run."""

    def __init__(self, status: str) -> None:
        super().__init__(f"video is {status}")
        self.status = status


class NotReviewable(Exception):
    """The run is not awaiting_review (409)."""


class VersionConflict(Exception):
    """The client edited or approved a version that is no longer the latest (409 version_conflict)."""

    def __init__(self, base_version: int, latest: int) -> None:
        super().__init__(f"base_version {base_version} is not the latest version {latest}")
        self.base_version = base_version
        self.latest = latest


class NoProposal(Exception):
    """The run has no proposal yet (409 on PUT/approve, 404 on GET)."""


class EditNotAllowed(Exception):
    """The body changes a field outside the trust rule (422); the message names the fields."""


class InvalidEdl(Exception):
    """The EDL check failed, so the render would break (422)."""

    def __init__(self, check: CheckResult) -> None:
        super().__init__(check.message)
        self.check = check
