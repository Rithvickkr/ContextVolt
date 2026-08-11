"""
ContextVolt — Ollama integration for local LLM summarization.

Communicates with Ollama's REST API at localhost:11434.
"""

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import requests

# Default to the IPv4 loopback literal, NOT "localhost". On Windows, Python's
# requests/urllib3 resolves "localhost" to the IPv6 ::1 first and waits ~2s for
# that connect to fail before falling back to IPv4 — Ollama binds 127.0.0.1 only.
# That dead 2s was paid on EVERY Ollama call (chat, summarize, embed, search).
# Override via OLLAMA_HOST for non-default setups (remote/containerised Ollama).
OLLAMA_BASE = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")

# File logger — writes to the platform user-data dir with rotation (max 5 MB, 2 backups)
from backend.paths import app_log_path as _app_log_path, config_path as _config_path
_LOG_PATH = str(_app_log_path())
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
    cfg_path = str(_config_path())
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

_CFG_PATH = str(_config_path())


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


def _embed_on_cpu() -> bool:
    """Whether to force the embedding model onto CPU (config 'embed_on_cpu', default False).

    Opt-in for small dedicated GPUs (~4 GB): keeping embeddings off the GPU frees
    VRAM so the summarize/RAG LLM can stay fully resident, avoiding model-swap
    churn. On capable GPUs leave it off so embedding stays fast on-device. Read at
    call time so toggling it takes effect without a restart.
    """
    try:
        with open(_CFG_PATH, "r", encoding="utf-8") as _f:
            _cfg = json.load(_f)
            if isinstance(_cfg, dict) and "embed_on_cpu" in _cfg:
                return bool(_cfg["embed_on_cpu"])
    except Exception:
        pass
    return False


def _embed_prefix(model: str, is_query: bool) -> str:
    """Return the task-instruction prefix this embed model expects.

    Modern retrieval embedders are trained with ASYMMETRIC prefixes: the search
    query and the stored document must be encoded with different instructions or
    recall drops measurably. Each family uses its own scheme:
      - nomic-embed-text (v1/v1.5): literal "search_query:" / "search_document:"
      - qwen3-embedding: an instruct line on the QUERY only; documents stay raw.
      - mxbai-embed-large: an instruct line on the QUERY only; documents raw.
    Unknown models get no prefix — sending raw text is safer than guessing a
    scheme the model wasn't trained on.

    NOTE: changing this scheme (or the embed model) invalidates existing vectors.
    Queries and documents must be embedded with the SAME scheme, so a full
    re-embed is required after any change here. See _embedding_scheme_id().
    """
    base = model.split(":")[0].lower()
    if base.startswith("nomic-embed-text"):
        return "search_query: " if is_query else "search_document: "
    if base.startswith("qwen3-embedding"):
        return (
            "Instruct: Given a search query, retrieve relevant passages that "
            "answer the query\nQuery: "
        ) if is_query else ""
    if base.startswith("mxbai-embed-large"):
        return "Represent this sentence for searching relevant passages: " if is_query else ""
    return ""


def _embedding_scheme_id(model: str) -> str:
    """Stable identifier for the (model, prefix-scheme) pair currently in effect.

    Stored alongside vectors so we can detect when a config change has made the
    on-disk embeddings incompatible with freshly-embedded queries (fix #6).
    """
    return f"{model}|q={_embed_prefix(model, True)!r}|d={_embed_prefix(model, False)!r}"


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

    # Native backend: read the context length from the model registry. Falling
    # through to Ollama's /api/show here used to cost ~15s per cold call (three
    # connection retries with exponential backoff against a server that isn't
    # running) and then return the 1200-char default, silently truncating every
    # embedding input to a fraction of what the model actually supports.
    from backend.engine import is_native_backend
    if is_native_backend():
        from backend.engine.native import MODEL_REGISTRY
        entry = MODEL_REGISTRY.get(model)
        if entry:
            limit = max(int(entry["n_ctx"] * 2.5), 256)
            _embed_ctx_cache[model] = limit
            _log.debug("Embed model %s n_ctx=%d (registry) -> char limit=%d", model, entry["n_ctx"], limit)
            return limit
        _embed_ctx_cache[model] = 1200
        return 1200

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
TOPIC: [a specific headline-style title, 4-12 words — name the actual subject plus the single most important concrete detail from the facts when one is central: an exact value, version, error, or technology. Copy values verbatim. Examples: "Debugging sqlite-vec load failure on macOS"; "Blood Sugar Drop 395 to 65 mg/dL After Lantus"; "Migrating Express 4 to 5 Auth Middleware". If no concrete detail stands out, just name the subject. Never start with "The user" or describe what the user wanted]
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


def _clean_value(val: str) -> str:
    """Strip leading/trailing markdown bold markers from an extracted value.

    LLMs like qwen2.5 output 'TOPIC: ** value' — the prefix strip in
    _clean_line removes ** from the start of the whole line, but not from
    the value portion after the colon. This strips it from the value itself.
    """
    return re.sub(r'^\*+|\*+$', '', val).strip()


# Summary-speak framing that small models prepend to TOPIC despite the
# prompt forbidding it: "The user wants to know if X", "The user was
# trying to Y", etc. The optional verb groups only consume filler verbs
# (know/understand/...) so content verbs like "build" survive the strip.
_TITLE_BOILERPLATE_RE = re.compile(
    r"^the\s+user\s+"
    r"(?:originally\s+|initially\s+)?"
    r"(?:wanted|wants?|is\s+trying|was\s+trying|tried|tries|asked|asks?|"
    r"needed|needs?|sought|seeks?|is\s+asking|is\s+looking|is\s+seeking)\b\s*"
    r"(?:to\s+|for\s+|about\s+)?"
    r"(?:know|understand|learn|find\s+out|figure\s+out|determine|explore|"
    r"discuss|get\s+help\s+with|help\s+with|ask\s+about)?\b\s*"
    r"(?:if|whether|how\s+to|how|what|why|when|where|about)?\s*",
    re.IGNORECASE,
)


