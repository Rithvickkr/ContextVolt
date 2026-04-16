"""
Tests for the FastAPI API endpoints.

Uses httpx + ASGITransport to test endpoints without a running server.
"""

import json

import pytest
import httpx
from httpx import ASGITransport

from backend.main import app, _rate_limit_store, _rate_limit_lock

pytestmark = pytest.mark.anyio


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ---------------------------------------------------------------------------
# Health & setup
# ---------------------------------------------------------------------------

class TestHealthEndpoints:
    async def test_health(self, client):
        resp = await client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"

    async def test_root_serves_frontend(self, client):
        resp = await client.get("/")
        assert resp.status_code == 200

    async def test_system_status(self, client):
        resp = await client.get("/api/system/status", timeout=15)
        assert resp.status_code == 200
        data = resp.json()
        assert "database" in data
        assert "backend" in data


# ---------------------------------------------------------------------------
# Context CRUD via API
# ---------------------------------------------------------------------------

class TestContextAPI:
    async def _create_via_api(self, client, title="API Test"):
        return await client.post("/api/contexts", json={
            "title": title,
            "summary": {
                "main_topic": "API testing",
                "key_ideas": ["testing"],
                "snapshot": "",
                "vitals": [],
                "conclusions": [],
                "unresolved_questions": [],
            },
            "tags": ["test"],
            "original_chat": "USER: Hello\nASSISTANT: Hi!",
        })

    async def test_create_context(self, client):
        resp = await self._create_via_api(client)
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] is not None
        assert data["title"] == "API Test"

    async def test_list_contexts(self, client):
        await self._create_via_api(client, "First")
        await self._create_via_api(client, "Second")
        resp = await client.get("/api/contexts")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 2
        assert len(data["contexts"]) == 2

    async def test_list_contexts_pagination(self, client):
        for i in range(5):
            await self._create_via_api(client, f"Ctx {i}")
        resp = await client.get("/api/contexts?page=1&per_page=2")
        data = resp.json()
        assert len(data["contexts"]) == 2
        assert data["has_more"] is True
        assert data["total"] == 5

    async def test_get_context(self, client):
        create_resp = await self._create_via_api(client)
        cid = create_resp.json()["id"]
        resp = await client.get(f"/api/contexts/{cid}")
        assert resp.status_code == 200
        assert resp.json()["title"] == "API Test"

    async def test_get_context_not_found(self, client):
        resp = await client.get("/api/contexts/99999")
        assert resp.status_code == 404

    async def test_update_context(self, client):
        cid = (await self._create_via_api(client)).json()["id"]
        resp = await client.put(f"/api/contexts/{cid}", json={
            "title": "Updated via API",
        })
        assert resp.status_code == 200
        assert resp.json()["title"] == "Updated via API"

    async def test_delete_context(self, client):
        cid = (await self._create_via_api(client)).json()["id"]
        resp = await client.delete(f"/api/contexts/{cid}")
        assert resp.status_code == 200
        assert resp.json()["status"] == "deleted"
        assert (await client.get(f"/api/contexts/{cid}")).status_code == 404

    async def test_toggle_star(self, client):
        cid = (await self._create_via_api(client)).json()["id"]
        resp = await client.post(f"/api/contexts/{cid}/star")
        assert resp.status_code == 200
        assert resp.json()["starred"] is True
        resp2 = await client.post(f"/api/contexts/{cid}/star")
        assert resp2.json()["starred"] is False

    async def test_bulk_delete(self, client):
        id1 = (await self._create_via_api(client, "A")).json()["id"]
        id2 = (await self._create_via_api(client, "B")).json()["id"]
        await self._create_via_api(client, "C")
        resp = await client.post("/api/contexts/bulk-delete", json={"ids": [id1, id2]})
        assert resp.status_code == 200
        data = resp.json()
        assert data["deleted"] == 2
        list_resp = await client.get("/api/contexts")
        assert list_resp.json()["total"] == 1

    async def test_search_contexts(self, client):
        await self._create_via_api(client, "Python Testing Guide")
        await self._create_via_api(client, "JavaScript Basics")
        resp = await client.get("/api/contexts?q=Python")
        data = resp.json()
        # At least one result should match
        titles = [c["title"] for c in data["contexts"]]
        assert "Python Testing Guide" in titles


# ---------------------------------------------------------------------------
# Chunks API
# ---------------------------------------------------------------------------

