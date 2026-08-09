"""
ContextVolt — standalone MCP-only ASGI app for safe remote exposure.

This is the ONLY app the Cloudflare tunnel is pointed at. It exposes exactly the
surface a remote MCP client (Grok, ChatGPT, Claude.ai) needs and nothing else:

  - /mcp                                    (bearer-token gated MCP transport)
  - /oauth/authorize, /oauth/token          (OAuth 2.0 + PKCE)
  - /.well-known/oauth-authorization-server (discovery)

The full REST API + frontend live on a separate FastAPI app (backend.main) bound
to loopback and never tunneled. Because the tunnel forwards a *port*, not a path,
isolation here is topological: a remote client physically cannot reach /api/*,
the updater, or the loopback admin endpoints — they don't exist on this app.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from backend.mcp_http import mount_mcp_http, mcp_http_lifespan
from backend.oauth_routes import register_oauth_routes


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # Drives the MCP HTTP session manager for this app's lifetime.
    async with mcp_http_lifespan():
        yield


def build_mcp_app() -> FastAPI:
    """Construct the MCP-only ASGI app. Call once; serve on its own port."""
    app = FastAPI(
        title="ContextVolt MCP",
        version="2.8.0",
        lifespan=_lifespan,
        # No interactive docs / schema on the public surface.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    mount_mcp_http(app, path="/mcp")
    register_oauth_routes(app)
    return app
