"""
ContextVolt — LLM Router.

Thin routing layer that reads config.json and dispatches generation calls
to either ollama_client (local) or cloud_client (OpenAI/Anthropic/Google).

All summarization and RAG generation flows go through this router.
Embedding always stays local (Ollama) — see implementation_plan.md.
"""

import json
import logging
from typing import Iterator

_log = logging.getLogger("contextvolt")

from backend.paths import config_path as _config_path
_CFG_PATH = str(_config_path())


def _read_config() -> dict:
    """Read config.json (same helper as main.py — duplicated to avoid circular import)."""
    try:
        with open(_CFG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


# ─────────────────────────────────────────────────────────────────────
# Provider resolution
# ─────────────────────────────────────────────────────────────────────

def get_active_provider() -> dict:
    """Return the active LLM provider config.

    Returns:
        {
            "provider": "ollama" | "openai" | "anthropic" | "google",
            "model": str,
            "api_key": str | None,
            "is_cloud": bool,
        }
    """
    cfg = _read_config()
    provider = cfg.get("provider", "ollama")

    if provider == "ollama":
        from backend.ollama_client import _get_default_model
        return {
            "provider": "ollama",
            "model": _get_default_model(),
            "api_key": None,
            "is_cloud": False,
        }

    # Cloud provider
    cloud_keys = cfg.get("cloud_keys", {})
    cloud_models = cfg.get("cloud_models", {})
    api_key = cloud_keys.get(provider, "")
    model = cloud_models.get(provider, "")

    # Fall back to Ollama if no API key is configured
    if not api_key:
        _log.warning("Provider %s selected but no API key — falling back to Ollama", provider)
        from backend.ollama_client import _get_default_model
        return {
            "provider": "ollama",
            "model": _get_default_model(),
            "api_key": None,
            "is_cloud": False,
        }

    return {
        "provider": provider,
        "model": model,
        "api_key": api_key,
        "is_cloud": True,
    }


def is_cloud_active() -> bool:
    """Quick check — is the active provider a cloud provider?"""
    return get_active_provider()["is_cloud"]


# ─────────────────────────────────────────────────────────────────────
# Unified generation
# ─────────────────────────────────────────────────────────────────────

def generate(prompt: str, temperature: float = 0.2, max_tokens: int = 2000,
             timeout: int = 180) -> dict:
    """Generate a completion using the active provider.

    Returns:
        {
            "response": str,
            "usage": {"input_tokens": int, "output_tokens": int} | None,
            "cost": float | None,
            "provider": str,
            "model": str,
        }
    """
    active = get_active_provider()

    if active["is_cloud"]:
        from backend.cloud_client import cloud_generate
        result = cloud_generate(
            prompt=prompt,
            provider=active["provider"],
            model=active["model"],
            api_key=active["api_key"],
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        )
        result["provider"] = active["provider"]
        result["model"] = active["model"]
        return result
    else:
        # Ollama path — use existing _call_generate
        from backend.ollama_client import _call_generate, _NUM_CTX
        r = _call_generate(
            active["model"],
            prompt,
            {"temperature": temperature, "num_predict": max_tokens, "num_ctx": _NUM_CTX},
            timeout=timeout,
        )
        r.raise_for_status()
        body = r.json()
        return {
            "response": body.get("response", ""),
            "usage": None,
            "cost": None,
            "provider": "ollama",
            "model": active["model"],
        }


def generate_stream(prompt: str, temperature: float = 0.2, max_tokens: int = 2000,
                    timeout: int = 180) -> Iterator[dict]:
    """Stream a completion using the active provider.

    Yields:
        {"token": str} during generation
        {"done": True, "usage": {...}, "cost": float, "provider": str, "model": str} at the end
    """
    active = get_active_provider()

    if active["is_cloud"]:
        from backend.cloud_client import cloud_generate_stream
        for event in cloud_generate_stream(
            prompt=prompt,
            provider=active["provider"],
            model=active["model"],
            api_key=active["api_key"],
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        ):
            if event.get("done"):
                event["provider"] = active["provider"]
                event["model"] = active["model"]
            yield event
    else:
        # Ollama streaming
        import requests as _req
        from backend.ollama_client import OLLAMA_BASE, _NUM_CTX
        try:
            r = _req.post(
                f"{OLLAMA_BASE}/api/generate",
                json={
                    "model": active["model"],
                    "prompt": prompt,
                    "stream": True,
                    "options": {"num_ctx": min(_NUM_CTX, 16384), "temperature": temperature},
                },
                stream=True,
                timeout=timeout,
            )
            r.raise_for_status()
            for line in r.iter_lines():
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    token = data.get("response", "")
                    if token:
                        yield {"token": token}
                    if data.get("done"):
                        yield {
                            "done": True,
                            "usage": None,
                            "cost": None,
                            "provider": "ollama",
                            "model": active["model"],
                        }
                        break
                except json.JSONDecodeError:
                    continue
        except Exception as e:
            _log.error("Ollama stream error: %s", e)
            yield {"error": str(e)}


# ─────────────────────────────────────────────────────────────────────
# Summarization (cloud-aware wrapper)
# ─────────────────────────────────────────────────────────────────────

def summarize_conversation(text: str, important_snippets: list[str] | None = None) -> dict:
    """Summarize using the active provider.

    For cloud providers: reuses the same EXTRACT/SYNTHESIZE prompts but calls
    the cloud API instead of Ollama. This gives dramatically better results.

    For Ollama: delegates to the existing ollama_client.summarize_conversation.
    """
    active = get_active_provider()

    if not active["is_cloud"]:
        # Use existing Ollama summarization (map-reduce pipeline)
        from backend.ollama_client import summarize_conversation as _ollama_summarize
        return _ollama_summarize(text, important_snippets=important_snippets)

    # Cloud path — simplified single-call summarization
    # Cloud models are smart enough that we don't need the map-reduce pipeline
    # for most conversations. Use it only for very long texts.
    from backend.ollama_client import (
        EXTRACT_PROMPT, SYNTHESIZE_PROMPT, _parse_text_summary,
        _conversation_anchors, _split_by_messages, _empty_summary,
        _CHAR_LIMIT, _CHUNK_LIMIT,
    )

    first_user, last_asst = _conversation_anchors(text)

    # Cloud models have much larger context windows — try single-call first
    cloud_char_limit = 100_000  # ~25k tokens — well within GPT-4o / Claude / Gemini limits

    if len(text) <= cloud_char_limit:
        # Single-call synthesis — cloud models handle this beautifully
        prompt = SYNTHESIZE_PROMPT.format(
            first_user=first_user[:800] or "(not available)",
            last_asst=last_asst[:800] or "(not available)",
            merged_facts=text[:cloud_char_limit],
        )
        try:
            result = generate(prompt, temperature=0.2, max_tokens=2000, timeout=180)
            response_text = result.get("response", "")
            if response_text.strip():
                return _parse_text_summary(response_text)
        except Exception as e:
            _log.warning("Cloud single-call summarize failed: %s — falling back to map-reduce", e)

    # Long conversation — use map-reduce even with cloud
    from backend.ollama_client import _parse_messages, _anchor_text

    messages = _parse_messages(text)
    anchor_count = 2
    opening, closing = _anchor_text(messages, anchor_count)
    middle_messages = messages[anchor_count:-anchor_count] if len(messages) > anchor_count * 2 else []
    middle_text = '\n\n'.join(middle_messages)
    middle_chunks = _split_by_messages(middle_text, chunk_char_limit=_CHUNK_LIMIT, overlap=1) if middle_text else []

    all_extractions: list[str] = []

    # Extract from each section
    for idx, chunk_text in enumerate([opening] + middle_chunks + ([closing] if closing else [])):
        if idx == 0:
            label = "OPENING"
        elif closing and idx == len(middle_chunks) + 1:
            label = "CLOSING — most recent, highest priority"
        else:
            label = f"SECTION {idx}"

        extract_prompt = EXTRACT_PROMPT.format(conversation=chunk_text[:_CHUNK_LIMIT])
        try:
            result = generate(extract_prompt, temperature=0.1, max_tokens=800, timeout=120)
            extracted = result.get("response", "").strip()
            if extracted:
                all_extractions.append(f"[{label}]\n{extracted}")
        except Exception as e:
            _log.warning("Cloud extract failed for %s: %s", label, e)

    merged_facts = "\n\n".join(all_extractions) if all_extractions else text[:cloud_char_limit]

    # Final synthesis
    synth_prompt = SYNTHESIZE_PROMPT.format(
        first_user=first_user[:800] or "(not available)",
        last_asst=last_asst[:800] or "(not available)",
        merged_facts=merged_facts[:cloud_char_limit],
    )
    try:
        result = generate(synth_prompt, temperature=0.2, max_tokens=2000, timeout=180)
        response_text = result.get("response", "")
        if response_text.strip():
            return _parse_text_summary(response_text)
    except Exception as e:
        _log.warning("Cloud synthesize failed: %s", e)

    return _empty_summary()


def summarize_conversation_streaming(text: str, important_snippets: list[str] | None = None):
    """Streaming summarization with progress events.

    For cloud providers, uses the same flow but reports progress.
    For Ollama, delegates to existing streaming function.
    """
    active = get_active_provider()

    if not active["is_cloud"]:
        from backend.ollama_client import summarize_conversation_streaming as _ollama_stream
        yield from _ollama_stream(text, important_snippets=important_snippets)
        return

    # Cloud streaming — simplified progress reporting
    from backend.ollama_client import (
        SYNTHESIZE_PROMPT, _parse_text_summary,
        _conversation_anchors, _empty_summary,
    )

    first_user, last_asst = _conversation_anchors(text)
    cloud_char_limit = 100_000

    total_steps = 1
    yield {"step": "Summarizing with cloud AI…", "done": 0, "total": total_steps}

    prompt = SYNTHESIZE_PROMPT.format(
        first_user=first_user[:800] or "(not available)",
        last_asst=last_asst[:800] or "(not available)",
        merged_facts=text[:cloud_char_limit],
    )

    try:
        result = generate(prompt, temperature=0.2, max_tokens=2000, timeout=180)
        response_text = result.get("response", "")
        if response_text.strip():
            summary = _parse_text_summary(response_text)
            summary["_usage"] = result.get("usage")
            summary["_cost"] = result.get("cost")
            yield {"step": "Done", "done": 1, "total": total_steps, "result": summary}
        else:
            yield {"step": "Done", "done": 1, "total": total_steps, "result": _empty_summary()}
    except Exception as e:
        _log.error("Cloud streaming summarize failed: %s", e)
        yield {"error": str(e)}
