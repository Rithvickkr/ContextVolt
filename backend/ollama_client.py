"""
ContextVolt — Ollama integration for local LLM summarization.

Communicates with Ollama's REST API at localhost:11434.
"""

import json
import logging
import os
import re
import requests

OLLAMA_BASE = "http://localhost:11434"

# File logger — writes to <project_root>/contextvolt.log regardless of launch method
_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "contextvolt.log")
logging.basicConfig(
    filename=_LOG_PATH,
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    encoding="utf-8",
)
_log = logging.getLogger("contextvolt")
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

DEFAULT_MODEL = _load_default_model()

# Context window config — override via env vars to match your local model.
# Default: 32k tokens (safe starting point; raise to e.g. 131072 for 128k models).
_NUM_CTX: int    = int(os.getenv("OLLAMA_NUM_CTX", "32768"))
_CHAR_LIMIT: int = _NUM_CTX * 3          # ~3 chars/token with headroom
_CHUNK_LIMIT: int = max(_CHAR_LIMIT - 20000, 10000)  # leave room for prompt overhead

SUMMARIZE_PROMPT = """You are a precise summarization assistant. Read the conversation below and produce a structured summary.

RULES:
- Preserve ALL exact technical values: error messages, file paths, commands, version numbers, API names, URLs.
- Key points: up to 8, semicolon-separated. Include specific numbers/values.
- SNAPSHOT: one sentence describing the current state of what is actively being built, coded, or debugged at the END of the conversation. Write "n/a" if nothing is being built.
- VITALS: up to 6 exact verbatim values (error messages, commands, file paths, version strings) that must not be paraphrased. Separate with semicolons. Write "none" if there are none.

CONVERSATION:
{conversation}

Respond in EXACTLY this format (no extra text):
TOPIC: [one sentence describing the main topic]
POINTS: [2-8 key points, separated by semicolons; include specific numbers/values]
SNAPSHOT: [current state of what is being built/debugged at conversation end, or "n/a"]
VITALS: [up to 6 exact verbatim technical values separated by semicolons, or "none"]
DECIDED: [what was concluded or decided, or "nothing yet"]
OPEN: [any unanswered questions, or "none"]
"""


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

        elif line_lower.startswith("points:") or line_lower.startswith("key points:"):
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

    # Last-ditch: if still no topic but we have key ideas, derive one
    if result["main_topic"] == "No topic extracted" and result["key_ideas"]:
        result["main_topic"] = "Discussion about: " + result["key_ideas"][0][:60]  # type: ignore[index]

    return result


def check_ollama_running() -> bool:
    """Check if the Ollama server is reachable."""
    try:
        r = requests.get(f"{OLLAMA_BASE}/api/tags", timeout=3)
        return r.status_code == 200
    except requests.ConnectionError:
        return False


def check_model_available(model: str = DEFAULT_MODEL) -> bool:
    """Check if the specified model is already pulled."""
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
    except (requests.ConnectionError, ValueError):
        return False


def get_pull_progress(model: str = DEFAULT_MODEL) -> dict:
    """
    Get a snapshot of whether the model is available.
    Returns {"available": bool, "model": str}.
    """
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


_MSG_BOUNDARY = re.compile(r'(?=(?:USER|ASSISTANT|Human|Assistant):\s)', re.IGNORECASE)


def _parse_messages(text: str) -> list[str]:
    """Split conversation text into individual messages.

    Splits on USER:/ASSISTANT:/Human:/Assistant: turn markers.
    Falls back to paragraph splitting when no markers are present.
    """
    messages = [m.strip() for m in _MSG_BOUNDARY.split(text) if m.strip()]
    if len(messages) <= 1:
        messages = [p.strip() for p in text.split('\n\n') if p.strip()] or [text]
    return messages


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


