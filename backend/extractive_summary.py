"""Deterministic, LLM-free conversation summarizer for the local path.

Produces the same 6-field summary dict the LLM pipeline produced, but by
selecting from the conversation instead of generating prose. Nothing here
calls a model, so a capture costs ~0s of inference instead of 26s (GPU) or
224s (CPU), needs no chat model downloaded, and cannot hallucinate a value
that wasn't in the conversation.

Why extractive is the right trade here, not a downgrade:

  * The continuation prompt — the thing that actually gets pasted into
    another AI — is already budget-capped verbatim text. The generated
    summary contributed roughly 1% of it (~175 chars of a 15-35k prompt),
    so removing the model barely changes what the receiving model sees.
  * VITALS are strictly better this way. `_build_lattice_entries` already
    documents that both a small local model and a large cloud model failed
    to preserve exact values (one truncates, the other paraphrases) — which
    is exactly what a "keep the error string / path / ticket id" field
    needs. Regex doesn't paraphrase.

The cloud/premium path is untouched: llm_router keeps its own
EXTRACT_PROMPT/SYNTHESIZE_PROMPT flow for paid providers.
"""

from __future__ import annotations

import re

# Sentence boundary: terminator followed by whitespace, or end of line. Kept
# deliberately simple — over-splitting costs a slightly short bullet, while a
# heavyweight sentence tokenizer would be a new dependency for no real gain.
_SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+|\n+")

# Openers that carry no information as a title/bullet ("Sure!", "Great question").
_FILLER_PREFIX_RE = re.compile(
    r"^(?:sure|certainly|of course|great question|good question|absolutely|"
    r"thanks|thank you|hi|hello|hey|ok|okay|got it|understood|no problem|"
    r"i see|alright|yes|no)\b[\s,!.:—-]*",
    re.IGNORECASE,
)

# VITALS are meant to be exact, copy-pasteable TOKENS — an error string, a
# file:line, a version, a command — not prose containing them. A sentence is
# the wrong unit: it's what key_ideas already carries, and it reintroduces the
# imprecision this field exists to avoid.
_VITAL_PATTERNS: tuple[re.Pattern, ...] = (
    # ExceptionName: value  /  ExceptionName
    re.compile(r"\b[A-Z]\w*(?:Error|Exception|Warning)\b(?:\s*:\s*[^\s,.;]{1,40})?"),
    # path/to/file.ext optionally with :line  (app.py:88, src/db.rs:12)
    re.compile(r"\b(?:[\w.\-]+[\\/])*[\w.\-]+\.(?:py|js|ts|tsx|jsx|go|rs|java|rb|"
               r"cpp|c|h|css|html|json|yaml|yml|toml|sql|sh|bat|md|env)\b(?::\d+)?"),
    # semantic-ish versions: v1.2, 3.11.9, 0.3.34
    re.compile(r"\bv?\d+\.\d+(?:\.\d+)*\b"),
    # `inline code` / commands in backticks
    re.compile(r"`([^`\n]{2,60})`"),
    # KEY=value env assignments
    re.compile(r"\b[A-Z][A-Z0-9_]{2,}=[^\s]{1,40}"),
    # numbers with units — timings/sizes that matter in perf discussions
    re.compile(r"\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|MB|GB|KB|TB|%)\b"),
)

# Uppercase words that look identifier-shaped to the entity scanner but carry
# no value as a "here is the exact token" hint — SQL/HTTP/shell vocabulary and
# shouty prose. entity_extractor has its own stoplist for conversation
# artifacts; this covers the technical-vocabulary case it doesn't.
_VITAL_STOPWORDS: frozenset[str] = frozenset({
    "CREATE", "SELECT", "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TABLE",
    "INDEX", "WHERE", "FROM", "JOIN", "GROUP", "ORDER", "LIMIT", "VALUES",
    "ANALYZE", "EXPLAIN", "VACUUM", "COMMIT", "ROLLBACK", "PRIMARY", "FOREIGN",
    "GET", "POST", "PUT", "PATCH", "HEAD", "HTTP", "HTTPS", "JSON", "HTML",
    "TODO", "FIXME", "NOTE", "WARNING", "ERROR", "DEBUG", "INFO",
    "THIS", "THAT", "WITH", "YOUR", "HAVE", "WILL", "WHEN", "THEN", "ELSE",
})

# Real captures rarely open with a tidy question. They open with an attachment
# marker ("Pasted text.txt  Document") or a wall of pasted material the user
# wants discussed. Both are terrible titles, so the opener is skipped when it
# looks like one and the first genuine ask is used instead.
_ATTACHMENT_RE = re.compile(
    r"^\s*(?:pasted\s+\w+|attachment|uploaded|screenshot|image|document|file)\b"
    r"|^\s*[\w .\-]{1,60}\.(?:txt|md|pdf|docx?|xlsx?|csv|png|jpe?g|gif|webp|zip|log)\b",
    re.IGNORECASE,
)
# A user turn longer than this is pasted material being handed to the model,
# not the question about it.
_PASTE_CHARS = 700
# How far in to look for the real opening ask before giving up.
_TOPIC_SCAN_MESSAGES = 8

