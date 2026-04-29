"""
ContextVolt — Ollama integration for local LLM summarization.

Communicates with Ollama's REST API at localhost:11434.
"""

import json
import logging
import os
import re
import time
import requests

OLLAMA_BASE = "http://localhost:11434"

# File logger — writes to <project_root>/contextvolt.log with rotation (max 5 MB, 2 backups)
_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "contextvolt.log")
from logging.handlers import RotatingFileHandler as _RFH
_log = logging.getLogger("contextvolt")
_log.setLevel(logging.DEBUG)
if not _log.handlers:
    _handler = _RFH(_LOG_PATH, maxBytes=5_000_000, backupCount=2, encoding="utf-8")
    _handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S"))
    _log.addHandler(_handler)


def _ollama_post(url: str, **kwargs) -> requests.Response:
    """POST to Ollama with exponential-backoff retry on connection/timeout errors.

    Retries up to 3 times (delays: 1s, 2s, 4s) for transient connectivity
    issues (Ollama restarting, brief busy states). Non-retryable errors
    (HTTP 4xx/5xx after a successful connection) propagate immediately.
    """
    max_retries = 3
    for attempt in range(max_retries + 1):
        try:
            return requests.post(url, **kwargs)
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
            if attempt == max_retries:
                _log.error("Ollama unreachable after %d retries: %s", max_retries, exc)
                raise
            delay = 2 ** attempt  # 1s, 2s, 4s
            _log.warning("Ollama connection error (attempt %d/%d), retrying in %ds: %s",
                         attempt + 1, max_retries, delay, exc)
            time.sleep(delay)


def _load_default_model() -> str:
    """Priority: OLLAMA_MODEL env var → config.json → hardcoded default."""
    env = os.getenv("OLLAMA_MODEL")
    if env:
        return env
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
    try:
        with open(cfg_path, "r", encoding="utf-8") as _f:
            _cfg = json.load(_f)
            if isinstance(_cfg, dict) and "model" in _cfg:
                return str(_cfg["model"])
    except Exception:
        pass
    return "qwen2.5:3b"

def _get_default_model() -> str:
    """Read LLM model from config at call time (supports runtime changes without restart)."""
    return _load_default_model()

# Module-level constant for backward compatibility — used as the initial/fallback value.
# All internal functions should call _get_default_model() instead.
DEFAULT_MODEL = _load_default_model()  # exported for setup_status endpoint

_CFG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json")


def _get_embed_model() -> str:
    """Read embed model from config.json at call time (supports runtime changes without restart)."""
    env = os.getenv("OLLAMA_EMBED_MODEL")
    if env:
        return env
    try:
        with open(_CFG_PATH, "r", encoding="utf-8") as _f:
            _cfg = json.load(_f)
            if isinstance(_cfg, dict) and "embed_model" in _cfg:
                return str(_cfg["embed_model"])
    except Exception:
        pass
    return "nomic-embed-text"


# Cache: model name → max chars (avoids repeated /api/show calls)
_embed_ctx_cache: dict[str, int] = {}

def _get_embed_max_chars(model: str) -> int:
    """Return the safe char truncation limit for an embed model.

    Queries Ollama's /api/show for the model's context_length, then converts
    tokens → chars with a 0.85 safety margin (accounts for multi-byte chars/emoji).
    Falls back to 1400 (safe for 512-token models like mxbai-embed-large) on any error.
    Result is cached per model name for the lifetime of the process.
    """
    if model in _embed_ctx_cache:
        return _embed_ctx_cache[model]
    try:
        r = _ollama_post(f"{OLLAMA_BASE}/api/show", json={"name": model}, timeout=10)
        r.raise_for_status()
        info = r.json().get("model_info", {})
        # Different model families use different keys
        ctx_tokens = (
            info.get("llama.context_length")
            or info.get("bert.context_length")
            or info.get("nomic_bert.context_length")
            or info.get("xlm-roberta.context_length")
        )
        if ctx_tokens and isinstance(ctx_tokens, int) and ctx_tokens > 0:
            # Use 2.5 chars/token — conservative estimate that handles emoji-heavy
            # and multi-byte text (Hindi, CJK) where effective chars/token can be <2.
            # For 512-token models this gives 1280 chars, well within the safe range.
            limit = max(int(ctx_tokens * 2.5), 256)
            _embed_ctx_cache[model] = limit
            _log.debug("Embed model %s context_length=%d → char limit=%d", model, ctx_tokens, limit)
            return limit
    except Exception as e:
        _log.debug("Could not fetch context_length for %s: %s — using default 1200", model, e)
    _embed_ctx_cache[model] = 1200  # safe default for unknown models
    return 1200

# Context window config — override via env vars to match your local model.
# Default: 32k tokens (safe starting point; raise to e.g. 131072 for 128k models).
_NUM_CTX: int    = int(os.getenv("OLLAMA_NUM_CTX", "32768"))
_CHAR_LIMIT: int = _NUM_CTX * 3          # ~3 chars/token with headroom
_CHUNK_LIMIT: int = max(_CHAR_LIMIT - 20000, 10000)  # leave room for prompt overhead

EXTRACT_PROMPT = """Extract the key content from this conversation. List — do not summarize, interpret, or compress.

CONVERSATION:
{conversation}

List every item you find in this exact format:
CLAIMS:
- [key arguments, explanations, or factual claims made — one per bullet]
DECISIONS:
- [exact decision or conclusion reached, with reasoning if stated]
TECHNICAL:
- [exact error message, command, file path, version string, URL — copy character-for-character]
STATE: [one sentence: what was actively being discussed/built/debugged at the END of this text, or "none"]

If a category has nothing, write "none". Do not skip any specific values or claims."""

SYNTHESIZE_PROMPT = """You are a summarization assistant. Synthesize the content below into a structured summary.

CONVERSATION START (first user message — use this to determine TOPIC):
{first_user}

CONVERSATION END (last assistant message — use this to determine DECIDED and OPEN):
{last_asst}

EXTRACTED FACTS:
{merged_facts}

Respond in EXACTLY this format (no extra text):
TOPIC: [one sentence — what the user originally wanted to do, learn, or solve]
POINTS: [4-10 key points covering the full conversation; semicolons; include specific values and claims]
SNAPSHOT: [one sentence: what was actively being discussed/built/debugged at the very end, or "n/a"]
VITALS: [up to 6 exact verbatim technical values — copy character-for-character; semicolons, or "none"]
DECIDED: [what was concluded or resolved, based on the final messages]
OPEN: [unanswered questions or next steps remaining, or "none"]"""


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two equal-length vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    mag = (sum(x ** 2 for x in a) ** 0.5) * (sum(x ** 2 for x in b) ** 0.5)
    return dot / mag if mag else 0.0


_MD_PREFIX = re.compile(
    r'^(?:\*{1,2}|#{1,3}|\d+[.)]\s*|\s*[-•]\s*)+',
    re.IGNORECASE,
)
_MD_SUFFIX = re.compile(r'\*{1,2}$')


def _clean_line(line: str) -> str:
    """Strip markdown decoration (**, ##, 1., -) from start/end of a line."""
    s = line.strip()
    s = _MD_PREFIX.sub("", s).strip()
    s = _MD_SUFFIX.sub("", s).strip()
    return s


