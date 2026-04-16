"""
Tests for backend.database — CRUD operations, indexes, batch queries, and search.
"""

import json

from backend.database import (
    create_context,
    create_chunks,
    get_all_contexts,
    get_contexts_paginated,
    get_context,
    get_contexts_by_ids,
    get_chunks_by_context,
    update_context,
    delete_context,
    delete_chunks_by_context,
    toggle_context_starred,
    search_contexts,
    search_chunks_keyword,
    get_db_stats,
    get_all_collections,
    create_collection,
    update_collection,
    delete_collection,
    set_context_collection,
    _get_conn,
)


# ---------------------------------------------------------------------------
# Schema & indexes
# ---------------------------------------------------------------------------

class TestSchemaAndIndexes:
    def test_tables_created(self):
        conn = _get_conn()
        tables = [
            r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        ]
        assert "contexts" in tables
        assert "chunks" in tables
        assert "collections" in tables

    def test_indexes_created(self):
        """Verify our performance indexes exist after init_db()."""
        conn = _get_conn()
        indexes = [
            r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            ).fetchall()
        ]
        assert "idx_chunks_context" in indexes
        assert "idx_chunks_starred" in indexes
        assert "idx_contexts_status" in indexes
        assert "idx_contexts_starred" in indexes
        assert "idx_contexts_collection" in indexes

    def test_wal_mode_enabled(self):
        conn = _get_conn()
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode == "wal"


# ---------------------------------------------------------------------------
# Context CRUD
# ---------------------------------------------------------------------------

class TestContextCRUD:
    def test_create_context(self, sample_context):
        ctx = create_context(**sample_context)
        assert ctx["id"] is not None
        assert ctx["title"] == "Test Conversation"
        assert ctx["tags"] == ["ChatGPT", "Extension"]
        assert isinstance(ctx["summary"], dict)
        assert ctx["summary"]["main_topic"] == "Testing ContextVolt"
        assert ctx["status"] == "completed"
        assert ctx["starred"] is False

    def test_get_context(self, sample_context):
        created = create_context(**sample_context)
        fetched = get_context(created["id"])
        assert fetched is not None
        assert fetched["id"] == created["id"]
        assert fetched["title"] == created["title"]

    def test_get_context_not_found(self):
        assert get_context(99999) is None

    def test_update_context_title(self, sample_context):
        ctx = create_context(**sample_context)
        updated = update_context(ctx["id"], title="Updated Title")
        assert updated["title"] == "Updated Title"
        assert updated["id"] == ctx["id"]

    def test_update_context_tags(self, sample_context):
        ctx = create_context(**sample_context)
        updated = update_context(ctx["id"], tags=["NewTag", "Another"])
        assert updated["tags"] == ["NewTag", "Another"]

    def test_update_context_status(self, sample_context):
        ctx = create_context(**sample_context, status="summarizing")
        assert ctx["status"] == "summarizing"
        updated = update_context(ctx["id"], status="completed")
        assert updated["status"] == "completed"

    def test_update_no_changes(self, sample_context):
        ctx = create_context(**sample_context)
        result = update_context(ctx["id"])
        assert result["id"] == ctx["id"]

    def test_delete_context(self, sample_context):
        ctx = create_context(**sample_context)
        assert delete_context(ctx["id"]) is True
        assert get_context(ctx["id"]) is None

    def test_delete_context_not_found(self):
        assert delete_context(99999) is False

    def test_toggle_starred(self, sample_context):
        ctx = create_context(**sample_context)
        assert ctx["starred"] is False
        toggled = toggle_context_starred(ctx["id"])
        assert toggled["starred"] is True
        toggled2 = toggle_context_starred(ctx["id"])
        assert toggled2["starred"] is False


# ---------------------------------------------------------------------------
# Batch fetch (get_contexts_by_ids) — validates the N+1 fix
# ---------------------------------------------------------------------------