def summarize_conversation(
    text: str,
    model: str = DEFAULT_MODEL,
    important_snippets: list[str] | None = None,
) -> dict:
    """
    Send the conversation text to Ollama and get a structured summary.
    Starred messages (important_snippets) are NOT injected into the summarization
    prompt — they are stored separately and appended verbatim to the continuation
    prompt later. This keeps the summary clean and unbiased.

    For long conversations uses message-boundary chunking with:
      - First/last message anchoring (opening goal + most-recent state)
      - 1-message overlap between chunks (preserves conversational flow)
      - Progressive rolling summarization (avoids naive merge of N summaries)
    Returns a dict with main_topic, key_ideas, conclusions, unresolved_questions.
    """
    if len(text) <= _CHAR_LIMIT:
        return _summarize_single(text, model)

    # --- Split at message boundaries, not raw char offsets ---
    messages = _parse_messages(text)

    # --- Always anchor on the first 2 and last 2 messages ---
    anchor_count = 2
    opening, closing = _anchor_text(messages, anchor_count)

    # Chunk the middle section (exclude anchored messages at both ends)
    middle_messages = messages[anchor_count:-anchor_count] if len(messages) > anchor_count * 2 else []
    middle_text = '\n\n'.join(middle_messages)

    # Build middle chunks with 1-message overlap for continuity
    middle_chunks = _split_by_messages(middle_text, chunk_char_limit=_CHUNK_LIMIT, overlap=1) if middle_text else []

    # --- Progressive (rolling) summarization of the middle ---
    running_summary = _summarize_single(opening, model, label="Opening")

    for idx, chunk in enumerate(middle_chunks):
        running_topic    = running_summary.get("main_topic", "")
        running_points   = "; ".join(running_summary.get("key_ideas", []))
        running_snapshot = running_summary.get("snapshot", "")
        running_vitals   = "; ".join(running_summary.get("vitals", []))
        rolling_context = (
            f"[So far — Topic: {running_topic}. Points: {running_points}. "
            f"Snapshot: {running_snapshot}. Vitals: {running_vitals}]\n\n"
            f"NEXT SECTION:\n{chunk}"
        )
        running_summary = _summarize_single(
            rolling_context, model,
            label=f"Middle {idx+1}/{len(middle_chunks)}",
        )

    # --- Final pass: merge rolling summary + closing anchor ---
    if closing:
        running_topic    = running_summary.get("main_topic", "")
        running_points   = "; ".join(running_summary.get("key_ideas", []))
        running_snapshot = running_summary.get("snapshot", "")
        running_vitals   = "; ".join(running_summary.get("vitals", []))
        running_decided  = "; ".join(running_summary.get("conclusions", []))
        running_open     = "; ".join(running_summary.get("unresolved_questions", []))

        final_prompt = (
            "You are a precise summarization assistant. "
            "Below is a running summary of a long conversation followed by the final messages.\n\n"
            f"RUNNING SUMMARY:\n"
            f"Topic: {running_topic}\n"
            f"Points: {running_points}\n"
            f"Snapshot: {running_snapshot}\n"
            f"Vitals: {running_vitals}\n"
            f"Decided: {running_decided}\n"
            f"Open: {running_open}\n\n"
            f"FINAL MESSAGES (highest priority):\n{closing}\n\n"
            "Produce the final unified summary. Prioritise conclusions from the final messages. "
            "Update SNAPSHOT to reflect the very end of the conversation.\n\n"
            "Respond in EXACTLY this format (no extra text):\n"
            "TOPIC: [one sentence describing the overall main topic]\n"
            "POINTS: [3-8 key points covering the whole conversation, separated by semicolons]\n"
            "SNAPSHOT: [current state of what is being built/debugged at conversation end, or \"n/a\"]\n"
            "VITALS: [up to 6 exact verbatim technical values separated by semicolons, or \"none\"]\n"
            "DECIDED: [what was concluded or decided overall, or \"nothing yet\"]\n"
            "OPEN: [any unanswered questions remaining, or \"none\"]\n"
        )

        try:
            r = _call_generate(
                model, final_prompt,
                {"temperature": 0.2, "num_predict": 2000, "num_ctx": _NUM_CTX},
                timeout=180,
            )
            r.raise_for_status()
            return _parse_text_summary(r.json().get("response", ""))
        except Exception:
            pass  # Fall through to return the rolling summary as-is

    return running_summary


EMBED_MODEL: str = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")

CONTINUATION_PROMPT = """You are preparing a context brief to help someone resume an AI conversation in a new session. The new AI assistant has no memory of the original conversation.

ORIGINAL CONVERSATION SUMMARY:
Topic: {topic}
Key Points: {points}
Snapshot (active state at end): {snapshot}
Vitals (exact values to preserve): {vitals}
Decisions Made: {decisions}
Open Questions: {open_questions}

RECENT MESSAGES:
{recent_messages}

Write a concise, actionable context brief. Be specific — use exact values from Vitals verbatim.

Respond in EXACTLY this format (no extra text):
BACKGROUND: [1-2 sentences — what this conversation was about and the user's goal]
PROGRESS: [4-6 bullet points of what was established, decided, or learned — include specific numbers/versions/names]
SNAPSHOT: [one sentence — precisely where the work was left and what was being actively built/debugged]
VITALS: [the exact commands, errors, file paths, version strings to know — copy verbatim from Vitals above]
NEXT: [what to tackle next based on open questions and the snapshot]"""