def _parse_text_summary(response_text: str) -> dict:
    """Parse the structured summary text from the LLM.

    Handles markdown noise that models like qwen2.5 add:
      **TOPIC:** ...   ## TOPIC: ...   1. TOPIC: ...
    """
    result: dict = {
        "main_topic": "No topic extracted",
        "key_ideas": [],
        "snapshot": "",
        "vitals": [],
        "conclusions": [],
        "unresolved_questions": [],
    }

    current_section: str | None = None

    for raw_line in response_text.strip().split("\n"):
        # Check both the raw stripped line AND the markdown-cleaned version
        raw = raw_line.strip()
        line = _clean_line(raw)
        line_lower = line.lower()

        # ── Section header detection ──────────────────────────────
        if line_lower.startswith("topic:") or line_lower.startswith("main topic:"):
            colon_idx = line.find(":")
            val = line[colon_idx + 1:].strip()  # type: ignore[index]
            # Reject unfilled placeholders like "[one sentence describing the main topic]"
            if val and not (val.startswith("[") and val.endswith("]")):
                result["main_topic"] = val
            current_section = None

        elif line_lower.startswith("points:") or line_lower.startswith("key points:") or line_lower.startswith("claims:"):
            colon_idx = line.find(":")
            rest = line[colon_idx + 1:].strip()  # type: ignore[index]
            if rest:
                result["key_ideas"] = [p.strip() for p in rest.split(";") if p.strip()] if ";" in rest else [rest]
            current_section = "key_ideas"

        elif line_lower.startswith("snapshot:"):
            colon_idx = line.find(":")
            val = line[colon_idx + 1:].strip()  # type: ignore[index]
            if val and val.lower() not in ("n/a", "none", "") and not (val.startswith("[") and val.endswith("]")):
                result["snapshot"] = val
            current_section = "snapshot"

        elif line_lower.startswith("vitals:"):
            colon_idx = line.find(":")
            rest = line[colon_idx + 1:].strip()  # type: ignore[index]
            if rest and rest.lower() not in ("none", "n/a"):
                result["vitals"] = [v.strip() for v in rest.split(";") if v.strip()]
            current_section = "vitals"

        elif line_lower.startswith("decided:") or line_lower.startswith("conclusion:") or line_lower.startswith("conclusions:"):
            colon_idx = line.find(":")
            rest = line[colon_idx + 1:].strip()  # type: ignore[index]
            if rest and rest.lower() not in ("nothing yet", "none", "n/a") and not (rest.startswith("[") and rest.endswith("]")):
                result["conclusions"] = [rest]
            current_section = "conclusions"

        elif line_lower.startswith("open:") or line_lower.startswith("unresolved:") or line_lower.startswith("questions:"):
            colon_idx = line.find(":")
            rest = line[colon_idx + 1:].strip()  # type: ignore[index]
            if rest and rest.lower() not in ("none", "n/a", "no additional questions") and not (rest.startswith("[") and rest.endswith("]")):
                result["unresolved_questions"] = [rest]
            current_section = "unresolved"

        # ── Bullet point under the current section ────────────────
        elif raw.startswith(("-", "•", "*", "–")) or re.match(r'^\d+[.)]\s', raw):
            # Strip bullet marker from the raw line
            item = re.sub(r'^[-•*–]|\d+[.)]\s*', "", raw, count=1).strip()
            if item and current_section == "key_ideas":
                result["key_ideas"].append(item)
            elif item and current_section == "vitals":
                result["vitals"].append(item)  # type: ignore[union-attr]
            elif item and current_section == "snapshot":
                result["snapshot"] = (str(result["snapshot"]) + " " + item).strip()
            elif item and current_section == "conclusions":
                if item.lower() not in ("nothing yet", "none", "n/a"):
                    result["conclusions"].append(item)
            elif item and current_section == "unresolved":
                if item.lower() not in ("none", "n/a"):
                    result["unresolved_questions"].append(item)

    # Last-ditch: if still no topic but we have key ideas, use the first idea as-is
    if result["main_topic"] == "No topic extracted" and result["key_ideas"]:
        result["main_topic"] = result["key_ideas"][0]  # type: ignore[index]

    return result


