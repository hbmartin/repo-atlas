from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
from pathlib import Path

import typer
from pydantic import ValidationError

from . import __version__
from .cache import Cache
from .github import GitHubClient, GitHubError, resolve_token
from .models import ClusterLabel
from .pipeline import STAGES, AtlasPipeline, now

app = typer.Typer(help="Build and inspect the Repo Atlas offline data bundle.", no_args_is_help=True)
labels_app = typer.Typer(help="Inspect or override generated region labels.")
cache_app = typer.Typer(help="Inspect and maintain the local pipeline cache.")
app.add_typer(labels_app, name="labels")
app.add_typer(cache_app, name="cache")


def project_root() -> Path:
    current = Path.cwd().resolve()
    for candidate in (current, *current.parents):
        if (candidate / "pyproject.toml").exists() and (candidate / "package.json").exists():
            return candidate
    raise typer.BadParameter("Run atlas from the Repo Atlas project directory.")


@app.callback()
def main(version: bool = typer.Option(False, "--version", is_eager=True)) -> None:
    if version:
        typer.echo(__version__)
        raise typer.Exit()


@app.command()
def run(
    from_stage: str = typer.Option("discover", "--from", help="First stage to run."),
    only: str | None = typer.Option(None, help="Comma-separated stages to run."),
    summarizer: str = typer.Option("openai", help="openai, codex, claude, or gemini."),
    embedder: str = typer.Option("hosted", help="hosted or local."),
    yes: bool = typer.Option(False, "--yes", help="Deprecated compatibility flag."),
    allow_fallback: bool = typer.Option(
        False,
        "--allow-fallback",
        help="Permit or reuse lower-quality TF-IDF/SVD embeddings when hosted quota is exhausted.",
    ),
    allow_agent_summarizer: bool = typer.Option(
        False,
        "--allow-agent-summarizer",
        help="Opt in to a local agent CLI that may access files or provider credentials.",
    ),
) -> None:
    selected = {value.strip() for value in only.split(",") if value.strip()} if only else None
    if from_stage not in STAGES:
        raise typer.BadParameter(f"Choose --from from: {', '.join(STAGES)}")
    chosen = selected if selected is not None else set(STAGES[STAGES.index(from_stage):])
    if chosen.intersection({"discover", "acquire"}):
        try:
            token = resolve_token()
        except GitHubError as exc:
            raise typer.BadParameter(str(exc)) from exc
    else:
        token = "unused"
    github = GitHubClient(token) if token != "unused" else None
    try:
        pipeline = AtlasPipeline(
            project_root(), github, summarizer, embedder, yes, allow_fallback,
            allow_agent_summarizer,
        )
        pipeline.run(from_stage, selected)
    finally:
        if github:
            github.close()


@app.command()
def doctor(
    summarizer: str = typer.Option("openai"),
    embedder: str = typer.Option("hosted"),
) -> None:
    try:
        github_authenticated = bool(resolve_token())
    except (GitHubError, OSError):
        github_authenticated = False

    def major_version(command: str) -> int | None:
        if not shutil.which(command):
            return None
        result = subprocess.run(
            [command, "--version"], capture_output=True, text=True, check=False,
        )
        digits = "".join(character if character.isdigit() else " " for character in result.stdout)
        first = digits.split()
        return int(first[0]) if result.returncode == 0 and first else None

    node_major = major_version("node")
    pnpm_major = major_version("pnpm")
    checks = {
        "GitHub authentication": github_authenticated,
        f"{summarizer} summarizer": (
            bool(os.environ.get("OPENAI_API_KEY"))
            if summarizer == "openai" else shutil.which(summarizer) is not None
        ),
        "OpenAI API key": bool(os.environ.get("OPENAI_API_KEY")) if embedder == "hosted" else True,
        "Node.js 24+": node_major is not None and node_major >= 24,
        "pnpm 12+": pnpm_major is not None and pnpm_major >= 12,
    }
    failed = False
    for label, status in checks.items():
        typer.echo(f"{'ok' if status else 'missing':7} {label}")
        failed |= not status
    if failed:
        raise typer.Exit(1)


@app.command()
def report(run_id: str | None = typer.Option(None, "--run")) -> None:
    root = project_root()
    reports = root / "reports"
    if run_id:
        path = reports / f"run-{run_id}.md"
    else:
        paths = sorted(reports.glob("run-*.md"), reverse=True) if reports.exists() else []
        if not paths:
            raise typer.BadParameter("No run reports are available.")
        path = paths[0]
    typer.echo(path.read_text(encoding="utf-8"))