_MAX_POINTS = 6
_MAX_VITALS = 6
_MAX_CONCLUSIONS = 3
_MAX_OPEN = 3
_POINT_CHARS = 220
_TOPIC_CHARS = 96
_SNAPSHOT_CHARS = 200


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT_SPLIT_RE.split(text or "") if s and s.strip()]


def _strip_filler(s: str) -> str:
    out = _FILLER_PREFIX_RE.sub("", s or "").strip()
    return out or (s or "").strip()


# Some captures carry raw JSON/markup (an API transcript pasted in, a tool
# dump). A structural fragment like '"role": "user",' is never a sentence and
# reads as a broken title, so those candidates are rejected outright.
_MARKUP_RE = re.compile(
    r'^\s*[\[\]{}<>"\']'          # opens with a bracket/quote
    r'|"\s*:\s*'                   # JSON key-value
    r'|^\s*\w+\s*:\s*[\[{"]'       # key: { / key: [ / key: "
    r'|^\s*</?\w+[\s>]'            # an HTML/XML tag
)


def _is_markup(s: str) -> bool:
    return bool(_MARKUP_RE.search(s or ""))


def _informative(sentences: list[str], min_len: int = 25) -> str:
    """First sentence that actually says something (not filler, markup, or a stub)."""
    for s in sentences:
        c = _strip_filler(s)
        if len(c) >= min_len and not _is_markup(c):
            return c
    for s in sentences:                       # relax the length rule, keep the markup rule
        c = _strip_filler(s)
        if c and not _is_markup(c):
            return c
    return ""


def _extract_vitals(text: str) -> list[str]:
    """Exact technical tokens, copied character-for-character.

    Ordered by where they appear so the most-discussed values (which tend to
    recur early) surface first, and de-duplicated case-insensitively so
    "app.py:88" mentioned six times occupies one slot.
    """
    found: list[str] = []

    def add(tok: str) -> None:
        tok = (tok or "").strip().strip(".,;:")
        if len(tok) < 3 or len(tok) > 80:
            return
        if tok.upper() in _VITAL_STOPWORDS:
            return
        low = tok.lower()
        # Keep the most specific form only: "KeyError: 42" beats "KeyError",
        # "app.py:88" beats "app.py". Without this the list fills with the
        # same fact at three levels of detail and crowds out real values.
        for i, existing in enumerate(found):
            e = existing.lower()
            if low == e or low in e:
                return                      # already covered by a richer token
            if e in low:
                found[i] = tok              # upgrade to the richer token
                return
        found.append(tok)

    # High-precision patterns first: they produce the values worth quoting,
    # and running them ahead of the generic identifier scan stops loose
    # uppercase words from eating the six available slots.
    for pat in _VITAL_PATTERNS:
        for m in pat.finditer(text or ""):
            add(m.group(1) if m.groups() else m.group(0))

    # Then identifier-shaped tokens (ticket ids, deploy keys, env names).
    try:
        from backend.entity_extractor import extract_entities
        for ent in extract_entities(text):
            add(ent)
    except Exception:
        pass

    return found[:_MAX_VITALS]


def build_summary(text: str, important_snippets: list[str] | None = None) -> dict:
    """Build the 6-field summary deterministically. Never raises."""
    # Imported here, not at module scope: ollama_client imports this module,
    # so a top-level import back into it would be a cycle.
    from backend.ollama_client import (
        _DECISION_RE,
        _ERROR_RE,
        _conversation_anchors,
        _parse_messages,
        _polish_title,
        _role_label,
        _score_message,
        _strip_capture_noise,
        _truncate_at_sentence,
    )

    try:
        return _build(
            text, important_snippets or [],
            _parse_messages, _conversation_anchors, _role_label, _score_message,
            _strip_capture_noise, _truncate_at_sentence, _polish_title,
            _DECISION_RE, _ERROR_RE,
        )
    except Exception:  # a summary is never worth failing a capture over
        from backend.ollama_client import _empty_summary
        return _empty_summary()


