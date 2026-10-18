"""Glossary request and response models."""

from pydantic import BaseModel, Field


class GlossaryTerm(BaseModel):
    term: str = Field(min_length=1, max_length=200)
    pronunciation: str | None = None
