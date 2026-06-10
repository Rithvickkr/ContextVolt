// ContextVolt — Worker status polling + app-wide summarizing poll.
import { $, API, state } from './core.js';
import { renderDetail } from './detail.js';
import { showToast } from './dialogs.js';
// â”€â”€â”€ Worker Status Polling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _workerPollTimer = null;

function startWorkerPolling() {
    stopWorkerPolling();
    _workerPollTimer = setInterval(_pollSummarizingContexts, 3000);
}

function stopWorkerPolling() {
    if (_workerPollTimer) {
        clearInterval(_workerPollTimer);
        _workerPollTimer = null;
    }
}

async function _pollSummarizingContexts() {
    // Collect IDs that are still 'summarizing' from library list
    const summarizingIds = state.contexts
        .filter(c => c.status === 'summarizing')
        .map(c => c.id);

    // Also watch the currently-open detail view
    const detailId = state.currentContext && state.currentContext.status === 'summarizing'
        ? state.currentContext.id : null;

    const idsToCheck = [...new Set([...summarizingIds, ...(detailId ? [detailId] : [])])];
    if (idsToCheck.length === 0) {
        // Nothing pending — stop polling
        stopWorkerPolling();
        return;
    }

    // Fetch each and update state / UI
    for (const id of idsToCheck) {
        try {
            const res = await fetch(`${API}/api/contexts/${id}`);
            if (!res.ok) continue;
            const fresh = await res.json();

            // Update library list state
            const idx = state.contexts.findIndex(c => c.id === id);
            if (idx !== -1) state.contexts[idx] = fresh;

            // Update detail view if open
            if (state.currentContext && state.currentContext.id === id) {
                state.currentContext = fresh;
                // Only re-render the status banner, not the whole detail
                const banner = document.getElementById('detail-status-banner');
                if (banner) {
                    const newBanner = _buildDetailStatusBanner(fresh.status);
                    banner.outerHTML = newBanner;
                } else if (fresh.status !== 'summarizing') {
                    // Banner was removed (status changed) — re-render full detail
                    renderDetail(fresh);
                }
            }

            // If status changed from summarizing, refresh the card
            // (toast is handled by _globalSummarizingPoll to avoid duplicates)
            if (fresh.status !== 'summarizing' && state.view === 'library') {
                _refreshCard(fresh);
            }
        } catch (_) { /* ignore individual errors */ }
    }
}

function _buildDetailStatusBanner(status) {
    if (status === 'summarizing') {
        return `<div class="detail-status-banner status-summarizing" id="detail-status-banner">
            <div class="detail-status-icon"><span class="detail-spinner"></span></div>
            <div class="detail-status-text">
                <strong>Summarizing in background…</strong>
                <span>The AI is building a full summary. This page will update automatically when it's ready.</span>
            </div>
        </div>`;
    } else if (status === 'failed') {
        return `<div class="detail-status-banner status-failed" id="detail-status-banner">
            <div class="detail-status-icon">\u26A0\uFE0F</div>
            <div class="detail-status-text">
                <strong>Summarization failed</strong>
                <span>The background worker could not complete the summary.</span>
            </div>
            <button class="btn btn-secondary btn-retry-summarize" onclick="retrySummarize()">Retry</button>
        </div>`;
    }
    return '';
}

function _buildCardStatusBadge(status) {
    if (status === 'summarizing') {
        return `<span class="status-badge status-summarizing"><span class="badge-spinner"></span>Summarizing</span>`;
    } else if (status === 'failed') {
        return `<span class="status-badge status-failed">âš  Failed</span>`;
    }
    return '';
}

function _refreshCard(ctx) {
    // Find and update an existing card in the grid without full re-render
    const grid = $('#contexts-grid');
    if (!grid) return;
    const cards = grid.querySelectorAll('.context-card');
    for (const card of cards) {
        const onclick = card.getAttribute('onclick') || '';
        if (onclick.includes(`showDetail(${ctx.id})`)) {
            // Remove old badge if any
            const old = card.querySelector('.status-badge');
            if (old) old.remove();
            // No new badge needed since status is no longer 'summarizing'
            break;
        }
    }
}

// ─── Global summarizing poll ─────────────────────────────────────────────────
// Runs app-wide (any view) so toasts fire even when the library is never opened.
let _globalPollTimer = null;
let _globalPollPrevIds = new Set();

async function _globalSummarizingPoll() {
    try {
        const res = await fetch(`${API}/api/contexts/summarizing`);
        if (!res.ok) return;
        const { contexts } = await res.json();
        const currentIds = new Set(contexts.map(c => c.id));

        // IDs that were summarizing last tick but aren't now → just finished
        for (const id of _globalPollPrevIds) {
            if (!currentIds.has(id)) {
                // Fetch the finished context to get its real status + title
                try {
                    const r = await fetch(`${API}/api/contexts/${id}`);
                    if (r.ok) {
                        const ctx = await r.json();
                        const label = ctx.title ? `"${ctx.title}"` : 'Context';
                        if (ctx.status === 'failed') {
                            showToast(`${label} summarization failed`, 'error');
                        } else {
                            showToast(`${label} has been summarized`, 'success');
                        }
                        // Refresh the card if library is visible
                        if (state.view === 'library') _refreshCard(ctx);
                    }
                } catch (_) {}
            }
        }

        _globalPollPrevIds = currentIds;

        // Heartbeat: poll fast (4s) while work is in flight, slow (15s) when idle.
        // The slow heartbeat is critical so extension captures get noticed without
        // the user having to click anything.
        const nextDelay = currentIds.size > 0 ? 4000 : 15000;
        _globalPollTimer = setTimeout(_globalSummarizingPoll, nextDelay);
    } catch (_) {
        // Network hiccup — retry in 8 s
        _globalPollTimer = setTimeout(_globalSummarizingPoll, 8000);
    }
}

function _startGlobalSummarizingPoll() {
    if (_globalPollTimer) return; // already running
    _globalSummarizingPoll();
}

// Call this whenever a new context enters 'summarizing' state (extension capture, retry, etc.)
function _kickGlobalPoll() {
    if (!_globalPollTimer) _startGlobalSummarizingPoll();
}


export { _buildDetailStatusBanner, _kickGlobalPoll, _startGlobalSummarizingPoll, startWorkerPolling };