def _polish_title(val: str) -> str:
    """Turn a TOPIC value into a presentable title.

    Strips "The user wants to know..." framing so the title leads with the
    actual subject, then tidies wrapping quotes, a trailing period, and
    re-capitalizes. Falls back to the input if stripping leaves nothing.
    """
    t = val.strip().strip('"“”').strip()
    stripped = _TITLE_BOILERPLATE_RE.sub("", t, count=1).strip()
    if len(stripped) >= 3:
        t = stripped
    t = t.rstrip(".").strip()
    if t and t[0].islower():
        t = t[0].upper() + t[1:]
    return t or val.strip()


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
            val = _clean_value(line[colon_idx + 1:].strip())  # type: ignore[index]
            # Reject unfilled placeholders like "[one sentence describing the main topic]"
            if val and not (val.startswith("[") and val.endswith("]")):
                result["main_topic"] = _polish_title(val)
            current_section = None

        elif line_lower.startswith("points:") or line_lower.startswith("key points:") or line_lower.startswith("claims:"):
            colon_idx = line.find(":")
            rest = _clean_value(line[colon_idx + 1:].strip())  # type: ignore[index]
            if rest:
                result["key_ideas"] = [_clean_value(p) for p in rest.split(";") if _clean_value(p)] if ";" in rest else [rest]
            current_section = "key_ideas"

        elif line_lower.startswith("snapshot:"):
            colon_idx = line.find(":")
            val = _clean_value(line[colon_idx + 1:].strip())  # type: ignore[index]
            if val and val.lower() not in ("n/a", "none", "") and not (val.startswith("[") and val.endswith("]")):
                result["snapshot"] = val
            current_section = "snapshot"

        elif line_lower.startswith("vitals:"):
            colon_idx = line.find(":")
            rest = _clean_value(line[colon_idx + 1:].strip())  # type: ignore[index]
            if rest and rest.lower() not in ("none", "n/a"):
                result["vitals"] = [_clean_value(v) for v in rest.split(";") if _clean_value(v) and _clean_value(v).lower() not in ("none", "n/a")]
            current_section = "vitals"

        elif line_lower.startswith("decided:") or line_lower.startswith("conclusion:") or line_lower.startswith("conclusions:"):
            colon_idx = line.find(":")
            rest = _clean_value(line[colon_idx + 1:].strip())  # type: ignore[index]
            if rest and rest.lower() not in ("nothing yet", "none", "n/a") and not (rest.startswith("[") and rest.endswith("]")):
                result["conclusions"] = [rest]
            current_section = "conclusions"

        elif line_lower.startswith("open:") or line_lower.startswith("unresolved:") or line_lower.startswith("questions:"):
            colon_idx = line.find(":")
            rest = _clean_value(line[colon_idx + 1:].strip())  # type: ignore[index]
            if rest and rest.lower() not in ("none", "n/a", "no additional questions") and not (rest.startswith("[") and rest.endswith("]")):
                result["unresolved_questions"] = [rest]
            current_section = "unresolved"

        # ── Bullet point under the current section ────────────────
        elif raw.startswith(("-", "•", "*", "–")) or re.match(r'^\d+[.)]\s', raw):
            # Strip bullet marker then markdown bold from the raw line
            item = _clean_value(re.sub(r'^[-•*–]|\d+[.)]\s*', "", raw, count=1).strip())
            if item and current_section == "key_ideas":
                result["key_ideas"].append(item)
            elif item and current_section == "vitals":
                if item.lower() not in ("none", "n/a"):
                    result["vitals"].append(item)  # type: ignore[union-attr]
            elif item and current_section == "snapshot":
                result["snapshot"] = (str(result["snapshot"]) + " " + item).strip()
            elif item and current_section == "conclusions":
                if item.lower() not in ("nothing yet", "none", "n/a"):
                    result["conclusions"].append(item)
            elif item and current_section == "unresolved":
                if item.lower() not in ("none", "n/a"):
                    result["unresolved_questions"].append(item)

    # Last-ditch: if still no topic but we have key ideas, use the first idea
    if result["main_topic"] == "No topic extracted" and result["key_ideas"]:
        result["main_topic"] = _polish_title(result["key_ideas"][0])  # type: ignore[index]

    return result


