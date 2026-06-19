"""
OAuth 2.0 + PKCE routes for ContextVolt's MCP endpoint.

These are registered ONLY on the standalone MCP app (backend.mcp_app), which is
the only surface the Cloudflare tunnel exposes. Remote MCP clients (Grok,
ChatGPT, Claude.ai) complete the OAuth handshake here; the issued access_token
is the existing MCP bearer token — no new credential is created.

The full REST API (backend.main) does NOT register these routes: it is bound to
loopback and never tunneled, so it has no reason to expose an OAuth surface.
"""

from __future__ import annotations

from urllib.parse import urlencode

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse


def register_oauth_routes(app: FastAPI) -> None:
    """Attach /oauth/* and the RFC 8414 discovery doc to `app`."""

    @app.get("/.well-known/oauth-authorization-server", include_in_schema=False)
    def oauth_discovery(request: Request):
        """RFC 8414 discovery — some clients fetch this before starting OAuth."""
        from backend.oauth_server import authorization_server_metadata
        base = str(request.base_url).rstrip("/")
        return authorization_server_metadata(base)

    @app.get("/oauth/authorize", response_class=HTMLResponse, include_in_schema=False)
    def oauth_authorize_get(
        response_type: str = "",
        client_id: str = "",
        redirect_uri: str = "",
        code_challenge: str = "",
        code_challenge_method: str = "S256",
        state: str = "",
        scope: str = "",   # accepted but not used — we grant full vault read access
    ):
        """Show the user a consent page."""
        from backend.oauth_server import CLIENT_ID, _consent_html

        if response_type != "code":
            raise HTTPException(status_code=400, detail="only response_type=code is supported")
        if not redirect_uri:
            raise HTTPException(status_code=400, detail="redirect_uri required")
        if not code_challenge:
            raise HTTPException(status_code=400, detail="PKCE code_challenge required")
        if code_challenge_method != "S256":
            raise HTTPException(status_code=400, detail="only S256 code_challenge_method supported")

        return _consent_html(
            client_id=client_id or CLIENT_ID,
            redirect_uri=redirect_uri,
            challenge=code_challenge,
            challenge_method=code_challenge_method,
            state=state,
        )

    @app.post("/oauth/authorize", response_class=HTMLResponse, include_in_schema=False)
    async def oauth_authorize_post(
        decision: str = Form(...),
        redirect_uri: str = Form(...),
        code_challenge: str = Form(...),
        client_id: str = Form(default="convx"),
        state: str = Form(default=""),
    ):
        """User clicked Allow or Deny — redirect back to the client."""
        from backend.oauth_server import _new_code

        if decision != "allow":
            params = urlencode({"error": "access_denied", "state": state})
            return RedirectResponse(f"{redirect_uri}?{params}", status_code=302)

        code = _new_code(
            challenge=code_challenge,
            redirect_uri=redirect_uri,
            client_id=client_id,
        )
        params: dict = {"code": code}
        if state:
            params["state"] = state
        return RedirectResponse(f"{redirect_uri}?{urlencode(params)}", status_code=302)

    @app.post("/oauth/token", include_in_schema=False)
    async def oauth_token(
        grant_type: str = Form(default=""),
        code: str = Form(default=""),
        code_verifier: str = Form(default=""),
        redirect_uri: str = Form(default=""),
        client_id: str = Form(default=""),   # accepted for spec compliance, not validated
    ):
        """Exchange an auth code + PKCE verifier for the MCP bearer token."""
        from backend.oauth_server import _pop_code, _verify_pkce
        from backend.mcp_http import get_http_token

        def _err(error: str, desc: str = ""):
            body = {"error": error}
            if desc:
                body["error_description"] = desc
            return JSONResponse(body, status_code=400)

        if grant_type != "authorization_code":
            return _err("unsupported_grant_type")
        if not code:
            return _err("invalid_request", "code required")
        if not code_verifier:
            return _err("invalid_request", "code_verifier required")

        entry = _pop_code(code)
        if not entry:
            return _err("invalid_grant", "code not found or expired")
        if not _verify_pkce(code_verifier, entry["challenge"]):
            return _err("invalid_grant", "PKCE verification failed")
        if redirect_uri and redirect_uri != entry["redirect_uri"]:
            return _err("invalid_grant", "redirect_uri mismatch")

        token = get_http_token()
        return {
            "access_token": token,
            "token_type": "bearer",
            "expires_in": 315360000,   # 10 years — effectively non-expiring
            "scope": "",
        }
