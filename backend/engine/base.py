"""
Interface every inference backend (Ollama today, the native llama.cpp
engine later) must satisfy so backend/ollama_client.py's callers can swap
between them behind an INFERENCE_BACKEND setting.

Mirrors the Ollama HTTP surface ollama_client.py actually uses:
  - /api/generate -> generate()
  - /api/embed    -> embed()
  - /api/tags     -> is_ready() / list_models()
  - install+pull  -> ensure_model()
"""

from __future__ import annotations

from typing import Protocol


class InferenceEngine(Protocol):
    def is_ready(self) -> bool:
        """True if the engine can serve requests right now."""
        ...

    def list_models(self) -> list[str]:
        """Model names currently available to this engine."""
        ...

    def ensure_model(self, model: str) -> bool:
        """Make `model` available (download/load as needed). Returns success."""
        ...

    def generate(self, prompt: str, model: str, **kwargs) -> str:
        """Single-shot text completion."""
        ...

    def embed(self, texts: list[str], model: str) -> list[list[float]]:
        """Batched embedding vectors, same order as `texts`."""
        ...
