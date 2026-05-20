"""Long-chat benchmark harness for ConVX summarization/continuation.

Generates a synthetic ~100-turn conversation with planted facts at varied
positions (opening / middle / closing), drives the real running backend via
/api/capture, waits for summarization to finish, then asks /api/contexts/{id}/prompt
for both no-query and query modes and scores recall@k of planted facts.

A planted fact embeds a unique 8-char token (e.g. "GH7A2X9Q") so a planted
fact is considered "recalled" iff its token appears verbatim in the returned
continuation prompt. This avoids LLM-paraphrase false negatives — the
question is whether the pipeline carries the literal signal through.

Usage:
    # Make sure the backend is running on 127.0.0.1:8000 (the default).
    python -m backend.eval.long_chat_harness

    # Custom host / fewer turns for a smoke run:
    python -m backend.eval.long_chat_harness --host http://127.0.0.1:8000 --turns 40

Output:
    Prints a table to stdout and writes a JSON report at
    backend/eval/baselines/<UTC-iso>_<short-sha>.json
"""
from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASELINES = HERE / "baselines"

DEFAULT_HOST = "http://127.0.0.1:8000"
DEFAULT_TURNS = 100
DEFAULT_FACTS = 20
SUMMARIZE_TIMEOUT_S = 600
POLL_INTERVAL_S = 3


# ---------------------------------------------------------------------------
# Fact + conversation generation
# ---------------------------------------------------------------------------

_TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I to avoid OCR-style ambiguity


def _mk_token(rng: random.Random) -> str:
    return "".join(rng.choices(_TOKEN_ALPHABET, k=8))


# Fact templates. Each template embeds {tok} which becomes the planted token.
# The query is what we ask later to test query-mode retrieval.
_FACT_TEMPLATES = [
    ("The production deploy key is {tok}.",                          "what is the production deploy key"),
    ("Our Postgres replica password is set to {tok} in vault.",      "postgres replica password"),
    ("The build artifact SHA we shipped is {tok}.",                  "build artifact sha we shipped"),
    ("Bug ticket reference: INC-{tok} (P1, customer-facing).",       "the P1 customer bug ticket reference"),
    ("The encryption key id is {tok} (rotates quarterly).",          "encryption key id"),
    ("Our staging hostname is host-{tok}.internal.",                 "staging hostname"),
    ("The pricing tier code agreed with finance is {tok}.",          "pricing tier code from finance"),
    ("Release tag for the hotfix is v9.{tok}.",                      "release tag for the hotfix"),
    ("Migration script id assigned by ops: M_{tok}.",                "migration script id from ops"),
    ("Feature flag name: ff_{tok} (default off).",                   "feature flag name we agreed on"),
    ("Customer escalation case: CASE-{tok}.",                        "customer escalation case number"),
    ("The runbook anchor is rb#{tok}.",                              "runbook anchor"),
    ("OAuth client id given by vendor: {tok}.",                      "oauth client id from vendor"),
    ("The kafka topic created for this is evt.{tok}.",               "kafka topic name"),
    ("Approved budget code from procurement is BC-{tok}.",           "approved budget code from procurement"),
    ("Security review ticket: SR-{tok}.",                            "security review ticket"),
    ("Index name in OpenSearch: idx_{tok}.",                         "opensearch index name"),
    ("Cron job id reserved: cron_{tok}.",                            "reserved cron job id"),
    ("Dashboard slug shared with PM: dash-{tok}.",                   "dashboard slug shared with PM"),
    ("API gateway route id: route-{tok}.",                           "api gateway route id"),
    ("Worker pool tag agreed on: pool_{tok}.",                       "worker pool tag"),
    ("Backup retention policy code: BR-{tok}.",                      "backup retention policy code"),
    ("Test fixture path everyone uses: fix/{tok}.json.",             "shared test fixture path"),
    ("CDN purge key for emergencies: {tok}.",                        "cdn purge key for emergencies"),
]

# Filler turns that pad the conversation between planted facts.
_USER_FILLERS = [
    "Got it. Can you also walk me through how we'd roll this back if something goes wrong?",
    "What's the impact if the latency budget is exceeded during peak hours?",
    "Are there any open questions from the architecture review we still need to close?",
    "How does this interact with the existing rate-limiter on the edge?",
    "What's the rough effort estimate — days, not weeks, right?",
    "Who owns the on-call rotation while this is being rolled out?",
    "Should we cut a feature flag for this or is it safe to ship directly?",
    "Can you summarise the trade-offs vs. the alternative we discussed last week?",
    "What metrics should we add to the dashboard to catch regressions?",
    "How will this affect the cold-start latency for first-time users?",
    "Are we comfortable with the failure modes, or do we need a kill-switch?",
    "Does this change any of the SLAs we've published?",
    "What does the test plan look like — unit, integration, load?",
    "Is there a dependency on the platform migration that's already underway?",
    "Have we got buy-in from the data team for the schema changes?",
]

