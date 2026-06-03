"""
Minimal OAuth 2.0 + PKCE server for ConVX's MCP endpoint.

Implements just enough OAuth to satisfy Grok, ChatGPT, and Claude.ai's
remote MCP connector flows — all of which require OAuth rather than a
static bearer token.

Flow (PKCE, no client secret):
  1. Client (Grok) redirects user to GET /oauth/authorize?...
  2. ConVX shows a one-click consent page in the user's browser.
  3. User clicks "Allow" → POST /oauth/authorize → redirect back with ?code=...
  4. Client calls POST /oauth/token with code + code_verifier.
  5. ConVX verifies PKCE, returns the existing MCP bearer token as access_token.

Security notes:
- Auth codes expire in 5 minutes and are single-use.
- The issued access_token IS the MCP bearer token — no new credential is created.
- PKCE code_challenge is always verified (S256 only).
- All endpoints except /oauth/authorize (GET) and /oauth/token are loopback-only.
"""

from __future__ import annotations

import base64
import hashlib
import html
import os
import secrets
import time
from typing import Optional

# In-memory store: code → {challenge, redirect_uri, client_id, expires_at}
_pending: dict[str, dict] = {}

CLIENT_ID = "convx"   # the value users paste into Grok's "Client ID" field


# ── PKCE helpers ─────────────────────────────────────────────────────────────

def _verify_pkce(code_verifier: str, stored_challenge: str) -> bool:
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    computed = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return secrets.compare_digest(computed, stored_challenge)


# ── Auth code store ───────────────────────────────────────────────────────────

def _new_code(challenge: str, redirect_uri: str, client_id: str) -> str:
    code = secrets.token_urlsafe(32)
    _pending[code] = {
        "challenge": challenge,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "expires_at": time.time() + 300,   # 5 minutes
    }
    _sweep()
    return code


def _pop_code(code: str) -> Optional[dict]:
    entry = _pending.pop(code, None)
    if not entry:
        return None
    if time.time() > entry["expires_at"]:
        return None
    return entry


def _sweep() -> None:
    now = time.time()
    stale = [k for k, v in _pending.items() if now > v["expires_at"]]
    for k in stale:
        _pending.pop(k, None)


# ── HTML consent page ─────────────────────────────────────────────────────────

def _consent_html(
    client_id: str,
    redirect_uri: str,
    challenge: str,
    challenge_method: str,
    state: str,
    error: str = "",
) -> str:
    esc = html.escape
    err_block = (
        f'<p style="color:#f87171;font-size:13px;margin-top:8px">{esc(error)}</p>'
        if error else ""
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ContextVolt — Allow Access</title>
<style>
  *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #09090b; color: #f0f0f0;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 24px;
  }}
  .card {{
    background: #17171c; border: 1px solid #2a2a3a;
    border-radius: 16px; padding: 36px 40px;
    max-width: 420px; width: 100%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }}
  .logo {{ font-size: 22px; font-weight: 700; margin-bottom: 6px; }}
  .logo span {{ color: #a0c0ff; }}
  .subtitle {{ font-size: 13px; color: #71717a; margin-bottom: 24px; }}
  h2 {{ font-size: 17px; font-weight: 600; margin-bottom: 8px; }}
  .scope-list {{
    background: #0f0f12; border: 1px solid #2a2a3a;
    border-radius: 10px; padding: 14px 16px; margin: 16px 0;
    font-size: 13px; line-height: 1.8;
  }}
  .scope-list li {{ list-style: none; padding-left: 18px; position: relative; }}
  .scope-list li::before {{ content: "✓"; position: absolute; left: 0; color: #34d399; }}
  .warn {{ font-size: 12px; color: #71717a; margin-bottom: 20px; }}
  .warn strong {{ color: #fbbf24; }}
  .btns {{ display: flex; gap: 10px; }}
  .btn {{
    flex: 1; padding: 11px; border-radius: 10px;
    border: none; font-size: 14px; font-weight: 600;
    cursor: pointer; transition: opacity 0.15s;
  }}
  .btn:hover {{ opacity: 0.85; }}
  .btn-allow {{ background: #a0c0ff; color: #09090b; }}
  .btn-deny {{ background: #2a2a3a; color: #a1a1aa; }}
  .client {{ color: #a0c0ff; font-weight: 600; }}
</style>
</head>
<body>
<div class="card">
  <div class="logo">Context<span>Volt</span></div>
  <div class="subtitle">MCP Vault Access Request</div>
  <h2><span class="client">{esc(client_id)}</span> wants to access your vault</h2>
  <ul class="scope-list">
    <li>Search your saved contexts (read-only)</li>
    <li>Read context summaries and chunks</li>
    <li>View vault statistics</li>
  </ul>
  <p class="warn">This grants <strong>{esc(client_id)}</strong> read access to everything in your vault. You can revoke it anytime by regenerating your MCP token in Settings.</p>
  {err_block}
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="redirect_uri" value="{esc(redirect_uri)}">
    <input type="hidden" name="code_challenge" value="{esc(challenge)}">
    <input type="hidden" name="code_challenge_method" value="{esc(challenge_method)}">
    <input type="hidden" name="client_id" value="{esc(client_id)}">
    <input type="hidden" name="state" value="{esc(state)}">
    <div class="btns">
      <button class="btn btn-deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="btn btn-allow" type="submit" name="decision" value="allow">Allow Access</button>
    </div>
  </form>
</div>
</body>
</html>"""


# ── Discovery document ────────────────────────────────────────────────────────

def authorization_server_metadata(base_url: str) -> dict:
    """RFC 8414 discovery document — some clients fetch this automatically."""
    return {
        "issuer": base_url,
        "authorization_endpoint": f"{base_url}/oauth/authorize",
        "token_endpoint": f"{base_url}/oauth/token",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
    }
