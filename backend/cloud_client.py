"""
ContextVolt — Cloud LLM provider adapters.

Supports OpenAI, Anthropic, and Google Gemini via their REST APIs.
Uses only the `requests` library — zero new dependencies.
"""

import json
import logging
import os
import time
import requests
from typing import Iterator

_log = logging.getLogger("contextvolt")

# ─────────────────────────────────────────────────────────────────────
# Provider registry
# ─────────────────────────────────────────────────────────────────────

PROVIDERS: dict[str, dict] = {
    "openai": {
        "label": "OpenAI",
        "api_base": "https://api.openai.com/v1",
        "models": [
            {"id": "gpt-4o-mini", "label": "GPT-4o Mini", "desc": "Fast & affordable — great for summaries", "recommended": True,
             "input_cost": 0.15, "output_cost": 0.60},
            {"id": "gpt-4o", "label": "GPT-4o", "desc": "Best quality — vision + reasoning", "recommended": False,
             "input_cost": 2.50, "output_cost": 10.00},
            {"id": "gpt-4.1-nano", "label": "GPT-4.1 Nano", "desc": "Cheapest — fast tasks only", "recommended": False,
             "input_cost": 0.10, "output_cost": 0.40},
            {"id": "gpt-4.1-mini", "label": "GPT-4.1 Mini", "desc": "Balanced — good for most tasks", "recommended": False,
             "input_cost": 0.40, "output_cost": 1.60},
        ],
        "key_prefix": "sk-",
        "key_hint": "Starts with sk-...",
        "docs_url": "https://platform.openai.com/api-keys",
    },
    "anthropic": {
        "label": "Anthropic",
        "api_base": "https://api.anthropic.com/v1",
        "models": [
            {"id": "claude-haiku-4-20250514", "label": "Claude Haiku", "desc": "Fastest & cheapest Claude", "recommended": True,
             "input_cost": 0.80, "output_cost": 4.00},
            {"id": "claude-sonnet-4-20250514", "label": "Claude Sonnet 4", "desc": "Best balance of speed & intelligence", "recommended": False,
             "input_cost": 3.00, "output_cost": 15.00},
            {"id": "claude-opus-4-20250514", "label": "Claude Opus 4", "desc": "Most capable — complex reasoning", "recommended": False,
             "input_cost": 15.00, "output_cost": 75.00},
        ],
        "key_prefix": "sk-ant-",
        "key_hint": "Starts with sk-ant-...",
        "docs_url": "https://console.anthropic.com/settings/keys",
    },
    "google": {
        "label": "Google Gemini",
        "api_base": "https://generativelanguage.googleapis.com/v1beta",
        "models": [
            {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash", "desc": "Fast, free tier available", "recommended": True,
             "input_cost": 0.15, "output_cost": 0.60},
            {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "desc": "Most capable Gemini", "recommended": False,
             "input_cost": 1.25, "output_cost": 10.00},
            {"id": "gemini-2.0-flash", "label": "Gemini 2.0 Flash", "desc": "Previous gen — still very capable", "recommended": False,
             "input_cost": 0.10, "output_cost": 0.40},
        ],
        "key_prefix": "AI",
        "key_hint": "Starts with AI...",
        "docs_url": "https://aistudio.google.com/apikey",
    },
}


# ─────────────────────────────────────────────────────────────────────
# Token estimation (rough, for cost display)
# ─────────────────────────────────────────────────────────────────────