def check_ollama_running() -> bool:
    """Check if the Ollama server is reachable."""
    try:
        r = requests.get(f"{OLLAMA_BASE}/api/tags", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


def check_model_available(model: str | None = None) -> bool:
    """Check if the specified model is already pulled."""
    model = model or _get_default_model()
    try:
        r = requests.get(f"{OLLAMA_BASE}/api/tags", timeout=5)
        if r.status_code != 200:
            return False
        data = r.json()
        names = [m.get("name", "") for m in data.get("models", [])]
        # Match exact name (e.g. "qwen2.5:7b") OR base-only name on either side
        return any(
            n == model or n.split(":")[0] == model or model.split(":")[0] == n
            for n in names
        )
    except Exception:
        return False


def get_pull_progress(model: str | None = None) -> dict:
    """
    Get a snapshot of whether the model is available.
    Returns {"available": bool, "model": str}.
    """
    model = model or _get_default_model()
    available = check_model_available(model)
    return {"available": available, "model": model}


def _extract_json_from_response(response_text: str) -> dict:
    """
    Attempt to extract valid JSON from an LLM response.
    Handles common issues like missing braces, markdown blocks, extra text.
    """
    cleaned = response_text.strip()
    
    # Remove markdown code blocks if present
    if "```" in cleaned:
        # Extract content between ```json and ``` or just ``` and ```
        match = re.search(r"```(?:json)?\s*([\s\S]*?)```", cleaned)
        if match:
            cleaned = match.group(1).strip()
    
    # Try direct parse first
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    
    # Try to find JSON object by locating { and }
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(cleaned[start:end + 1])
        except json.JSONDecodeError:
            pass
    
    # Try wrapping in braces if it looks like JSON content without them
    if '"main_topic"' in cleaned and not cleaned.strip().startswith("{"):
        try:
            wrapped = "{" + cleaned.strip().rstrip(",") + "}"
            return json.loads(wrapped)
        except json.JSONDecodeError:
            pass
    
    # Last resort: try to extract key-value pairs manually
    result = {
        "main_topic": "Could not parse response",
        "key_ideas": [],
        "conclusions": [],
        "unresolved_questions": [],
    }
    
    # Try to find main_topic
    topic_match = re.search(r'"main_topic"\s*:\s*"([^"]*)"', cleaned)
    if topic_match:
        result["main_topic"] = topic_match.group(1)
    
    # Try to find arrays
    for key in ["key_ideas", "conclusions", "unresolved_questions"]:
        array_match = re.search(rf'"{key}"\s*:\s*\[([\s\S]*?)\]', cleaned)
        if array_match:
            items = re.findall(r'"([^"]*)"', array_match.group(1))
            result[key] = items
    
    return result


_MSG_BOUNDARY = re.compile(r'(?=^(?:USER|ASSISTANT|Human|Assistant|A|AI):\s)', re.IGNORECASE | re.MULTILINE)


def _parse_messages(text: str) -> list[str]:
    """Split conversation text into individual messages.

    Splits on USER:/ASSISTANT:/Human:/Assistant: turn markers.
    Falls back to paragraph splitting when no markers are present.
    """
    messages = [m.strip() for m in _MSG_BOUNDARY.split(text) if m.strip()]
    if len(messages) <= 1:
        messages = [p.strip() for p in text.split('\n\n') if p.strip()] or [text]
    return messages


## ── Chunk + Embed for retrieval ───────────────────────────────────────

def _split_to_fit(text: str, max_chars: int) -> list[str]:
    """Split text into segments that each fit within max_chars.

    Splits on newlines first (preserving structure), then falls back to
    hard-splitting on the char limit. Returns a list of non-empty strings.
    """
    if len(text) <= max_chars:
        return [text]
    parts = []
    current = []
    current_len = 0
    for line in text.split("\n"):
        line_len = len(line) + 1  # +1 for newline
        if current_len + line_len > max_chars and current:
            parts.append("\n".join(current))
            current = []
            current_len = 0
        # Single line longer than max_chars — hard split
        if line_len > max_chars:
            for start in range(0, len(line), max_chars):
                parts.append(line[start:start + max_chars])
        else:
            current.append(line)
            current_len += line_len
    if current:
        parts.append("\n".join(current))
    return [p for p in parts if p.strip()]


def chunk_conversation(
    text: str,
    starred_snippets: list[str] | None = None,
) -> list[dict]:
    """Split conversation into message-pair chunks for embedding-based retrieval.

    Groups consecutive USER+ASSISTANT messages into pairs, then sub-splits any
    pair that exceeds the embed model's context window so every chunk is fully
    embedded (no silent truncation).
    Tags each chunk with metadata: has_code, is_starred, role_hint.
    """
    messages = _parse_messages(text)
    starred_keys = set()
    if starred_snippets:
        starred_keys = {s[:100].strip() for s in starred_snippets if s.strip()}

    # Determine the embed model's char limit once per call
    embed_max = _get_embed_max_chars(_get_embed_model())

    chunks: list[dict] = []
    chunk_idx = 0

    def _add(text_segment: str, role_hint: str, has_code: bool, is_starred: bool) -> None:
        nonlocal chunk_idx
        for segment in _split_to_fit(text_segment, embed_max):
            chunks.append({
                "chunk_index": chunk_idx,
                "text": segment,
                "has_code": has_code or "```" in segment,
                "is_starred": is_starred,
                "role_hint": role_hint,
            })
            chunk_idx += 1

    i = 0
    while i < len(messages):
        msg = messages[i]
        role = _role_label(msg)

        # Try to pair user+assistant
        if role == "USER" and i + 1 < len(messages) and _role_label(messages[i + 1]) == "ASSISTANT":
            pair_text = msg + "\n\n" + messages[i + 1]
            role_hint = "pair"
            i += 2
        else:
            pair_text = msg
            role_hint = role.lower()
            i += 1

        has_code = "```" in pair_text
        is_starred = any(key in pair_text[:200] for key in starred_keys) if starred_keys else False
        _add(pair_text, role_hint, has_code, is_starred)

    return chunks


def embed_chunks(chunks: list[dict], model: str | None = None) -> list[dict]:
    """Embed all chunks in a single batch API call (much faster than per-chunk).

    Ollama's /api/embed accepts an array of strings as 'input'.
    One HTTP request for N chunks instead of N requests.
    Mutates each dict in-place to add 'embedding' key. Returns same list.
    """
    if not chunks:
        return chunks

    # Resolve model at runtime (EMBED_MODEL is defined later in the file)
    _model = model or _get_embed_model()

    max_chars = _get_embed_max_chars(_model)
    texts = [ch["text"][:max_chars] for ch in chunks]
    try:
        r = _ollama_post(
            f"{OLLAMA_BASE}/api/embed",
            json={"model": _model, "input": texts},
            timeout=60,
        )
        r.raise_for_status()
        embeddings = r.json().get("embeddings", [])
        for i, ch in enumerate(chunks):
            ch["embedding"] = embeddings[i] if i < len(embeddings) else None
    except Exception as e:
        _log.warning("Batch embed failed (%d chunks): %s — falling back to sequential", len(chunks), e)
        for ch in chunks:
            ch["embedding"] = embed_text(ch["text"])
    return chunks


# Tier budgets for retrieval prompts: (max_retrieved_chars, max_code_chars, starred_chars)
_RETRIEVAL_BUDGETS: dict[str, tuple[int, int, int]] = {
    "compact":  (3000,    0,  500),
    "standard": (8000, 2000, 2000),
    "full":     (16000, 4000, 4000),
}


def build_retrieval_prompt(
    retrieved_chunks: list[dict],
    query: str,
    total_chunks: int = 0,
    context_title: str = "",
    source_llm: str = "",
    created_at: str = "",
    prompt_size: str = "standard",
    important_snippets: list[str] | None = None,
) -> str:
    """Build an XML continuation prompt from retrieved chunks.

    retrieved_chunks should already be deduplicated and sorted by chunk_index.
    """
    tier = prompt_size if prompt_size in _RETRIEVAL_BUDGETS else "standard"
    max_retrieved, max_code, starred_budget = _RETRIEVAL_BUDGETS[tier]

    total = total_chunks or len(retrieved_chunks)

    # ── Metadata ──────────────────────────────────────────────────
    meta_parts = []
    if source_llm:
        meta_parts.append(f"Source: {source_llm}")
    meta_parts.append(f"Chunks: {len(retrieved_chunks)}/{total} retrieved")
    if created_at:
        meta_parts.append(f"Captured: {created_at[:10]}")
    meta_line = " | ".join(meta_parts)

    sections: list[str] = []
    sections.append(f"<context_brief>\n<meta>\n{meta_line}\n</meta>")
    sections.append(f"\n<query>\n{query}\n</query>")

    # ── Retrieved context (chronological, within budget) ──────────
    context_lines: list[str] = []
    char_used = 0
    for ch in retrieved_chunks:
        text = ch["text"]
        if char_used + len(text) > max_retrieved:
            # Truncate last chunk to fit
            remaining = max_retrieved - char_used
            if remaining > 200:
                text = _truncate_at_sentence(text, remaining)
            else:
                break
        idx = ch.get("chunk_index", 0)
        # Label: OPENING / LATEST / STARRED / RELEVANT
        if idx == 0:
            label = "OPENING"
        elif total > 0 and idx >= total - 1:
            label = "LATEST"
        elif ch.get("is_starred"):
            label = "STARRED"
        else:
            score = ch.get("_score", 0)
            label = f"RELEVANT ({score:.2f})" if score else "RELEVANT"

        clean = _strip_capture_noise(text)
        context_lines.append(f"[Chunk {idx + 1}/{total} - {label}]:\n{clean}")
        char_used += len(text)

    if context_lines:
        sections.append("\n<retrieved_context>\n" + "\n\n".join(context_lines) + "\n</retrieved_context>")

    # ── Starred content (verbatim) ────────────────────────────────
    if important_snippets:
        cleaned = [_strip_capture_noise(s) for s in important_snippets]
        joined = "\n\n---\n\n".join(cleaned)
        starred_section = _truncate_at_sentence(joined, starred_budget)
        if starred_section:
            sections.append(f"\n<important_context>\n{starred_section}\n</important_context>")

    # ── Code artifacts from retrieved chunks ──────────────────────
    if max_code > 0:
        all_retrieved_text = "\n\n".join(ch["text"] for ch in retrieved_chunks)
        code_blocks = _extract_code_blocks(all_retrieved_text, max_blocks=5, max_chars=max_code)
        if code_blocks:
            parts: list[str] = []
            for cb in code_blocks:
                header = f"# {cb['context']}" if cb["context"] else ""
                lang = cb["language"]
                parts.append(f"{header}\n```{lang}\n{cb['code']}\n```".strip())
            sections.append("\n<code_artifacts>\n" + "\n\n".join(parts) + "\n</code_artifacts>")

    # ── Instructions ──────────────────────────────────────────────
    instructions = (
        f"Continue this conversation. The user wants to resume: \"{query}\". "
        f"The chunks above are the most relevant parts of a {total}-message conversation. "
        "Use them as context to provide a helpful, informed response."
    )
    sections.append(f"\n<instructions>\n{instructions}\n</instructions>")
    sections.append("</context_brief>")

    return "\n".join(sections)


def build_hybrid_prompt(
    summary: dict,
    retrieved_chunks: list[dict],
    query: str,
    total_chunks: int,
    source_llm: str = "",
    created_at: str = "",
    prompt_size: str = "standard",
    important_snippets: list[str] | None = None,
) -> str:
    """Build a hybrid prompt combining a summary overview with retrieved chunks.

    Gives the receiving LLM both the forest (structured overview from the summary)
    and the trees (actual conversation exchanges from semantic retrieval). This is
    better than pure RAG (no overview) or pure static (no verbatim text).

    Uses the conversation_replay format so chunks are presented as labeled turns
    rather than anonymous fragments.
    """
    tier = prompt_size if prompt_size in ("compact", "standard", "full") else "standard"
    # Use retrieval budgets for the chunk section
    retrieval_bases = {
        "compact":  {"retrieved": 3000, "code": 0,    "starred": 500,  "max_blocks": 0},
        "standard": {"retrieved": 8000, "code": 2000, "starred": 2000, "max_blocks": 3},
        "full":     {"retrieved": 16000,"code": 4000, "starred": 4000, "max_blocks": 5},
    }
    rb = retrieval_bases.get(tier, retrieval_bases["standard"])
    overview_budget = 600 if tier == "full" else 500

    # ── Metadata ──────────────────────────────────────────────────
    meta_parts = []
    if source_llm:
        meta_parts.append(f"Source: {source_llm}")
    meta_parts.append(f"Chunks: {len(retrieved_chunks)}/{total_chunks} retrieved")
    if created_at:
        meta_parts.append(f"Captured: {created_at[:10]}")
    meta_line = " | ".join(meta_parts)

    sections: list[str] = []
    sections.append(f"<context_brief>\n<meta>\n{meta_line}\n</meta>")

    # ── Overview from summary (forest view) ───────────────────────
    overview_text = _build_overview(summary, overview_budget)
    if overview_text:
        sections.append(f"\n<overview>\n{overview_text}\n</overview>")

    # ── Query ─────────────────────────────────────────────────────
    sections.append(f"\n<query>\n{query}\n</query>")

    # ── Conversation replay from retrieved chunks (tree view) ─────
    replay_lines: list[str] = []
    char_used = 0
    for ch in retrieved_chunks:
        text = ch["text"]
        if char_used + len(text) > rb["retrieved"]:
            remaining = rb["retrieved"] - char_used
            if remaining > 200:
                text = _truncate_at_sentence(text, remaining)
            else:
                break

        idx = ch.get("chunk_index", 0)
        role = _role_label(text)

        # Build turn label
        label_parts = [f"Turn {idx + 1}/{total_chunks}", role]
        if idx == 0:
            label_parts.append("OPENING")
        elif total_chunks > 0 and idx >= total_chunks - 1:
            label_parts.append("LATEST")
        elif ch.get("is_starred"):
            label_parts.append("STARRED")
        else:
            score = ch.get("_score", 0)
            label_parts.append(f"RELEVANT ({score:.2f})" if score else "RELEVANT")
        label = " - ".join(label_parts)

        clean = _strip_capture_noise(text)
        replay_lines.append(f"[{label}]:\n{clean}")
        char_used += len(text)

    if replay_lines:
        sections.append("\n<conversation_replay>\n" + "\n\n".join(replay_lines) + "\n</conversation_replay>")

    # ── Code artifacts ─────────────────────────────────────────────
    if rb["max_blocks"] > 0:
        all_text = "\n\n".join(ch["text"] for ch in retrieved_chunks)
        code_blocks = _extract_code_blocks(all_text, max_blocks=rb["max_blocks"], max_chars=rb["code"])
        if code_blocks:
            parts: list[str] = []
            for cb in code_blocks:
                header = f"# {cb['context']}" if cb["context"] else ""
                lang = cb["language"]
                parts.append(f"{header}\n```{lang}\n{cb['code']}\n```".strip())
            sections.append("\n<code_artifacts>\n" + "\n\n".join(parts) + "\n</code_artifacts>")

    # ── Starred content (verbatim) ─────────────────────────────────
    if important_snippets:
        cleaned = [_strip_capture_noise(s) for s in important_snippets]
        joined = "\n\n---\n\n".join(cleaned)
        starred = _truncate_at_sentence(joined, rb["starred"])
        if starred:
            sections.append(f"\n<important_context>\n{starred}\n</important_context>")

    # ── Instructions ──────────────────────────────────────────────
    source_clause = f" originally held with {source_llm}" if source_llm else ""
    instructions = (
        f"You are continuing a conversation{source_clause}. "
        f"The overview summarizes the full {total_chunks}-chunk conversation. "
        f'The replay shows the most relevant exchanges for: "{query}". '
        "Continue naturally from where the conversation left off."
    )
    sections.append(f"\n<instructions>\n{instructions}\n</instructions>")
    sections.append("</context_brief>")

    return "\n".join(sections)


def build_cross_context_prompt(
    retrieved_chunks: list[dict],
    query: str,
    prompt_size: str = "standard",
) -> str:
    """Build an XML prompt from chunks retrieved across multiple conversations.

    Each chunk is annotated with its source context title, LLM, and date.
    """
    tier = prompt_size if prompt_size in _RETRIEVAL_BUDGETS else "standard"
    max_retrieved, max_code, _starred = _RETRIEVAL_BUDGETS[tier]

    sections: list[str] = []
    sections.append(f"<context_brief>\n<meta>\nCross-conversation retrieval | Chunks: {len(retrieved_chunks)}\n</meta>")
    sections.append(f"\n<query>\n{query}\n</query>")

    # ── Retrieved context with source annotations ─────────────
    context_lines: list[str] = []
    char_used = 0
    for ch in retrieved_chunks:
        text = ch["text"]
        if char_used + len(text) > max_retrieved:
            remaining = max_retrieved - char_used
            if remaining > 200:
                text = _truncate_at_sentence(text, remaining)
            else:
                break

        # Source annotation
        src = ch.get("_ctx_source", "")
        title = ch.get("_ctx_title", "")
        date = ch.get("_ctx_date", "")
        score = ch.get("_score", 0)
        header_parts = []
        if src:
            header_parts.append(src)
        if date:
            header_parts.append(date)
        if title:
            header_parts.append(f'"{title}"')
        source_label = " | ".join(header_parts) if header_parts else "Unknown"

        clean = _strip_capture_noise(text)
        context_lines.append(f"[From {source_label} — relevance {score:.2f}]:\n{clean}")
        char_used += len(text)

    if context_lines:
        sections.append("\n<retrieved_context>\n" + "\n\n".join(context_lines) + "\n</retrieved_context>")

    # ── Code artifacts from retrieved chunks ──────────────────
    if max_code > 0:
        all_text = "\n\n".join(ch["text"] for ch in retrieved_chunks)
        code_blocks = _extract_code_blocks(all_text, max_blocks=5, max_chars=max_code)
        if code_blocks:
            parts: list[str] = []
            for cb in code_blocks:
                header = f"# {cb['context']}" if cb["context"] else ""
                lang = cb["language"]
                parts.append(f"{header}\n```{lang}\n{cb['code']}\n```".strip())
            sections.append("\n<code_artifacts>\n" + "\n\n".join(parts) + "\n</code_artifacts>")

    # ── Instructions ──────────────────────────────────────────
    instructions = (
        f'The user wants to continue working on: "{query}". '
        f"The chunks above are from {len(set(ch.get('context_id') for ch in retrieved_chunks))} "
        f"different past conversations. Use them as context to provide a helpful, informed response."
    )
    sections.append(f"\n<instructions>\n{instructions}\n</instructions>")
    sections.append("</context_brief>")

    return "\n".join(sections)


def _split_by_messages(text: str, chunk_char_limit: int = 10000, overlap: int = 1) -> list[str]:
    """
    Split conversation text at message boundaries (USER:/ASSISTANT: turns).
    Adds `overlap` messages of shared context between consecutive chunks so
    the LLM sees conversational continuity across chunk boundaries.
    Falls back to paragraph-splitting if no message markers are found.
    """
    messages = _parse_messages(text)

    chunks = []
    current: list[str] = []
    current_len = 0

    for msg in messages:
        msg_len = len(msg)
        if current_len + msg_len > chunk_char_limit and current:
            chunks.append('\n\n'.join(current))
            # Carry the last `overlap` messages into the next chunk for continuity
            current = current[-overlap:] if overlap else []
            current_len = sum(len(m) for m in current)
        current.append(msg)
        current_len += msg_len

    if current:
        chunks.append('\n\n'.join(current))

    return chunks


def _anchor_text(messages: list[str], anchor_count: int = 2) -> tuple[str, str]:
    """
    Return (opening_block, closing_block) containing the first and last
    `anchor_count` messages.  These are always included verbatim so the LLM
    knows the original goal and the most recent state of the conversation.
    """
    opening = '\n\n'.join(messages[:anchor_count])
    closing = '\n\n'.join(messages[-anchor_count:]) if len(messages) > anchor_count else ''
    return opening, closing


_USER_TURN   = re.compile(r'^(?:USER|Human)\s*:\s*', re.IGNORECASE | re.MULTILINE)
_ASST_TURN   = re.compile(r'^(?:ASSISTANT|Assistant|A|AI)\s*:\s*', re.IGNORECASE | re.MULTILINE)


def _conversation_anchors(text: str) -> tuple[str, str]:
    """Return (first_user_message, last_assistant_message) from the conversation.

    These are used to pin TOPIC and DECIDED to the actual conversation boundaries
    rather than whatever facts happened to be most prominent in extracted chunks.
    """
    user_parts = _USER_TURN.split(text)
    asst_parts = _ASST_TURN.split(text)

    first_user = user_parts[1].strip()[:800] if len(user_parts) > 1 else ""  # type: ignore[index]
    last_asst  = asst_parts[-1].strip()[:800] if len(asst_parts) > 1 else ""  # type: ignore[index]

    return first_user, last_asst


def _empty_summary() -> dict:
    return {
        "main_topic": "No topic extracted",
        "key_ideas": [], "snapshot": "", "vitals": [],
        "conclusions": [], "unresolved_questions": [],
    }


def _extract_chunk(text: str, model: str | None = None, label: str = "") -> str:
    """Run constrained fact-extraction on a single chunk. Returns raw extraction text.

    Asks the model only to LIST — no synthesis, no compression. This is reliable
    even on small models because it's constrained extraction, not open-ended generation.
    Returns an empty string on failure so callers can skip silently.
    """
    model = model or _get_default_model()
    prompt = EXTRACT_PROMPT.format(conversation=text[:_CHUNK_LIMIT])  # type: ignore[index]
    try:
        r = _call_generate(
            model, prompt,
            {"temperature": 0.1, "num_predict": 800, "num_ctx": _NUM_CTX},
            timeout=120,
        )
        _log.debug("Extract status=%s label=%r", r.status_code, label)
        r.raise_for_status()
        result = _strip_think_blocks(r.json().get("response", ""))
        _log.debug("Extract result (first 300): %r", result[:300])  # type: ignore[index]
        return result
    except Exception as e:
        _log.warning("_extract_chunk exception (label=%r): %s", label, e)
        return ""


def _synthesize(
    merged_facts: str,
    model: str | None = None,
    label: str = "",
    first_user: str = "",
    last_asst: str = "",
) -> dict:
    """Synthesize a 6-field summary dict from merged extracted facts (or raw conversation).

    This is the single compression step in the map-reduce pipeline. The model works
    from structured extracted facts, not raw noisy conversation text.
    first_user / last_asst pin TOPIC and DECIDED to the actual conversation boundaries.

    Starred content is intentionally excluded — it's stored separately in important_notes
    and displayed verbatim in the continuation prompt. The summary must reflect the full
    conversation without priority overrides.
    """
    model = model or _get_default_model()
    prompt = SYNTHESIZE_PROMPT.format(
        first_user=first_user[:800] or "(not available)",   # type: ignore[index]
        last_asst=last_asst[:800] or "(not available)",     # type: ignore[index]
        merged_facts=merged_facts[:_CHAR_LIMIT],            # type: ignore[index]
    )
    try:
        r = _call_generate(
            model, prompt,
            {"temperature": 0.2, "num_predict": 2000, "num_ctx": _NUM_CTX},
            timeout=180,
        )
        _log.debug("Synthesize status=%s label=%r", r.status_code, label)
        r.raise_for_status()
        body = r.json()
        if "error" in body:
            _log.warning("Ollama error in synthesize: %s", body["error"])
            raise RuntimeError(body["error"])
        response_text = _strip_think_blocks(body.get("response", ""))
        _log.debug("Synthesize response (first 400): %r", response_text[:400])  # type: ignore[index]
        if not response_text.strip():
            _log.warning("Empty synthesize response (label=%r)", label)
            return _empty_summary()
        return _parse_text_summary(response_text)
    except requests.ConnectionError:
        raise ConnectionError("Cannot connect to Ollama. Is it running? (ollama serve)")
    except requests.Timeout:
        raise TimeoutError("Ollama took too long to respond. The model may still be loading.")
    except Exception as e:
        _log.warning("_synthesize exception (label=%r): %s", label, e)
        return _empty_summary()


def summarize_conversation(
    text: str,
    model: str | None = None,
    important_snippets: list[str] | None = None,
) -> dict:
    """
    Summarize a conversation using a two-phase Map-Reduce pipeline.

    Phase 1 — EXTRACT (map): Each chunk gets an independent constrained extraction call.
      The model is only asked to LIST facts (decisions, exact errors, commands, file paths).
      This is reliable on small models; it preserves verbatim values.

    Phase 2 — MERGE: All extraction outputs are concatenated in order. No LLM involved —
      nothing is lost in this step.

    Phase 3 — SYNTHESIZE (reduce): A single final LLM call works from the clean merged
      facts to produce the 6-field summary. One compression step instead of N chained ones.

    Short conversations (≤ _CHAR_LIMIT) skip the map/merge and go straight to synthesis
      using the raw conversation text — quality is still better because SYNTHESIZE_PROMPT
      is more structured than the old single-pass SUMMARIZE_PROMPT.

    Starred messages (important_snippets) are stored separately in the database
      (important_notes column) and displayed verbatim in the continuation prompt.
      They do NOT influence the summary — keeping the summary a balanced representation
      of the full conversation.
    """
    model = model or _get_default_model()
    first_user, last_asst = _conversation_anchors(text)

    # Short conversation: synthesize directly from raw text
    if len(text) <= _CHAR_LIMIT:
        return _synthesize(text, model=model, label="Single",
                           first_user=first_user, last_asst=last_asst)

    # Long conversation: Map-Reduce
    messages = _parse_messages(text)
    anchor_count = 2
    opening, closing = _anchor_text(messages, anchor_count)

    middle_messages = messages[anchor_count:-anchor_count] if len(messages) > anchor_count * 2 else []
    middle_text = '\n\n'.join(middle_messages)
    middle_chunks = _split_by_messages(middle_text, chunk_char_limit=_CHUNK_LIMIT, overlap=1) if middle_text else []

    # MAP: extract facts from each section independently
    all_extractions: list[str] = []

    opening_facts = _extract_chunk(opening, model, label="Opening")
    if opening_facts:
        all_extractions.append(f"[OPENING]\n{opening_facts}")

    for idx, chunk in enumerate(middle_chunks):
        facts = _extract_chunk(chunk, model, label=f"Middle {idx+1}/{len(middle_chunks)}")
        if facts:
            all_extractions.append(f"[SECTION {idx+1}]\n{facts}")

    if closing:
        closing_facts = _extract_chunk(closing, model, label="Closing")
        if closing_facts:
            all_extractions.append(f"[CLOSING — most recent, highest priority]\n{closing_facts}")

    # MERGE: concatenate all extractions — no LLM, nothing is lost
    merged_facts = "\n\n".join(all_extractions) if all_extractions else text[:_CHAR_LIMIT]  # type: ignore[index]

    # SYNTHESIZE: one final call from clean merged facts
    return _synthesize(merged_facts, model=model, label="Final",
                       first_user=first_user, last_asst=last_asst)


def summarize_conversation_streaming(
    text: str,
    model: str | None = None,
    important_snippets: list[str] | None = None,
):
    """Generator version of summarize_conversation that yields progress dicts.

    Each yield is a dict: {"step": str, "done": int, "total": int}
    The final yield includes "result": <summary dict>.
    """
    import json as _json
    model = model or _get_default_model()
    first_user, last_asst = _conversation_anchors(text)

    if len(text) <= _CHAR_LIMIT:
        yield {"step": "Synthesizing summary…", "done": 0, "total": 1}
        result = _synthesize(text, model=model, label="Single",
                             first_user=first_user, last_asst=last_asst)
        yield {"step": "Done", "done": 1, "total": 1, "result": result}
        return

    messages = _parse_messages(text)
    anchor_count = 2
    opening, closing = _anchor_text(messages, anchor_count)
    middle_messages = messages[anchor_count:-anchor_count] if len(messages) > anchor_count * 2 else []
    middle_text = '\n\n'.join(middle_messages)
    middle_chunks = _split_by_messages(middle_text, chunk_char_limit=_CHUNK_LIMIT, overlap=1) if middle_text else []

    total_steps = 1 + len(middle_chunks) + (1 if closing else 0) + 1  # opening + middles + closing + synthesize
    done = 0

    all_extractions: list[str] = []

    yield {"step": "Extracting from opening…", "done": done, "total": total_steps}
    opening_facts = _extract_chunk(opening, model, label="Opening")
    if opening_facts:
        all_extractions.append(f"[OPENING]\n{opening_facts}")
    done += 1

    for idx, chunk in enumerate(middle_chunks):
        yield {"step": f"Extracting section {idx+1}/{len(middle_chunks)}…", "done": done, "total": total_steps}
        facts = _extract_chunk(chunk, model, label=f"Middle {idx+1}/{len(middle_chunks)}")
        if facts:
            all_extractions.append(f"[SECTION {idx+1}]\n{facts}")
        done += 1

    if closing:
        yield {"step": "Extracting from closing…", "done": done, "total": total_steps}
        closing_facts = _extract_chunk(closing, model, label="Closing")
        if closing_facts:
            all_extractions.append(f"[CLOSING — most recent, highest priority]\n{closing_facts}")
        done += 1

    merged_facts = "\n\n".join(all_extractions) if all_extractions else text[:_CHAR_LIMIT]

    yield {"step": "Synthesizing final summary…", "done": done, "total": total_steps}
    result = _synthesize(merged_facts, model=model, label="Final",
                         first_user=first_user, last_asst=last_asst)
    done += 1
    yield {"step": "Done", "done": done, "total": total_steps, "result": result}


# EMBED_MODEL kept for backward compatibility — runtime resolution via _get_embed_model()
EMBED_MODEL: str = _get_embed_model()


# ---------------------------------------------------------------------------
# Continuation Prompt — helper functions
# ---------------------------------------------------------------------------

_CODE_BLOCK_RE = re.compile(r'```(\w*)\n(.*?)```', re.DOTALL)
_ERROR_RE = re.compile(
    r'(?:Error|Exception|Traceback|FAIL|error\[|panic:|fatal:)',
    re.IGNORECASE,
)
_FILE_PATH_RE = re.compile(
    r'(?:[a-zA-Z]:\\|/[\w.]+/|\.{1,2}/)'           # absolute or relative paths
    r'|(?:\w+\.(?:py|js|ts|tsx|jsx|go|rs|java|rb|cpp|c|h|css|html|json|yaml|yml|toml|sql|sh|bat))',
    re.IGNORECASE,
)
_DECISION_RE = re.compile(
    r"(?:let'?s go with|I'?ll use|the solution is|decided to|we should|going with|chose|picked|settled on)",
    re.IGNORECASE,
)

def _compute_budget(msg_count: int, original_len: int, tier: str) -> dict:
    """Return character budgets for prompt assembly, scaled to conversation size.

    Short conversations (≤10 msgs) get a doubled replay budget — they often fit entirely.
    Long conversations (>50 msgs) get a larger overview to capture more of the arc.
    """
    bases: dict[str, dict] = {
        "compact":  {"overview": 300,  "replay": 1500, "code": 0,    "starred": 500,  "max_blocks": 0},
        "standard": {"overview": 500,  "replay": 4000, "code": 2000, "starred": 2000, "max_blocks": 3},
        "full":     {"overview": 500,  "replay": 8000, "code": 4000, "starred": 4000, "max_blocks": 6},
    }
    b = dict(bases.get(tier, bases["standard"]))
    if msg_count <= 10:
        b["overview"] = 200
        b["replay"] = min(original_len, b["replay"] * 2)
    elif msg_count > 50:
        b["overview"] = min(800, b["overview"] + 200)
    return b


def _extract_code_blocks(
    text: str, max_blocks: int = 5, max_chars: int = 3000,
) -> list[dict]:
    """Extract fenced code blocks from conversation text.

    Returns list of {"language": str, "code": str, "context": str} dicts,
    preferring the *last* N blocks (most recent code is most relevant).
    """
    blocks: list[dict] = []
    for m in _CODE_BLOCK_RE.finditer(text):
        lang = m.group(1) or ""
        code = m.group(2).strip()
        # Grab up to 120 chars before the opening ``` for context
        start = max(0, m.start() - 120)
        preceding = text[start:m.start()].strip().split("\n")
        context_line = preceding[-1].strip() if preceding else ""
        blocks.append({"language": lang, "code": code, "context": context_line})

    # Keep the last N blocks (most recent = most relevant)
    blocks = blocks[-max_blocks:]

    # Enforce total character budget
    kept: list[dict] = []
    total = 0
    for b in blocks:
        size = len(b["code"]) + len(b["context"])
        if total + size > max_chars:
            break
        kept.append(b)
        total += size
    return kept


def _score_message(msg: str, idx: int, total: int) -> int:
    """Score a single message for importance in context selection."""
    score = 1  # base
    if idx == 0:
        score += 10  # first user message — establishes goal
    if idx >= total - 2:
        score += 10  # last 2 messages — most recent state
    if "```" in msg:
        score += 5   # contains code block
    if _ERROR_RE.search(msg):
        score += 5   # contains error / traceback
    if _FILE_PATH_RE.search(msg):
        score += 3   # contains file paths
    if _DECISION_RE.search(msg):
        score += 2   # contains decision language
    return score


def _select_key_messages(
    messages: list[str],
    char_budget: int = 6000,
    chunks: list[dict] | None = None,
) -> list[tuple[int, str]]:
    """Return (original_index, text) tuples of the most important messages.

    Scores each message by heuristics + optional embedding similarity to the
    final conversation state. Uses stored chunk embeddings (no extra API calls).
    Re-sorts selected messages chronologically before returning.
    """
    if not messages:
        return []

    total = len(messages)
    scored = [(i, _score_message(m, i, total), m) for i, m in enumerate(messages)]

    # Boost messages semantically similar to the final conversation state
    # using already-stored chunk embeddings (free — no extra embed calls).
    if chunks:
        # Find the embedding of the last chunk as the "final state" anchor
        last_vec: list[float] | None = None
        for ch in reversed(chunks):
            raw = ch.get("embedding")
            if raw:
                try:
                    vec = json.loads(raw) if isinstance(raw, str) else raw
                    if vec:
                        last_vec = vec
                        break
                except Exception:
                    pass

        if last_vec:
            # Map chunk_index → embedding for fast lookup
            chunk_vecs: dict[int, list[float]] = {}
            for ch in chunks:
                raw = ch.get("embedding")
                if raw:
                    try:
                        vec = json.loads(raw) if isinstance(raw, str) else raw
                        if vec:
                            chunk_vecs[ch["chunk_index"]] = vec
                    except Exception:
                        pass

            new_scored = []
            for i, (idx, score, msg) in enumerate(scored):
                # Messages map approximately 2:1 to chunks (pair-based chunking)
                chunk_idx = idx // 2
                vec = chunk_vecs.get(chunk_idx)
                if vec:
                    sim = _cosine_similarity(last_vec, vec)
                    # Add 0–8 semantic bonus points (scaled from cosine similarity)
                    score += int(sim * 8)
                new_scored.append((idx, score, msg))
            scored = new_scored

    scored.sort(key=lambda x: x[1], reverse=True)

    selected: list[tuple[int, str]] = []
    used = 0
    for idx, _score, text in scored:
        if used + len(text) > char_budget:
            continue
        selected.append((idx, text))
        used += len(text)

    # Re-sort chronologically
    selected.sort(key=lambda x: x[0])
    return selected


def _role_label(msg: str) -> str:
    """Extract role label (USER/ASSISTANT) from a message string."""
    upper = msg.lstrip()[:20].upper()
    if upper.startswith(("USER:", "HUMAN:")):
        return "USER"
    if upper.startswith(("ASSISTANT:", "ASSISTANT :", "A:", "AI:")):
        return "ASSISTANT"
    return "USER"


_CAPTURE_NOISE_RE = re.compile(
    r'^\s*(?:Show thinking|Hide thinking|'
    r'(?:Gemini|ChatGPT|Claude|Copilot|Grok|DeepSeek|Perplexity)\s+said|'
    r'(?:Gemini|ChatGPT|Claude|Copilot|Grok|DeepSeek|Perplexity)\s+is thinking|'
    r'Searching the web|Analyzing|Thinking)\s*$',
    re.IGNORECASE | re.MULTILINE,
)


_ROLE_PREFIX_RE = re.compile(
    r'\A(?:USER|ASSISTANT|Human|Assistant|A|AI)\s*:\s*',
    re.IGNORECASE,
)


def _strip_capture_noise(text: str) -> str:
    """Remove browser-capture artifacts and role prefixes from message text."""
    cleaned = _CAPTURE_NOISE_RE.sub('\n', text)
    cleaned = _ROLE_PREFIX_RE.sub('', cleaned, count=1)  # strip leading role prefix
    # Collapse multiple blank lines into one
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    return cleaned.strip()


def _truncate_at_sentence(text: str, limit: int) -> str:
    """Truncate text at a sentence boundary within the character limit."""
    if len(text) <= limit:
        return text
    # Look for the last sentence-ending punctuation before the limit
    truncated = text[:limit]
    # Find last sentence boundary (. ! ? followed by space or newline)
    for i in range(len(truncated) - 1, max(0, len(truncated) - 200), -1):
        if truncated[i] in '.!?\n' and (i + 1 >= len(truncated) or truncated[i + 1] in ' \n\t'):
            return truncated[:i + 1]
    # No sentence boundary found — cut at last space to avoid mid-word
    last_space = truncated.rfind(' ', max(0, limit - 100), limit)
    if last_space > 0:
        return truncated[:last_space] + '...'
    return truncated + '...'


def _build_overview(summary: dict, budget: int) -> str:
    """Build a compact 5-field overview block from a summary dict.

    Returns a plain-text block (no XML tags) suitable for embedding inside
    an <overview> section. Fields are omitted when empty/stub.
    """
    lines: list[str] = []

    topic = summary.get("main_topic", "") or ""
    if topic and topic not in ("No topic extracted", "N/A"):
        lines.append(f"Topic: {topic}")

    snapshot = (summary.get("snapshot", "") or "").strip()
    if snapshot and snapshot.lower() not in ("n/a", "none", ""):
        lines.append(f"State: {snapshot}")

    conclusions = summary.get("conclusions", []) or []
    if conclusions:
        real = [c for c in conclusions if c.lower().strip() != topic.lower().strip()]
        if real:
            lines.append(f"Decided: {'; '.join(real)}")

    unresolved = summary.get("unresolved_questions", []) or []
    if unresolved and unresolved[0].lower() not in ("none", "n/a"):
        lines.append(f"Open: {'; '.join(unresolved)}")

    vitals = summary.get("vitals", []) or []
    if vitals:
        lines.append(f"Vitals: {'; '.join(vitals)}")

    block = "\n".join(lines)
    return _truncate_at_sentence(block, budget) if len(block) > budget else block


def _message_turn_label(orig_idx: int, msg_count: int, role: str) -> str:
    """Return a turn label like 'Turn 1/47 - USER - OPENING'."""
    parts = [f"Turn {orig_idx + 1}/{msg_count}", role]
    if orig_idx == 0:
        parts.append("OPENING")
    elif orig_idx >= msg_count - 2:
        parts.append("LATEST")
    return " - ".join(parts)


def generate_continuation_prompt(
    summary: dict,
    original_chat: str,
    important_snippets: list[str] | None = None,
    source_llm: str = "",
    created_at: str = "",
    prompt_size: str = "standard",
    chunks: list[dict] | None = None,
) -> str:
    """Build a structured XML continuation prompt deterministically (no LLM call).

    Uses an overview + conversation_replay format so the receiving LLM understands
    the context as a natural conversation transcript rather than a structured dossier.

    overview:           compact 5-field digest (topic, state, decided, open, vitals)
    conversation_replay: key messages in chronological order with turn labels
    code_artifacts:     extracted code blocks
    important_context:  verbatim starred snippets
    """
    tier = prompt_size if prompt_size in ("compact", "standard", "full") else "standard"
    messages = _parse_messages(original_chat)
    msg_count = len(messages)
    budget = _compute_budget(msg_count, len(original_chat), tier)

    # ── Smart-select key messages ─────────────────────────────────
    selected = _select_key_messages(messages, char_budget=budget["replay"], chunks=chunks)

    replay_lines: list[str] = []
    for orig_idx, text in selected:
        role = _role_label(text)
        clean_text = _strip_capture_noise(text)
        label = _message_turn_label(orig_idx, msg_count, role)
        replay_lines.append(f"[{label}]:\n{clean_text}")
    replay_block = "\n\n".join(replay_lines)

    # ── Extract code blocks ───────────────────────────────────────
    max_blocks = budget["max_blocks"]
    code_blocks = _extract_code_blocks(original_chat, max_blocks=max_blocks, max_chars=budget["code"]) if max_blocks > 0 else []
    code_section = ""
    if code_blocks:
        parts: list[str] = []
        for cb in code_blocks:
            header = f"# {cb['context']}" if cb["context"] else ""
            lang = cb["language"]
            parts.append(f"{header}\n```{lang}\n{cb['code']}\n```".strip())
        code_section = "\n\n".join(parts)

    # ── Starred content (verbatim) ────────────────────────────────
    starred_section = ""
    if important_snippets:
        cleaned = [_strip_capture_noise(s) for s in important_snippets]
        joined = "\n\n---\n\n".join(cleaned)
        starred_section = _truncate_at_sentence(joined, budget["starred"])

    # ── Metadata ──────────────────────────────────────────────────
    meta_parts = []
    if source_llm:
        meta_parts.append(f"Source: {source_llm}")
    meta_parts.append(f"Messages: {msg_count} turns")
    if created_at:
        meta_parts.append(f"Captured: {created_at[:10]}")
    meta_line = " | ".join(meta_parts)

    # ── Assemble XML prompt ───────────────────────────────────────
    sections: list[str] = []
    sections.append(f"<context_brief>\n<meta>\n{meta_line}\n</meta>")

    # Compact overview — replaces the old multi-section dossier
    overview_text = _build_overview(summary, budget["overview"])
    if overview_text:
        sections.append(f"\n<overview>\n{overview_text}\n</overview>")

    # Conversation replay — chronological key messages with turn labels
    if replay_block:
        sections.append(f"\n<conversation_replay>\n{replay_block}\n</conversation_replay>")

    # Code artifacts (skip if empty)
    if code_section:
        sections.append(f"\n<code_artifacts>\n{code_section}\n</code_artifacts>")

    # Important context (skip if empty)
    if starred_section:
        sections.append(f"\n<important_context>\n{starred_section}\n</important_context>")

    # Instructions
    snapshot = (summary.get("snapshot", "") or "").strip()
    has_snapshot = snapshot and snapshot.lower() not in ("n/a", "none", "")
    source_clause = f" originally held with {source_llm}" if source_llm else ""
    if has_snapshot:
        instructions = (
            f"You are continuing a conversation{source_clause}. "
            f"The overview above summarizes the full {msg_count}-turn conversation. "
            f"The replay shows the most relevant exchanges. "
            f"The user was last working on: {snapshot}. Continue naturally from there."
        )
    else:
        instructions = (
            f"You are continuing a conversation{source_clause}. "
            f"The overview above summarizes the full {msg_count}-turn conversation. "
            "The replay shows the most relevant exchanges. Continue naturally from where it left off."
        )
    sections.append(f"\n<instructions>\n{instructions}\n</instructions>")
    sections.append("</context_brief>")

    return "\n".join(sections)


def embed_text(text: str, model: str | None = None) -> list[float] | None:
    """Generate an embedding vector via Ollama's /api/embed endpoint.

    Returns None if the embed model is not installed or any error occurs —
    callers must handle None gracefully (fall back to keyword search).
    """
    _model = model or _get_embed_model()
    try:
        r = _ollama_post(
            f"{OLLAMA_BASE}/api/embed",
            json={"model": _model, "input": text[:_get_embed_max_chars(_model)]},
            timeout=30,
        )
        r.raise_for_status()
        embeddings = r.json().get("embeddings")
        if embeddings:
            return embeddings[0]
        return None
    except Exception:
        return None


_THINK_BLOCK_RE = re.compile(r'<think>[\s\S]*?</think>\s*', re.IGNORECASE)


def _strip_think_blocks(response_text: str) -> str:
    """Remove <think>...</think> reasoning blocks emitted by hybrid-thinking models (Qwen 3, R1)."""
    return _THINK_BLOCK_RE.sub('', response_text).strip()


def _is_thinking_model(model: str) -> bool:
    """Models that emit <think> blocks unless explicitly told not to (Qwen 3 family)."""
    base = model.split(":")[0].lower()
    return base.startswith("qwen3") and "embedding" not in base


def _call_generate(model: str, prompt: str, options: dict, timeout: int = 180) -> requests.Response:
    """Call Ollama /api/generate with GPU → CPU fallback strategy.

    Phase 1 — GPU, staged num_ctx: configured → half → 8192 → Ollama default.
    Phase 2 — CPU (num_gpu=0) with 4096 ctx: handles CUDA_Host buffer / VRAM errors.
    Each tier is only tried if the previous one returned 500.

    For Qwen 3 (hybrid-thinking) models, appends `/no_think` so the model skips
    the <think>...</think> reasoning block that would otherwise break our text parser.
    """
    if _is_thinking_model(model) and "/no_think" not in prompt:
        prompt = prompt + "\n/no_think"

    requested_ctx: int = options.get("num_ctx", _NUM_CTX)

    # Phase 1: GPU ladder
    ctx_ladder: list[int | None] = []
    ctx = requested_ctx
    while ctx > 8192:
        ctx_ladder.append(ctx)
        ctx = ctx // 2
    ctx_ladder.append(8192)
    ctx_ladder.append(None)  # let Ollama pick

    for ctx_val in ctx_ladder:
        opts = dict(options)
        if ctx_val is None:
            opts.pop("num_ctx", None)
        else:
            opts["num_ctx"] = ctx_val
        r = _ollama_post(
            f"{OLLAMA_BASE}/api/generate",
            json={"model": model, "prompt": prompt, "stream": False, "options": opts},
            timeout=timeout,
        )
        if r.status_code != 500:
            return r
        _log.warning("Ollama 500 (num_ctx=%s) body: %s", ctx_val, r.text[:300])

    # Phase 2: CPU fallback — works even when GPU VRAM is exhausted
    _log.warning("All GPU attempts failed — retrying with CPU (num_gpu=0, num_ctx=4096)")
    cpu_opts = dict(options)
    cpu_opts["num_gpu"] = 0
    cpu_opts["num_ctx"] = 4096
    r = _ollama_post(
        f"{OLLAMA_BASE}/api/generate",
        json={"model": model, "prompt": prompt, "stream": False, "options": cpu_opts},
        timeout=timeout * 3,  # CPU is slower — triple the timeout
    )
    if r.status_code == 500:
        _log.warning("CPU fallback also failed: %s", r.text[:300])
    return r


def _summarize_single(text: str, model: str | None = None, label: str = "") -> dict:
    """Summarize a single chunk of text."""
    model = model or _get_default_model()
    prompt = SUMMARIZE_PROMPT.format(conversation=text[:_CHAR_LIMIT])  # type: ignore[index]

    try:
        r = _call_generate(
            model, prompt,
            {"temperature": 0.2, "num_predict": 2000, "num_ctx": _NUM_CTX},
            timeout=180,
        )
        _log.debug("Ollama status=%s label=%r", r.status_code, label)
        r.raise_for_status()
        body = r.json()
        # Ollama can return {"error": "..."} with status 200 in some edge cases
        if "error" in body:
            _log.warning("Ollama error field: %s", body["error"])
            raise RuntimeError(body["error"])
        response_text = _strip_think_blocks(body.get("response", ""))
        _log.debug("Raw response (first 400 chars): %r", response_text[:400])  # type: ignore[index]
        if not response_text.strip():
            _log.warning("Empty response from Ollama (label=%r)", label)
            return {
                "main_topic": "No topic extracted",
                "key_ideas": [], "snapshot": "", "vitals": [],
                "conclusions": [], "unresolved_questions": [],
            }
        return _parse_text_summary(response_text)

    except requests.ConnectionError:
        raise ConnectionError("Cannot connect to Ollama. Is it running? (ollama serve)")
    except requests.Timeout:
        raise TimeoutError("Ollama took too long to respond. The model may still be loading.")
    except Exception as e:
        _log.warning("_summarize_single exception (label=%r): %s", label, e)
        return {
            "main_topic": "No topic extracted",
            "key_ideas": [], "snapshot": "", "vitals": [],
            "conclusions": [], "unresolved_questions": [],
        }
