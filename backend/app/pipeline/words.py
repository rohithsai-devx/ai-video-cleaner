"""Timed placeholder words. Real timestamps arrive with transcription."""

from app.contracts.pipeline import Word


def stub_words(duration: float) -> list[Word]:
    if duration < 1:
        return [Word(w="word", start=0.0, end=duration)]
    return [Word(w="word", start=float(i), end=i + 0.5) for i in range(int(duration))]