@labels_app.command("show")
def labels_show() -> None:
    cache = Cache(project_root() / ".atlas" / "cache.db")
    rows = cache.rows(
        """SELECT c.cluster_id,c.label,c.gloss,c.member_count,
        EXISTS(SELECT 1 FROM label_overrides o WHERE o.signature=c.signature AND o.locked=1) locked
        FROM clusters c WHERE c.run_id=(SELECT run_id FROM runs ORDER BY started_at DESC LIMIT 1)
        ORDER BY c.cluster_id"""
    )
    for row in rows:
        typer.echo(f"{row['cluster_id']:>2}  {row['label']} ({row['member_count']}){' [locked]' if row['locked'] else ''}")
        if row["gloss"]:
            typer.echo(f"    {row['gloss']}")


@labels_app.command("set")
def labels_set(
    assignment: str = typer.Argument(..., help="ID=LABEL"),
    lock: bool = typer.Option(True, "--lock/--unlock"),
    gloss: str | None = typer.Option(None),
) -> None:
    if "=" not in assignment:
        raise typer.BadParameter("Expected ID=LABEL")
    raw_id, label = assignment.split("=", 1)
    cluster_id = int(raw_id)
    cache = Cache(project_root() / ".atlas" / "cache.db")
    rows = cache.rows(
        """SELECT signature,gloss FROM clusters
        WHERE run_id=(SELECT run_id FROM runs ORDER BY started_at DESC LIMIT 1) AND cluster_id=?""",
        (cluster_id,),
    )
    if not rows:
        raise typer.BadParameter(f"Cluster {cluster_id} does not exist in the latest run.")
    try:
        value = ClusterLabel(label=label.strip(), gloss=gloss or rows[0]["gloss"] or "")
    except ValidationError as exc:
        raise typer.BadParameter(str(exc)) from exc
    cache.execute(
        "INSERT OR REPLACE INTO label_overrides VALUES (?,?,?,?,?)",
        (rows[0]["signature"], value.label, value.gloss, bool(lock), now()),
    )
    typer.echo(f"Set cluster {cluster_id} to {value.label!r}{' and locked it' if lock else ' and unlocked it'}.")


@cache_app.command("stats")
def cache_stats() -> None:
    cache = Cache(project_root() / ".atlas" / "cache.db")
    for table in (
        "repos", "summaries", "summary_failures", "embeddings", "runs", "clusters",
        "label_overrides",
    ):
        count = cache.rows(f"SELECT COUNT(*) count FROM {table}")[0]["count"]
        typer.echo(f"{table:18} {count}")


@cache_app.command("invalidate")
def cache_invalidate(stage: str = typer.Argument(...)) -> None:
    if stage not in STAGES:
        raise typer.BadParameter(f"Choose one of: {', '.join(STAGES)}")
    cache = Cache(project_root() / ".atlas" / "cache.db")
    index = STAGES.index(stage)
    with cache.connect() as con:
        if index <= STAGES.index("summarize"):
            con.execute("DELETE FROM summaries")
            con.execute("DELETE FROM summary_failures")
        if index <= STAGES.index("embed"):
            con.execute("DELETE FROM embeddings")
        if index <= STAGES.index("cluster"):
            con.execute("DELETE FROM stage_cache WHERE stage IN ('cluster','label','project')")
        elif index <= STAGES.index("label"):
            con.execute("DELETE FROM stage_cache WHERE stage IN ('label','project')")
        elif index <= STAGES.index("project"):
            con.execute("DELETE FROM stage_cache WHERE stage='project'")
        if index <= STAGES.index("acquire"):
            con.execute("UPDATE repos SET acquire_key=NULL")
    typer.echo(f"Invalidated {stage} and downstream caches.")


@cache_app.command("vacuum")
def cache_vacuum() -> None:
    path = project_root() / ".atlas" / "cache.db"
    cache = Cache(path)
    cache.close()
    con = sqlite3.connect(path)
    try:
        con.execute("VACUUM")
    finally:
        con.close()
    typer.echo("Cache vacuum complete.")


@cache_app.command("prune")
def cache_prune(
    keep_runs: int = typer.Option(20, min=0, help="Completed runs to retain."),
    keep_stage_entries: int = typer.Option(
        20, min=0, help="Analysis stage-cache entries to retain per stage.",
    ),
) -> None:
    cache = Cache(project_root() / ".atlas" / "cache.db")
    try:
        removed = cache.prune(keep_runs, keep_stage_entries)
    finally:
        cache.close()
    typer.echo(
        f"Removed {removed['runs_removed']} runs and "
        f"{removed['stage_entries_removed']} stage-cache entries."
    )


if __name__ == "__main__":
    app()