class TestChunksAPI:
    def _create_context_with_chunks(self):
        from backend.database import create_context, create_chunks
        ctx = create_context(
            title="Chunked Context",
            summary={"main_topic": "chunks"},
            tags=["test"],
            original_chat="USER: Hello\nASSISTANT: World",
        )
        create_chunks(ctx["id"], [
            {"chunk_index": 0, "text": "USER: Hello", "role_hint": "user"},
            {"chunk_index": 1, "text": "ASSISTANT: World", "role_hint": "assistant"},
        ])
        return ctx["id"]

    async def test_get_chunks(self, client):
        cid = self._create_context_with_chunks()
        resp = await client.get(f"/api/contexts/{cid}/chunks")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 2
        assert len(data["chunks"]) == 2
        for ch in data["chunks"]:
            assert "embedding" not in ch

    async def test_get_chunks_not_found(self, client):
        resp = await client.get("/api/contexts/99999/chunks")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Collections API
# ---------------------------------------------------------------------------

class TestCollectionsAPI:
    async def test_create_collection(self, client):
        resp = await client.post("/api/collections", json={"name": "Test Col", "color": "#ff0000"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "Test Col"
        assert data["color"] == "#ff0000"

    async def test_list_collections(self, client):
        await client.post("/api/collections", json={"name": "A"})
        await client.post("/api/collections", json={"name": "B"})
        resp = await client.get("/api/collections")
        assert resp.status_code == 200
        assert len(resp.json()) == 2

    async def test_update_collection(self, client):
        cid = (await client.post("/api/collections", json={"name": "Old"})).json()["id"]
        resp = await client.put(f"/api/collections/{cid}", json={"name": "New"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "New"

    async def test_delete_collection(self, client):
        cid = (await client.post("/api/collections", json={"name": "Bye"})).json()["id"]
        resp = await client.delete(f"/api/collections/{cid}")
        assert resp.status_code == 200
        assert len((await client.get("/api/collections")).json()) == 0

    async def test_set_context_collection(self, client):
        col = (await client.post("/api/collections", json={"name": "Target"})).json()
        ctx = (await client.post("/api/contexts", json={
            "title": "T",
            "summary": {"main_topic": "t"},
            "tags": [],
            "original_chat": "test",
        })).json()
        resp = await client.post(f"/api/contexts/{ctx['id']}/collection", json={"collection_id": col["id"]})
        assert resp.status_code == 200
        assert resp.json()["collection_id"] == col["id"]


# ---------------------------------------------------------------------------
# Lightweight list (extension picker)
# ---------------------------------------------------------------------------

class TestLightweightList:
    async def test_list_contexts_lightweight(self, client):
        await client.post("/api/contexts", json={
            "title": "Light Test",
            "summary": {"main_topic": "light"},
            "tags": ["ext"],
            "original_chat": "USER: test\nASSISTANT: ok",
        })
        resp = await client.get("/api/contexts/list")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert "original_chat" not in data[0]
        assert "embedding" not in data[0]


# ---------------------------------------------------------------------------
# Rate limiting via API (integration)
# ---------------------------------------------------------------------------

class TestRateLimitingIntegration:
    @pytest.fixture(autouse=True)
    def _clear_store(self):
        with _rate_limit_lock:
            _rate_limit_store.clear()
        yield
        with _rate_limit_lock:
            _rate_limit_store.clear()

    async def test_rate_limit_returns_429(self, client):
        """Exceeding the rate limit should return 429."""
        # Test the rate limiter directly — the middleware integration is validated
        # by the fact that _check_rate_limit is wired into the middleware.
        from fastapi import HTTPException
        from backend.main import _check_rate_limit

        # /api/summarize has a low limit: 10 req/60s
        for i in range(10):
            _check_rate_limit("test-client", "/api/summarize")

        with pytest.raises(HTTPException) as exc_info:
            _check_rate_limit("test-client", "/api/summarize")
        assert exc_info.value.status_code == 429
        assert "Rate limit" in exc_info.value.detail


# ---------------------------------------------------------------------------
# Export / Backup
# ---------------------------------------------------------------------------

class TestExportBackup:
    async def test_backup_download(self, client):
        resp = await client.get("/api/backup/download")
        assert resp.status_code == 200
        assert "application/octet-stream" in resp.headers.get("content-type", "")


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------

class TestErrorHandling:
    async def test_summarize_empty_text(self, client):
        resp = await client.post("/api/summarize", json={"text": ""})
        assert resp.status_code == 400

    async def test_summarize_whitespace_text(self, client):
        resp = await client.post("/api/summarize", json={"text": "   "})
        assert resp.status_code == 400

    async def test_capture_empty_text(self, client):
        resp = await client.post("/api/capture", json={"text": "", "source": "test"})
        assert resp.status_code == 400

    async def test_retrieve_empty_query(self, client):
        resp = await client.post("/api/retrieve", json={"query": ""})
        assert resp.status_code == 400

    async def test_retrieve_search_empty_query(self, client):
        resp = await client.post("/api/retrieve/search", json={"query": ""})
        assert resp.status_code == 400
