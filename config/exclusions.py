"""Versioned file-count exclusions used by the acquisition stage."""

DIRECTORY_PREFIXES = (
    "node_modules/", "vendor/", "third_party/", ".git/", "dist/", "build/",
    "out/", "target/", ".next/", ".venv/", "venv/", "__pycache__/", "Pods/",
    "Carthage/", "bower_components/", ".yarn/", "coverage/", ".terraform/",
)

EXTENSIONS = (
    ".lock", ".map", ".min.js", ".min.css", ".pyc", ".class", ".o", ".a",
    ".so", ".dylib",
)

NAMED_FILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock",
    "Cargo.lock", "Gemfile.lock", "composer.lock", "go.sum",
}

GENERATED_PATTERNS = ("*.pb.go", "*_pb2.py", "*.generated.*", "*.g.dart")

