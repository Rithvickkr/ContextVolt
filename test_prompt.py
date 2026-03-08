import requests
import json
import sys

from backend.ollama_client import _parse_text_summary

prompt = """Summarize this conversation briefly.

CONVERSATION:
should i join codespire for 12 lpa or hcl tech for 10 lpa
Bro, let’s think about this like an engineer — not just salary, but trajectory.
... (Startup vs Service company advice) ...
What tech stack each uses
Then I’ll give you a very clear decision.

Write your summary in this exact format:
TOPIC: [one sentence describing the main topic]
POINTS: [list 2-4 key points, separated by semicolons]
DECIDED: [what was concluded or decided, or write "nothing yet"]
OPEN: [any unanswered questions, or write "none"]

Summary:"""

r = requests.post("http://localhost:11434/api/generate", json={
    "model": "phi3",
    "prompt": prompt,
    "stream": False,
    "options": {"temperature": 0.3, "num_predict": 512}
})

response_text = r.json().get("response")
print("RAW RESPONSE:")
print(response_text)
print("-" * 50)
print("PARSED:")
print(json.dumps(_parse_text_summary(response_text), indent=2))