class TestBatchFetch:
    def test_empty_ids(self):
        result = get_contexts_by_ids([])
        assert result == {}

    def test_single_id(self, sample_context):
        ctx = create_context(**sample_context)
        result = get_contexts_by_ids([ctx["id"]])
        assert ctx["id"] in result
        assert result[ctx["id"]]["title"] == "Test Conversation"

    def test_multiple_ids(self, sample_context):
        ids = []
        for i in range(5):
            c = create_context(**{**sample_context, "title": f"Context {i}"})
            ids.append(c["id"])
        result = get_contexts_by_ids(ids)
        assert len(result) == 5
        for i, cid in enumerate(ids):
            assert result[cid]["title"] == f"Context {i}"

    def test_nonexistent_ids_ignored(self, sample_context):
        ctx = create_context(**sample_context)
        result = get_contexts_by_ids([ctx["id"], 99999, 88888])
        assert len(result) == 1
        assert ctx["id"] in result

    def test_returns_dict_keyed_by_id(self, sample_context):
        c1 = create_context(**{**sample_context, "title": "First"})
        c2 = create_context(**{**sample_context, "title": "Second"})
        result = get_contexts_by_ids([c2["id"], c1["id"]])
        assert result[c1["id"]]["title"] == "First"
        assert result[c2["id"]]["title"] == "Second"


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------

class TestPagination:
    def test_paginated_default(self, sample_context):
        for i in range(3):
            create_context(**{**sample_context, "title": f"Ctx {i}"})
        page = get_contexts_paginated(page=1, per_page=2)
        assert page["total"] == 3
        assert len(page["contexts"]) == 2
        assert page["has_more"] is True
        assert page["page"] == 1

    def test_paginated_second_page(self, sample_context):
        for i in range(3):
            create_context(**{**sample_context, "title": f"Ctx {i}"})
        page = get_contexts_paginated(page=2, per_page=2)
        assert len(page["contexts"]) == 1
        assert page["has_more"] is False

    def test_paginated_sort_oldest(self, sample_context):
        c1 = create_context(**{**sample_context, "title": "First"})
        c2 = create_context(**{**sample_context, "title": "Second"})
        page = get_contexts_paginated(sort="oldest")
        titles = [c["title"] for c in page["contexts"]]
        assert titles.index("First") < titles.index("Second")

    def test_paginated_collection_filter(self, sample_context):
        col = create_collection("Test Col")
        c1 = create_context(**{**sample_context, "title": "In collection"})
        c2 = create_context(**{**sample_context, "title": "No collection"})
        set_context_collection(c1["id"], col["id"])
        page = get_contexts_paginated(collection_id=col["id"])
        assert page["total"] == 1
        assert page["contexts"][0]["title"] == "In collection"


# ---------------------------------------------------------------------------
# Chunks
# ---------------------------------------------------------------------------

class TestChunks:
    def test_create_and_get_chunks(self, sample_context, sample_chunks):
        ctx = create_context(**sample_context)
        ids = create_chunks(ctx["id"], sample_chunks)
        assert len(ids) == 3
        fetched = get_chunks_by_context(ctx["id"])
        assert len(fetched) == 3
        assert fetched[0]["text"] == "USER: How do I write tests?"
        assert fetched[1]["is_starred"] is True
        assert fetched[2]["has_code"] is True

    def test_delete_chunks_by_context(self, sample_context, sample_chunks):
        ctx = create_context(**sample_context)
        create_chunks(ctx["id"], sample_chunks)
        count = delete_chunks_by_context(ctx["id"])
        assert count == 3
        assert get_chunks_by_context(ctx["id"]) == []

    def test_chunks_empty_for_new_context(self, sample_context):
        ctx = create_context(**sample_context)
        assert get_chunks_by_context(ctx["id"]) == []


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

