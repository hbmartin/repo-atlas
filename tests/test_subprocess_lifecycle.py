import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from repo_atlas.models import RepoSummary
from repo_atlas.summarizers import (
    CodexPreflightCache,
    CodexSummarizer,
    Summarizer,
    SummarizerCancelledError,
    SummarizerConfigurationError,
)


def wait_until(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    pytest.fail('child process did not reach the expected state')


def fake_codex(tmp_path, monkeypatch, block_phase=None):
    executable = tmp_path / 'codex'
    marker, log, heartbeat = (tmp_path / name for name in ('started.json', 'calls.jsonl', 'heartbeat'))
    executable.write_text(f'''#!{sys.executable}
import json, os, subprocess, sys, time
from pathlib import Path
args = sys.argv[1:]
phase = 2 if '--help' in args else 1 if '--disable' in args else 0
with open({str(log)!r}, 'a') as handle:
    handle.write(json.dumps(args) + '\\n')
if phase == {block_phase!r}:
    child = subprocess.Popen([sys.executable, '-c', "import time; from pathlib import Path; p=Path({str(heartbeat)!r});\\nwhile True: p.write_text(str(time.monotonic())); time.sleep(.03)"])
    Path({str(marker)!r}).write_text(json.dumps({{'pid': os.getpid(), 'child': child.pid}}))
    time.sleep(60)
if '--help' in args:
    print('--sandbox --ephemeral --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check --color --disable --output-schema')
else:
    disabled = set(args[i+1] for i, arg in enumerate(args[:-1]) if arg == '--disable')
    for name in {sorted(CodexSummarizer.required_features)!r}:
        print(name, 'stable', str(name not in disabled).lower())
''')
    executable.chmod(0o755)
    monkeypatch.setenv('PATH', str(tmp_path) + os.pathsep + os.defpath)
    return marker, log, heartbeat


@pytest.mark.skipif(os.name != 'posix', reason='POSIX process group behavior')
@pytest.mark.parametrize('phase', [0, 1, 2])
def test_cancel_kills_and_reaps_every_preflight_phase(tmp_path, monkeypatch, phase):
    marker, log, heartbeat = fake_codex(tmp_path, monkeypatch, block_phase=phase)
    summarizer = CodexSummarizer()
    killed = []
    killpg = os.killpg
    def record_kill(pid, signal):
        killed.append(pid)
        return killpg(pid, signal)
    monkeypatch.setattr(os, 'killpg', record_kill)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(summarizer.invoke_with_repairs, 'untrusted prompt', RepoSummary)
        try:
            wait_until(lambda: marker.exists() and heartbeat.exists())
            started = json.loads(marker.read_text())
            start = time.monotonic()
            summarizer.cancel()
            with pytest.raises(SummarizerCancelledError):
                future.result(timeout=2)
            assert time.monotonic() - start < 2
            assert killed == [started['pid']]
            assert not summarizer._active_processes
            with pytest.raises(ChildProcessError):
                os.waitpid(started['pid'], os.WNOHANG)
            stamp = heartbeat.stat().st_mtime_ns
            time.sleep(0.12)
            assert heartbeat.stat().st_mtime_ns == stamp
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            assert len(calls) == phase + 1
            assert not any('untrusted prompt' in str(call) for call in calls)
            assert all(call[0] != 'exec' or '--help' in call for call in calls)
            assert not summarizer._preflight_cache.results
            assert not summarizer._preflight_cache.failures
        finally:
            summarizer.cancel()


@pytest.mark.skipif(os.name != 'posix', reason='executable script fixture')
def test_concurrent_adapters_share_one_successful_preflight(tmp_path, monkeypatch):
    _, log, _ = fake_codex(tmp_path, monkeypatch)
    cache = CodexPreflightCache()
    providers = [CodexSummarizer(preflight_cache=cache) for _ in range(4)]
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda provider: provider._preflight(), providers))
    assert all(result == results[0] for result in results)
    assert len(log.read_text().splitlines()) == 3
    assert all(not provider._active_processes for provider in providers)


def test_cancelled_cache_waiter_does_not_wait_for_other_adapter():
    cache = CodexPreflightCache()
    provider = CodexSummarizer(preflight_cache=cache)
    # Exercise the waiting path after executable discovery, without a local Codex dependency.
    from unittest.mock import patch
    held_lock = cache.lock
    waiting = Event()
    class ObservedLock:
        def acquire(self, **kwargs):
            waiting.set()
            return held_lock.acquire(**kwargs)
        def release(self):
            held_lock.release()
    held_lock.acquire()
    cache.lock = ObservedLock()
    try:
        with (
            patch('repo_atlas.summarizers.shutil.which', return_value=sys.executable),
            ThreadPoolExecutor(max_workers=1) as executor,
        ):
            future = executor.submit(provider._preflight)
            try:
                assert waiting.wait(timeout=2)
            finally:
                provider.cancel()
            with pytest.raises(SummarizerCancelledError):
                future.result(timeout=1)
    finally:
        held_lock.release()


@pytest.mark.skipif(os.name != 'posix', reason='POSIX process group behavior')
def test_probe_timeout_uses_tracked_runner_and_cleans_descendants(tmp_path, monkeypatch):
    marker, log, heartbeat = fake_codex(tmp_path, monkeypatch, block_phase=0)
    provider = CodexSummarizer()
    original = Summarizer._run_process
    def shorter_timeout(self, command, **kwargs):
        kwargs['timeout'] = 1
        return original(self, command, **kwargs)
    monkeypatch.setattr(Summarizer, '_run_process', shorter_timeout)
    with pytest.raises(SummarizerConfigurationError, match='after 3 attempts.*timed out'):
        provider._preflight()
    assert len(log.read_text().splitlines()) == 3
    assert not provider._active_processes and not provider._preflight_cache.results
    assert len(provider._preflight_cache.failures) == 1
    started = json.loads(marker.read_text())
    with pytest.raises(ChildProcessError):
        os.waitpid(started['pid'], os.WNOHANG)
    stamp = heartbeat.stat().st_mtime_ns
    time.sleep(.12)
    assert heartbeat.stat().st_mtime_ns == stamp