_STARRED_SUMMARY_PROMPT = """The user starred these specific messages from a conversation as particularly important:

{snippets}

Summarise what makes these messages important in 2-4 concise bullet points. Focus on decisions made, key findings, errors resolved, or critical context a future AI session must know.

Respond with only the bullet points, no intro text."""


def _summarize_starred(snippets: list[str], model: str = DEFAULT_MODEL) -> str | None:
    """Run a short independent summarization of the user's starred messages.

    Returns a bullet-point string, or None if the call fails (caller skips the section).
    """
    joined = "\n---\n".join(snippets)
    prompt = _STARRED_SUMMARY_PROMPT.format(snippets=joined[:6000])  # type: ignore[index]
    try:
        r = _call_generate(
            model, prompt,
            {"temperature": 0.2, "num_predict": 400, "num_ctx": min(_NUM_CTX, 8192)},
            timeout=60,
        )
        r.raise_for_status()
        result = r.json().get("response", "").strip()
        return result or None
    except Exception:
        return None


def generate_continuation_prompt(
    summary: dict,
    original_chat: str,
    model: str = DEFAULT_MODEL,
    important_snippets: list[str] | None = None,
) -> str | None:
    """Use the LLM to generate a rich context brief for resuming a conversation.

    Starred messages are summarized independently and appended as a separate
    'Important things to remember' section — keeping the main summary clean.

    Returns the full brief as a plain string, or None on failure.
    """
    messages = _parse_messages(original_chat)
    recent = "\n\n".join(messages[-4:]) if len(messages) >= 4 else original_chat[:3000]  # type: ignore[index]

    prompt = CONTINUATION_PROMPT.format(
        topic=summary.get("main_topic", "N/A"),
        points="; ".join(summary.get("key_ideas", [])) or "None noted",
        snapshot=summary.get("snapshot", "") or "N/A",
        vitals="; ".join(summary.get("vitals", [])) or "None",
        decisions="; ".join(summary.get("conclusions", [])) or "None yet",
        open_questions="; ".join(summary.get("unresolved_questions", [])) or "None",
        recent_messages=recent[:4000],  # type: ignore[index]
    )

    try:
        r = _call_generate(
            model, prompt,
            {"temperature": 0.3, "num_predict": 1500, "num_ctx": _NUM_CTX},
            timeout=120,
        )
        r.raise_for_status()
        result = r.json().get("response", "").strip()
        if not result:
            return None
    except Exception:
        return None

    # Independently summarize the starred messages and append as a dedicated section
    if important_snippets:
        starred_summary = _summarize_starred(important_snippets, model)
        if starred_summary:
            result += f"\n\n---\n\nIMPORTANT THINGS TO REMEMBER (from your starred messages):\n{starred_summary}"

    return result


def embed_text(text: str, model: str = EMBED_MODEL) -> list[float] | None:
    """Generate an embedding vector via Ollama's /api/embed endpoint.

    Returns None if the embed model is not installed or any error occurs —
    callers must handle None gracefully (fall back to keyword search).
    """
    try:
        r = requests.post(
            f"{OLLAMA_BASE}/api/embed",
            json={"model": model, "input": text[:8000]},  # type: ignore[index]
            timeout=30,
        )
        r.raise_for_status()
        embeddings = r.json().get("embeddings")
        if embeddings:
            return embeddings[0]
        return None
    except Exception:
        return None


def _call_generate(model: str, prompt: str, options: dict, timeout: int = 180) -> requests.Response:
    """Call Ollama /api/generate with GPU → CPU fallback strategy.

    Phase 1 — GPU, staged num_ctx: configured → half → 8192 → Ollama default.
    Phase 2 — CPU (num_gpu=0) with 4096 ctx: handles CUDA_Host buffer / VRAM errors.
    Each tier is only tried if the previous one returned 500.
    """
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
        r = requests.post(
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
    r = requests.post(
        f"{OLLAMA_BASE}/api/generate",
        json={"model": model, "prompt": prompt, "stream": False, "options": cpu_opts},
        timeout=timeout * 3,  # CPU is slower — triple the timeout
    )
    if r.status_code == 500:
        _log.warning("CPU fallback also failed: %s", r.text[:300])
    return r


def _summarize_single(text: str, model: str = DEFAULT_MODEL, label: str = "") -> dict:
    """Summarize a single chunk of text."""
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
        response_text = body.get("response", "")
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