def _build(text, important_snippets, _parse_messages, _conversation_anchors,
           _role_label, _score_message, _strip_capture_noise,
           _truncate_at_sentence, _polish_title, _DECISION_RE, _ERROR_RE) -> dict:
    messages = _parse_messages(text)
    if not messages:
        from backend.ollama_client import _empty_summary
        return _empty_summary()

    total = len(messages)
    clean = [_strip_capture_noise(m) for m in messages]
    first_user, last_asst = _conversation_anchors(text)

    # ── TOPIC ────────────────────────────────────────────────────────
    # The user's opening ask, cleaned up. People recognise a saved
    # conversation by what they asked, and it can't drift from the source the
    # way a generated title can — but "the first message" is naive, because
    # real captures routinely start with an attachment marker or a paste.
    topic_sentence = ""
    for i, msg in enumerate(messages[:_TOPIC_SCAN_MESSAGES]):
        body = clean[i]
        if not body or _ATTACHMENT_RE.match(body):
            continue
        if _role_label(msg) != "USER":
            continue
        if len(body) > _PASTE_CHARS:      # pasted material, not the question
            continue
        cand = _informative(_sentences(body), min_len=12)
        if cand:
            topic_sentence = cand
            break
    if not topic_sentence:
        # Nothing question-shaped: fall back to the opening anchor, then to
        # the first message with any substance at all.
        opener = _strip_capture_noise(first_user) if first_user else ""
        topic_sentence = _informative(_sentences(opener), min_len=15)
    if not topic_sentence:
        for body in clean:
            if body and not _ATTACHMENT_RE.match(body):
                topic_sentence = _informative(_sentences(body), min_len=15)
                if topic_sentence:
                    break
    # A very short opener is usually a correction or an aside ("did i ask about
    # X??", "this"), not what the conversation is about. When the substance sits
    # in a long early message instead — pasted material, or the answer the user
    # saved the thread for — take the topic from there.
    if len(topic_sentence) < 30:
        head = [(len(b), b) for b in clean[:4] if b and not _ATTACHMENT_RE.match(b)]
        if head:
            longest = max(head)[1]
            if len(longest) > _PASTE_CHARS:
                alt = _informative(_sentences(longest), min_len=30)
                if len(alt) > len(topic_sentence):
                    topic_sentence = alt
    topic = _polish_title(_truncate_at_sentence(topic_sentence, _TOPIC_CHARS)) if topic_sentence else ""

    # ── POINTS ───────────────────────────────────────────────────────
    # Reuse the existing importance scorer (position, code, errors, paths,
    # decision language) so this stays consistent with how the continuation
    # prompt already picks what matters, then quote one sentence per message.
    scored = sorted(
        ((i, _score_message(m, i, total)) for i, m in enumerate(messages)),
        key=lambda x: x[1], reverse=True,
    )
    points: list[str] = []
    seen: set[str] = set()
    for idx, _score in scored:
        if len(points) >= _MAX_POINTS:
            break
        sent = _informative(_sentences(clean[idx]))
        if not sent:
            continue
        key = sent[:60].lower()
        if key in seen:
            continue
        seen.add(key)
        points.append((idx, _truncate_at_sentence(sent, _POINT_CHARS)))
    # Chronological order reads as a narrative; score order reads as noise.
    points = [p for _i, p in sorted(points, key=lambda x: x[0])]

    # ── SNAPSHOT ─────────────────────────────────────────────────────
    tail = _strip_capture_noise(last_asst) if last_asst else (clean[-1] if clean else "")
    snapshot = _truncate_at_sentence(_informative(_sentences(tail)), _SNAPSHOT_CHARS)

    # ── VITALS ───────────────────────────────────────────────────────
    # The field where extraction beats generation outright: exact tokens,
    # copied not rewritten.
    vitals = _extract_vitals(text)

    # ── DECIDED ──────────────────────────────────────────────────────
    # Decision language, weighted to the back half where conclusions land.
    conclusions: list[str] = []
    for i in range(total - 1, -1, -1):
        if len(conclusions) >= _MAX_CONCLUSIONS:
            break
        for s in _sentences(clean[i]):
            if len(conclusions) >= _MAX_CONCLUSIONS:
                break
            if _DECISION_RE.search(s):
                c = _truncate_at_sentence(_strip_filler(s), _POINT_CHARS)
                if c and c not in conclusions:
                    conclusions.append(c)
    conclusions.reverse()

    # ── OPEN ─────────────────────────────────────────────────────────
    # Trailing unanswered questions. Only the last quarter of the
    # conversation: an early question the thread went on to answer is not an
    # open item, and surfacing it as one actively misleads the next model.
    open_qs: list[str] = []
    start = max(0, int(total * 0.75))
    for i in range(total - 1, start - 1, -1):
        if len(open_qs) >= _MAX_OPEN:
            break
        if _role_label(messages[i]) != "USER":
            continue
        for s in _sentences(clean[i]):
            if len(open_qs) >= _MAX_OPEN:
                break
            if s.rstrip().endswith("?"):
                q = _truncate_at_sentence(_strip_filler(s), _POINT_CHARS)
                if q and q not in open_qs:
                    open_qs.append(q)

    return {
        "main_topic": topic or "Saved conversation",
        "key_ideas": points,
        "snapshot": snapshot,
        "vitals": vitals,
        "conclusions": conclusions,
        "unresolved_questions": open_qs,
    }