class TestSearch:
    def test_search_contexts_by_title(self, sample_context):
        create_context(**sample_context)
        create_context(
            title="Unrelated",
            summary={"main_topic": "Other stuff"},
            tags=["Other"],
            original_chat="nothing here",
        )
        results = search_contexts("Test Conversation")
        assert len(results) == 1
        assert results[0]["title"] == "Test Conversation"

    def test_search_contexts_by_tag(self, sample_context):
        create_context(**sample_context)
        results = search_contexts("ChatGPT")
        assert len(results) == 1

    def test_search_contexts_no_match(self, sample_context):
        create_context(**sample_context)
        results = search_contexts("zzz_no_match_zzz")
        assert results == []

    def test_search_chunks_keyword(self, sample_context, sample_chunks):
        ctx = create_context(**sample_context)
        create_chunks(ctx["id"], sample_chunks)
        results = search_chunks_keyword("pytest")
        assert len(results) == 1
        assert results[0]["context_id"] == ctx["id"]
        assert results[0]["_keyword_match"] is True

    def test_search_chunks_keyword_no_match(self, sample_context, sample_chunks):
        ctx = create_context(**sample_context)
        create_chunks(ctx["id"], sample_chunks)
        results = search_chunks_keyword("zzz_nothing_zzz")
        assert results == []


# ---------------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------------

class TestCollections:
    def test_create_collection(self):
        col = create_collection("My Collection", "#ff0000")
        assert col["name"] == "My Collection"
        assert col["color"] == "#ff0000"
        assert col["count"] == 0

    def test_get_all_collections(self):
        create_collection("Col A")
        create_collection("Col B")
        cols = get_all_collections()
        assert len(cols) == 2
        names = {c["name"] for c in cols}
        assert names == {"Col A", "Col B"}

    def test_update_collection(self):
        col = create_collection("Original")
        updated = update_collection(col["id"], name="Renamed", color="#00ff00")
        assert updated["name"] == "Renamed"
        assert updated["color"] == "#00ff00"

    def test_delete_collection(self):
        col = create_collection("To Delete")
        assert delete_collection(col["id"]) is True
        assert get_all_collections() == []

    def test_delete_collection_not_found(self):
        assert delete_collection(99999) is False

    def test_set_context_collection(self, sample_context):
        col = create_collection("Target")
        ctx = create_context(**sample_context)
        result = set_context_collection(ctx["id"], col["id"])
        assert result["collection_id"] == col["id"]
        # Verify collection count
        cols = get_all_collections()
        assert cols[0]["count"] == 1

    def test_unset_context_collection(self, sample_context):
        col = create_collection("Target")
        ctx = create_context(**sample_context)
        set_context_collection(ctx["id"], col["id"])
        result = set_context_collection(ctx["id"], None)
        assert result["collection_id"] is None


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

class TestStats:
    def test_db_stats_empty(self):
        stats = get_db_stats()
        assert stats["contexts"] == 0
        assert stats["chunks"] == 0
        assert stats["collections"] == 0
        assert isinstance(stats["size_mb"], float)

    def test_db_stats_with_data(self, sample_context, sample_chunks):
        ctx = create_context(**sample_context)
        create_chunks(ctx["id"], sample_chunks)
        create_collection("Col")
        stats = get_db_stats()
        assert stats["contexts"] == 1
        assert stats["chunks"] == 3
        assert stats["collections"] == 1


# ---------------------------------------------------------------------------
# Crashed contexts — init_db marks stuck "summarizing" as "failed"
# ---------------------------------------------------------------------------

class TestCrashedContextRecovery:
    def test_stuck_summarizing_marked_failed(self, sample_context, _isolate_db):
        """Contexts stuck in 'summarizing' from a crash should be marked 'failed' on init."""
        from backend.database import init_db
        ctx = create_context(**{**sample_context, "status": "summarizing"})
        assert get_context(ctx["id"])["status"] == "summarizing"
        init_db()
        assert get_context(ctx["id"])["status"] == "failed"
