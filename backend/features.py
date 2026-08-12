"""Feature flags — which capabilities this build exposes to the user.

The free tier ships with no local generative LLM. Summaries, titles and
continuation prompts are all built deterministically (see
backend/extractive_summary.py), and the only local model that remains is the
embedding model, which powers semantic search and the extension's query box.

That leaves RAG chat ("Ask Your Vault") as a paid capability: it needs a real
generative model, which for us means a cloud provider the user pays for. The
code for it is deliberately kept in the tree rather than deleted — flipping a
flag turns it back on for a premium build, with no feature to rebuild.

Resolution order, most specific first:

    CONTEXTVOLT_ENABLE_ASK_VAULT=1      env var, per-process
    config.json {"features": {...}}     per-install
    _DEFAULTS                           this file

Read at call time, never cached, so toggling a flag takes effect without a
restart — the same contract as get_inference_backend().
"""

from __future__ import annotations

import json
import os

from backend.paths import config_path as _config_path

# Every flag the app knows about, with its free-tier value.
_DEFAULTS: dict[str, bool] = {
    # RAG chat over the saved vault. Off: needs a generative model, which the
    # free tier no longer has locally.
    "ask_vault": False,
    # Local generative inference of any kind (titles, summaries, chat). Off:
    # nothing in the free tier calls engine.generate() any more. Embeddings are
    # NOT covered by this flag — they're a separate, non-generative model that
    # stays on in every tier.
    "local_llm": False,
}

_ENV_PREFIX = "CONTEXTVOLT_ENABLE_"


def _truthy(value: str) -> bool:
    return value.strip().lower() in ("1", "true", "yes", "on")


def is_enabled(name: str) -> bool:
    """True if feature `name` is available in this build."""
    default = _DEFAULTS.get(name, False)

    env = os.getenv(_ENV_PREFIX + name.upper())
    if env is not None and env.strip():
        return _truthy(env)

    try:
        with open(str(_config_path()), "r", encoding="utf-8") as f:
            cfg = json.load(f)
        feats = cfg.get("features")
        if isinstance(feats, dict) and name in feats:
            return bool(feats[name])
    except Exception:
        # A missing or malformed config must never disable the app — fall
        # through to the built-in default.
        pass

    return default


def all_features() -> dict[str, bool]:
    """Every flag and its resolved value — what /api/features serves the UI."""
    return {name: is_enabled(name) for name in _DEFAULTS}