_ASSIST_FILLERS = [
    "Sure — rollback would mean reverting the migration, redeploying the previous artifact, and clearing caches. Estimated 10–15 minutes if we have on-call paged.",
    "If we breach the latency budget we'd see customer-facing 5xx and an alert on the API SLI dashboard. We'd auto-shed traffic via the edge limiter.",
    "From the review, the only outstanding question is around backpressure handling under sustained load. Otherwise we're aligned.",
    "It sits behind the same edge rate-limiter; we'd add a route-specific bucket so noisy clients don't starve others.",
    "Maybe four to six engineering days, plus two for review and rollout.",
    "On-call is paged for the team owning the service; secondary is the platform group, just in case.",
    "I'd put it behind a flag — gives us a one-line rollback if telemetry looks off in the first hour.",
    "Compared to last week's option, we trade about 5% steady-state CPU for a much simpler operational model.",
    "We should add p95 / p99 of the new code path, plus an error-rate panel split by route.",
    "Cold-start should be unaffected; the new code only kicks in on warm requests.",
    "We've thought through the obvious failures. A kill-switch on the orchestrator gives us a fast off-ramp.",
    "No change to published SLAs; internal SLOs may tighten slightly once we measure real numbers.",
    "Unit + a focused integration suite, plus a short load test against staging before flipping the flag at 1%.",
    "There is a soft dependency, but we can ship before that migration completes if we keep the old code path live.",
    "Data team signed off on the schema yesterday — the new column is nullable with a default for back-fill.",
]


@dataclass
class PlantedFact:
    token: str
    sentence: str        # the full sentence containing the token, embedded into the convo
    query: str           # what we ask to test query-mode retrieval
    position: str        # "opening" / "middle" / "closing"
    turn_index: int      # 0-based turn index in the assistant stream


def generate_conversation(turns: int, n_facts: int, seed: int) -> tuple[str, list[PlantedFact]]:
    """Return (full chat as one string, list of planted facts).

    Facts are placed in assistant turns at varied positions:
      - first third  -> "opening"
      - middle third -> "middle"
      - last third   -> "closing"
    """
    rng = random.Random(seed)
    n_facts = min(n_facts, len(_FACT_TEMPLATES))
    chosen_templates = rng.sample(_FACT_TEMPLATES, n_facts)

    # Allocate fact-bearing turn indices roughly evenly across the conversation.
    third = turns // 3
    bands = {
        "opening": list(range(0, third)),
        "middle":  list(range(third, 2 * third)),
        "closing": list(range(2 * third, turns)),
    }
    per_band = n_facts // 3
    leftover = n_facts - per_band * 3
    plan = []
    for i, band in enumerate(bands):
        k = per_band + (1 if i < leftover else 0)
        plan.extend((band, idx) for idx in rng.sample(bands[band], k))

    fact_at_turn: dict[int, PlantedFact] = {}
    for (band, turn_idx), (template, query) in zip(plan, chosen_templates):
        tok = _mk_token(rng)
        sentence = template.format(tok=tok)
        fact_at_turn[turn_idx] = PlantedFact(
            token=tok, sentence=sentence, query=query, position=band, turn_index=turn_idx,
        )

    # Assemble the transcript. The browser-extension capture uses lines starting
    # with "User:" / "Assistant:" — match that shape.
    lines: list[str] = []
    for t in range(turns):
        user_msg = _USER_FILLERS[rng.randrange(len(_USER_FILLERS))]
        lines.append(f"User: {user_msg}")
        assist_msg = _ASSIST_FILLERS[rng.randrange(len(_ASSIST_FILLERS))]
        if t in fact_at_turn:
            # Embed the planted fact in this assistant turn so it's a real
            # piece of the conversation, not an out-of-band annotation.
            assist_msg = f"{assist_msg} For the record: {fact_at_turn[t].sentence}"
        lines.append(f"Assistant: {assist_msg}")

    return "\n\n".join(lines), list(fact_at_turn.values())


# ---------------------------------------------------------------------------
# HTTP helpers (stdlib only)
# ---------------------------------------------------------------------------


