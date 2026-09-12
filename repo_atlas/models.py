from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


ArtifactType = Literal[
    "library", "application", "cli", "service", "experiment", "dataset",
    "config", "docs", "unclear",
]
Maturity = Literal["production", "working", "prototype", "abandoned", "unclear"]
Confidence = Literal["high", "low"]


class RepoSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    one_liner: str = Field(max_length=140)
    what_it_does: str
    domain: str
    platform: str
    techniques: list[str]
    artifact_type: ArtifactType
    maturity: Maturity
    confidence: Confidence

    @field_validator("one_liner", mode="before")
    @classmethod
    def bounded_one_liner(cls, value: str) -> str:
        return str(value).strip()[:140].rstrip()

    @field_validator("domain", "platform", mode="before")
    @classmethod
    def at_most_four_words(cls, value: str) -> str:
        # Agent CLIs do not currently express word-count constraints in JSON Schema.
        # Normalize an otherwise valid structured response deterministically.
        return " ".join(str(value).strip().split()[:4])

    @field_validator("what_it_does")
    @classmethod
    def consistent_register(cls, value: str) -> str:
        lowered = value.strip().lower()
        if lowered.startswith("this repository contains"):
            return value.strip()[len("this repository contains"):].lstrip(" :—-").capitalize()
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
        return " ".join(words[:4])


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
