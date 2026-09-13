from repo_atlas.content import (
    clean_readme,
    excluded_path,
    tracked_file_count,
    tree_digest,
)


def test_readme_cleaning_removes_boilerplate_and_truncates_code():
    code = "\n".join(f"line {index}" for index in range(30))
    source = f"""![badge](https://img.shields.io/x)\n# Tool\nDoes useful work.\n```py\n{code}\n```\n## License\nMIT text\n## Notes\nKept.\n"""
    cleaned = clean_readme(source)
    assert "shields.io" not in cleaned
    assert "MIT text" not in cleaned
    assert "line 19" in cleaned
    assert "line 20" not in cleaned
    assert "Kept." in cleaned


def test_readme_headings_and_badges_inside_fences_are_preserved_as_code():
    source = """# Tool\n```md\n## License\n![badge](https://img.shields.io/x)\n```\n## Notes\nKept.\n"""
    cleaned = clean_readme(source)
    assert "## License" in cleaned
    assert "shields.io" in cleaned
    assert "Kept." in cleaned


def test_readme_fence_closes_only_with_matching_marker_and_length():
    source = """# Tool
````md
```
~~~
## License
![badge](https://img.shields.io/x)
````
## Notes
Kept.
"""
    cleaned = clean_readme(source)
    assert "```" in cleaned
    assert "~~~" in cleaned
    assert "## License" in cleaned
    assert "shields.io" in cleaned
    assert "Kept." in cleaned


def test_file_exclusions_cover_dependencies_and_generated_files():
    assert excluded_path("node_modules/pkg/index.js")
    assert excluded_path("src/schema.generated.ts")
    assert excluded_path("pnpm-lock.yaml")
    assert excluded_path("NODE_MODULES/pkg/index.js")
    assert not excluded_path(".../src/main.ts")
    assert not excluded_path("src/main.ts")
    tree = [
        {"type": "blob", "path": "src/main.ts"},
        {"type": "blob", "path": "dist/main.js"},
        {"type": "tree", "path": "src"},
    ]
    assert tracked_file_count(tree) == 1


def test_tree_digest_is_stable_and_structural():
    tree = [
        {"type": "blob", "path": "package.json"},
        {"type": "blob", "path": "src/index.ts"},
        {"type": "blob", "path": "docs/readme.md"},
    ]
    assert tree_digest(list(reversed(tree))) == tree_digest(tree)
    assert tree_digest(tree)["notable_files"]["package.json"] == 1