def _post(host: str, path: str, body: dict, timeout: float = 60) -> dict:
    req = urllib.request.Request(
        host + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get(host: str, path: str, timeout: float = 30) -> dict:
    with urllib.request.urlopen(host + path, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


def score_recall(prompt: str, facts: list[PlantedFact]) -> dict:
    """Recall = fraction of planted-fact tokens present in `prompt`."""
    by_position: dict[str, dict[str, int]] = {"opening": {"hit": 0, "n": 0},
                                              "middle":  {"hit": 0, "n": 0},
                                              "closing": {"hit": 0, "n": 0}}
    hits = []
    for f in facts:
        present = f.token in prompt
        by_position[f.position]["n"] += 1
        if present:
            by_position[f.position]["hit"] += 1
            hits.append(f.token)
    total = len(facts)
    hit = sum(b["hit"] for b in by_position.values())
    return {
        "recall": hit / total if total else 0.0,
        "hits": hit,
        "total": total,
        "by_position": {
            k: {"recall": (v["hit"] / v["n"]) if v["n"] else 0.0, **v}
            for k, v in by_position.items()
        },
        "hit_tokens": hits,
    }


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


@dataclass
class RunResult:
    label: str
    mode: str
    size: str
    prompt_len: int
    score: dict


def run_harness(host: str, turns: int, n_facts: int, seed: int) -> dict:
    print(f"[harness] generating conversation: turns={turns}, facts={n_facts}, seed={seed}")
    chat, facts = generate_conversation(turns, n_facts, seed)
    print(f"[harness] conversation size: {len(chat):,} chars, {len(facts)} facts planted")

    # POST capture
    print(f"[harness] POST {host}/api/capture")
    cap = _post(host, "/api/capture", {
        "text": chat,
        "source": "Benchmark",
        "important_snippets": [],
        "conversation_url": f"convx-benchmark://{int(time.time())}-{seed}",
    })
    ctx_id = cap["id"]
    print(f"[harness] context_id={ctx_id}, waiting for summarization to finish...")

    # Poll until status != summarizing
    deadline = time.time() + SUMMARIZE_TIMEOUT_S
    last_status = None
    while time.time() < deadline:
        ctx = _get(host, f"/api/contexts/{ctx_id}")
        status = ctx.get("status")
        if status != last_status:
            print(f"[harness]   status={status} (t+{int(time.time() - (deadline - SUMMARIZE_TIMEOUT_S))}s)")
            last_status = status
        if status in ("completed", "failed"):
            break
        time.sleep(POLL_INTERVAL_S)
    else:
        raise SystemExit(f"timed out waiting for summarization after {SUMMARIZE_TIMEOUT_S}s")
    if status == "failed":
        raise SystemExit("summarization status=failed; cannot benchmark")

    results: list[RunResult] = []

    # No-query path at each prompt size
    for size in ("compact", "standard", "full"):
        r = _post(host, f"/api/contexts/{ctx_id}/prompt?size={size}", {})
        prompt = r["prompt"]
        sc = score_recall(prompt, facts)
        results.append(RunResult(
            label=f"no-query/{size}", mode=r.get("mode", "?"), size=size,
            prompt_len=len(prompt), score=sc,
        ))
        print(f"[harness] no-query size={size:<8} mode={r.get('mode')}: "
              f"recall={sc['recall']:.2f} ({sc['hits']}/{sc['total']}), prompt={len(prompt):,} chars")

    # Query path — sample up to 6 facts spread across positions
    sample_per_band = 2
    sample: list[PlantedFact] = []
    for band in ("opening", "middle", "closing"):
        sample.extend([f for f in facts if f.position == band][:sample_per_band])
    print(f"[harness] query mode: testing {len(sample)} sampled facts")
    query_hits = 0
    per_query = []
    for f in sample:
        r = _post(host, f"/api/contexts/{ctx_id}/prompt?size=standard",
                  {"query": f.query, "size": "standard"})
        prompt = r["prompt"]
        present = f.token in prompt
        if present:
            query_hits += 1
        per_query.append({
            "token": f.token, "position": f.position, "query": f.query,
            "recalled": present, "prompt_len": len(prompt), "mode": r.get("mode"),
        })
    query_recall = query_hits / len(sample) if sample else 0.0
    print(f"[harness] query mode recall: {query_recall:.2f} ({query_hits}/{len(sample)})")
    results.append(RunResult(
        label="query/sampled", mode="retrieval", size="standard",
        prompt_len=0, score={"recall": query_recall, "hits": query_hits,
                             "total": len(sample), "per_query": per_query},
    ))

    return {
        "config": {"host": host, "turns": turns, "n_facts": n_facts, "seed": seed,
                   "chat_chars": len(chat), "context_id": ctx_id},
        "results": [asdict(r) for r in results],
        "facts": [asdict(f) for f in facts],
    }


def _git_sha() -> str:
    try:
        out = subprocess.check_output(["git", "rev-parse", "--short=10", "HEAD"],
                                      stderr=subprocess.DEVNULL).decode().strip()
        return out or "nogit"
    except Exception:
        return "nogit"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--host", default=DEFAULT_HOST)
    p.add_argument("--turns", type=int, default=DEFAULT_TURNS)
    p.add_argument("--facts", type=int, default=DEFAULT_FACTS)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--label", default="", help="optional label written into the report filename")
    args = p.parse_args(argv)

    report = run_harness(args.host, args.turns, args.facts, args.seed)
    BASELINES.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    sha = _git_sha()
    label = f"_{args.label}" if args.label else ""
    out_path = BASELINES / f"{stamp}_{sha}{label}.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"[harness] report written: {out_path}")

    # Compact stdout summary
    print("\n=== summary ===")
    for r in report["results"]:
        sc = r["score"]
        if "by_position" in sc:
            bp = sc["by_position"]
            print(f"  {r['label']:<20} recall={sc['recall']:.2f}  "
                  f"open={bp['opening']['recall']:.2f}  mid={bp['middle']['recall']:.2f}  "
                  f"close={bp['closing']['recall']:.2f}")
        else:
            print(f"  {r['label']:<20} recall={sc['recall']:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