def estimate_tokens(text: str) -> int:
    """Rough token count — ~4 chars per token for English text."""
    return max(1, len(text) // 4)


def estimate_cost(provider: str, model: str, input_tokens: int, output_tokens: int) -> float | None:
    """Estimate cost in USD for a generation call. Returns None if model not found."""
    prov = PROVIDERS.get(provider)
    if not prov:
        return None
    for m in prov["models"]:
        if m["id"] == model:
            # Costs are per 1M tokens
            cost = (input_tokens * m["input_cost"] / 1_000_000) + (output_tokens * m["output_cost"] / 1_000_000)
            return round(cost, 6)
    return None


# ─────────────────────────────────────────────────────────────────────
# OpenAI adapter
# ─────────────────────────────────────────────────────────────────────

def _openai_generate(prompt: str, model: str, api_key: str,
                     temperature: float = 0.2, max_tokens: int = 2000,
                     timeout: int = 180) -> dict:
    """Call OpenAI Chat Completions API. Returns {response, usage}."""
    r = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": max_tokens,
        },
        timeout=timeout,
    )
    r.raise_for_status()
    data = r.json()
    choice = data["choices"][0]
    usage = data.get("usage", {})
    return {
        "response": choice["message"]["content"],
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }


def _openai_generate_stream(prompt: str, model: str, api_key: str,
                            temperature: float = 0.2, max_tokens: int = 2000,
                            timeout: int = 180) -> Iterator[dict]:
    """Stream OpenAI Chat Completions. Yields {token} dicts, final {done, usage}."""
    r = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
            "stream_options": {"include_usage": True},
        },
        stream=True,
        timeout=timeout,
    )
    r.raise_for_status()
    output_tokens = 0
    input_tokens = 0
    for line in r.iter_lines():
        if not line:
            continue
        text = line.decode("utf-8", errors="replace")
        if not text.startswith("data: "):
            continue
        payload = text[6:]
        if payload.strip() == "[DONE]":
            break
        try:
            chunk = json.loads(payload)
            # Check for usage in the final chunk
            if chunk.get("usage"):
                input_tokens = chunk["usage"].get("prompt_tokens", 0)
                output_tokens = chunk["usage"].get("completion_tokens", 0)
            delta = chunk.get("choices", [{}])[0].get("delta", {})
            token = delta.get("content", "")
            if token:
                yield {"token": token}
        except (json.JSONDecodeError, IndexError, KeyError):
            continue
    yield {"done": True, "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens}}


def _openai_validate(api_key: str) -> dict:
    """Validate an OpenAI key by listing models."""
    try:
        r = requests.get(
            "https://api.openai.com/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10,
        )
        if r.status_code == 401:
            return {"valid": False, "error": "Invalid API key"}
        r.raise_for_status()
        models = [m["id"] for m in r.json().get("data", []) if "gpt" in m["id"]]
        return {"valid": True, "models": models[:10]}
    except requests.RequestException as e:
        return {"valid": False, "error": str(e)}


# ─────────────────────────────────────────────────────────────────────
# Anthropic adapter
# ─────────────────────────────────────────────────────────────────────

_ANTHROPIC_API_VERSION = "2023-06-01"


def _anthropic_generate(prompt: str, model: str, api_key: str,
                        temperature: float = 0.2, max_tokens: int = 2000,
                        timeout: int = 180) -> dict:
    """Call Anthropic Messages API. Returns {response, usage}."""
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": _ANTHROPIC_API_VERSION,
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
        },
        timeout=timeout,
    )
    r.raise_for_status()
    data = r.json()
    content = "".join(
        block.get("text", "") for block in data.get("content", [])
        if block.get("type") == "text"
    )
    usage = data.get("usage", {})
    return {
        "response": content,
        "usage": {
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
        },
    }


