"""
Tests for the rate limiter — validates the deque-based sliding window implementation.
"""

import time
from collections import deque
from unittest.mock import patch

import pytest

from backend.main import _check_rate_limit, _rate_limit_store, _rate_limit_lock


@pytest.fixture(autouse=True)
def _clear_rate_limit_store():
    """Reset the rate limiter state before each test."""
    with _rate_limit_lock:
        _rate_limit_store.clear()
    yield
    with _rate_limit_lock:
        _rate_limit_store.clear()


class TestRateLimiterBasics:
    def test_allows_requests_under_limit(self):
        """Requests under the limit should not raise."""
        for _ in range(5):
            _check_rate_limit("127.0.0.1", "/api/summarize")

    def test_blocks_at_limit(self):
        """Exceeding the limit should raise HTTP 429."""
        from fastapi import HTTPException

        # /api/summarize limit is 10 req/60s
        for _ in range(10):
            _check_rate_limit("127.0.0.1", "/api/summarize")

        with pytest.raises(HTTPException) as exc_info:
            _check_rate_limit("127.0.0.1", "/api/summarize")
        assert exc_info.value.status_code == 429

    def test_different_clients_independent(self):
        """Rate limits are per-client."""
        from fastapi import HTTPException

        for _ in range(10):
            _check_rate_limit("10.0.0.1", "/api/summarize")

        # Different client should be unaffected
        _check_rate_limit("10.0.0.2", "/api/summarize")  # Should not raise

        # Original client should be blocked
        with pytest.raises(HTTPException):
            _check_rate_limit("10.0.0.1", "/api/summarize")

    def test_different_routes_independent(self):
        """Each route prefix has its own limit bucket."""
        from fastapi import HTTPException

        # Fill up /api/summarize (limit 10)
        for _ in range(10):
            _check_rate_limit("127.0.0.1", "/api/summarize")

        # /api/retrieve should still work (different bucket, limit 60)
        _check_rate_limit("127.0.0.1", "/api/retrieve")  # Should not raise


class TestDequeImplementation:
    def test_store_uses_deque(self):
        """Verify the store uses deque objects, not lists."""
        _check_rate_limit("127.0.0.1", "/api/summarize")
        key = "127.0.0.1:/api/summarize"
        assert key in _rate_limit_store
        assert isinstance(_rate_limit_store[key], deque)

    def test_expired_entries_evicted(self):
        """Old timestamps are evicted from the front of the deque."""
        key = "127.0.0.1:/api/summarize"
        # Pre-fill with old timestamps (older than 60s window)
        with _rate_limit_lock:
            _rate_limit_store[key] = deque([time.monotonic() - 120] * 10)

        # This should succeed because all entries are expired
        _check_rate_limit("127.0.0.1", "/api/summarize")
        assert len(_rate_limit_store[key]) == 1  # Only the new one


class TestSlidingWindowBehavior:
    def test_window_expiry_allows_new_requests(self):
        """After the window passes, requests should be allowed again."""
        from fastapi import HTTPException

        # Use /api/setup/pull-model which has a shorter limit (5 per 300s)
        # but we can test the concept with the capture endpoint (30 per 60s)
        # by manipulating timestamps directly
        key = "127.0.0.1:/api/capture"
        with _rate_limit_lock:
            # Fill to limit with timestamps 59 seconds old (just inside window)
            old = time.monotonic() - 59
            _rate_limit_store[key] = deque([old] * 30)

        with pytest.raises(HTTPException):
            _check_rate_limit("127.0.0.1", "/api/capture")

        # Now make them 61 seconds old (outside the 60s window)
        with _rate_limit_lock:
            old = time.monotonic() - 61
            _rate_limit_store[key] = deque([old] * 30)

        # Should succeed now — all entries expired
        _check_rate_limit("127.0.0.1", "/api/capture")


class TestStaleKeyCleanup:
    def test_empty_deques_cleaned_up(self):
        """Stale keys with empty deques are removed during periodic cleanup."""
        import backend.main as main_module

        # Insert an empty deque (simulates expired entries)
        with _rate_limit_lock:
            _rate_limit_store["stale:key"] = deque()

        # Force cleanup by making the last cleanup time very old
        original = main_module._rate_limit_last_cleanup
        main_module._rate_limit_last_cleanup = 0.0

        try:
            _check_rate_limit("127.0.0.1", "/api/health")
            # The stale key should have been cleaned
            assert "stale:key" not in _rate_limit_store
        finally:
            main_module._rate_limit_last_cleanup = original


class TestRouteMatching:
    def test_capture_route_matches(self):
        _check_rate_limit("127.0.0.1", "/api/capture")
        assert "127.0.0.1:/api/capture" in _rate_limit_store

    def test_summarize_route_matches(self):
        _check_rate_limit("127.0.0.1", "/api/summarize")
        assert "127.0.0.1:/api/summarize" in _rate_limit_store

    def test_retrieve_route_matches(self):
        _check_rate_limit("127.0.0.1", "/api/retrieve/search")
        assert "127.0.0.1:/api/retrieve" in _rate_limit_store

    def test_generic_api_fallback(self):
        _check_rate_limit("127.0.0.1", "/api/contexts")
        assert "127.0.0.1:/api/" in _rate_limit_store

    def test_first_matching_prefix_wins(self):
        """The first matching prefix in the list should be used."""
        _check_rate_limit("127.0.0.1", "/api/capture/something")
        # Should match /api/capture, not the generic /api/
        assert "127.0.0.1:/api/capture" in _rate_limit_store
        assert "127.0.0.1:/api/" not in _rate_limit_store
