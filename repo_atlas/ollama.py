"""Loopback-only Ollama endpoints for offline inference."""

import os

from .errors import AtlasError


def ollama_url(endpoint: str) -> str:
    port = os.environ.get("ATLAS_OLLAMA_PORT", "11434")
    if not port.isascii() or not port.isdecimal() or len(port) > 5 or not 1 <= int(port) <= 65535:
        raise AtlasError("ATLAS_OLLAMA_PORT must be a port from 1 to 65535.")
    return f"http://127.0.0.1:{port}/api/{endpoint}"