def _anthropic_generate_stream(prompt: str, model: str, api_key: str,
                               temperature: float = 0.2, max_tokens: int = 2000,
                               timeout: int = 180) -> Iterator[dict]:
    """Stream Anthropic Messages. Yields {token} dicts, final {done, usage}."""
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": _ANTHROPIC_API_VERSION,
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "stream": True,
        },
        stream=True,
        timeout=timeout,
    )
    r.raise_for_status()
    input_tokens = 0
    output_tokens = 0
    for line in r.iter_lines():
        if not line:
            continue
        text = line.decode("utf-8", errors="replace")
        if not text.startswith("data: "):
            continue
        payload = text[6:]
        try:
            event = json.loads(payload)
            etype = event.get("type", "")
            if etype == "content_block_delta":
                delta = event.get("delta", {})
                token = delta.get("text", "")
                if token:
                    yield {"token": token}
            elif etype == "message_start":
                usage = event.get("message", {}).get("usage", {})
                input_tokens = usage.get("input_tokens", 0)
            elif etype == "message_delta":
                usage = event.get("usage", {})
                output_tokens = usage.get("output_tokens", 0)
        except (json.JSONDecodeError, KeyError):
            continue
    yield {"done": True, "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens}}


def _anthropic_validate(api_key: str) -> dict:
    """Validate an Anthropic key by making a minimal completion."""
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": _ANTHROPIC_API_VERSION,
                "Content-Type": "application/json",
            },
            json={
                "model": "claude-haiku-4-20250514",
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}],
            },
            timeout=15,
        )
        if r.status_code == 401:
            return {"valid": False, "error": "Invalid API key"}
        if r.status_code == 403:
            return {"valid": False, "error": "API key does not have permission"}
        r.raise_for_status()
        return {"valid": True, "models": [m["id"] for m in PROVIDERS["anthropic"]["models"]]}
    except requests.RequestException as e:
        return {"valid": False, "error": str(e)}


# ─────────────────────────────────────────────────────────────────────
# Google Gemini adapter
# ─────────────────────────────────────────────────────────────────────

_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"


def _gemini_generate(prompt: str, model: str, api_key: str,
                     temperature: float = 0.2, max_tokens: int = 2000,
                     timeout: int = 180) -> dict:
    """Call Google Gemini generateContent API. Returns {response, usage}."""
    r = requests.post(
        f"{_GEMINI_BASE}/models/{model}:generateContent",
        params={"key": api_key},
        headers={"Content-Type": "application/json"},
        json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_tokens,
            },
        },
        timeout=timeout,
    )
    r.raise_for_status()
    data = r.json()
    # Extract text from response
    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    response_text = "".join(p.get("text", "") for p in parts)
    # Usage metadata
    usage_meta = data.get("usageMetadata", {})
    return {
        "response": response_text,
        "usage": {
            "input_tokens": usage_meta.get("promptTokenCount", 0),
            "output_tokens": usage_meta.get("candidatesTokenCount", 0),
        },
    }


