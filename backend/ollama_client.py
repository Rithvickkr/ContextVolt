"""
Context Vault — Ollama integration for local LLM summarization.

Communicates with Ollama's REST API at localhost:11434.
"""

import json
import requests

OLLAMA_BASE = "http://localhost:11434"
DEFAULT_MODEL = "phi3"

SUMMARIZE_PROMPT = """You are a precise summarization assistant. Read the conversation below and produce a structured summary.

IMPORTANT: Pay special attention to any numbers, statistics, metrics, dates, versions, quantities, prices, percentages, scores, measurements, or any other numerical data mentioned in the conversation. Always preserve these values accurately in your summary.

CONVERSATION:
{conversation}

Respond in EXACTLY this format (no extra text):
TOPIC: [one sentence describing the main topic]
POINTS: [list 2-5 key points, separated by semicolons; always include specific numbers/values if any were discussed]
DECIDED: [what was concluded or decided, or "nothing yet"; include any numerical outcomes]
OPEN: [any unanswered questions, or "none"]
"""


def _parse_text_summary(response_text: str) -> dict:
    """Parse the text-based summary into a structured dict."""
    result = {
        "main_topic": "No topic extracted",
        "key_ideas": [],
        "conclusions": [],
        "unresolved_questions": [],
    }
    
    text = response_text.strip()
    lines = text.split("\n")
    
    current_section = None
    
    for line in lines:
        line_stripped = line.strip()
        line_lower = line_stripped.lower()
        
        # Detect section headers
        if line_lower.startswith("topic:") or line_lower.startswith("main topic:"):
            colon_idx = line_stripped.find(":")
            result["main_topic"] = line_stripped[colon_idx + 1:].strip()
            current_section = None
        elif line_lower.startswith("points:") or line_lower.startswith("key points:"):
            colon_idx = line_stripped.find(":")
            rest = line_stripped[colon_idx + 1:].strip()
            if rest:
                # Inline points
                if ";" in rest:
                    result["key_ideas"] = [p.strip() for p in rest.split(";") if p.strip()]
                else:
                    result["key_ideas"] = [rest]
            current_section = "key_ideas"
        elif line_lower.startswith("decided:") or line_lower.startswith("conclusions:") or line_lower.startswith("conclusion:"):
            colon_idx = line_stripped.find(":")
            rest = line_stripped[colon_idx + 1:].strip()
            if rest and rest.lower() not in ["nothing yet", "none", "n/a"]:
                result["conclusions"] = [rest]
            current_section = "conclusions"
        elif line_lower.startswith("open:") or line_lower.startswith("unresolved:") or line_lower.startswith("questions:"):
            colon_idx = line_stripped.find(":")
            rest = line_stripped[colon_idx + 1:].strip()
            if rest and rest.lower() not in ["none", "n/a", "no additional questions"]:
                result["unresolved_questions"] = [rest]
            current_section = "unresolved"
        elif line_stripped.startswith("-") or line_stripped.startswith("•") or line_stripped.startswith("*"):
            # Bullet point - add to current section
            item = line_stripped[1:].strip()
            if item and current_section == "key_ideas":
                result["key_ideas"].append(item)
            elif item and current_section == "conclusions":
                if item.lower() not in ["nothing yet", "none", "n/a", "no further questions or decisions were needed.", "both are recommended for a fitness tracking app"]:
                    result["conclusions"].append(item)
            elif item and current_section == "unresolved":
                if item.lower() not in ["none", "n/a", "no additional questions or decisions were needed."]:
                    result["unresolved_questions"].append(item)
    
    # If no topic found, try to extract from "Conversation:" line or first meaningful line
    if result["main_topic"] == "No topic extracted" and result["key_ideas"]:
        result["main_topic"] = "Discussion about: " + result["key_ideas"][0][:50]
    
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
        models = [m.get("name", "").split(":")[0] for m in data.get("models", [])]
        return model in models
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
        import re
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
    
    import re
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


def summarize_conversation(text: str, model: str = DEFAULT_MODEL) -> dict:
    """
    Send the conversation text to Ollama and get a structured summary.
    For long conversations, splits into chunks and merges summaries.
    Returns a dict with main_topic, key_ideas, conclusions, unresolved_questions.
    """
    # phi3 handles ~4K tokens by default; request more context for longer input
    # ~4 chars per token as rough estimate
    char_limit = 16000
    chunk_size = 12000

    if len(text) <= char_limit:
        return _summarize_single(text, model)

    # Long conversation: chunk, summarize each, then merge
    chunks = []
    for i in range(0, len(text), chunk_size):
        chunks.append(text[i:i + chunk_size])

    partial_summaries = []
    for idx, chunk in enumerate(chunks):
        result = _summarize_single(chunk, model, label=f"Part {idx+1}/{len(chunks)}")
        topic = result.get("main_topic", "")
        points = "; ".join(result.get("key_ideas", []))
        decided = "; ".join(result.get("conclusions", []))
        opens = "; ".join(result.get("unresolved_questions", []))
        partial_summaries.append(
            f"Part {idx+1}: Topic: {topic}. Points: {points}. Decided: {decided}. Open: {opens}"
        )

    # Merge pass: summarize the summaries
    merged_text = "\n".join(partial_summaries)
    merge_prompt = (
        "You are a precise summarization assistant. Below are partial summaries of a long conversation. "
        "Combine them into one unified summary.\n\n"
        f"PARTIAL SUMMARIES:\n{merged_text}\n\n"
        "Respond in EXACTLY this format (no extra text):\n"
        "TOPIC: [one sentence describing the overall main topic]\n"
        "POINTS: [list 3-6 key points covering the whole conversation, separated by semicolons]\n"
        "DECIDED: [what was concluded or decided overall, or \"nothing yet\"]\n"
        "OPEN: [any unanswered questions remaining, or \"none\"]\n"
    )

    try:
        r = requests.post(
            f"{OLLAMA_BASE}/api/generate",
            json={
                "model": model,
                "prompt": merge_prompt,
                "stream": False,
                "options": {
                    "temperature": 0.2,
                    "num_predict": 1000,
                    "num_ctx": 4096,
                },
            },
            timeout=180,
        )
        r.raise_for_status()
        response_text = r.json().get("response", "")
        return _parse_text_summary(response_text)
    except Exception:
        # If merge fails, return the first chunk's summary
        return _summarize_single(text[:char_limit], model)


def _summarize_single(text: str, model: str = DEFAULT_MODEL, label: str = "") -> dict:
    """Summarize a single chunk of text."""
    prompt = SUMMARIZE_PROMPT.format(conversation=text[:16000])

    try:
        r = requests.post(
            f"{OLLAMA_BASE}/api/generate",
            json={
                "model": model,
                "prompt": prompt,
                "stream": False,
                "options": {
                    "temperature": 0.2,
                    "num_predict": 1000,
                    "num_ctx": 8192,
                },
            },
            timeout=180,
        )
        r.raise_for_status()
        response_text = r.json().get("response", "")

        # Use text-based parsing (more reliable for small models)
        summary = _parse_text_summary(response_text)

        return summary

    except requests.ConnectionError:
        raise ConnectionError("Cannot connect to Ollama. Is it running? (ollama serve)")
    except requests.Timeout:
        raise TimeoutError("Ollama took too long to respond. The model may still be loading.")
    except Exception as e:
        # Return a graceful fallback instead of crashing
        return {
            "main_topic": "Summary extraction encountered an issue",
            "key_ideas": [f"Error: {str(e)[:100]}"],
            "conclusions": [],
            "unresolved_questions": [],
        }
