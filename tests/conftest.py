"""
Shared fixtures for ContextVolt tests.

Uses a temporary SQLite database per test so tests are isolated
and never touch the real context_volt.db.
"""

import os
import sys
import tempfile
import threading

import pytest

# Ensure the project root is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


@pytest.fixture(autouse=True)
def _isolate_db(tmp_path, monkeypatch):
    """Point the database layer at a temp file and re-init for every test."""
    import backend.database as db

    tmp_db = str(tmp_path / "test.db")
    monkeypatch.setattr(db, "DB_PATH", tmp_db)

    # Clear thread-local connection so the next _get_conn() uses the new path
    db._thread_local.conn = None

    db.init_db()
    yield tmp_db

    # Clean up thread-local connection after test
    conn = getattr(db._thread_local, "conn", None)
    if conn:
        try:
            conn.close()
        except Exception:
            pass
        db._thread_local.conn = None


@pytest.fixture
def sample_context():
    """Return kwargs suitable for create_context()."""
    return {
        "title": "Test Conversation",
        "summary": {
            "main_topic": "Testing ContextVolt",
            "key_ideas": ["unit tests", "integration tests"],
            "snapshot": "A test conversation about testing.",
            "vitals": [],
            "conclusions": ["Tests are good"],
            "unresolved_questions": [],
        },
        "tags": ["ChatGPT", "Extension"],
        "original_chat": "USER: How do I write tests?\nASSISTANT: Use pytest!",
    }


@pytest.fixture
def sample_chunks():
    """Return a list of chunk dicts suitable for create_chunks()."""
    return [
        {
            "chunk_index": 0,
            "text": "USER: How do I write tests?",
            "role_hint": "user",
            "has_code": False,
            "is_starred": False,
        },
        {
            "chunk_index": 1,
            "text": "ASSISTANT: Use pytest! It's the standard Python testing framework.",
            "role_hint": "assistant",
            "has_code": False,
            "is_starred": True,
        },
        {
            "chunk_index": 2,
            "text": "USER: Can you show me an example?\nASSISTANT: ```python\ndef test_add():\n    assert 1 + 1 == 2\n```",
            "role_hint": "mixed",
            "has_code": True,
            "is_starred": False,
        },
    ]


@pytest.fixture
def api_client():
    """Return a TestClient for the FastAPI app with an isolated DB."""
    from httpx import ASGITransport
    import httpx

    from backend.main import app

    transport = ASGITransport(app=app)
    with httpx.Client(transport=transport, base_url="http://test") as client:
        yield client
