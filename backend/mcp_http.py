"""
ContextVolt — MCP server, Streamable HTTP transport.

Mounts the same `Server` instance defined in `backend.mcp_server` (with all five
tools + context resources) on the existing FastAPI app at a configurable path
(default `/mcp`). Authentication is a bearer token sent in the
`Authorization: Bearer …` header.

Why one shared Server: zero duplication of tool logic between stdio and HTTP.
Whatever Claude Desktop / Cursor / Claude Code see locally over stdio is exactly
what ChatGPT / Grok / a remote Claude Desktop "custom connector" see over HTTP.

Wire-up (done in main.py):
    from backend.mcp_http import mount_mcp_http
    mount_mcp_http(app)

Token resolution order (first hit wins):
    1. config.json::mcp_http_token        (preferred — survives restarts)
    2. env var CONVX_MCP_HTTP_TOKEN
    3. auto-generated on first startup; persisted back into config.json
       and logged once at INFO level so the user can copy it.

To disable auth (NOT recommended for any non-loopback exposure), set
config.json::mcp_http_auth_required = false.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import secrets
import tempfile
from typing import Any

from fastapi import FastAPI
from starlette.responses import JSONResponse

from backend.mcp_server import server as mcp_server_instance

_log = logging.getLogger("contextvolt.mcp_http")

from backend.paths import config_path as _config_path
_CFG_PATH = str(_config_path())


# ----------------------------------------------------------------------
# Config helpers (kept local — same atomic-write pattern as elsewhere)
# ----------------------------------------------------------------------

def _read_config() -> dict:
    try:
        with open(_CFG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _write_config(data: dict) -> None:
    tmp_fd, tmp_path = tempfile.mkstemp(
        dir=os.path.dirname(_CFG_PATH), suffix=".tmp", prefix=".config_"
    )
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, _CFG_PATH)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _resolve_token() -> tuple[str, bool]:
    """Return (token, was_generated). Persists newly generated tokens."""
    cfg = _read_config()
    token = (cfg.get("mcp_http_token") or "").strip()
    if token:
        return token, False
    env = os.environ.get("CONVX_MCP_HTTP_TOKEN", "").strip()
    if env:
        return env, False
    new = "convx_" + secrets.token_urlsafe(24)
    cfg["mcp_http_token"] = new
    cfg.setdefault("mcp_http_auth_required", True)
    try:
        _write_config(cfg)
    except Exception as e:
        _log.warning("could not persist generated MCP token: %s", e)
    return new, True


def _auth_required() -> bool:
    return bool(_read_config().get("mcp_http_auth_required", True))


# ----------------------------------------------------------------------
# Mount
# ----------------------------------------------------------------------

# Shared between mount_mcp_http() (registers the route) and mcp_http_lifespan()
# (runs the session manager). Module-level so the ASGI handler and the lifespan
# see the same manager/ready flag without closing over locals.
_mcp: dict[str, Any] = {"manager": None, "ready": False, "path": "/mcp"}


@contextlib.asynccontextmanager
async def mcp_http_lifespan():
    """Run the MCP session manager for the app's lifetime.

    Wire this into FastAPI via `FastAPI(lifespan=...)`. A no-op if
    mount_mcp_http() was never called (e.g. stdio-only deployments).
    """
    manager = _mcp.get("manager")
    if manager is None:
        yield
        return

    token, generated = _resolve_token()
    if generated:
        _log.warning(
            "MCP HTTP token auto-generated. Copy this into your client config:\n"
            "  Authorization: Bearer %s",
            token,
        )
    else:
        _log.info("MCP HTTP transport enabled at %s (token configured)", _mcp["path"])

    stack = contextlib.AsyncExitStack()
    await stack.enter_async_context(manager.run())
    _mcp["ready"] = True
    try:
        yield
    finally:
        _mcp["ready"] = False
        try:
            await stack.aclose()
        except Exception as e:
            _log.warning("MCP HTTP shutdown error: %s", e)


def mount_mcp_http(app: FastAPI, path: str = "/mcp") -> None:
    """Attach the MCP Streamable HTTP transport to a FastAPI app.

    Registers a single ASGI route at `path` that handles all MCP traffic (POST
    for client→server, GET for the SSE stream, DELETE to terminate). The session
    manager lifecycle is driven separately by mcp_http_lifespan(), which the app
    must install via FastAPI(lifespan=...).
    """
    # Lazy import — keep the SDK out of the import graph until the user asks
    # for HTTP transport. Stdio-only deployments won't pay this cost.
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager

    _mcp["manager"] = StreamableHTTPSessionManager(
        app=mcp_server_instance,
        stateless=True,                # remote clients (Grok, ChatGPT, Claude.ai) send each
                                       # request independently — no session ID between calls
        json_response=False,           # use SSE streams (matches Anthropic remote-MCP spec)
    )
    _mcp["path"] = path

    async def _asgi_handler(scope, receive, send) -> None:
        # Method gate (DELETE used by clients to terminate sessions).
        method = scope.get("method", "GET")
        if method not in ("GET", "POST", "DELETE"):
            await _send_json(send, 405, {"error": "method not allowed"})
            return

        # Bearer-token check.
        if _auth_required():
            headers = {k.decode("latin-1").lower(): v.decode("latin-1")
                       for k, v in scope.get("headers", [])}
            authz = headers.get("authorization", "")
            expected, _ = _resolve_token()
            if not authz.startswith("Bearer ") or authz[7:].strip() != expected:
                await _send_json(send, 401, {"error": "missing or invalid bearer token"})
                return

        if not _mcp.get("ready"):
            await _send_json(send, 503, {"error": "MCP transport not ready"})
            return

        await _mcp["manager"].handle_request(scope, receive, send)

    # Register the ASGI route. Starlette's add_route doesn't support raw ASGI
    # callables, so we hand-roll a Mount-equivalent via the lower-level router.
    app.router.routes.append(_AsgiRoute(path, _asgi_handler))

    # Companion JSON endpoints for the setup UI / debugging.
    @app.get(f"{path}/_info")
    def mcp_http_info():
        cfg = _read_config()
        token = (cfg.get("mcp_http_token") or "").strip()
        return {
            "path": path,
            "auth_required": _auth_required(),
            "token_configured": bool(token),
            # Don't echo the full token in the response. Surface a stable hint
            # so the user can sanity-check which token is active without
            # exposing it to anyone who happens to load this URL.
            "token_hint": (token[:8] + "…" + token[-4:]) if len(token) >= 14 else "",
            "ready": _mcp.get("ready", False),
        }


def regenerate_http_token() -> str:
    """Generate a fresh token, persist to config.json, return the new value."""
    new = "convx_" + secrets.token_urlsafe(24)
    cfg = _read_config()
    cfg["mcp_http_token"] = new
    cfg.setdefault("mcp_http_auth_required", True)
    _write_config(cfg)
    return new


def get_http_token() -> str:
    """Return the current token (resolves env var if config is empty)."""
    token, _ = _resolve_token()
    return token


def get_auth_required() -> bool:
    return _auth_required()


def set_auth_required(required: bool) -> None:
    cfg = _read_config()
    cfg["mcp_http_auth_required"] = bool(required)
    _write_config(cfg)


# ----------------------------------------------------------------------
# Tiny ASGI route + helpers (we don't want a Starlette Route subclass)
# ----------------------------------------------------------------------

class _AsgiRoute:
    """Minimal Starlette-compatible route: matches an exact path, any method."""

    def __init__(self, path: str, handler) -> None:
        self.path = path
        self.handler = handler

    def matches(self, scope):
        from starlette.routing import Match
        if scope["type"] != "http":
            return Match.NONE, {}
        if scope.get("path") != self.path:
            return Match.NONE, {}
        return Match.FULL, {}

    async def handle(self, scope, receive, send):
        await self.handler(scope, receive, send)

    async def __call__(self, scope, receive, send):
        await self.handler(scope, receive, send)


async def _send_json(send, status: int, body: dict) -> None:
    payload = json.dumps(body).encode("utf-8")
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(payload)).encode("ascii")),
        ],
    })
    await send({"type": "http.response.body", "body": payload, "more_body": False})
