import importlib.util
import io
import json
import sys
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "update_linguist_colors.py"
SPEC = importlib.util.spec_from_file_location("update_linguist_colors", SCRIPT)
assert SPEC and SPEC.loader
update_linguist_colors = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(update_linguist_colors)


def test_default_commit_follows_last_explicit_refresh(tmp_path, monkeypatch):
    old_commit = "a" * 40
    new_commit = "b" * 40
    output = tmp_path / "linguist_colors.json"
    notice = tmp_path / "THIRD_PARTY_NOTICES.md"
    output.write_text(json.dumps({"source_commit": old_commit, "colors": {"Python": "#000000"}}))
    notice.write_text(f"https://github.com/github-linguist/linguist/blob/{old_commit}/lib/linguist/languages.yml")
    monkeypatch.setattr(update_linguist_colors, "OUTPUT", output)
    monkeypatch.setattr(update_linguist_colors, "NOTICE", notice)
    urls = []

    def fake_urlopen(url, timeout):
        assert timeout == 30
        urls.append(url)
        return io.BytesIO(b"Python:\n  color: '#3572A5'\n")

    monkeypatch.setattr(update_linguist_colors, "urlopen", fake_urlopen)
    monkeypatch.setattr(sys, "argv", ["update_linguist_colors.py", "--commit", new_commit])
    update_linguist_colors.main()
    monkeypatch.setattr(sys, "argv", ["update_linguist_colors.py"])
    update_linguist_colors.main()

    assert len(urls) == 2
    assert all(f"/{new_commit}/" in url for url in urls)
    assert json.loads(output.read_text())["source_commit"] == new_commit
    assert f"/{new_commit}/" in notice.read_text()