def _gemini_generate_stream(prompt: str, model: str, api_key: str,
                            temperature: float = 0.2, max_tokens: int = 2000,
                            timeout: int = 180) -> Iterator[dict]:
    """Stream Gemini generateContent. Yields {token} dicts, final {done, usage}."""
    r = requests.post(
        f"{_GEMINI_BASE}/models/{model}:streamGenerateContent",
        params={"key": api_key, "alt": "sse"},
        headers={"Content-Type": "application/json"},
        json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_tokens,
            },
        },
        stream=True,
        timeout=timeout,
    )
    r.raise_for_status()
    input_tokens = 0
    output_tokens = 0
    for line in r.iter_lines():
        if not line:
            continue
        text = line.decode("utf-8", errors="replace")
        if not text.startswith("data: "):
            continue
        payload = text[6:]
        try:
            chunk = json.loads(payload)
            parts = chunk.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            for p in parts:
                token = p.get("text", "")
                if token:
                    yield {"token": token}
            # Usage in final chunk
            usage_meta = chunk.get("usageMetadata", {})
            if usage_meta.get("promptTokenCount"):
                input_tokens = usage_meta["promptTokenCount"]
            if usage_meta.get("candidatesTokenCount"):
                output_tokens = usage_meta["candidatesTokenCount"]
        except (json.JSONDecodeError, IndexError, KeyError):
            continue
    yield {"done": True, "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens}}


def _gemini_validate(api_key: str) -> dict:
    """Validate a Google Gemini key by listing models."""
    try:
        r = requests.get(
            f"{_GEMINI_BASE}/models",
            params={"key": api_key},
            timeout=10,
        )
        if r.status_code in (400, 401, 403):
            return {"valid": False, "error": "Invalid API key"}
        r.raise_for_status()
        models = [
            m["name"].replace("models/", "")
            for m in r.json().get("models", [])
            if "gemini" in m.get("name", "").lower()
        ]
        return {"valid": True, "models": models[:10]}
    except requests.RequestException as e:
        return {"valid": False, "error": str(e)}


# ─────────────────────────────────────────────────────────────────────
# Unified dispatch
# ─────────────────────────────────────────────────────────────────────

def cloud_generate(prompt: str, provider: str, model: str, api_key: str,
                   temperature: float = 0.2, max_tokens: int = 2000,
                   timeout: int = 180) -> dict:
    """Generate a completion via a cloud provider. Returns {response, usage}."""
    _log.debug("cloud_generate provider=%s model=%s prompt_len=%d", provider, model, len(prompt))
    start = time.time()
    try:
        if provider == "openai":
            result = _openai_generate(prompt, model, api_key, temperature, max_tokens, timeout)
        elif provider == "anthropic":
            result = _anthropic_generate(prompt, model, api_key, temperature, max_tokens, timeout)
        elif provider == "google":
            result = _gemini_generate(prompt, model, api_key, temperature, max_tokens, timeout)
        else:
            raise ValueError(f"Unknown provider: {provider}")
        elapsed = round(time.time() - start, 2)
        _log.debug("cloud_generate done in %ss, tokens: %s", elapsed, result.get("usage"))
        # Attach cost estimate
        usage = result.get("usage", {})
        result["cost"] = estimate_cost(
            provider, model,
            usage.get("input_tokens", 0),
            usage.get("output_tokens", 0),
        )
        return result
    except requests.HTTPError as e:
        _log.error("cloud_generate HTTP error: %s %s", e.response.status_code, e.response.text[:300])
        raise
    except Exception as e:
        _log.error("cloud_generate error: %s", e)
        raise


def cloud_generate_stream(prompt: str, provider: str, model: str, api_key: str,
                          temperature: float = 0.2, max_tokens: int = 2000,
                          timeout: int = 180) -> Iterator[dict]:
    """Stream a completion via a cloud provider. Yields {token} and final {done, usage, cost}."""
    _log.debug("cloud_generate_stream provider=%s model=%s", provider, model)
    try:
        if provider == "openai":
            gen = _openai_generate_stream(prompt, model, api_key, temperature, max_tokens, timeout)
        elif provider == "anthropic":
            gen = _anthropic_generate_stream(prompt, model, api_key, temperature, max_tokens, timeout)
        elif provider == "google":
            gen = _gemini_generate_stream(prompt, model, api_key, temperature, max_tokens, timeout)
        else:
            raise ValueError(f"Unknown provider: {provider}")
        for event in gen:
            if event.get("done"):
                # Attach cost estimate to final event
                usage = event.get("usage", {})
                event["cost"] = estimate_cost(
                    provider, model,
                    usage.get("input_tokens", 0),
                    usage.get("output_tokens", 0),
                )
            yield event
    except requests.HTTPError as e:
        _log.error("cloud_generate_stream HTTP error: %s", e)
        yield {"error": f"API error: {e.response.status_code} — {e.response.text[:200]}"}
    except Exception as e:
        _log.error("cloud_generate_stream error: %s", e)
        yield {"error": str(e)}


def cloud_validate_key(provider: str, api_key: str) -> dict:
    """Validate an API key for a provider. Returns {valid, error?, models?}."""
    if provider == "openai":
        return _openai_validate(api_key)
    elif provider == "anthropic":
        return _anthropic_validate(api_key)
    elif provider == "google":
        return _gemini_validate(api_key)
    else:
        return {"valid": False, "error": f"Unknown provider: {provider}"}
