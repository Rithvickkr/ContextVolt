"""Lightweight heuristic entity extractor for the Memory Lattice (Phase 1, Step 5).

Pulls "identifier-shaped" tokens out of conversation text: deploy keys,
ticket references, file paths, environment-variable names, version tags,
versioned slugs, etc. No LLM call — both small local models and large
cloud models proved unreliable at faithful extraction (see Step 3
benchmark), and we don't need semantics here, just lookup keys.

Two patterns are emitted per chunk:
  1. Compound form with surrounding separators kept (e.g. "INC-4V5UYBHK",
     "pool_5V3ZT9NT", "fix/NH9SCBDW.json"). Useful when the user's query
     contains the exact decorated form.
  2. Bare uppercase token at the core (e.g. "4V5UYBHK", "NH9SCBDW").
     Useful when the user remembers only the discriminating fragment.

Stored case-preserved; search is case-insensitive substring in either
direction so "case-NH9SCBDW" matches the indexed "NH9SCBDW" and vice versa.
"""
from __future__ import annotations

import re

# Compound form: allow word chars + - . / # in the middle (file paths,
# ticket prefixes, dotted versions). Requires at least one inner run of
# 4+ uppercase letters or digits — that's the "identifier" core.
_COMPOUND_RE = re.compile(r"\b[\w\-./#]*[A-Z0-9]{4,}[\w\-./#]*\b")

# Bare uppercase token: pure [A-Z0-9_] 4-24 chars. Catches inner cores
# like "4V5UYBHK" or all-caps env names like "DATABASE_URL".
_BARE_RE = re.compile(r"\b[A-Z0-9][A-Z0-9_]{3,23}\b")

# Words that match the patterns but are conversation-structure artifacts
# rather than real identifiers, so we never index them.
_STOPWORDS: set[str] = {
    # Capture noise / role labels
    "USER", "ASSISTANT", "HUMAN", "ASST", "AI",
    # Lattice + prompt-builder section labels
    "OPENING", "CLOSING", "SECTION", "ROOT", "MIDDLE", "LATEST", "TURN",
    # SYNTHESIZE_PROMPT output labels
    "TOPIC", "POINTS", "SNAPSHOT", "VITALS", "DECIDED", "OPEN", "STATE",
    "CLAIMS", "DECISIONS", "TECHNICAL", "META", "MESSAGES", "CAPTURED",
    "SOURCE",
    # Generic strings users won't search for as IDs
    "NONE", "N/A", "TRUE", "FALSE", "NULL",
}

_MIN_LEN = 4
_MAX_LEN = 64


def _accept(token: str) -> bool:
    if not (_MIN_LEN <= len(token) <= _MAX_LEN):
        return False
    if token.upper() in _STOPWORDS:
        return False
    # Skip pure English words (no digits, no separators, all-alpha all-caps short)
    if token.isalpha() and len(token) < 6 and token.isupper():
        return False
    # Require at least one uppercase letter or digit run of 4+ — i.e. an
    # identifier-shape, not a plain English word like "Tuesday".
    if not re.search(r"[A-Z0-9]{4,}", token):
        return False
    return True


def extract_entities(text: str) -> set[str]:
    """Return the set of identifier-shaped tokens found in `text`.

    The set is order-independent and deduplicated. Callers can map it to
    chunk-id lists by calling this once per chunk and unioning per entity.
    """
    if not text:
        return set()
    found: set[str] = set()
    for m in _COMPOUND_RE.findall(text):
        if _accept(m):
            found.add(m)
    for m in _BARE_RE.findall(text):
        if _accept(m):
            found.add(m)
    return found


def extract_entities_per_chunk(
    chunks: list[dict],
) -> dict[str, list[int]]:
    """Walk a list of chunk dicts and return entity_name -> [chunk_index, ...].

    `chunks` items must have at least {chunk_index, text}.
    Order of the returned chunk_index lists is the order chunks were seen.
    """
    by_entity: dict[str, list[int]] = {}
    for ch in chunks:
        idx = ch.get("chunk_index")
        if idx is None:
            continue
        for name in extract_entities(ch.get("text", "")):
            by_entity.setdefault(name, []).append(idx)
    return by_entity