def check_ollama_running() -> bool:
    """Check if the Ollama server is reachable."""
    try:
        r = requests.get(f"{OLLAMA_BASE}/api/tags", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


def _find_ollama_binary() -> str | None:
    """Locate the ollama CLI across PATH and platform-specific install dirs.

    Returns the absolute path as a string, or None if not found.
    """
    found = shutil.which("ollama")
    if found:
        return found
    if sys.platform == "win32":
        candidate = os.path.join(
            os.environ.get("LOCALAPPDATA", ""), "Programs", "Ollama", "ollama.exe"
        )
        return candidate if os.path.exists(candidate) else None
    for p in (
        "/usr/local/bin/ollama",
        "/opt/homebrew/bin/ollama",
        "/Applications/Ollama.app/Contents/Resources/ollama",
        os.path.expanduser("~/Applications/Ollama.app/Contents/Resources/ollama"),
    ):
        if os.path.exists(p):
            return p
    return None


# Handle to the `ollama serve` process WE spawned (if any). Used by
# stop_spawned_ollama() so we only ever shut down an Ollama instance ContextVolt
# started — never one the user/tray was already running.
_spawned_proc: "subprocess.Popen | None" = None


def ensure_ollama_running(timeout: float = 12.0) -> bool:
    """If Ollama is down, start `ollama serve` headless and wait for it to come up.

    Best-effort: returns True if Ollama is (or becomes) reachable, False if no
    binary is found or it doesn't come up within `timeout`. Safe to call from a
    startup thread — never raises. The spawned server inherits OLLAMA_MODELS from
    the environment (run.py sets it) so models resolve to the same dir as the app.

    If Ollama is ALREADY running we leave it untouched and record nothing, so a
    later stop_spawned_ollama() won't close an instance we didn't start.
    """
    if check_ollama_running():
        return True
    binary = _find_ollama_binary()
    if not binary:
        _log.warning("Ollama not running and no ollama binary found — cannot auto-start")
        return False
    kwargs: dict = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if sys.platform == "win32":
        # CREATE_NO_WINDOW alone — deliberately NOT combined with DETACHED_PROCESS.
        # DETACHED_PROCESS leaves `ollama serve` with no console, so the model-runner
        # subprocesses Ollama spawns (ollama_llama_server.exe) each allocate a brand-new
        # console window → visible cmd flashes on every model load. CREATE_NO_WINDOW gives
        # serve a hidden console its runner children inherit, so they never create windows.
        # serve still survives our app exiting (Windows doesn't kill children on parent exit).
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True

    # Prefer a dedicated NVIDIA GPU over an integrated one for the Ollama instance
    # WE launch. Ollama 0.30.x defaults Vulkan on and picks the device with the most
    # free VRAM — on hybrid-GPU laptops that's the slower integrated GPU, leaving the
    # NVIDIA card idle. Disabling Vulkan forces the CUDA path onto the NVIDIA card.
    # Scoped to this spawned process only — never the user's system environment. Only
    # when an NVIDIA GPU is present (iGPU-only users keep Vulkan, their only accel)
    # and only when the user hasn't set OLLAMA_VULKAN themselves.
    env = os.environ.copy()
    if "OLLAMA_VULKAN" not in env and _prefer_dedicated_gpu():
        try:
            from backend.gpu_info import has_nvidia
            if has_nvidia():
                env["OLLAMA_VULKAN"] = "0"
                _log.info("NVIDIA GPU detected — launching Ollama with OLLAMA_VULKAN=0 to prefer it")
        except Exception:
            pass
    kwargs["env"] = env

    try:
        global _spawned_proc
        _spawned_proc = subprocess.Popen([binary, "serve"], **kwargs)
        _log.info("Started 'ollama serve' (%s, pid %s)", binary, _spawned_proc.pid)
    except Exception as e:
        _log.warning("Failed to spawn 'ollama serve': %s", e)
        return False
    deadline = time.time() + timeout
    while time.time() < deadline:
        if check_ollama_running():
            _log.info("Ollama is up after auto-start")
            return True
        time.sleep(0.5)
    _log.warning("Ollama did not become reachable within %.0fs of auto-start", timeout)
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

def _split_to_fit(text: str, max_chars: int, overlap_chars: int | None = None) -> list[str]:
    """Split text into segments that each fit within max_chars, with overlap.

    Splits on newlines first (preserving structure), then falls back to
    hard-splitting on the char limit. Adjacent segments share an `overlap_chars`
    tail from the previous segment so a fact straddling a boundary isn't lost to
    retrieval (it appears, in full, in at least one chunk). Returns a list of
    non-empty strings, each <= max_chars including the prepended overlap.
    """
    if len(text) <= max_chars:
        return [text]
    if overlap_chars is None:
        overlap_chars = max(0, int(max_chars * 0.12))
    # Cap overlap so the effective segment size stays sane even for small limits.
    overlap_chars = max(0, min(overlap_chars, max_chars // 4))
    # Reserve room for the overlap tail AND the joining newline so that
    # segment + overlap + "\n" still fits within max_chars.
    eff = max(64, max_chars - overlap_chars - 1)

    base: list[str] = []
    current: list[str] = []
    current_len = 0
    for line in text.split("\n"):
        line_len = len(line) + 1  # +1 for newline
        if current_len + line_len > eff and current:
            base.append("\n".join(current))
            current = []
            current_len = 0
        # Single line longer than the effective limit — hard split
        if line_len > eff:
            for start in range(0, len(line), eff):
                base.append(line[start:start + eff])
        else:
            current.append(line)
            current_len += line_len
    if current:
        base.append("\n".join(current))
    base = [p for p in base if p.strip()]

    if overlap_chars <= 0 or len(base) <= 1:
        return base

    # Prepend an overlap tail from the previous segment to each subsequent one.
    out = [base[0]]
    for i in range(1, len(base)):
        tail = base[i - 1][-overlap_chars:]
        out.append(f"{tail}\n{base[i]}" if tail.strip() else base[i])
    return out


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


# Max chunks per /api/embed request. A whole large conversation sent as one
# request can exceed the read timeout (a 125-chunk context did, in testing),
# stalling the embed and forcing a slow per-chunk fallback. Sub-batching keeps
# each request bounded while still being far faster than one-call-per-chunk.
_EMBED_BATCH_SIZE = 32


def _embed_batch(texts: list[str], model: str, cpu_opts: dict | None = None, keep_alive: str | None = None) -> list[list[float] | None]:
    """Backend-agnostic batched embedding — routes to the native engine when
    INFERENCE_BACKEND=native, otherwise Ollama's /api/embed.

    `keep_alive` (Ollama only) keeps the embed model resident past its default
    5-minute idle window — the native engine has no equivalent concept (it
    caches loaded models for the process lifetime already, see engine/native.py).
    """
    from backend.engine import get_inference_backend, get_engine
    if get_inference_backend() == "native":
        return get_engine().embed(texts, model)
    body: dict = {"model": model, "input": texts}
    if cpu_opts:
        body["options"] = cpu_opts
    if keep_alive:
        body["keep_alive"] = keep_alive
    r = _ollama_post(f"{OLLAMA_BASE}/api/embed", json=body, timeout=60)
    r.raise_for_status()
    return r.json().get("embeddings", [])


def embed_chunks(chunks: list[dict], model: str | None = None) -> list[dict]:
    """Embed all chunks via batched /api/embed calls (much faster than per-chunk).

    Chunks are embedded in sub-batches of _EMBED_BATCH_SIZE so a single large
    context can't time out the whole request. If a sub-batch request fails, only
    that sub-batch falls back to sequential single-chunk embedding.
    Mutates each dict in-place to add 'embedding' key. Returns same list.
    """
    if not chunks:
        return chunks

    # Resolve model at runtime (EMBED_MODEL is defined later in the file)
    _model = model or _get_embed_model()

    max_chars = _get_embed_max_chars(_model)
    # Chunks are stored documents → document-side prefix (is_query=False).
    doc_prefix = _embed_prefix(_model, is_query=False)
    cpu_opts = {"num_gpu": 0} if _embed_on_cpu() else None  # resolve once per call

    for start in range(0, len(chunks), _EMBED_BATCH_SIZE):
        batch = chunks[start:start + _EMBED_BATCH_SIZE]
        texts = [doc_prefix + ch["text"][:max_chars] for ch in batch]
        try:
            embeddings = _embed_batch(texts, _model, cpu_opts)
            for i, ch in enumerate(batch):
                ch["embedding"] = embeddings[i] if i < len(embeddings) else None
        except Exception as e:
            _log.warning(
                "Batch embed failed (chunks %d–%d): %s — falling back to sequential",
                start, start + len(batch) - 1, e,
            )
            for ch in batch:
                ch["embedding"] = embed_text(ch["text"], is_query=False)
    return chunks


# Tier budgets for retrieval prompts: (max_retrieved_chars, max_code_chars, starred_chars)
_RETRIEVAL_BUDGETS: dict[str, tuple[int, int, int]] = {
    "compact":  (3000,    0,  500),
    "standard": (8000, 2000, 2000),
    "full":     (16000, 4000, 4000),
}


# Anti-hallucination directive shared by every continuation-prompt builder.
# A continuation prompt is a lossy digest: when a specific identifier was dropped
# during compression, the receiving model must abstain rather than invent a
# plausible-but-wrong value. Blind-continuation eval showed invented values are
# the dominant failure mode under compression — this is the cheap guard.
_FIDELITY_DIRECTIVE = (
    "Use only the information above. If the user asks for a specific value — an "
    "identifier, key, token, ticket number, path, hostname, or name — that does "
    "not appear above, say you don't have it on hand rather than inventing one."
)


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
        "Use them as context to provide a helpful, informed response. "
        f"{_FIDELITY_DIRECTIVE}"
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
        "Continue naturally from where the conversation left off. "
        f"{_FIDELITY_DIRECTIVE}"
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


def _generate_text(model: str, prompt: str, temperature: float, max_tokens: int, timeout: int) -> str:
    """Backend-agnostic single-shot generation for the summarization pipeline.

    Routes to the native in-process engine when INFERENCE_BACKEND=native,
    otherwise to Ollama's HTTP API via the existing GPU->CPU fallback ladder
    in _call_generate(). Both paths already strip <think> blocks; this
    normalizes them to a single "-> plain text" contract so _extract_chunk /
    _synthesize don't need to know which backend served the call.
    """
    from backend.engine import get_inference_backend, get_engine
    if get_inference_backend() == "native":
        return get_engine().generate(prompt, model, temperature=temperature, max_tokens=max_tokens, timeout=timeout)
    r = _call_generate(
        model, prompt,
        {"temperature": temperature, "num_predict": max_tokens, "num_ctx": _NUM_CTX},
        timeout=timeout,
    )
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise RuntimeError(body["error"])
    return _strip_think_blocks(body.get("response", ""))


def _extract_chunk(text: str, model: str | None = None, label: str = "") -> str:
    """Run constrained fact-extraction on a single chunk. Returns raw extraction text.

    Asks the model only to LIST — no synthesis, no compression. This is reliable
    even on small models because it's constrained extraction, not open-ended generation.
    Returns an empty string on failure so callers can skip silently.
    """
    model = model or _get_default_model()
    prompt = EXTRACT_PROMPT.format(conversation=text[:_CHUNK_LIMIT])  # type: ignore[index]
    try:
        result = _generate_text(model, prompt, temperature=0.1, max_tokens=800, timeout=120)
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
        response_text = _generate_text(model, prompt, temperature=0.2, max_tokens=2000, timeout=180)
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


def _build_lattice_entries(text: str) -> tuple[list[dict], str]:
    """Build Layer-1 lattice entries from verbatim per-region chunks of text.

    Each entry holds the raw message-bounded text for one region of the
    conversation (OPENING / SECTION N / CLOSING). No LLM extraction is run —
    we tried that on both Gemini 2.5 Flash and qwen2.5:1.5b and neither
    preserved specific values reliably (the small model truncates, the big
    cloud model paraphrases). Storing raw text trades a bit of size for full
    fidelity, which is what STONE-style continuation prompts actually need.

    Also returns a "merged_facts" string formed from the same regions so the
    SYNTHESIZE step still gets structured per-region input. Synthesis is
    still allowed to paraphrase for the human-readable summary, but the
    lattice itself stays verbatim.
    """
    messages = _parse_messages(text)
    if not messages:
        entry = {"depth": 1, "chunk_label": "ROOT",
                 "chunk_range_start": 0, "chunk_range_end": 0,
                 "content": text}
        return [entry], f"[ROOT]\n{text}"

    anchor_count = 2 if len(messages) > 4 else 0
    opening_msgs = messages[:anchor_count] if anchor_count else []
    closing_msgs = (messages[-anchor_count:]
                    if anchor_count and len(messages) > anchor_count * 2 else [])

    if anchor_count and len(messages) > anchor_count * 2:
        middle_messages = messages[anchor_count:-anchor_count]
        middle_start = anchor_count
    else:
        middle_messages = messages
        middle_start = 0
    middle_text = '\n\n'.join(middle_messages)
    # Keep per-section chunks reasonably small so the prompt-budget renderer
    # has flexibility to drop / truncate without losing whole regions. The
    # numeric limit here is independent of _CHUNK_LIMIT (which sized inputs
    # to the LLM extract pass that we no longer run).
    _LATTICE_SECTION_CHARS = 6000
    middle_chunks = _split_by_messages(
        middle_text, chunk_char_limit=_LATTICE_SECTION_CHARS, overlap=0,
    ) if middle_text else []

    entries: list[dict] = []
    merged_parts: list[str] = []

    if opening_msgs:
        op_text = '\n\n'.join(opening_msgs)
        entries.append({
            "depth": 1, "chunk_label": "OPENING",
            "chunk_range_start": 0, "chunk_range_end": anchor_count - 1,
            "content": op_text,
        })
        merged_parts.append(f"[OPENING]\n{op_text}")

    cursor = middle_start
    for idx, chunk in enumerate(middle_chunks):
        chunk_msgs = _parse_messages(chunk) or [chunk]
        n = len(chunk_msgs)
        start = cursor
        end = cursor + n - 1
        cursor = end + 1
        entries.append({
            "depth": 1, "chunk_label": f"SECTION {idx+1}",
            "chunk_range_start": start, "chunk_range_end": end,
            "content": chunk,
        })
        merged_parts.append(f"[SECTION {idx+1}]\n{chunk}")

    if closing_msgs:
        cl_text = '\n\n'.join(closing_msgs)
        entries.append({
            "depth": 1, "chunk_label": "CLOSING",
            "chunk_range_start": len(messages) - anchor_count,
            "chunk_range_end": len(messages) - 1,
            "content": cl_text,
        })
        merged_parts.append(f"[CLOSING — most recent, highest priority]\n{cl_text}")

    return entries, "\n\n".join(merged_parts)


def summarize_with_lattice(
    text: str,
    model: str | None = None,
    important_snippets: list[str] | None = None,
) -> dict:
    """Summarize a conversation and return both the 6-field summary AND the
    per-chunk lattice entries that fed it.

    Pipeline (Phase 1 of the Memory Lattice):
      EXTRACT (map) — Always chunk by message boundary. Each chunk is run through
        _extract_chunk which produces a verbatim fact list. The per-chunk
        outputs are the Layer-1 lattice entries.

      MERGE — concatenate extractions in order. No LLM call.

      SYNTHESIZE (reduce) — one final call from merged facts produces the
        6-field summary. Same as before.

    Returns: {"summary": dict, "lattice": [entry, ...]}.

    Starred snippets are still ignored here — they're stored verbatim in
    important_notes and displayed by the continuation builder directly.
    """
    model = model or _get_default_model()
    first_user, last_asst = _conversation_anchors(text)

    lattice, merged_facts = _build_lattice_entries(text)

    # If extraction returned nothing (e.g. extreme model failure), fall back to
    # synthesizing on the raw text so we still produce a usable summary.
    source = merged_facts if merged_facts else text[:_CHAR_LIMIT]  # type: ignore[index]
    summary = _synthesize(
        source, model=model, label="Final",
        first_user=first_user, last_asst=last_asst,
    )
    return {"summary": summary, "lattice": lattice}


def summarize_conversation(
    text: str,
    model: str | None = None,
    important_snippets: list[str] | None = None,
) -> dict:
    """Backward-compatible wrapper: returns only the 6-field summary dict.

    Callers that need the lattice should use summarize_with_lattice() instead.
    """
    return summarize_with_lattice(
        text, model=model, important_snippets=important_snippets,
    )["summary"]


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


def _render_lattice_block(
    lattice: list[dict] | None, char_budget: int,
) -> str:
    """Render Layer-1 lattice entries as a verbatim block, budget-capped.

    Allocation strategy:
      1. Anchor entries (OPENING / CLOSING / ROOT) get full inclusion first.
      2. Remaining budget is split across middle SECTION entries weighted by
         entity density (sections with more identifier tokens get more budget).
      3. Any middle section that received no content gets a first-sentence stub
         so the receiving LLM has a presence signal for every region.

    Output order is chronological — OPENING, sections, CLOSING.
    """
    if not lattice or char_budget <= 0:
        return ""

    from backend.entity_extractor import extract_entities  # lazy, avoids circular

    def _is_anchor(e: dict) -> bool:
        return e.get("chunk_label", "").upper() in ("OPENING", "CLOSING", "ROOT")

    def _entity_weight(e: dict) -> float:
        return float(max(len(extract_entities(e.get("content") or "")), 1))

    anchors = [e for e in lattice if _is_anchor(e)]
    middles = [e for e in lattice if not _is_anchor(e)]

    rendered_for: dict[int, str] = {}  # id(entry) -> rendered block
    used = 0

    def _block(entry: dict, content: str) -> str:
        return f"[{entry.get('chunk_label', '')}]\n{content}".strip()

    # Pass 1: include anchors in full (they're typically tiny).
    for e in anchors:
        content = (e.get("content") or "").strip()
        if not content:
            continue
        block = _block(e, content)
        size = len(block) + 2
        if used + size > char_budget:
            remaining = char_budget - used
            if remaining > 80:
                truncated = _truncate_at_sentence(block, remaining)
                if truncated.strip():
                    rendered_for[id(e)] = truncated
                    used += len(truncated) + 2
            continue
        rendered_for[id(e)] = block
        used += size

    # Pass 2: entity-weighted budget split for middle sections.
    remaining = max(0, char_budget - used)
    if middles and remaining > 0:
        weights = [_entity_weight(e) for e in middles]
        total_w = sum(weights)
        for e, w in zip(middles, weights):
            if used >= char_budget:
                break
            content = (e.get("content") or "").strip()
            if not content:
                continue
            block = _block(e, content)
            alloc = max(int(remaining * w / total_w), 200)
            slot = min(alloc, char_budget - used)
            if len(block) + 2 <= slot:
                rendered_for[id(e)] = block
                used += len(block) + 2
            else:
                truncated = _truncate_at_sentence(block, slot - 2)
                if truncated.strip():
                    rendered_for[id(e)] = truncated
                    used += len(truncated) + 2

    # Pass 3: stub pass — sections that got nothing rendered receive a
    # first-sentence presence signal (recovers compact-tier recall).
    unrendered = [e for e in middles if id(e) not in rendered_for]
    if unrendered:
        stub_budget = char_budget - used
        stub_alloc = stub_budget // len(unrendered) if unrendered else 0
        if stub_alloc >= 60:
            for e in unrendered:
                if used >= char_budget:
                    break
                content = (e.get("content") or "").strip()
                if not content:
                    continue
                first_sent = re.split(r"[.\n]", content, maxsplit=1)[0].strip()
                if not first_sent:
                    continue
                stub = _block(e, first_sent + "…")
                slot = min(stub_alloc, char_budget - used)
                if len(stub) + 2 <= slot:
                    rendered_for[id(e)] = stub
                    used += len(stub) + 2

    # Emit in chronological order (the order they sit in `lattice`).
    return "\n\n".join(rendered_for[id(e)] for e in lattice if id(e) in rendered_for)


_STANCE_KEYWORDS: list[tuple[tuple[str, ...], str]] = [
    (("debug", "error", "exception", "traceback", "bug", "crash", "stack trace", "fix"),
     "You were acting as a debugging partner."),
    (("review", "refactor", "critique", "cleanup", "code smell"),
     "You were acting as a code reviewer."),
    (("architect", "architecture", "design", "system design", "scaffold", "plan", "structure"),
     "You were acting as an architecture advisor."),
    (("explain", "how does", "what is", "understand", "learn", "teach"),
     "You were helping the user understand this topic."),
]


def _detect_stance(summary: dict) -> str:
    """Pick a stance string based on keywords in topic + key_ideas + snapshot.

    Falls back to a generic stance when no keyword matches. Pure heuristic — no
    LLM call. Tested against `main_topic` and the first 3 key_ideas because
    later ideas tend to be tangents.
    """
    haystack_parts = [
        (summary.get("main_topic", "") or ""),
        (summary.get("snapshot", "") or ""),
    ]
    haystack_parts.extend((summary.get("key_ideas", []) or [])[:3])
    haystack = " ".join(haystack_parts).lower()
    for keywords, stance in _STANCE_KEYWORDS:
        if any(kw in haystack for kw in keywords):
            return stance
    return "You were the user's assistant on this task."


_SOURCE_STYLE_HINTS: dict[str, str] = {
    "chatgpt": "markdown headers and numbered lists",
    "gpt-4":   "markdown headers and numbered lists",
    "claude":  "conversational prose with code blocks where needed",
    "gemini":  "concise outputs with clear bullet structure",
    "copilot": "concise inline answers",
    "grok":    "informal prose",
    "deepseek": "detailed step-by-step explanations",
    "perplexity": "cited concise summaries",
}


# Words that follow "I'm …" / "… here" but are NOT persona names — guards the
# heuristic against false positives like "I'm sorry" or "Look here".
_PERSONA_STOPWORDS = frozenset({
    "sorry", "here", "right", "just", "back", "ready", "happy", "glad", "sure",
    "going", "looking", "afraid", "certain", "confident", "talking", "thinking",
    "listen", "look", "stop", "wait", "okay", "alright", "come", "over", "down",
    "still", "really", "also", "well", "here.", "done", "good",
})
# Capitalized name group is case-SENSITIVE on purpose; only the surrounding
# keywords are allowed in either case. (No re.IGNORECASE — it would let the name
# group match lowercase words and flood false positives.)
_PERSONA_RE = re.compile(
    r"([A-Z][a-z]{2,11})\s+here\b"               # "Cody here"
    r"|[Ii]'?m\s+([A-Z][a-z]{2,11})\b"           # "I'm Cody"
    r"|[Tt]his\s+is\s+([A-Z][a-z]{2,11})\b"      # "This is Cody"
)


def _detect_persona(text: str) -> str:
    """Detect a recurring assistant self-name (persona) such as 'Cody'.

    Continuation quality drops when the receiving model loses an established
    persona/voice, so we surface it explicitly in the brief + instructions
    instead of leaving it buried in the replayed transcript. Pure heuristic —
    returns "" when nothing matches with confidence. Picks the most frequently
    self-referenced name so a one-off "I'm happy" can't win.
    """
    counts: dict[str, int] = {}
    for m in _PERSONA_RE.finditer(text or ""):
        name = m.group(1) or m.group(2) or m.group(3)
        if not name or name.lower() in _PERSONA_STOPWORDS:
            continue
        key = name[0].upper() + name[1:].lower()
        counts[key] = counts.get(key, 0) + 1
    if not counts:
        return ""
    return max(counts.items(), key=lambda kv: kv[1])[0]


def _forward_target(summary: dict) -> str:
    """The NEXT step to advance to.

    Prefers open questions / remaining next-steps over the end-state snapshot so
    the receiving model moves the conversation FORWARD rather than re-describing
    what was just done. Returns "" when neither is available.
    """
    for q in (summary.get("unresolved_questions", []) or []):
        q = (q or "").strip()
        if q and q.lower() not in ("none", "n/a"):
            return q
    snap = (summary.get("snapshot", "") or "").strip()
    if snap and snap.lower() not in ("none", "n/a", ""):
        return snap
    return ""


def _render_replay_index(selected: list[tuple[int, str]], msg_count: int) -> str:
    """Render selected turns as a one-line-per-turn INDEX (label + first ~100 chars).

    Used when the verbatim lattice (<key_facts>) is already present: the full
    transcript would just duplicate it, so replay collapses to a navigational
    index that preserves turn numbering and the OPENING/LATEST markers without
    re-emitting the same text wholesale.
    """
    lines: list[str] = []
    for orig_idx, text in selected:
        role = _role_label(text)
        label = _message_turn_label(orig_idx, msg_count, role)
        snippet = " ".join(_strip_capture_noise(text).split())
        if len(snippet) > 100:
            snippet = snippet[:100].rstrip() + "…"
        lines.append(f"[{label}]: {snippet}")
    return "\n".join(lines)


def _build_cold_start_brief(
    summary: dict, source_llm: str, msg_count: int, persona: str = "",
) -> str:
    """2-3 sentence plain-prose orientation for the receiving LLM.

    Uses only existing summary fields (no arc/next). Sits at the top of the
    continuation prompt so the receiving LLM has its bearings before parsing
    the structured blocks.
    """
    topic = (summary.get("main_topic", "") or "").strip()
    snapshot = (summary.get("snapshot", "") or "").strip()
    conclusions = summary.get("conclusions", []) or []
    source_clause = f"originally held with {source_llm}" if source_llm else "captured from a prior session"
    parts: list[str] = []
    if topic and topic not in ("No topic extracted",):
        parts.append(f"This is a continuation of a {msg_count}-turn conversation {source_clause} about: {topic}.")
    else:
        parts.append(f"This is a continuation of a {msg_count}-turn conversation {source_clause}.")
    if snapshot and snapshot.lower() not in ("n/a", "none"):
        parts.append(f"At session end, the active task was: {snapshot}.")
    if conclusions:
        first = (conclusions[0] or "").strip()
        if first and first.lower() not in ("none", "n/a"):
            parts.append(f"Most recent decision: {first}.")
    if persona:
        parts.append(f'The assistant went by "{persona}" — keep that persona and voice.')
    style = _SOURCE_STYLE_HINTS.get((source_llm or "").lower().strip())
    if style:
        parts.append(f"The prior assistant tended to use {style}; match that style for visual continuity.")
    return " ".join(parts)


def generate_continuation_prompt(
    summary: dict,
    original_chat: str,
    important_snippets: list[str] | None = None,
    source_llm: str = "",
    created_at: str = "",
    prompt_size: str = "standard",
    chunks: list[dict] | None = None,
    lattice: list[dict] | None = None,
) -> str:
    """Build a structured XML continuation prompt deterministically (no LLM call).

    Uses an overview + conversation_replay format so the receiving LLM understands
    the context as a natural conversation transcript rather than a structured dossier.

    overview:           compact 5-field digest (topic, state, decided, open, vitals)
    key_facts:          verbatim Layer-1 lattice extractions (STONE) — when present
    conversation_replay: key messages in chronological order with turn labels
    code_artifacts:     extracted code blocks
    important_context:  verbatim starred snippets
    """
    tier = prompt_size if prompt_size in ("compact", "standard", "full") else "standard"
    messages = _parse_messages(original_chat)
    msg_count = len(messages)
    budget = _compute_budget(msg_count, len(original_chat), tier)

    # ── Lattice (Layer 1 verbatim regions) — STONE ────────────────
    # The lattice is the primary verbatim source — bigger budgets than the
    # heuristic replay because lattice content is evenly distributed across
    # the whole conversation, while replay is front-loaded by score.
    # "full" is sized so a typical 20–30KB conversation lands without any
    # truncation; closing-tail facts otherwise get cut from the last middle
    # sections under fair-share split.
    lattice_budget = {"compact": 3000, "standard": 10000, "full": 24000}.get(tier, 10000)
    lattice_block = _render_lattice_block(lattice, lattice_budget)

    # ── Smart-select key messages ─────────────────────────────────
    selected = _select_key_messages(messages, char_budget=budget["replay"], chunks=chunks)

    if lattice_block:
        # <key_facts> already carries the verbatim regions across the whole
        # conversation, so a full replay would duplicate it. Collapse replay to a
        # compact turn index — keeps turn numbering + OPENING/LATEST markers
        # without re-emitting the same text two more times.
        replay_block = _render_replay_index(selected, msg_count)
    else:
        # No lattice → replay is the only verbatim source, so keep it in full.
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
    # These are user-starred snippets from the extension: an explicit "keep this
    # exactly as-is" signal. We intentionally do NOT dedupe them against the
    # lattice — if the user pinned it, it stays verbatim even when it overlaps.
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
        # Add "X days ago" so the receiving LLM knows the user may have new context.
        age_clause = ""
        try:
            from datetime import datetime, timezone
            captured = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            if captured.tzinfo is None:
                captured = captured.replace(tzinfo=timezone.utc)
            days = (datetime.now(timezone.utc) - captured).days
            if days <= 0:
                age_clause = " (today)"
            elif days == 1:
                age_clause = " (1 day ago)"
            elif days < 365:
                age_clause = f" ({days} days ago)"
            else:
                age_clause = f" ({days // 365} year{'s' if days // 365 > 1 else ''} ago)"
        except Exception:
            pass
        meta_parts.append(f"Captured: {created_at[:10]}{age_clause}")
    meta_line = " | ".join(meta_parts)

    # ── Assemble XML prompt ───────────────────────────────────────
    sections: list[str] = []

    # Detect an established assistant persona (e.g. "Cody") so we can hoist it
    # into the brief + instructions instead of leaving it buried in the replay.
    persona = _detect_persona(original_chat)

    # Cold-start brief: 1-3 sentence plain-prose orientation so the receiving
    # LLM gets the situation before parsing the structured blocks below.
    cold_brief = _build_cold_start_brief(summary, source_llm, msg_count, persona=persona)
    sections.append(f"<context_brief>\n<cold_start>\n{cold_brief}\n</cold_start>")

    sections.append(f"\n<meta>\n{meta_line}\n</meta>")

    overview_text = _build_overview(summary, budget["overview"])
    if overview_text:
        sections.append(f"\n<overview>\n{overview_text}\n</overview>")

    # Verbatim per-section facts from the Memory Lattice (Layer 1).
    if lattice_block:
        sections.append(f"\n<key_facts>\n{lattice_block}\n</key_facts>")

    if replay_block:
        sections.append(f"\n<conversation_replay>\n{replay_block}\n</conversation_replay>")

    if code_section:
        sections.append(f"\n<code_artifacts>\n{code_section}\n</code_artifacts>")

    if starred_section:
        sections.append(f"\n<important_context>\n{starred_section}\n</important_context>")

    # Instructions — stance-aware + explicit acknowledgment + clarifying-question fallback.
    stance = _detect_stance(summary)
    # Point at the NEXT step (open question / remaining work), not the end-state
    # snapshot, so the model advances the conversation instead of re-summarizing.
    forward = _forward_target(summary)
    if forward:
        advance = f"then advance the conversation by addressing the next open step: {forward}."
    else:
        advance = "then continue naturally from where the conversation left off."
    persona_clause = f' Stay in the established persona ("{persona}") and its voice.' if persona else ""
    instructions = (
        f"{stance} "
        f"You are now continuing this conversation. "
        f"Begin by briefly acknowledging where the prior session left off (1-2 sentences), "
        f"{advance} "
        f"If the current state is ambiguous, ask one focused clarifying question before proceeding. "
        f"Maintain the same tone and technical depth as the prior session.{persona_clause} "
        f"{_FIDELITY_DIRECTIVE}"
    )
    sections.append(f"\n<instructions>\n{instructions}\n</instructions>")
    sections.append("</context_brief>")

    # Explicit next-turn marker so the receiving LLM produces the next assistant
    # message directly instead of acknowledging the brief and asking "what now?".
    # Many models (especially smaller ones) need this framing to skip a meta-turn.
    sections.append("\nThe next message in the conversation is yours, as the assistant. Begin now:")

    return "\n".join(sections)


def embed_text(text: str, model: str | None = None, is_query: bool = True,
               keep_alive: str = "30m") -> list[float] | None:
    """Generate an embedding vector via Ollama's /api/embed endpoint.

    `is_query` selects the task prefix (see _embed_prefix). Search queries must
    pass is_query=True (default); stored documents/contexts pass is_query=False
    so the asymmetric retrieval models encode them correctly.

    `keep_alive` is forwarded to Ollama so the embed model stays resident instead
    of being unloaded after the default 5-minute idle window. Cold-loading this
    model costs several seconds, so eviction is what makes the first search after
    an idle period feel frozen — keeping it warm is the whole latency win.

    Returns None if the embed model is not installed or any error occurs —
    callers must handle None gracefully (fall back to keyword search).
    """
    _model = model or _get_embed_model()
    # Truncate content first, then prepend the prefix so the instruction is never
    # the part that gets cut off.
    content = text[:_get_embed_max_chars(_model)]
    payload = _embed_prefix(_model, is_query) + content
    cpu_opts = {"num_gpu": 0} if _embed_on_cpu() else None
    try:
        embeddings = _embed_batch([payload], _model, cpu_opts, keep_alive=keep_alive)
        return embeddings[0] if embeddings else None
    except Exception:
        return None


def warm_embed_model() -> bool:
    """Pre-load the embed model into Ollama so the first real search isn't cold.

    Best-effort and safe to call from a background thread at startup: returns
    False (without raising) if Ollama is down or the model isn't installed.
    """
    return embed_text("warmup", is_query=True) is not None


def _prefer_dedicated_gpu() -> bool:
    """Whether to steer the Ollama we launch onto a dedicated NVIDIA GPU.

    Read from config.json at call time (default True). The user can turn this off
    if they'd rather keep inference on the integrated GPU — e.g. to leave a small
    dedicated card free for gaming.
    """
    try:
        with open(_CFG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
            if isinstance(cfg, dict) and "prefer_dedicated_gpu" in cfg:
                return bool(cfg["prefer_dedicated_gpu"])
    except Exception:
        pass
    return True


def restart_ollama() -> dict:
    """Stop any running Ollama and relaunch it via ensure_ollama_running().

    User-initiated only (the 'Switch to NVIDIA' banner action). Relaunching is how
    the OLLAMA_VULKAN=0 preference takes effect on a server that was already running
    on the integrated GPU — env vars can't change under a live process. Best-effort;
    returns the post-restart diagnostic.
    """
    try:
        if sys.platform == "win32":
            # Kill the tray app too ("ollama app.exe") so it can't immediately
            # respawn a server without our env before we launch our own.
            for image in ("ollama app.exe", "ollama.exe"):
                subprocess.run(
                    ["taskkill", "/F", "/IM", image],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
        else:
            # Scope to the server specifically — "ollama serve" is in its argv, so
            # this won't catch the Ollama.app GUI or unrelated processes the way a
            # bare "ollama" pattern would.
            subprocess.run(
                ["pkill", "-f", "ollama serve"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
    except Exception as e:
        _log.warning("restart_ollama: kill step failed: %s", e)
    time.sleep(1.0)  # let the OS release port 11434
    ensure_ollama_running(timeout=20.0)
    return gpu_usage_diagnostic()


def stop_spawned_ollama() -> bool:
    """Stop the Ollama server ONLY if ContextVolt started it.

    Called on app shutdown. If Ollama was already running when we launched (the
    user or its tray started it), `_spawned_proc` is None and we leave it alone —
    it isn't ours to close. Idempotent and never raises.
    """
    global _spawned_proc
    proc = _spawned_proc
    _spawned_proc = None
    if proc is None:
        return False
    try:
        if proc.poll() is not None:
            return False  # already exited
        if sys.platform == "win32":
            # /T kills the runner children (ollama_llama_server.exe) too, so none
            # are orphaned after serve dies.
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        else:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
        _log.info("Stopped ContextVolt-spawned Ollama (pid %s) on exit", proc.pid)
        return True
    except Exception as e:
        _log.warning("Failed to stop spawned Ollama: %s", e)
        return False


def _models_loaded() -> bool:
    """True if Ollama currently has at least one model resident (via /api/ps)."""
    try:
        r = requests.get(f"{OLLAMA_BASE}/api/ps", timeout=3)
        if r.status_code == 200:
            return bool(r.json().get("models"))
    except Exception:
        pass
    return False


def gpu_usage_diagnostic() -> dict:
    """Detect whether a loaded model is actually running on the NVIDIA GPU.

    Hybrid-GPU laptops can end up running inference on the integrated GPU (via
    Ollama's Vulkan backend) while a faster NVIDIA card sits idle. We flag that
    with a version-independent signal: an NVIDIA GPU is present and a model is
    loaded, yet no ollama process appears in nvidia-smi's compute-app list.

    Returns a dict the UI can render as a banner. `warn` is True only when we are
    confident inference is NOT on the NVIDIA card; `using_nvidia` is None when
    nvidia-smi can't tell. Never raises.
    """
    nvidia = False
    on_nvidia: bool | None = None
    try:
        from backend.gpu_info import has_nvidia, nvidia_running_ollama
        nvidia = has_nvidia()
        if nvidia:
            on_nvidia = nvidia_running_ollama()
    except Exception:
        pass

    model_loaded = _models_loaded()
    warn = bool(nvidia and model_loaded and on_nvidia is False)
    detail = (
        "A model is loaded but Ollama isn't using your NVIDIA GPU — it's likely "
        "running on your integrated GPU. Restart Ollama with OLLAMA_VULKAN=0 to "
        "prefer the NVIDIA card."
    ) if warn else ""

    return {
        "nvidia_present": nvidia,
        "model_loaded": model_loaded,
        "using_nvidia": on_nvidia,
        "warn": warn,
        "detail": detail,
    }


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
