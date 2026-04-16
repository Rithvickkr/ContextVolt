"""
Tests for the thread-local SQLite connection pooling.
"""

import threading
import sqlite3

import pytest

from backend.database import _get_conn, _thread_local, create_context, get_context


class TestConnectionReuse:
    def test_same_thread_reuses_connection(self):
        """Multiple _get_conn() calls on the same thread return the same object."""
        conn1 = _get_conn()
        conn2 = _get_conn()
        assert conn1 is conn2

    def test_connection_is_valid(self):
        """The reused connection should be functional."""
        conn = _get_conn()
        result = conn.execute("SELECT 1").fetchone()[0]
        assert result == 1

    def test_broken_connection_replaced(self):
        """If the cached connection is broken, a new one is created."""
        conn1 = _get_conn()
        # Simulate a broken connection
        conn1.close()
        conn2 = _get_conn()
        assert conn2 is not conn1
        # The new connection should work
        result = conn2.execute("SELECT 1").fetchone()[0]
        assert result == 1


class TestThreadIsolation:
    def test_different_threads_get_different_connections(self):
        """Each thread should get its own connection object."""
        connections = {}
        errors = []

        def worker(name):
            try:
                conn = _get_conn()
                connections[name] = id(conn)
                # Verify the connection works
                conn.execute("SELECT 1")
            except Exception as e:
                errors.append(e)

        t1 = threading.Thread(target=worker, args=("thread1",))
        t2 = threading.Thread(target=worker, args=("thread2",))
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        assert not errors, f"Threads raised errors: {errors}"
        assert len(connections) == 2
        assert connections["thread1"] != connections["thread2"]

    def test_concurrent_writes_safe(self, sample_context):
        """Multiple threads can write to the DB concurrently without corruption."""
        results = []
        errors = []

        def writer(index):
            try:
                ctx = create_context(
                    title=f"Thread {index}",
                    summary=sample_context["summary"],
                    tags=["test"],
                    original_chat=f"Chat from thread {index}",
                )
                results.append(ctx["id"])
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"Threads raised errors: {errors}"
        assert len(results) == 10
        # All IDs should be unique
        assert len(set(results)) == 10

    def test_concurrent_reads_safe(self, sample_context):
        """Multiple threads can read concurrently."""
        ctx = create_context(**sample_context)
        results = []
        errors = []

        def reader():
            try:
                fetched = get_context(ctx["id"])
                results.append(fetched["title"])
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=reader) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert all(r == "Test Conversation" for r in results)


class TestConnectionProperties:
    def test_wal_mode(self):
        """Connection should use WAL journal mode."""
        conn = _get_conn()
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode == "wal"

    def test_foreign_keys_enabled(self):
        """Connection should have foreign keys enabled."""
        conn = _get_conn()
        fk = conn.execute("PRAGMA foreign_keys").fetchone()[0]
        assert fk == 1

    def test_row_factory_set(self):
        """Connection should have Row factory set."""
        conn = _get_conn()
        assert conn.row_factory == sqlite3.Row

    def test_sqlite_vec_loaded(self):
        """sqlite-vec extension should be loaded and functional."""
        conn = _get_conn()
        # vec_version() is available when sqlite-vec is loaded
        try:
            version = conn.execute("SELECT vec_version()").fetchone()[0]
            assert version is not None
        except Exception:
            pytest.skip("sqlite-vec not available in test environment")
