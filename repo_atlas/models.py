from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

ArtifactType = Literal[
    "library", "application", "cli", "service", "experiment", "dataset",
    "config", "docs", "unclear",
]
Maturity = Literal["production", "working", "prototype", "abandoned", "unclear"]
Confidence = Literal["high", "low"]


class RepoSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    one_liner: str = Field(min_length=1, max_length=140)
    what_it_does: str = Field(min_length=1, max_length=800)
    domain: str = Field(max_length=80)
    platform: str = Field(max_length=80)
    techniques: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(max_length=12)
    artifact_type: ArtifactType
    maturity: Maturity
    confidence: Confidence

    @field_validator("one_liner", "what_it_does", mode="before")
    @classmethod
    def normalize_summary_text(cls, value: str) -> str:
        # Let the field constraint reject overlong model output so the
        # summarizer repair loop can produce a complete sentence. Silently
        # slicing here published broken words and partial Unicode sequences.
        if not isinstance(value, str):
            raise TypeError("value must be a string")
        normalized = value.strip()
        if not normalized:
            raise ValueError("value must not be empty")
        return normalized

    @field_validator("domain", "platform", mode="before")
    @classmethod
    def at_most_four_words(cls, value: str) -> str:
        if not isinstance(value, str):
            raise TypeError("value must be a string")
        normalized = " ".join(value.strip().split())
        if not normalized:
            raise ValueError("value must not be empty")
        if len(normalized.split()) > 4:
            raise ValueError("value must contain at most four words")
        return normalized

    @field_validator("techniques", mode="after")
    @classmethod
    def normalize_techniques(cls, values: list[str]) -> list[str]:
        normalized = [" ".join(value.strip().split()) for value in values]
        if any(not value for value in normalized):
            raise ValueError("techniques must not contain empty values")
        return normalized

    @field_validator("what_it_does")
    @classmethod
    def consistent_register(cls, value: str) -> str:
        lowered = value.strip().lower()
        if lowered.startswith("this repository contains"):
            remainder = value.strip()[len("this repository contains"):].lstrip(" :—-")
            if not remainder:
                raise ValueError("value must not be empty after normalization")
            return remainder[:1].upper() + remainder[1:]
        return value.strip()


class ClusterLabel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str
    gloss: str = Field(max_length=100)

    @field_validator("label", mode="before")
    @classmethod
    def short_label(cls, value: str) -> str:
        words = str(value).strip().split()
        if not words:
            raise ValueError("label must not be empty")
        if len(words) > 4:
            raise ValueError("label must contain at most four words")
        return " ".join(words)


class Neighbor(BaseModel):
    full_name: str
    similarity: float


class RepoResult(BaseModel):
    full_name: str
    name: str
    url: str
    homepage: str | None
    x: float
    y: float
    x_alt: float
    y_alt: float
    cluster_id: int | None
    one_liner: str
    what_it_does: str
    domain: str
    platform: str
    techniques: list[str]
    artifact_type: ArtifactType
    maturity: Maturity
    primary_language: str | None
    languages: list[dict]
    topics: list[str]
    stars: int
    file_count: int | None
    size_r: float
    created_at: str
    pushed_at: str
    archived: bool
    is_fork: bool
    parent_full_name: str | None
    low_confidence: bool
    neighbors: list[Neighbor]
