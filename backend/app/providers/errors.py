"""Errors from a model call. The node retry policy reads ``retryable``."""


class ProviderError(Exception):
    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable
