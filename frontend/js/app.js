/**
 * ContextVolt — Frontend SPA
 *
 * Vanilla JS single-page application.
 * Handles: Setup Wizard, Chat Input, Context Library, Detail View, Prompt Builder.
 */

const API = '';  // Use same-origin so fetches go to whatever host pywebview loaded (127.0.0.1 or localhost)

// â”€â”€â”€ Global error handler — prevents silent freezes in pywebview â”€â”€
window.addEventListener('error', e => {
    console.error('Uncaught error:', e.message, e.filename, e.lineno, e.error && e.error.stack);
    try { showToast(`JS Error: ${e.message}`, 'error'); } catch (_) {}
});
window.addEventListener('unhandledrejection', e => {
    console.error('Unhandled promise rejection:', e.reason, e.reason && e.reason.stack);
    try { showToast(`Error: ${e.reason?.message || e.reason}`, 'error'); } catch (_) {}
});

// â”€â”€â”€ Theme â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.settings-theme-opt').forEach(btn => {
        const active = btn.dataset.theme === theme;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
}

function setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') return;
    _applyTheme(theme);
    localStorage.setItem('cv-theme', theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    setTheme(current === 'dark' ? 'light' : 'dark');
}

// Restore saved theme on load
(function() {
    const saved = localStorage.getItem('cv-theme') || 'dark';
    _applyTheme(saved);
})();

// â”€â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const state = {
    view: 'input',           // 'input' | 'library' | 'detail'
    contexts: [],
    currentContext: null,
    currentPrompt: null,
    setupComplete: false,
    ollamaReady: false,
    libraryPage: 1,
    libraryHasMore: false,
    activeTagFilter: null,
    sortOrder: 'newest',
    selectMode: false,
    selectedIds: new Set(),
    pendingDeletes: new Map(),  // id -> { timer, ctx }
    collections: [],           // [{id, name, color, count}]
    activeCollection: null,    // collection id or null (all)
    newCollectionColor: '#6366f1',
    totalContextCount: 0,      // global unfiltered total, for the "All" badge
    searchQuery: '',           // current search query for highlighting
};

// â”€â”€â”€ P2-2: Source badge constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _KNOWN_SOURCES = ['ChatGPT', 'Claude', 'Gemini', 'Grok', 'DeepSeek', 'Perplexity', 'Copilot'];

// Brand colors per AI model — used on library cards so users can recognize source at a glance.
const _AI_BRAND = {
    'ChatGPT':    { label: 'ChatGPT',    color: '#10a37f', bg: 'rgba(16,163,127,0.14)',  border: 'rgba(16,163,127,0.38)' },
    'Claude':     { label: 'Claude',     color: '#d97757', bg: 'rgba(217,119,87,0.14)',  border: 'rgba(217,119,87,0.38)' },
    'Gemini':     { label: 'Gemini',     color: '#4285f4', bg: 'rgba(66,133,244,0.14)',  border: 'rgba(66,133,244,0.38)' },
    'Grok':       { label: 'Grok',       color: '#e5e5e7', bg: 'rgba(229,229,231,0.10)', border: 'rgba(229,229,231,0.32)' },
    'DeepSeek':   { label: 'DeepSeek',   color: '#4d6bfe', bg: 'rgba(77,107,254,0.14)',  border: 'rgba(77,107,254,0.38)' },
    'Perplexity': { label: 'Perplexity', color: '#20c5c5', bg: 'rgba(32,197,197,0.14)',  border: 'rgba(32,197,197,0.38)' },
    'Copilot':    { label: 'Copilot',    color: '#5ea0ef', bg: 'rgba(94,160,239,0.14)',  border: 'rgba(94,160,239,0.38)' },
};

// Capture-method tags that should appear as the card's source chip (bottom) — not as a tag chip.
const _CAPTURE_TAGS = new Set([
    'extension', 'Extension', 'EXTENSION',
    'paste', 'Paste', 'PASTE',
    'import', 'Import', 'IMPORT',
    'api', 'API',
    'upload', 'Upload',
]);

function _getAIBrand(tags) {
    if (!tags || !tags.length) return null;
    const hit = tags.find(t => _AI_BRAND[t]);
    return hit ? { key: hit, ..._AI_BRAND[hit] } : null;
}

function _getCaptureTag(tags) {
    if (!tags || !tags.length) return '';
    const hit = tags.find(t => _CAPTURE_TAGS.has(t));
    return hit || '';
}

function _getSourceBadge(tags) {
    if (!tags || !tags.length) return '';
    const source = tags.find(t => _KNOWN_SOURCES.includes(t));
    if (!source) return '';
    const cls = 'source-' + source.toLowerCase();
    return `<span class="source-badge ${cls}">${escapeHtml(source)}</span>`;
}

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

// â”€â”€â”€ DOM Refs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// â”€â”€â”€ Setup Wizard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let setupInterval = null;
let setupAttempts = 0;

function _setStepState(el, stepState, statusText) {
    el.classList.remove('pending', 'ok', 'warn');
    el.classList.add(stepState);
    el.querySelector('.step-status').textContent = statusText;
}


async function checkSetup() {
    setupAttempts++;
    const stepBackend = $('#step-backend');
    const stepOllama = $('#step-ollama');
    const stepModel = $('#step-model');
    const skipBtn = $('#skip-setup-btn');

    try {
        const res = await fetch(`${API}/api/setup/status`);
        const data = await res.json();

        // Backend
        _setStepState(stepBackend, 'ok', 'Connected');
        stepBackend.classList.add('ready');

        // Ollama
        if (data.ollama_running) {
            _setStepState(stepOllama, 'ok', 'Running');
            stepOllama.classList.add('ready');
        } else {
            _setStepState(stepOllama, 'pending', 'Waiting for Ollama...');
            stepOllama.classList.remove('ready');
        }

        // Model
        if (data.model_ready) {
            _setStepState(stepModel, 'ok', `${data.model_name} ready`);
            stepModel.classList.add('ready');
        } else if (data.ollama_running) {
            _setStepState(stepModel, 'pending', 'Downloading model...');
            fetch(`${API}/api/setup/pull-model`, { method: 'POST' }).catch(() => {});
        } else {
            _setStepState(stepModel, 'pending', 'Waiting...');
        }

         // Check if a cloud provider is active -- bypass Ollama requirement
        try {
            const cfgRes = await fetch(`${API}/api/setup/config`);
            const cfg = await cfgRes.json();
            _settingsConfig = _settingsConfig || cfg;  // prime cache early
            if (cfg.is_cloud_active) {
                const provLabel = (_PROVIDER_META[cfg.active_provider] || {}).label || cfg.active_provider;
                _setStepState(stepOllama, 'ok', `Using ${provLabel}`);
                stepOllama.classList.add('ready');
                _setStepState(stepModel, 'ok', cfg.active_model || 'Cloud model ready');
                stepModel.classList.add('ready');
                updateStatusIndicator(true, provLabel);
                state.setupComplete = true;
                transitionToApp();
                return;
            }
        } catch (_) { /* ignore */ }

       // Update status indicator
        state.ollamaReady = data.ollama_running && data.model_ready;
        updateStatusIndicator(data.ollama_running && data.model_ready);

        // LLM ready â†’ go to app
        if (data.ollama_running && data.model_ready) {
            state.setupComplete = true;
            transitionToApp();
            return;
        }

        // Show skip button after 15 seconds
        if (setupAttempts > 7) {
            skipBtn.style.display = 'block';
        }

    } catch (err) {
        // Backend not yet reachable
        _setStepState(stepBackend, 'pending', 'Connecting...');

        if (setupAttempts > 15) {
            _setStepState(stepBackend, 'warn', 'Cannot reach backend');
            stepBackend.classList.add('error');
            skipBtn.style.display = 'block';
        }
    }
}

function transitionToApp() {
    if (setupInterval) { clearInterval(setupInterval); setupInterval = null; }
    const wizard = $('#setup-wizard');
    wizard.style.transition = 'opacity 0.5s ease';
    wizard.style.opacity = '0';
    setTimeout(() => {
        wizard.style.display = 'none';
        $('#app').style.display = 'flex';
        $('#app').style.animation = 'fadeIn 0.5s ease';
        loadCollections();
        _prefetchSettingsConfig();
        loadDashboard();
        try { maybeStartOnboarding(); } catch (e) { console.warn('onboarding init failed', e); }
        _startGlobalSummarizingPoll();
    }, 500);
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

// â”€â”€â”€ Navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function navigateTo(view) {
    state.view = view;

    // Hide all views, show target with fade-in
    $$('.view').forEach(v => {
        if (v.id === `view-${view}`) {
            v.style.display = 'block';
            // Trigger fade-in: start invisible, paint, then transition to visible
            v.style.opacity = '0';
            v.style.transform = 'translateY(6px)';
            v.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
            requestAnimationFrame(() => {
                v.style.opacity = '1';
                v.style.transform = 'translateY(0)';
            });
        } else {
            v.style.display = 'none';
            v.style.opacity = '';
            v.style.transform = '';
            v.style.transition = '';
        }
    });

    // Update nav
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    const navKey = view === 'detail' ? 'library' : (view === 'capture' ? 'input' : view);
    const navBtn = $(`[data-view="${navKey}"]`);
    if (navBtn) navBtn.classList.add('active');

    // Load data for the target view
    if (view === 'library') {
        loadContexts();
    } else if (view === 'input') {
        if (!_dashboardLoaded) loadDashboard();
    }

    // Start polling when entering library/detail; let it self-stop when done
    // (don't stop on other views — in-flight summarizations still need to fire toasts)
    if (view === 'library' || view === 'detail') {
        startWorkerPolling();
    }
}

// â”€â”€â”€ Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _dashboardLoaded = false;

function _getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
}

function _getDayString() {
    return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function _animateCountUp(el, target, suffix = '') {
    const duration = 600;
    const start = performance.now();
    const from = 0;
    function step(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        // ease-out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(from + (target - from) * eased);
        el.textContent = current.toLocaleString() + suffix;
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}
function _timeAgo(dateStr) {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diff = Math.max(0, now - then);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Accent colours per collection/tag category
const _CV_ACCENTS = [
    'var(--cv-volt)',
    'oklch(0.72 0.18 280)',
    'oklch(0.78 0.18 145)',
    'oklch(0.78 0.15 30)',
    'oklch(0.72 0.18 200)',
    'oklch(0.75 0.18 320)',
];

function _renderRecentCard(ctx) {
    const summary = typeof ctx.summary === 'string' ? {} : ctx.summary;
    const title = escapeHtml(ctx.title || 'Untitled');
    const date = _timeAgo(ctx.created_at);
    const tags = Array.isArray(ctx.tags) ? ctx.tags : (ctx.tags ? String(ctx.tags).split(',').map(t => t.trim()).filter(Boolean) : []);
    const topic = escapeHtml(tags[0] || 'Context');
    const mark = topic.slice(0, 2).toUpperCase();
    const accent = _CV_ACCENTS[ctx.id % _CV_ACCENTS.length];

    // Key idea as the hover-preview question
    const snippet = summary.unresolved_questions && summary.unresolved_questions.length > 0
        ? escapeHtml(summary.unresolved_questions[0])
        : (summary.key_ideas && summary.key_ideas.length > 0 ? escapeHtml(summary.key_ideas[0]) : '');

    const desc = summary.snapshot ? escapeHtml(summary.snapshot)
        : (summary.key_ideas && summary.key_ideas.length > 0 ? escapeHtml(summary.key_ideas.slice(0, 2).join('. ')) : '');

    const tag1 = tags[0] ? `<span class="cv-tag">#${escapeHtml(tags[0])}</span>` : '';
    const tag2 = tags[1] ? `<span class="cv-tag">#${escapeHtml(tags[1])}</span>` : '';

    return `<article class="cv-card" style="--accent:${accent};" onclick="showDetail(${ctx.id})">
        <div class="cv-card-top">
            <div class="cv-card-mark">${mark}</div>
            <span class="cv-card-dot" aria-hidden="true"></span>
            <span class="cv-card-topic">${topic}</span>
            <span class="cv-card-date">${date}</span>
        </div>
        <h3>${title}</h3>
        ${desc ? `<p>${desc}</p>` : ''}
        <div class="cv-card-foot">
            ${tag1}${tag2}
        </div>
        ${snippet ? `<div class="cv-card-preview">${snippet}</div>` : ''}
    </article>`;
}

async function loadDashboard() {
    // Update hero greeting synchronously
    const eyebrow = document.getElementById('cv-hero-eyebrow');
    if (eyebrow) eyebrow.textContent = `${_getGreeting()} · ${_getDayString()}`;

    // Show skeleton immediately — before any network call
    document.querySelectorAll('.cv-stat').forEach(el => el.classList.add('skel'));
    const gridEl  = document.getElementById('dashboard-recent-grid');
    const emptyEl = document.getElementById('dashboard-recent-empty');
    if (gridEl) {
        if (emptyEl) emptyEl.style.display = 'none';
        for (let i = 0; i < 3; i++) {
            const d = document.createElement('div');
            d.className = 'cv-skel-card';
            gridEl.appendChild(d);
        }
    }

    // Fetch user name in background — does not block stats fetch
    const nameEl = document.getElementById('cv-greeting-name');
    if (nameEl) {
        const nameP = (_settingsConfig && _settingsConfig.user_name)
            ? Promise.resolve(_settingsConfig.user_name)
            : (_settingsConfigPromise
                ? _settingsConfigPromise.then(() => (_settingsConfig && _settingsConfig.user_name) || '')
                : fetch(`${API}/api/setup/config`).then(r => r.json()).then(d => { _settingsConfig = _settingsConfig || d; return d.user_name || ''; }).catch(() => ''));
        nameP.then(name => { nameEl.textContent = (name || 'User') + '.'; });
    }

    try {
        const res = await fetch(`${API}/api/dashboard`);
        if (!res.ok) throw new Error('Dashboard fetch failed');
        const data = await res.json();
        const stats = data.stats || {};
        const recent = data.recent || [];

        // Animate stat values
        const ctxVal         = document.getElementById('stat-contexts-val');
        const collectionsVal = document.getElementById('stat-collections-val');
        const asksVal        = document.getElementById('stat-asks-val');
        const weekVal        = document.getElementById('stat-week-val');

        if (ctxVal)         _animateCountUp(ctxVal,         stats.contexts            || 0);
        if (collectionsVal) _animateCountUp(collectionsVal, stats.collections         || 0);
        if (asksVal)        _animateCountUp(asksVal,        stats.questions_asked     || 0);
        if (weekVal)        _animateCountUp(weekVal,        stats.contexts_this_week  || 0);

        // Update idx badge
        const idxEl = document.getElementById('cv-recent-idx');
        if (idxEl && stats.contexts) idxEl.textContent = `${Math.min(recent.length, 8)} / ${stats.contexts}`;

        // Render recent contexts
        if (gridEl) {
            if (recent.length > 0) {
                const cardsHtml = recent.map(ctx => _renderRecentCard(ctx)).join('');
                gridEl.innerHTML = '';
                if (emptyEl) { emptyEl.style.display = 'none'; gridEl.appendChild(emptyEl); }
                gridEl.insertAdjacentHTML('beforeend', cardsHtml);
                _attachCardEffects(gridEl);
            } else {
                gridEl.innerHTML = '';
                if (emptyEl) { gridEl.appendChild(emptyEl); emptyEl.style.display = ''; }
            }
        }

        // Stat card spotlight
        document.querySelectorAll('.cv-stat').forEach(el => {
            el.addEventListener('pointermove', e => {
                const r = el.getBoundingClientRect();
                el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
                el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
            });
            el.addEventListener('pointerleave', () => {
                el.style.setProperty('--mx', '50%');
                el.style.setProperty('--my', '50%');
            });
        });

        _dashboardLoaded = true;
    } catch (err) {
        console.error('Dashboard load error:', err);
        // Restore empty state on error
        if (gridEl && emptyEl) { gridEl.innerHTML = ''; gridEl.appendChild(emptyEl); emptyEl.style.display = ''; }
    } finally {
        document.querySelectorAll('.cv-stat').forEach(el => el.classList.remove('skel'));
        document.querySelectorAll('.cv-skel-card').forEach(el => el.remove());
    }
}

function _attachCardEffects(container) {
    container.querySelectorAll('.cv-card').forEach(el => {
        // Radial spotlight
        el.addEventListener('pointermove', e => {
            const r = el.getBoundingClientRect();
            el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
            el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
        });
        el.addEventListener('pointerleave', () => {
            el.style.setProperty('--mx', '50%');
            el.style.setProperty('--my', '50%');
            el.style.transform = '';
        });
        // Subtle 3-D tilt
        el.addEventListener('pointermove', e => {
            const r = el.getBoundingClientRect();
            const x = (e.clientX - r.left) / r.width - 0.5;
            const y = (e.clientY - r.top) / r.height - 0.5;
            el.style.transform = `translateY(-2px) perspective(900px) rotateX(${(-y * 3).toFixed(2)}deg) rotateY(${(x * 3).toFixed(2)}deg)`;
        });
    });
}

// â”€â”€â”€ Chat Input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initChatInput() {
    const textarea = $('#chat-textarea');
    const charCount = $('#char-count');
    const summarizeBtn = $('#summarize-btn');

    textarea.addEventListener('input', () => {
        const len = textarea.value.length;
        const tokens = Math.round(len / 4);
        const tokenStr = tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${tokens}`;
        charCount.textContent = `${len.toLocaleString()} chars · ${tokenStr} tokens`;
        summarizeBtn.disabled = len < 20;
    });

    summarizeBtn.addEventListener('click', () => summarizeAndSave());
}

// ─── Pipeline UI helpers ─────────────────────────────────────────
function _pipelineShow(title) {
    const pipe = document.getElementById('cv-pipeline');
    if (!pipe) return;
    const titleEl = document.getElementById('cv-pipe-title');
    if (titleEl) titleEl.textContent = title || 'Processing conversation…';
    pipe.style.display = '';
    [1,2,3,4].forEach(n => {
        const step = document.getElementById(`cv-step-${n}`);
        if (step) step.classList.remove('done', 'active');
        const bar = document.getElementById(`cv-step-${n}-bar`);
        if (bar) bar.style.width = '0%';
    });
    const streamEl = document.getElementById('cv-stream-text');
    if (streamEl) streamEl.innerHTML = '';
    setTimeout(() => pipe.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
    pipe.addEventListener('pointermove', _pipelineSheen);
}
function _pipelineSheen(e) {
    const pipe = e.currentTarget;
    const r = pipe.getBoundingClientRect();
    pipe.style.setProperty('--px', ((e.clientX - r.left) / r.width * 100) + '%');
}
function _pipelineHide() {
    const pipe = document.getElementById('cv-pipeline');
    if (pipe) { pipe.style.display = 'none'; pipe.removeEventListener('pointermove', _pipelineSheen); }
}
function _pipelineSetStep(n, stepState, nameOverride) {
    const step = document.getElementById(`cv-step-${n}`);
    if (!step) return;
    step.classList.remove('done', 'active');
    if (stepState) step.classList.add(stepState);
    const bar = document.getElementById(`cv-step-${n}-bar`);
    if (bar) bar.style.width = stepState === 'done' ? '100%' : stepState === 'active' ? '60%' : '0%';
    if (nameOverride) { const nm = step.querySelector('.name'); if (nm) nm.textContent = nameOverride; }
}
function _pipelineAppendToken(token) {
    const el = document.getElementById('cv-stream-text');
    if (!el) return;
    el.textContent += token;
    const box = el.closest('.cv-stream');
    if (box) box.scrollTop = box.scrollHeight;
}

let _summarizing = false;
async function summarizeAndSave() {
    if (_summarizing) { console.warn('[ConVX] already in flight — bailing'); return; }
    const textarea = $('#chat-textarea');
    const btn = $('#summarize-btn');
    const text = textarea.value.trim();
    if (!text) { console.warn('[ConVX] empty text — bailing'); return; }

    _summarizing = true;
    // Show loading
    btn.querySelector('.btn-text').style.display = 'none';
    btn.querySelector('.btn-loader').style.display = 'inline-flex';
    btn.disabled = true;

    // Show pipeline on dashboard
    const _firstLine = text.split('\n').find(l => l.trim()) || 'Processing conversation…';
    _pipelineShow(_firstLine.slice(0, 80));

    try {
        // Step 1: Summarize via Ollama (streaming progress)
        const _setProgress = (msg, pct = null) => {
            const textEl = document.getElementById('summarize-progress-text');
            const fillEl = document.getElementById('summarize-progress-fill');
            if (textEl) textEl.textContent = ' ' + msg;
            if (fillEl && pct !== null) fillEl.style.width = pct + '%';
        };
        _setProgress('Summarizing…', 5);

        const summaryRes = await fetch(`${API}/api/summarize/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        });

        if (!summaryRes.ok) {
            const err = await summaryRes.json().catch(() => ({}));
            throw new Error(err.detail || 'Summarization failed');
        }

        // Read NDJSON stream for progress
        let summary = null;
        const reader = summaryRes.body.getReader();
        const decoder = new TextDecoder();
        let streamBuf = '';
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            streamBuf += decoder.decode(value, { stream: true });
            const lines = streamBuf.split('\n');
            streamBuf = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const evt = JSON.parse(line);
                    if (evt.error) throw new Error(evt.error);
                    if (evt.step) {
                        const pct = evt.total > 0 ? Math.round((evt.done / evt.total) * 85) : 0;
                        _setProgress(evt.step, pct);
                        _pipelineSetStep(1, 'active', evt.step.slice(0, 40));
                    }
                    if (evt.token) _pipelineAppendToken(evt.token);
                    if (evt.result) summary = evt.result;
                } catch (e) { if (e.message !== line) throw e; }
            }
        }

        if (!summary) throw new Error('Summarization produced no result');
        _pipelineSetStep(1, 'done', 'Summary ready');

        // Create title + tags
        const title = summary.main_topic || 'Untitled Context';
        const tags = generateTags(summary);

        // Save to database
        _pipelineSetStep(2, 'active', 'Storing to vault…');
        _setProgress('Saving…', 90);
        const createRes = await fetch(`${API}/api/contexts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title,
                summary,
                tags,
                original_chat: text,
            }),
        });

        if (!createRes.ok) {
            throw new Error('Failed to save context');
        }

        const created = await createRes.json();
        _pipelineSetStep(2, 'done', 'Saved to vault');
        _pipelineSetStep(3, 'active', 'Splitting chunks…');

        // Chunk and embed
        _setProgress('Embedding…', 97);
        try {
            const chunkRes = await fetch(`${API}/api/contexts/chunk-all?force=false`, { method: 'POST' });
            if (chunkRes.ok) {
                // Consume the NDJSON stream to completion
                const reader = chunkRes.body.getReader();
                const decoder = new TextDecoder();
                let buf = '';
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                }
            }
        } catch {
            showToast('Context saved, but chunking failed — use Rebuild Embeddings later', 'error');
        }

        _pipelineSetStep(3, 'done', 'Chunks ready');
        _pipelineSetStep(4, 'done', 'Vectors indexed');

        // Clear textarea
        textarea.value = '';
        $('#char-count').textContent = '0 characters';
        btn.disabled = true;

        showToast('Context summarized & saved', 'success');

        // Navigate to detail view
        setTimeout(() => showDetail(created.id), 500);

    } catch (err) {
        console.error('[ConVX] summarize failed', err);
        showToast(`Summarization failed: ${err.message}`, 'error');
        _pipelineHide();
    } finally {
        _summarizing = false;
        btn.querySelector('.btn-text').style.display = 'inline-flex';
        btn.querySelector('.btn-loader').style.display = 'none';
        btn.disabled = false;
        // Reset progress bar
        const fillEl = document.getElementById('summarize-progress-fill');
        if (fillEl) fillEl.style.width = '0%';
        // Hide pipeline after a beat
        setTimeout(_pipelineHide, 3000);
    }
}

function generateTags(summary) {
    const tags = new Set();
    const corpus = [
        summary.main_topic || '',
        ...(summary.key_ideas || []),
        ...(summary.conclusions || []),
        ...(summary.vitals || []),
    ].join(' ').toLowerCase();

    // Known tech keywords — still useful for canonical naming
    const knownTags = {
        'python': 'Python', 'javascript': 'JavaScript', 'typescript': 'TypeScript',
        'react': 'React', 'vue': 'Vue', 'angular': 'Angular', 'svelte': 'Svelte',
        'node': 'Node.js', 'express': 'Express', 'fastapi': 'FastAPI', 'django': 'Django', 'flask': 'Flask',
        'rust': 'Rust', 'go ': 'Go', 'golang': 'Go', 'java ': 'Java', 'kotlin': 'Kotlin', 'swift': 'Swift',
        'c++': 'C++', 'c#': 'C#', '.net': '.NET',
        'sql': 'SQL', 'sqlite': 'SQLite', 'postgres': 'PostgreSQL', 'mongodb': 'MongoDB', 'redis': 'Redis',
        'docker': 'Docker', 'kubernetes': 'Kubernetes', 'aws': 'AWS', 'gcp': 'GCP', 'azure': 'Azure',
        'git ': 'Git', 'github': 'GitHub', 'ci/cd': 'CI/CD', 'terraform': 'Terraform',
        'css': 'CSS', 'html': 'HTML', 'tailwind': 'Tailwind', 'sass': 'Sass',
        'machine learning': 'ML', 'deep learning': 'Deep Learning', 'neural': 'ML',
        'llm': 'LLM', 'gpt': 'LLM', 'transformer': 'ML', 'embedding': 'Embeddings',
        'api': 'API', 'rest': 'REST', 'graphql': 'GraphQL', 'websocket': 'WebSocket',
        'testing': 'Testing', 'debug': 'Debugging', 'performance': 'Performance',
        'security': 'Security', 'auth': 'Auth', 'oauth': 'Auth', 'jwt': 'Auth',
        'linux': 'Linux', 'windows': 'Windows', 'bash': 'Shell', 'powershell': 'Shell',
    };
    for (const [keyword, tag] of Object.entries(knownTags)) {
        if (corpus.includes(keyword)) tags.add(tag);
    }

    // Extract key nouns from the topic itself as tags (2+ word chunks)
    const topic = (summary.main_topic || '').trim();
    if (topic && tags.size < 3) {
        // Use capitalized words from the topic that look like proper nouns or tech terms
        const topicWords = topic.split(/\s+/).filter(w => w.length > 2);
        for (const w of topicWords) {
            if (/^[A-Z]/.test(w) && !['The', 'And', 'For', 'With', 'How', 'What', 'Why', 'When', 'Using', 'From', 'Into', 'About'].includes(w)) {
                tags.add(w);
            }
            if (tags.size >= 5) break;
        }
    }

    return [...tags].slice(0, 5);
}

// â”€â”€â”€ Collections â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadCollections() {
    try {
        const res = await fetch(`${API}/api/collections`);
        state.collections = await res.json();
        renderCollections();
        _askPopulateScopeSelect();
    } catch { /* non-fatal */ }
}

function renderCollections() {
    const list = $('#collections-list');
    if (!list) return;

    const allActive = state.activeCollection === null;
    const totalAll = state.totalContextCount;

    let html = `<div class="collection-item${allActive ? ' active' : ''}" role="button" tabindex="0" onclick="filterByCollection(null)" onkeydown="if(event.key==='Enter'||event.key===' ')filterByCollection(null)">
        <span class="collection-dot" style="background:var(--text-faint)"></span>
        <span class="collection-item-name">All</span>
        <span class="collection-item-count">${totalAll}</span>
    </div>`;

    for (const col of state.collections) {
        const active = state.activeCollection === col.id;
        const safeName = escapeHtml(col.name).replace(/'/g, '&#39;');
        html += `<div class="collection-item${active ? ' active' : ''}" role="button" tabindex="0" onclick="filterByCollection(${col.id})" onkeydown="if(event.key==='Enter'||event.key===' ')filterByCollection(${col.id})" data-col-id="${col.id}">
            <span class="collection-dot" style="background:${escapeHtml(col.color)}"></span>
            <span class="collection-item-name">${escapeHtml(col.name)}</span>
            <span class="collection-item-count">${col.count}</span>
            <span class="collection-item-rename" onclick="event.stopPropagation(); startRenameCollection(${col.id})" title="Rename" aria-label="Rename ${escapeHtml(col.name)}" role="button" tabindex="0">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </span>
            <span class="collection-item-delete" onclick="event.stopPropagation(); confirmDeleteCollection(${col.id}, '${safeName}')" title="Delete" aria-label="Delete ${escapeHtml(col.name)}" role="button" tabindex="0">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </span>
        </div>`;
    }
    list.innerHTML = html;
}

function filterByCollection(id) {
    state.activeCollection = id;
    state.activeTagFilter = null;
    renderCollections();
    loadContexts('', false);
}

function openCollectionCreate() {
    const row = $('#collection-create-row');
    row.style.display = 'flex';
    $('#collection-name-input').focus();
}

function closeCollectionCreate() {
    $('#collection-create-row').style.display = 'none';
    $('#collection-name-input').value = '';
    state.newCollectionColor = '#6366f1';
    document.querySelectorAll('.color-swatch').forEach(s => {
        s.classList.toggle('active', s.dataset.color === '#6366f1');
    });
}

async function submitCollectionCreate() {
    const name = $('#collection-name-input').value.trim();
    if (!name) return;
    try {
        const res = await fetch(`${API}/api/collections`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, color: state.newCollectionColor }),
        });
        if (!res.ok) throw new Error();
        const col = await res.json();
        state.collections.push(col);
        closeCollectionCreate();
        renderCollections();
        showToast(`Collection "${col.name}" created`, 'success');
    } catch { showToast('Failed to create collection', 'error'); }
}

function startRenameCollection(id) {
    const col = state.collections.find(c => c.id === id);
    if (!col) return;

    const row = document.querySelector(`.collection-item[data-col-id="${id}"]`);
    if (!row) return;

    const nameSpan = row.querySelector('.collection-item-name');
    const currentName = col.name;

    // Replace the name span with an inline input
    const input = document.createElement('input');
    input.className = 'collection-rename-input';
    input.value = currentName;
    input.maxLength = 40;
    nameSpan.replaceWith(input);

    // Disable the row's click-to-filter while editing
    row.onclick = null;

    input.focus();
    input.select();

    const finish = async (save) => {
        const newName = input.value.trim();
        if (save && newName && newName !== currentName) {
            await submitRenameCollection(id, newName);
        } else {
            // Restore original name span without a fetch
            const span = document.createElement('span');
            span.className = 'collection-item-name';
            span.textContent = currentName;
            input.replaceWith(span);
            row.onclick = () => filterByCollection(id);
        }
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.onclick = (e) => e.stopPropagation();
}

async function submitRenameCollection(id, newName) {
    try {
        const res = await fetch(`${API}/api/collections/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName }),
        });
        if (!res.ok) throw new Error();
        const updated = await res.json();
        const idx = state.collections.findIndex(c => c.id === id);
        if (idx !== -1) state.collections[idx] = { ...state.collections[idx], ...updated };
        renderCollections();
        showToast(`Renamed to "${newName}"`, 'success');
    } catch {
        showToast('Failed to rename collection', 'error');
        renderCollections(); // restore original name
    }
}

function confirmDeleteCollection(id, name) {
    openConfirmDeleteModal({
        title: 'Delete collection?',
        message: `Delete collection <b>"${escapeHtml(name)}"</b>?<br><span style="color:var(--text-muted);font-size:13px;">Contexts inside won't be deleted — they'll just become uncollected.</span>`,
        confirmLabel: 'Delete collection',
        onConfirm: () => _performDeleteCollection(id, name),
    });
}

async function _performDeleteCollection(id, name) {
    try {
        const res = await fetch(`${API}/api/collections/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        state.collections = state.collections.filter(c => c.id !== id);
        if (state.activeCollection === id) state.activeCollection = null;
        renderCollections();
        loadContexts('', false);
        showToast(`Collection "${name}" deleted`, 'success');
    } catch { showToast('Failed to delete collection', 'error'); }
}

async function setContextCollection(contextId, collectionId) {
    try {
        const res = await fetch(`${API}/api/contexts/${contextId}/collection`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collection_id: collectionId }),
        });
        if (!res.ok) throw new Error();
        const updated = await res.json();
        // Update local state
        const idx = state.contexts.findIndex(c => c.id === contextId);
        if (idx !== -1) state.contexts[idx] = updated;
        if (state.currentContext && state.currentContext.id === contextId) state.currentContext = updated;
        // Refresh collection counts
        await loadCollections();
        return updated;
    } catch { showToast('Failed to update collection', 'error'); return null; }
}

function _getCollectionForContext(collectionId) {
    return state.collections.find(c => c.id === collectionId) || null;
}

// â”€â”€â”€ Context Library â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Wrap matched search terms in <span class="search-highlight"> */
function _highlightText(text, query) {
    if (!query || query.length < 2) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const queryEscaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${queryEscaped})`, 'gi');
    return escaped.replace(regex, '<span class="search-highlight">$1</span>');
}

function _renderContextCard(ctx) {
    const summary = typeof ctx.summary === 'string' ? {} : (ctx.summary || {});
    const q = state.searchQuery;
    const title = _highlightText(ctx.title || 'Untitled', q);
    const date  = _timeAgo(ctx.created_at);

    const allTags = Array.isArray(ctx.tags) ? ctx.tags : [];
    const brand   = _getAIBrand(allTags);
    const capture = _getCaptureTag(allTags);

    // User tags exclude both AI brand tags and capture-method tags — those are surfaced
    // as dedicated UI (top-left AI pill, bottom capture chip) and should never double up
    // as generic #tag chips.
    const userTags = allTags.filter(t =>
        !_AI_BRAND[t] && !_CAPTURE_TAGS.has(t)
    );

    const starred  = !!ctx.starred;
    const selected = state.selectedIds && state.selectedIds.has(ctx.id);
    const checked  = selected ? ' checked' : '';
    const accent   = brand ? brand.color : _CV_ACCENTS[ctx.id % _CV_ACCENTS.length];

    const col = ctx.collection_id ? _getCollectionForContext(ctx.collection_id) : null;

    const firstIdea = (summary.key_ideas || [])[0] || '';
    const snap      = summary.snapshot || '';
    const desc = snap ? _highlightText(snap, q)
                      : (firstIdea ? _highlightText(firstIdea, q) : '');
    const snippet = (summary.unresolved_questions || [])[0]
                  || (summary.key_ideas || [])[1]
                  || firstIdea
                  || '';

    const tagHtml = userTags.slice(0, 3).map(t =>
        `<span class="cv-tag">#${_highlightText(t, q)}</span>`
    ).join('');

    // Top-left AI brand pill (replaces the old generic mark/topic combo).
    const aiPill = brand
        ? `<span class="cv-card-ai" data-ai="${escapeHtml(brand.key)}" style="--ai-color:${brand.color};--ai-bg:${brand.bg};--ai-border:${brand.border};">
              <span class="cv-card-ai-dot" aria-hidden="true"></span>${escapeHtml(brand.label)}
           </span>`
        : `<span class="cv-card-ai cv-card-ai-generic"><span class="cv-card-ai-dot" aria-hidden="true"></span>Context</span>`;

    // Capture chip at the bottom (shown once, at most).
    const captureChip = capture
        ? `<span class="cv-card-capture">${escapeHtml(capture)}</span>`
        : '';

    // Live status indicator (positioned at top-right, does not overlap title/body).
    let statusLive = '';
    if (ctx.status === 'summarizing') {
        statusLive = `<div class="cv-card-live" aria-live="polite">
            <span class="cv-card-live-dot" aria-hidden="true"></span>
            <span class="cv-card-live-label">Summarizing</span>
            <span class="cv-card-live-sweep" aria-hidden="true"></span>
        </div>`;
    } else if (ctx.status === 'failed') {
        statusLive = `<div class="cv-card-live cv-card-live-err">
            <span class="cv-card-live-dot" aria-hidden="true"></span>
            <span class="cv-card-live-label">Failed</span>
        </div>`;
    }

    const onCardClick = state.selectMode
        ? `toggleSelectCard(${ctx.id})`
        : `showDetail(${ctx.id})`;

    const checkbox = state.selectMode
        ? `<input type="checkbox" class="cv-card-check" ${checked}
                 onclick="event.stopPropagation(); toggleSelectCard(${ctx.id})"
                 aria-label="Select context ${ctx.id}" />`
        : '';

    // Star and delete hide when the live-status pill occupies the top-right slot.
    const showTopRightActions = !state.selectMode && ctx.status !== 'summarizing' && ctx.status !== 'failed';
    const starBtn = showTopRightActions
        ? `<button class="cv-card-star${starred ? ' on' : ''}"
                   onclick="event.stopPropagation(); toggleStar(${ctx.id})"
                   title="${starred ? 'Unpin' : 'Pin'}"
                   aria-label="${starred ? 'Unpin context' : 'Pin context'}">
             <svg width="12" height="12" viewBox="0 0 24 24" fill="${starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
           </button>`
        : '';

    const delBtn = !state.selectMode
        ? `<button class="cv-card-del"
                   onclick="event.stopPropagation(); deleteFromLibrary(${ctx.id})"
                   title="Delete" aria-label="Delete context">
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
           </button>`
        : '';

    const colDot = col
        ? `<span class="cv-card-coldot" style="background:${escapeHtml(col.color)};color:${escapeHtml(col.color)};" title="${escapeHtml(col.name)}"></span>`
        : '';

    return `
        <article class="cv-card context-card${starred ? ' starred' : ''}${selected ? ' cv-card-selected' : ''}${ctx.status === 'summarizing' ? ' cv-card-summarizing' : ''}"
                 data-id="${ctx.id}" data-anim
                 style="--accent:${accent};"
                 onclick="${onCardClick}">
            ${checkbox}
            ${starBtn}
            <div class="cv-card-top">
                ${aiPill}
                ${colDot}
                <span class="cv-card-date">${date}</span>
            </div>
            <h3 class="card-title">${title}</h3>
            ${desc ? `<p>${desc}</p>` : ''}
            <div class="cv-card-foot">
                ${statusLive}
                ${tagHtml}
                ${captureChip}
            </div>
            ${snippet ? `<div class="cv-card-preview">${_highlightText(snippet, q)}</div>` : ''}
            ${delBtn}
        </article>
    `;
}

async function loadContexts(query = '', append = false) {
    state.searchQuery = query; // Track for highlighting
    const grid = $('#contexts-grid');
    const emptyState = $('#empty-state');
    const loadMoreContainer = $('#load-more-container');

    if (!append) {
        state.libraryPage = 1;
        state.contexts = [];
        // Show skeleton loaders while fetching
        grid.style.display = 'grid';
        grid.style.opacity = '1';
        grid.style.transition = '';
        emptyState.style.display = 'none';
        grid.innerHTML = Array(8).fill(
            '<div class="cv-skel skeleton-card">' +
              '<div class="cv-skel-line w40"></div>' +
              '<div class="cv-skel-line w80"></div>' +
              '<div class="cv-skel-line w60"></div>' +
            '</div>'
        ).join('');
    }

    try {
        const colParam = state.activeCollection !== null ? `&collection_id=${state.activeCollection}` : '';
        let url = query
            ? `${API}/api/contexts?q=${encodeURIComponent(query)}${colParam}`
            : `${API}/api/contexts?page=${state.libraryPage}&per_page=50&sort=${state.sortOrder}${colParam}`;

        const res = await fetch(url);
        const data = await res.json();
        const contexts = data.contexts || data;
        state.libraryHasMore = !!data.has_more;

        // Keep the global total up to date (only when not filtered by collection)
        if (state.activeCollection === null && !query && data.total != null) {
            state.totalContextCount = data.total;
            renderCollections();
        }

        // Notify user when semantic search fell back to keyword
        if (query && data.search_mode === 'keyword') {
            showToast('Semantic search unavailable — showing keyword results', 'error');
        }

        if (append) {
            state.contexts = state.contexts.concat(contexts);
        } else {
            state.contexts = contexts;
        }

        if (state.contexts.length === 0) {
            grid.style.display = 'none';
            loadMoreContainer.style.display = 'none';
            emptyState.style.display = 'flex';
            _updateLibCount(0, 0, query);
            _renderActiveFilters();
            return;
        }

        grid.style.display = 'grid';
        emptyState.style.display = 'none';

        // Apply tag filter
        const filtered = state.activeTagFilter
            ? state.contexts.filter(c => (c.tags || []).includes(state.activeTagFilter))
            : state.contexts;

        if (append && !state.activeTagFilter) {
            grid.insertAdjacentHTML('beforeend', _staggeredCards(contexts));
        } else {
            grid.innerHTML = _staggeredCards(filtered);
        }

        // Attach parallax/spotlight to the cards
        if (typeof _attachCardEffects === 'function') _attachCardEffects(grid);

        // Build tag filter bar + active-filter pills + live count
        if (!append) _renderTagFilterBar(state.contexts);
        _updateLibCount(filtered.length, state.contexts.length, query);
        _renderActiveFilters();

        loadMoreContainer.style.display = state.libraryHasMore && !query ? 'flex' : 'none';

        if (state.contexts.some(c => c.status === 'summarizing')) {
            startWorkerPolling();
        }

    } catch (err) {
        showToast('Failed to load contexts', 'error');
    }
}

// Live count + active-filter pills for the library hero
function _updateLibCount(showing, total, query) {
    const el = document.getElementById('cv-lib-count-text');
    if (!el) return;
    if (total === 0) {
        el.textContent = query ? `No matches for "${query}"` : 'Nothing saved yet';
        return;
    }
    const total_ = `<span class="cv-lib-count-num">${showing.toLocaleString()}</span>`;
    if (showing === total && !query && !state.activeCollection && !state.activeTagFilter) {
        el.innerHTML = `${total_} context${showing === 1 ? '' : 's'} in your vault`;
    } else {
        el.innerHTML = `${total_} of ${total.toLocaleString()} · filtered`;
    }
}

function _renderActiveFilters() {
    const bar = document.getElementById('cv-active-filters');
    if (!bar) return;
    const pills = [];

    if (state.searchQuery) {
        pills.push(`<span class="cv-active-pill">Search: "${escapeHtml(state.searchQuery)}"
            <button class="cv-active-pill-x" onclick="cvClearSearch()" title="Clear search">×</button>
        </span>`);
    }
    if (state.activeCollection !== null && state.activeCollection !== undefined) {
        const col = state.collections.find(c => c.id === state.activeCollection);
        if (col) {
            pills.push(`<span class="cv-active-pill" style="background:color-mix(in oklab, ${escapeHtml(col.color)} 20%, transparent);border-color:color-mix(in oklab, ${escapeHtml(col.color)} 40%, transparent);color:${escapeHtml(col.color)}">
                ${escapeHtml(col.name)}
                <button class="cv-active-pill-x" style="background:color-mix(in oklab, ${escapeHtml(col.color)} 25%, transparent);color:${escapeHtml(col.color)}" onclick="cvClearCollection()" title="Clear collection">×</button>
            </span>`);
        }
    }
    if (state.activeTagFilter) {
        pills.push(`<span class="cv-active-pill">#${escapeHtml(state.activeTagFilter)}
            <button class="cv-active-pill-x" onclick="cvClearTag()" title="Clear tag">×</button>
        </span>`);
    }

    if (pills.length > 1) {
        pills.push(`<button class="cv-active-clear" onclick="cvClearAllFilters()">Clear all</button>`);
    }

    if (pills.length === 0) {
        bar.style.display = 'none';
        bar.innerHTML = '';
    } else {
        bar.style.display = 'flex';
        bar.innerHTML = pills.join('');
    }
}

function cvClearSearch() {
    const input = document.getElementById('search-input');
    if (input) input.value = '';
    state.searchQuery = '';
    loadContexts('');
}
function cvClearCollection() {
    state.activeCollection = null;
    loadContexts(state.searchQuery || '');
    if (typeof renderCollections === 'function') renderCollections();
}
function cvClearTag() {
    state.activeTagFilter = null;
    if (typeof _applyTagFilter === 'function') _applyTagFilter();
    _renderActiveFilters();
}
function cvClearAllFilters() {
    const input = document.getElementById('search-input');
    if (input) input.value = '';
    state.searchQuery = '';
    state.activeTagFilter = null;
    state.activeCollection = null;
    loadContexts('');
    if (typeof renderCollections === 'function') renderCollections();
}
window.cvClearSearch = cvClearSearch;
window.cvClearCollection = cvClearCollection;
window.cvClearTag = cvClearTag;
window.cvClearAllFilters = cvClearAllFilters;

async function loadMoreContexts() {
    state.libraryPage++;
    await loadContexts('', true);
}

function _renderTagFilterBar(contexts) {
    const bar = $('#tag-filter-bar');
    if (!bar) return;

    // Collect all unique tags with counts
    const tagCounts = {};
    contexts.forEach(ctx => {
        (ctx.tags || []).forEach(t => {
            tagCounts[t] = (tagCounts[t] || 0) + 1;
        });
    });

    const tags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

    if (tags.length === 0) {
        bar.style.display = 'none';
        return;
    }

    bar.style.display = 'flex';
    bar.innerHTML = tags.map(([tag, count]) => {
        const active = state.activeTagFilter === tag ? ' active' : '';
        return `<button class="tag-chip${active}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)} <span class="tag-chip-count">${count}</span></button>`;
    }).join('');

    // Wire up click handlers
    bar.querySelectorAll('.tag-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const tag = chip.dataset.tag;
            if (state.activeTagFilter === tag) {
                state.activeTagFilter = null;
            } else {
                state.activeTagFilter = tag;
            }
            _applyTagFilter();
        });
    });
}

function _applyTagFilter() {
    const grid = $('#contexts-grid');
    const bar = $('#tag-filter-bar');

    // Update chip active states
    bar.querySelectorAll('.tag-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.tag === state.activeTagFilter);
    });

    // Show/hide cards via CSS instead of full DOM re-render
    const tag = state.activeTagFilter;
    const cards = grid.querySelectorAll('.context-card');
    if (cards.length > 0 && cards.length === state.contexts.length) {
        // Cards match state — toggle visibility in-place
        const ctxById = new Map(state.contexts.map(c => [c.id, c]));
        cards.forEach(card => {
            const id = parseInt(card.dataset.id, 10);
            const ctx = ctxById.get(id);
            if (!tag || (ctx && (ctx.tags || []).includes(tag))) {
                card.style.display = '';
            } else {
                card.style.display = 'none';
            }
        });
    } else {
        // Cards out of sync — fall back to full re-render
        const filtered = tag
            ? state.contexts.filter(c => (c.tags || []).includes(tag))
            : state.contexts;
        grid.innerHTML = _staggeredCards(filtered);
        if (typeof _attachCardEffects === 'function') _attachCardEffects(grid);
    }

    // Refresh count + active-filter pills
    const visible = state.contexts.filter(c => !tag || (c.tags || []).includes(tag)).length;
    if (typeof _updateLibCount === 'function') _updateLibCount(visible, state.contexts.length, state.searchQuery);
    if (typeof _renderActiveFilters === 'function') _renderActiveFilters();
}

let _deepSearchMode = false;

function initSearch() {
    let debounce = null;
    const input = $('#search-input');
    input.addEventListener('input', () => {
        clearTimeout(debounce);
        state.activeTagFilter = null;
        const q = input.value.trim();
        if (_deepSearchMode && q.length >= 3) {
            debounce = setTimeout(() => _runDeepSearch(q), 500);
        } else {
            _hideDeepResults();
            debounce = setTimeout(() => loadContexts(q), 300);
        }
    });

    // Enter key triggers deep search immediately
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && _deepSearchMode) {
            clearTimeout(debounce);
            const q = input.value.trim();
            if (q.length >= 2) _runDeepSearch(q);
        }
    });
}

function toggleDeepSearch() {
    _deepSearchMode = !_deepSearchMode;
    const btn = $('#btn-deep-search');
    btn.classList.toggle('active', _deepSearchMode);
    btn.setAttribute('aria-pressed', _deepSearchMode ? 'true' : 'false');

    const input = $('#search-input');
    if (_deepSearchMode) {
        input.placeholder = 'Deep search across all chunks…';
        const q = input.value.trim();
        if (q.length >= 3) _runDeepSearch(q);
    } else {
        input.placeholder = 'Search contexts...';
        _hideDeepResults();
        loadContexts(input.value.trim());
    }
}

function _hideDeepResults() {
    const container = $('#deep-search-results');
    if (container) { container.style.display = 'none'; container.innerHTML = ''; }
    $('#contexts-grid').style.display = 'grid';
    $('#tag-filter-bar').style.display = '';
}

async function _runDeepSearch(query) {
    const container = $('#deep-search-results');
    const grid = $('#contexts-grid');
    const tagBar = $('#tag-filter-bar');
    const loadMore = $('#load-more-container');
    const emptyState = $('#empty-state');

    // Show loading
    grid.style.display = 'none';
    tagBar.style.display = 'none';
    loadMore.style.display = 'none';
    emptyState.style.display = 'none';
    container.style.display = 'block';
    container.innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--text-muted)"><span class="spinner" style="display:inline-block;width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--text-primary);border-radius:50%;animation:spin 0.55s linear infinite"></span> Searching all chunks…</div>';

    try {
        const res = await fetch(`${API}/api/retrieve/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Search failed');
        }
        const data = await res.json();
        _renderDeepResults(data, query);
    } catch (err) {
        container.innerHTML = `<div style="text-align:center;padding:40px 0;color:var(--danger)">${escapeHtml(err.message)}</div>`;
    }
}

function _renderDeepResults(data, query) {
    const container = $('#deep-search-results');
    if (!data.results || data.results.length === 0) {
        const msg = data.low_confidence
            ? `<div style="text-align:center;padding:40px 0;color:var(--text-muted)">
                <div style="font-size:1.1rem;margin-bottom:8px">No strong matches found for <strong>${escapeHtml(data.query || query)}</strong></div>
                <div style="font-size:0.85rem;opacity:0.7">If this conversation was recently captured, try <strong>Rebuild Embeddings</strong> in Settings.<br>Otherwise, try a more specific query.</div>
               </div>`
            : '<div style="text-align:center;padding:40px 0;color:var(--text-muted)">No matching chunks found across your conversations.</div>';
        container.innerHTML = msg;
        return;
    }

    const modeNote = data.search_mode === 'keyword'
        ? ' <span style="font-size:0.75rem;opacity:0.6;font-weight:normal">(keyword match — run Rebuild Embeddings for semantic search)</span>'
        : '';
    let html = `<div class="deep-search-header">${data.total_chunks} chunks matched across ${data.results.length} conversation${data.results.length > 1 ? 's' : ''}${modeNote}</div>`;

    for (const group of data.results) {
        const date = new Date(group.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const tags = (group.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
        const scoreLabel = data.search_mode === 'keyword' ? 'keyword match' : `${Math.round(group.best_score * 100)}% match`;

        html += `<div class="deep-result-group">
            <div class="deep-result-header" onclick="showDetail(${group.context_id})">
                <div class="deep-result-title">${escapeHtml(group.title)}</div>
                <div class="deep-result-meta">
                    <span class="deep-score">${scoreLabel}</span>
                    <span>${date}</span>
                    ${tags}
                </div>
            </div>
            <div class="deep-result-chunks">`;

        for (const chunk of group.chunks) {
            const excerpt = escapeHtml(chunk.text.length > 300 ? chunk.text.slice(0, 300) + '…' : chunk.text);
            const badges = [];
            if (chunk.has_code) badges.push('<span class="deep-badge">code</span>');
            if (chunk.is_starred) badges.push('<span class="deep-badge starred">starred</span>');
            html += `<div class="deep-chunk">
                <div class="deep-chunk-score">${chunk.score != null ? Math.round(chunk.score * 100) + '%' : '~'}</div>
                <div class="deep-chunk-text">${excerpt}${badges.length ? ' ' + badges.join('') : ''}</div>
            </div>`;
        }

        html += `</div></div>`;
    }

    container.innerHTML = html;
}

function deleteFromLibrary(id) {
    const ctx = state.contexts.find(c => c.id === id);
    if (!ctx) return;
    openConfirmDeleteModal(ctx, () => _performLibraryDelete(id));
}

function _performLibraryDelete(id) {
    // P2-10: Undo delete — hide card immediately, commit after 5s
    const ctx = state.contexts.find(c => c.id === id);
    if (!ctx) return;

    // Cancel any existing pending delete for this id
    if (state.pendingDeletes.has(id)) {
        clearTimeout(state.pendingDeletes.get(id).timer);
        state.pendingDeletes.delete(id);
    }

    // Hide card from grid
    const card = document.querySelector(`.context-card[data-id="${id}"]`);
    if (card) {
        card.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.95)';
        setTimeout(() => card.style.display = 'none', 200);
    }

    // Show undo toast
    const timer = setTimeout(() => _commitDelete(id), 5000);
    state.pendingDeletes.set(id, { timer, ctx });
    _showUndoToast(`"${ctx.title}" deleted`, () => {
        // Undo: cancel timer, restore card
        clearTimeout(timer);
        state.pendingDeletes.delete(id);
        if (card) {
            card.style.display = '';
            requestAnimationFrame(() => {
                card.style.opacity = '1';
                card.style.transform = 'scale(1)';
            });
        }
        showToast('Delete undone', 'success');
    });
}

async function _commitDelete(id) {
    state.pendingDeletes.delete(id);
    try {
        await fetch(`${API}/api/contexts/${id}`, { method: 'DELETE' });
        // Remove from state
        state.contexts = state.contexts.filter(c => c.id !== id);
    } catch (err) {
        showToast('Failed to delete', 'error');
        // Reload to restore
        loadContexts($('#search-input').value.trim());
    }
}

// â”€â”€â”€ Star / Select / Bulk â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function toggleStar(id) {
    const ctx = state.contexts.find(c => c.id === id);
    if (!ctx) return;

    // Optimistic DOM update — no full re-render
    const wasStarred = ctx.starred;
    ctx.starred = !wasStarred;

    const card = document.querySelector(`.context-card[data-id="${id}"]`);
    const starBtn = card?.querySelector('.cv-card-star');
    if (starBtn) {
        starBtn.classList.toggle('on', ctx.starred);
        const svg = starBtn.querySelector('svg');
        if (svg) svg.setAttribute('fill', ctx.starred ? 'currentColor' : 'none');
        // Pop animation
        starBtn.classList.remove('popping');
        requestAnimationFrame(() => starBtn.classList.add('popping'));
        starBtn.addEventListener('animationend', () => starBtn.classList.remove('popping'), { once: true });
    }
    if (card) card.classList.toggle('starred', ctx.starred);

    try {
        const res = await fetch(`${API}/api/contexts/${id}/star`, { method: 'POST' });
        if (!res.ok) throw new Error();
        const updated = await res.json();
        const idx = state.contexts.findIndex(c => c.id === id);
        if (idx !== -1) state.contexts[idx] = updated;
    } catch {
        // Revert optimistic update
        ctx.starred = wasStarred;
        if (starBtn) {
            starBtn.classList.toggle('on', wasStarred);
            const svg = starBtn.querySelector('svg');
            if (svg) svg.setAttribute('fill', wasStarred ? 'currentColor' : 'none');
        }
        if (card) card.classList.toggle('starred', wasStarred);
        showToast('Failed to toggle pin', 'error');
    }
}

const _PIN_SVG = {
    on:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    off: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
};

async function toggleStarDetail(id) {
    const btn = document.getElementById('cv-btn-pin');
    try {
        const res = await fetch(`${API}/api/contexts/${id}/star`, { method: 'POST' });
        if (!res.ok) throw new Error();
        const updated = await res.json();
        state.currentContext = updated;
        // Keep the library grid's copy in sync for the next time it renders.
        const idx = state.contexts.findIndex(c => c.id === id);
        if (idx !== -1) state.contexts[idx] = updated;
        // Patch just the pin button instead of re-rendering the whole page — a
        // full renderDetail() would reset scroll, recollapse the conversation,
        // close Diagnostics, and re-render every chat bubble for a 1-bit change.
        if (btn) {
            const on = !!updated.starred;
            btn.classList.toggle('on', on);
            btn.title = on ? 'Unpin' : 'Pin';
            btn.setAttribute('aria-label', on ? 'Unpin context' : 'Pin context');
            btn.innerHTML = on ? _PIN_SVG.on : _PIN_SVG.off;
        }
    } catch {
        showToast('Failed to toggle pin', 'error');
    }
}

function toggleSelectMode() {
    state.selectMode = !state.selectMode;
    state.selectedIds.clear();
    const bar = $('#bulk-actions-bar');
    const btn = $('#btn-select-mode');
    if (state.selectMode) {
        if (bar) {
            bar.style.display = 'flex';
            // small delay so the CSS transition fires
            requestAnimationFrame(() => bar.classList.add('show'));
        }
        if (btn) { btn.classList.add('active'); btn.classList.add('on'); }
    } else {
        if (bar) {
            bar.classList.remove('show');
            setTimeout(() => { if (!state.selectMode) bar.style.display = 'none'; }, 300);
        }
        if (btn) { btn.classList.remove('active'); btn.classList.remove('on'); }
    }
    _rerenderGrid();
    _updateBulkCount();
}

function toggleSelectCard(id) {
    if (state.selectedIds.has(id)) {
        state.selectedIds.delete(id);
    } else {
        state.selectedIds.add(id);
    }
    // Update the card visual + checkbox without a full re-render
    const card = document.querySelector(`.context-card[data-id="${id}"]`);
    if (card) {
        const cb = card.querySelector('.cv-card-check, .card-checkbox');
        if (cb) cb.checked = state.selectedIds.has(id);
        card.classList.toggle('cv-card-selected', state.selectedIds.has(id));
    }
    _updateBulkCount();
}

function selectAllCards() {
    const filtered = state.activeTagFilter
        ? state.contexts.filter(c => (c.tags || []).includes(state.activeTagFilter))
        : state.contexts;
    filtered.forEach(c => state.selectedIds.add(c.id));
    _rerenderGrid();
    _updateBulkCount();
}

async function bulkDelete() {
    const count = state.selectedIds.size;
    if (!count) return;
    if (!await showConfirm({ title: `Delete ${count} context${count > 1 ? 's' : ''}?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) return;

    try {
        const res = await fetch(`${API}/api/contexts/bulk-delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [...state.selectedIds] }),
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        showToast(`Deleted ${data.deleted} context${data.deleted > 1 ? 's' : ''}`, 'success');
        state.selectMode = false;
        state.selectedIds.clear();
        const bar = $('#bulk-actions-bar');
        if (bar) { bar.classList.remove('show'); setTimeout(() => { bar.style.display = 'none'; }, 300); }
        const selBtn = $('#btn-select-mode');
        if (selBtn) { selBtn.classList.remove('active'); selBtn.classList.remove('on'); }
        loadContexts($('#search-input').value.trim());
    } catch {
        showToast('Bulk delete failed', 'error');
    }
}

function _updateBulkCount() {
    const el = $('#bulk-count');
    if (el) el.textContent = `${state.selectedIds.size} selected`;
}

function _staggeredCards(items) {
    return items.map((ctx, i) =>
        _renderContextCard(ctx).replace(
            /class="context-card([^"]*)"/,
            `class="context-card$1" style="--card-delay:${Math.min(i * 40, 400)}ms"`
        )
    ).join('');
}

function _rerenderGrid(changedId) {
    const grid = $('#contexts-grid');
    // Targeted update: if a single card changed, replace just that card
    if (changedId != null) {
        const existing = grid.querySelector(`.context-card[data-id="${changedId}"]`);
        const ctx = state.contexts.find(c => c.id === changedId);
        if (existing && ctx) {
            const temp = document.createElement('div');
            temp.innerHTML = _renderContextCard(ctx);
            existing.replaceWith(temp.firstElementChild);
            return;
        } else if (existing && !ctx) {
            // Card was deleted
            existing.remove();
            return;
        }
    }
    // Full re-render fallback
    const filtered = state.activeTagFilter
        ? state.contexts.filter(c => (c.tags || []).includes(state.activeTagFilter))
        : state.contexts;
    grid.innerHTML = _staggeredCards(filtered);
    if (typeof _attachCardEffects === 'function') _attachCardEffects(grid);
}

// â”€â”€â”€ Context Detail â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function showDetail(id) {
    // Show detail view immediately with a layout-shaped skeleton (avoids the
    // jarring spinner→full-page pop, gives the eye the final structure up front).
    navigateTo('detail');
    $('#detail-content').innerHTML = _detailSkeleton();
    try {
        const res = await fetch(`${API}/api/contexts/${id}`);
        if (!res.ok) throw new Error('Not found');
        const ctx = await res.json();
        state.currentContext = ctx;

        renderDetail(ctx);

        // Kick off polling immediately if this context is still being summarized
        if (ctx.status === 'summarizing') {
            startWorkerPolling();
        }
    } catch (err) {
        showToast('Failed to load context', 'error');
    }
}

function _detailSkeleton() {
    // Reuses the shared .cv-skel card + .cv-skel-line primitives (lines shimmer
    // via the card's ::before sweep). Mirrors the real detail layout.
    return `
        <section class="cv-dhero">
            <div class="cv-skel" style="min-height:auto;padding:22px 24px">
                <div class="cv-skel-line w40"></div>
                <div class="cv-skel-line w80" style="height:26px;margin-top:14px"></div>
                <div class="cv-skel-line w60" style="margin-top:14px"></div>
            </div>
        </section>
        <section class="cv-dlayout">
            <div class="cv-dmain">
                <div class="cv-skel"></div>
                <div class="cv-skel"></div>
            </div>
            <aside class="cv-daside">
                <div class="cv-skel"></div>
            </aside>
        </section>`;
}

function renderDetail(ctx) {
    _chunksLoaded = false;
    _currentSnippets = _extractFinalCodeSnippets(ctx.original_chat || '');
    const container = $('#detail-content');
    const summary = typeof ctx.summary === 'string' ? {} : (ctx.summary || {});

    const date = new Date(ctx.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
    });
    const timeAgo = _timeAgo(ctx.created_at);

    const keyIdeas      = (summary.key_ideas || []);
    const conclusions   = (summary.conclusions || []);
    const unresolved    = (summary.unresolved_questions || []);
    const importantNotes = (ctx.important_notes || []);
    const vitals        = (summary.vitals || []);
    const snapshot      = summary.snapshot && summary.snapshot.toLowerCase() !== 'n/a' ? summary.snapshot : '';
    const mainTopic     = (summary.main_topic && summary.main_topic !== ctx.title && summary.main_topic !== 'No topic extracted') ? summary.main_topic : '';

    const statusInfo = _buildDetailStatusBanner(ctx.status);
    const source     = (ctx.tags || []).find(t => _KNOWN_SOURCES.includes(t)) || '';
    const aiModel    = _detectAIModel(ctx.tags);
    const starred    = !!ctx.starred;

    // Derive quick metrics for the hero eyebrow + facts grid
    const chatText = ctx.original_chat || '';
    const wordCount = chatText ? chatText.trim().split(/\s+/).length : 0;
    const turnCount = chatText ? (chatText.match(/^(User|Human|You|Assistant|AI|Agent|ChatGPT|Claude|Grok|Gemini|Copilot|DeepSeek|Llama|Mistral|Bot):/gmi) || []).length : 0;
    const tagCount  = (ctx.tags || []).length;

    // Accent the final word of the title — but only when it's a "real" word,
    // so we don't italicize trailing punctuation, numbers, or 1–2 char fragments.
    const titleWords = (ctx.title || '').trim().split(/\s+/);
    const safeTitle = (() => {
        const last = titleWords[titleWords.length - 1] || '';
        if (titleWords.length >= 2 && /^[A-Za-z][A-Za-z'-]{2,}$/.test(last)) {
            const head = titleWords.slice(0, -1).join(' ');
            return `${escapeHtml(head)} <span class="voltword">${escapeHtml(last)}</span>`;
        }
        return escapeHtml(ctx.title || 'Untitled');
    })();

    const tagsHtml = (ctx.tags || [])
        .filter(t => !_KNOWN_SOURCES.includes(t))
        .map(t => `<span class="cv-tag">#${escapeHtml(t)}</span>`).join('');

    const icon = {
        pin:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        pinO:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        edit:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
        export: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        del:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
        back:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
        idea:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>',
        done:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
        open:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/></svg>',
        code:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
        chat:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        chev:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
        pinIc:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v7M5 9l7-7 7 7M12 22v-6"/></svg>',
        vitals: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
        bolt:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></svg>',
        chunks: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
        redo:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>',
    };

    // Eyebrow stays a glance (source + when); the full metrics live once, in the aside.
    const eyebrowBits = [];
    if (source) {
        eyebrowBits.push(`<span class="cv-ebadge">${escapeHtml(source)}</span>`);
        eyebrowBits.push(`<span class="cv-dot"></span>`);
    }
    eyebrowBits.push(`<span>${escapeHtml(timeAgo)}</span>`);

    // Aside detail rows (rendered as a sleek key-value list on the right)
    // Source lives in the eyebrow badge, Collection in the hero <select> — kept out
    // of here so each fact appears exactly once.
    const detailRows = [
        { k: 'Model',   v: aiModel,                  ic: 'cpu'  },
        { k: 'Turns',   v: turnCount || '—',         ic: 'msg'  },
        { k: 'Words',   v: wordCount ? wordCount.toLocaleString() : '—', ic: 'type' },
        { k: 'Tags',    v: tagCount || '—',          ic: 'tag'  },
        { k: 'Created', v: date,                     ic: 'cal'  },
        { k: 'Updated', v: timeAgo,                  ic: 'clk'  },
    ];
    const asideIc = {
        cpu:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>',
        msg:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        type:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
        tag:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
        cal:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
        clk:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    };
    const detailRowsHtml = detailRows.map(r => `
        <div class="cv-aside-row">
            <span class="cv-aside-ic">${asideIc[r.ic] || ''}</span>
            <span class="cv-aside-k">${escapeHtml(r.k)}</span>
            <span class="cv-aside-v" title="${escapeHtml(String(r.v))}">${escapeHtml(String(r.v))}</span>
        </div>
    `).join('');

    container.innerHTML = `
        <!-- Rail: back + meta + actions -->
        <div class="cv-detail-rail">
            <button class="cv-back" onclick="navigateTo('library')" aria-label="Back to library">
                ${icon.back} Library
            </button>
            <div class="cv-rail-meta">
                <span>Context <b>#${ctx.id}</b></span>
                <span class="cv-rail-sep">·</span>
                <span>${escapeHtml(timeAgo)}</span>
            </div>
            <div class="cv-rail-actions">
                <button class="cv-ibtn${starred ? ' on' : ''}" id="cv-btn-pin"
                        onclick="toggleStarDetail(${ctx.id})"
                        title="${starred ? 'Unpin' : 'Pin'}" aria-label="${starred ? 'Unpin' : 'Pin'} context">
                    ${starred ? icon.pin : icon.pinO}
                </button>
                <button class="cv-ibtn" onclick="openEditModal()" title="Edit" aria-label="Edit context">${icon.edit}</button>
                <button class="cv-ibtn" id="cv-btn-resummarize"${ctx.status === 'summarizing' ? ' disabled' : ''}
                        onclick="resummarizeContext()"
                        title="Re-summarize with current model" aria-label="Re-summarize context with current model">${icon.redo}</button>
                <div style="position:relative;">
                    <button class="cv-ibtn" id="cv-export-trigger" onclick="cvToggleExportMenu(event)" title="Export" aria-label="Export context" aria-haspopup="menu" aria-expanded="false">${icon.export}</button>
                    <div class="cv-export-menu" id="cv-export-menu" role="menu">
                        <button class="cv-export-opt" role="menuitem" onclick="exportContext('markdown'); cvCloseExportMenu();">Markdown (.md)</button>
                        <button class="cv-export-opt" role="menuitem" onclick="exportContext('json'); cvCloseExportMenu();">Copy as JSON</button>
                        <button class="cv-export-opt" role="menuitem" onclick="exportContext('text'); cvCloseExportMenu();">Copy as Plain Text</button>
                    </div>
                </div>
                <button class="cv-ibtn cv-ibtn-danger" onclick="deleteCurrentContext()" title="Delete" aria-label="Delete context">${icon.del}</button>
            </div>
        </div>

        <!-- Hero -->
        <section class="cv-dhero">
            <div class="cv-dhero-eyebrow">${eyebrowBits.join('')}</div>
            <h1 class="cv-dtitle" id="detail-title-heading">${safeTitle}</h1>
            ${mainTopic ? `<p class="cv-dtopic">${escapeHtml(mainTopic)}</p>` : ''}
            ${snapshot ? `<p class="cv-dsnap">${escapeHtml(snapshot)}</p>` : ''}
            <div class="cv-dmeta">
                <span class="cv-collection-inline">
                    <select id="detail-collection-select" onchange="handleDetailCollectionChange(${ctx.id}, this.value)">
                        <option value="">Collection: None</option>
                        ${state.collections.map(c =>
                            `<option value="${c.id}"${ctx.collection_id === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
                        ).join('')}
                    </select>
                </span>
            </div>
            ${statusInfo ? `<div class="cv-dstatus${ctx.status === 'failed' ? ' err' : ''}">${statusInfo}</div>` : ''}
        </section>

        <!-- Body: 2-column layout — main content + sleek sticky aside -->
        <section class="cv-dlayout">
          <div class="cv-dmain">

            ${importantNotes.length ? `
            <div class="cv-block cv-block-pinned">
                <div class="cv-block-head">
                    <span class="cv-block-ic cv-ic-volt">${icon.pinIc}</span>
                    <h3>Pinned notes</h3>
                    <span class="cv-count">${importantNotes.length}</span>
                </div>
                <div class="cv-pinned">
                    ${importantNotes.map(n => `<div class="cv-note">${_askSimpleMarkdown(String(n))}</div>`).join('')}
                </div>
            </div>` : ''}

            ${(keyIdeas.length || conclusions.length || unresolved.length) ? `
            <div class="cv-insights">
                ${keyIdeas.length ? `
                <div class="cv-block">
                    <div class="cv-block-head">
                        <span class="cv-block-ic cv-ic-idea">${icon.idea}</span>
                        <h3>Key ideas</h3>
                        <span class="cv-count">${keyIdeas.length}</span>
                    </div>
                    <ul class="cv-list">${keyIdeas.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
                </div>` : ''}
                ${conclusions.length ? `
                <div class="cv-block">
                    <div class="cv-block-head">
                        <span class="cv-block-ic cv-ic-done">${icon.done}</span>
                        <h3>Conclusions</h3>
                        <span class="cv-count">${conclusions.length}</span>
                    </div>
                    <ul class="cv-list">${conclusions.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
                </div>` : ''}
                <div class="cv-block cv-block-open">
                    <div class="cv-block-head">
                        <span class="cv-block-ic cv-ic-open">${icon.open}</span>
                        <h3>Open questions</h3>
                        ${unresolved.length ? `<span class="cv-count">${unresolved.length}</span>` : ''}
                    </div>
                    ${unresolved.length
                        ? `<ul class="cv-list">${unresolved.map(q => `<li>${escapeHtml(q)}</li>`).join('')}</ul>`
                        : `<p class="cv-block-empty">No open questions</p>`}
                </div>
            </div>` : ''}

            ${(!keyIdeas.length && !conclusions.length && !unresolved.length && ctx.status !== 'summarizing' && ctx.status !== 'failed') ? `
            <div class="cv-block cv-empty-insights">
                <span class="cv-block-ic cv-ic-idea">${icon.idea}</span>
                <div class="cv-empty-insights-text">
                    <h3>No structured insights</h3>
                    <p>No AI summary was extracted for this context. You can still generate a continuation prompt or read the original conversation below.</p>
                </div>
                <button class="cv-empty-insights-btn" onclick="retrySummarize()">Re-run summary</button>
            </div>` : ''}

            <!-- ⚡ Continuation prompt — primary action, placed below the read content -->
            <section class="cv-action" id="cv-action-card">
                <div class="cv-action-head">
                    <span class="cv-action-ic">${icon.bolt}</span>
                    <div>
                        <h2 class="cv-action-title">Continuation prompt</h2>
                        <p class="cv-action-sub">Pack this conversation into a ready-to-paste prompt for any AI chat.</p>
                    </div>
                </div>
                <div class="cv-action-row">
                    <input type="text" id="retrieval-query" class="cv-action-input"
                           placeholder="Focus the prompt on… (optional — e.g. 'auth flow', 'the migration plan')" />
                    <button class="cv-action-go" onclick="generatePrompt(${ctx.id}, this)">
                        ${icon.bolt}<span>Generate</span>
                    </button>
                </div>
                <div class="cv-action-foot">
                    <div class="cv-size-seg" id="cv-size-seg" role="tablist" aria-label="Prompt size">
                        <button class="prompt-size-btn" role="tab" aria-selected="false" data-size="compact" data-hint="Compact · ~2,000 chars — fits 4k context windows">Compact</button>
                        <button class="prompt-size-btn on" role="tab" aria-selected="true" data-size="standard" data-hint="Standard · ~5,200 chars — fits most 8k context windows">Standard</button>
                        <button class="prompt-size-btn" role="tab" aria-selected="false" data-size="full" data-hint="Full · ~12,000 chars — for 16k+ context windows">Full</button>
                    </div>
                    <span class="cv-action-hint" id="cv-action-hint">Standard · ~5,200 chars — fits most 8k context windows</span>
                    <span class="cv-action-kbd" aria-hidden="true"><kbd>⌘</kbd><kbd>↵</kbd></span>
                </div>
                <div class="cv-prompt-out" id="prompt-section" role="region" aria-labelledby="prompt-section-heading" style="display:none;">
                    <div class="cv-prompt-out-head">
                        <h3 id="prompt-section-heading">Generated prompt</h3>
                        <span class="cv-prompt-stat" id="cv-prompt-stat"></span>
                        <div class="cv-prompt-out-acts">
                            <button class="cv-prompt-copy" id="copy-prompt-btn" type="button">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                <span>Copy</span>
                            </button>
                            <button class="cv-prompt-close" id="close-prompt-btn" type="button" aria-label="Close">×</button>
                        </div>
                    </div>
                    <pre class="prompt-display" id="prompt-display" tabindex="0"></pre>
                </div>
            </section>

            ${_currentSnippets.length ? `
            <div class="cv-block">
                <div class="cv-block-head">
                    <span class="cv-block-ic">${icon.code}</span>
                    <h3>Code snippets</h3>
                    <span class="cv-count">${_currentSnippets.length}</span>
                </div>
                <div class="cv-snips">
                    ${_currentSnippets.map((s, i) => `
                    <div class="cv-snip">
                        <div class="cv-snip-head">
                            <span class="cv-snip-lang">${escapeHtml(s.label)}</span>
                            <span class="cv-snip-lines">${s.code.split('\n').filter(l => l.trim()).length} lines</span>
                            <button class="cv-snip-copy code-snippet-copy" data-idx="${i}" onclick="copyCodeSnippet(${i})">Copy</button>
                        </div>
                        <pre class="cv-snip-pre"><code>${escapeHtml(s.code.replace(/\n$/, ''))}</code></pre>
                    </div>`).join('')}
                </div>
            </div>` : ''}

            <!-- Original conversation (collapsible) -->
            <div class="cv-block cv-collapse" id="origConv">
                <button class="cv-block-head cv-collapse-head" onclick="this.parentElement.classList.toggle('open')">
                    <span class="cv-block-ic">${icon.chat}</span>
                    <h3>Original conversation</h3>
                    <span class="cv-count">${turnCount || '—'} turns</span>
                    <span class="cv-collapse-chev">${icon.chev}</span>
                </button>
                <div class="cv-chat" id="original-chat-box">${_renderChatBubbles(ctx.original_chat, aiModel)}</div>
            </div>

            <!-- Diagnostics: indexed chunks (collapsed, dev-facing) -->
            <details class="cv-diag" id="chunksBlock">
                <summary class="cv-diag-sum">
                    <span class="cv-diag-ic">${icon.chunks}</span>
                    <span class="cv-diag-label">Diagnostics · indexed chunks</span>
                    <span class="cv-diag-hint" id="chunks-count-badge">view retrieval index</span>
                </summary>
                <div class="cv-diag-body">
                    <div id="chunks-viewer-content" class="cv-chunks"></div>
                </div>
            </details>

          </div>

          <!-- Sticky aside: details + vitals -->
          <aside class="cv-daside">
            <div class="cv-aside-card">
                <div class="cv-aside-head">
                    <span class="cv-aside-eyebrow">Details</span>
                </div>
                <div class="cv-aside-rows">
                    ${detailRowsHtml}
                </div>
            </div>

            ${vitals.length ? `
            <div class="cv-aside-card">
                <div class="cv-aside-head">
                    <span class="cv-aside-eyebrow">Technical vitals</span>
                    <span class="cv-aside-pill">${vitals.length}</span>
                </div>
                <div class="cv-aside-vitals">
                    ${vitals.map(v => `<code>${escapeHtml(v)}</code>`).join('')}
                </div>
            </div>` : ''}

            ${tagsHtml ? `
            <div class="cv-aside-card">
                <div class="cv-aside-head">
                    <span class="cv-aside-eyebrow">Tags</span>
                    <span class="cv-aside-pill">${tagCount}</span>
                </div>
                <div class="cv-aside-tags">${tagsHtml}</div>
            </div>` : ''}
          </aside>
        </section>
    `;

    // Bind copy/close on the inline prompt-output (rendered fresh each view)
    const copyBtn  = document.getElementById('copy-prompt-btn');
    const closeBtn = document.getElementById('close-prompt-btn');
    if (copyBtn)  copyBtn.addEventListener('click', copyPrompt);
    if (closeBtn) closeBtn.addEventListener('click', () => {
        const s = document.getElementById('prompt-section');
        if (s) s.style.display = 'none';
    });

    // Open chunks viewer when the <details> is toggled open (replaces old onclick)
    const diag = document.getElementById('chunksBlock');
    if (diag) {
        diag.addEventListener('toggle', () => {
            if (diag.open && !_chunksLoaded) {
                toggleChunkViewer(ctx.id);
            }
        });
    }

    // Segmented size control — toggle .on class + update live hint
    const hintEl = document.getElementById('cv-action-hint');
    document.querySelectorAll('#cv-size-seg .prompt-size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#cv-size-seg .prompt-size-btn').forEach(b => {
                b.classList.remove('on');
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            btn.classList.add('on');
            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');
            if (hintEl && btn.dataset.hint) hintEl.textContent = btn.dataset.hint;
        });
    });

    // ⌘/Ctrl+Enter on the focus input triggers Generate
    const focusInput = document.getElementById('retrieval-query');
    if (focusInput) {
        focusInput.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                const goBtn = document.querySelector('.cv-action-go');
                if (goBtn && !goBtn.disabled) goBtn.click();
            }
        });
    }

    _initInsightExpand();
    _bindInsightResize();
    $('#prompt-section').style.display = 'none';
}

function _initInsightExpand() {
    requestAnimationFrame(() => {
        document.querySelectorAll('.cv-insights .cv-block').forEach(block => {
            const list = block.querySelector('.cv-list');
            if (!list) return;
            // Reset prior state so this is safe to re-run (e.g. after a resize
            // flips the insights grid between 1/2/3 columns).
            block.classList.remove('cv-expanded');
            list.classList.remove('cv-list--full');
            const oldBtn = block.querySelector('.cv-expand-btn');
            if (oldBtn) oldBtn.remove();

            const overflows = list.scrollHeight > list.clientHeight + 4;
            if (!overflows) {
                list.classList.add('cv-list--full');
                return;
            }
            const total = list.querySelectorAll('li').length;
            const btn = document.createElement('button');
            btn.className = 'cv-expand-btn';
            btn.textContent = `Show all ${total}`;
            btn.onclick = () => {
                const expanded = block.classList.toggle('cv-expanded');
                btn.textContent = expanded ? 'Show less' : `Show all ${total}`;
            };
            block.appendChild(btn);
        });
    });
}

// The insights grid changes column count at breakpoints, so the clamp/overflow
// decision has to be re-measured on resize. Bound once, debounced.
let _insightResizeBound = false;
function _bindInsightResize() {
    if (_insightResizeBound) return;
    _insightResizeBound = true;
    let t;
    window.addEventListener('resize', () => {
        if (!document.querySelector('.cv-insights')) return;
        clearTimeout(t);
        t = setTimeout(_initInsightExpand, 150);
    });
}

// ─── Export menu toggle (used by new cv-detail rail) ─────────────
function cvToggleExportMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('cv-export-menu');
    const trigger = document.getElementById('cv-export-trigger');
    if (!menu) return;
    const open = menu.classList.toggle('open');
    if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Move focus into the menu so keyboard users can arrow through the options.
    if (open) { const first = menu.querySelector('.cv-export-opt'); if (first) first.focus(); }
}
function cvCloseExportMenu(refocus) {
    const menu = document.getElementById('cv-export-menu');
    const trigger = document.getElementById('cv-export-trigger');
    if (menu) menu.classList.remove('open');
    if (trigger) {
        trigger.setAttribute('aria-expanded', 'false');
        if (refocus) trigger.focus();
    }
}
window.cvToggleExportMenu = cvToggleExportMenu;
window.cvCloseExportMenu  = cvCloseExportMenu;
document.addEventListener('click', (e) => {
    if (!e.target.closest('#cv-export-menu') && !e.target.closest('[onclick*="cvToggleExportMenu"]')) {
        cvCloseExportMenu();
    }
});
// Keyboard nav for the open export menu: Esc closes (refocusing the trigger),
// Arrow Up/Down cycle through the options.
document.addEventListener('keydown', (e) => {
    const menu = document.getElementById('cv-export-menu');
    if (!menu || !menu.classList.contains('open')) return;
    const opts = [...menu.querySelectorAll('.cv-export-opt')];
    if (!opts.length) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        cvCloseExportMenu(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = opts.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown'
            ? (i + 1) % opts.length
            : (i - 1 + opts.length) % opts.length;
        opts[next].focus();
    }
});


// â”€â”€â”€ Chat Bubble Renderer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _detectAIModel(tags) {
    if (!tags || !tags.length) return 'AI Assistant';
    const t = tags.map(x => x.toLowerCase());
    if (t.some(x => x.includes('chatgpt') || x.includes('gpt'))) return 'ChatGPT';
    if (t.some(x => x.includes('claude'))) return 'Claude';
    if (t.some(x => x.includes('grok'))) return 'Grok';
    if (t.some(x => x.includes('gemini'))) return 'Gemini';
    if (t.some(x => x.includes('copilot'))) return 'Copilot';
    if (t.some(x => x.includes('deepseek'))) return 'DeepSeek';
    if (t.some(x => x.includes('llama'))) return 'Llama';
    if (t.some(x => x.includes('mistral'))) return 'Mistral';
    return 'AI Assistant';
}

function _renderChatBubbles(text, aiModel) {
    if (!text) return '<div class="cv-msg" style="color:var(--cv-text-3);font-size:12.5px;">No conversation data available.</div>';
    const lines = text.split('\n');
    let html = '';
    let currentRole = null;
    let buffer = [];

    function flushBuffer() {
        if (!currentRole || !buffer.length) return;
        const content = escapeHtml(buffer.join('\n').trim());
        if (!content) return;
        const isUser = currentRole === 'user';
        const avatar = isUser ? 'U' : 'AI';
        const name = isUser ? 'You' : aiModel;
        html += `<div class="cv-msg ${isUser ? 'cv-msg-user' : 'cv-msg-ai'}">
            <div class="cv-msg-av ${isUser ? 'cv-msg-av-user' : 'cv-msg-av-ai'}">${avatar}</div>
            <div class="cv-msg-body">
                <div class="cv-msg-name">${name}</div>
                <div class="cv-msg-text">${content}</div>
            </div>
        </div>`;
        buffer = [];
    }

    for (const line of lines) {
        const trimmed = line.trim();
        if (/^(User|Human|You):/i.test(trimmed)) {
            flushBuffer();
            currentRole = 'user';
            buffer.push(trimmed.replace(/^(User|Human|You):\s*/i, ''));
        } else if (/^(Assistant|AI|Agent|ChatGPT|Claude|Grok|Gemini|Copilot|DeepSeek|Llama|Mistral|Bot):/i.test(trimmed)) {
            flushBuffer();
            currentRole = 'ai';
            buffer.push(trimmed.replace(/^(Assistant|AI|Agent|ChatGPT|Claude|Grok|Gemini|Copilot|DeepSeek|Llama|Mistral|Bot):\s*/i, ''));
        } else {
            if (!currentRole) currentRole = 'user';
            buffer.push(line);
        }
    }
    flushBuffer();
    return html || '<div class="cv-msg" style="color:var(--cv-text-3);font-size:12.5px;">No conversation data available.</div>';
}

// â”€â”€â”€ Final Code Snippets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _currentSnippets = [];

/**
 * Parse all fenced code blocks from a chat string.
 * Returns the LAST occurrence for each language/filename key,
 * preserving order of last appearance.
 */
function _extractFinalCodeSnippets(text) {
    const regex = /```([^\n`]*)\n([\s\S]*?)```/g;
    const order = [];           // keys in order of last appearance
    const byKey = new Map();    // key -> {lang, label, code}
    let m;
    while ((m = regex.exec(text)) !== null) {
        const rawLang = m[1].trim();
        const code = m[2];
        if (!code.trim()) continue;
        // Use the full "lang:filename" as dedup key; fall back to 'text'
        const key = rawLang.replace(/\s+/g, '') || 'text';
        const lang = (rawLang.split(/[\s:/]/)[0] || 'text').toLowerCase();
        if (!order.includes(key)) order.push(key);
        byKey.set(key, { lang, label: rawLang || 'text', code });
    }
    return order.map(k => byKey.get(k));
}

async function copyCodeSnippet(idx) {
    const s = _currentSnippets[idx];
    if (!s) return;
    try {
        await navigator.clipboard.writeText(s.code);
        const btn = document.querySelector(`.code-snippet-copy[data-idx="${idx}"]`);
        if (btn) {
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
        }
    } catch {
        showToast('Copy failed', 'error');
    }
}

// â”€â”€â”€ P2-4: Chunk Viewer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _chunksLoaded = false;

async function toggleChunkViewer(contextId) {
    // Collapse state is handled by the parent .cv-collapse.open class in the new design.
    // This function is now only responsible for lazy-loading chunk data on first open.
    const content = $('#chunks-viewer-content');
    if (!content) return;
    if (_chunksLoaded) return;

    content.innerHTML = `
        <div class="chunks-query-row" style="display:flex;gap:8px;margin-bottom:10px;">
            <input type="text" class="chunks-query-input" id="chunks-query" placeholder="Enter a query to see similarity scores…"
                   style="flex:1;padding:8px 10px;border-radius:8px;background:rgba(6,6,8,0.6);border:1px solid var(--cv-line);color:var(--cv-text-0);font:400 12.5px/1 var(--cv-body);" />
            <button class="cv-snip-copy chunks-score-btn" id="chunks-score-btn" onclick="loadChunks(${contextId})">Score</button>
        </div>
        <div id="chunks-list-container"><div class="chunks-empty" style="color:var(--cv-text-3);font-size:12.5px;">Loading chunks…</div></div>
    `;
    await loadChunks(contextId);
}

async function loadChunks(contextId) {
    const container = $('#chunks-list-container');
    const queryInput = $('#chunks-query');
    const query = queryInput ? queryInput.value.trim() : '';

    container.innerHTML = '<div class="chunks-empty"><span class="spinner" style="display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--text-primary);border-radius:50%;animation:spin 0.55s linear infinite"></span> Loading…</div>';

    try {
        const url = query
            ? `${API}/api/contexts/${contextId}/chunks?query=${encodeURIComponent(query)}`
            : `${API}/api/contexts/${contextId}/chunks`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to load chunks');
        const data = await res.json();

        if (!data.chunks || data.chunks.length === 0) {
            container.innerHTML = '<div class="chunks-empty">No chunks stored for this context yet.</div>';
            return;
        }

        _chunksLoaded = true;
        let html = `<div class="chunks-summary">${data.total} chunks${query ? ' — scored against: "' + escapeHtml(query) + '"' : ''}</div><div class="chunks-list">`;

        for (const ch of data.chunks) {
            const badges = [];
            if (ch.has_code) badges.push('<span class="chunk-badge code">code</span>');
            if (ch.is_starred) badges.push('<span class="chunk-badge starred">â˜… important</span>');

            const scoreHtml = ch.similarity !== null && ch.similarity !== undefined
                ? (() => {
                    const pct = Math.round(ch.similarity * 100);
                    const color = pct >= 70 ? '#34d399' : pct >= 40 ? '#fbbf24' : '#f87171';
                    return `<div class="chunk-score-bar">
                        <div class="chunk-score-track"><div class="chunk-score-fill" style="width:${pct}%;background:${color}"></div></div>
                        <span class="chunk-score-label" style="color:${color}">${pct}%</span>
                    </div>`;
                })()
                : '';

            const text = ch.text.length > 300 ? ch.text.slice(0, 300) + '…' : ch.text;
            const role = ch.role_hint ? `<div class="chunk-role">${escapeHtml(ch.role_hint)}</div>` : '';

            html += `<div class="chunk-card">
                <div class="chunk-card-header">
                    <span class="chunk-index">#${ch.chunk_index}</span>
                    <div class="chunk-badges">${badges.join('')}${scoreHtml}</div>
                </div>
                <div class="chunk-text">${escapeHtml(text)}</div>
                ${role}
            </div>`;
        }

        html += '</div>';
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<div class="chunks-empty" style="color:var(--danger)">${escapeHtml(err.message)}</div>`;
    }
}

window.toggleChunkViewer = toggleChunkViewer;
window.loadChunks = loadChunks;

function toggleOriginalChat() {
    const box = $('#original-chat-box');
    const icon = $('#chat-toggle-icon');
    if (box.style.display === 'none') {
        box.style.display = 'block';
        icon.textContent = 'â–¼';
    } else {
        box.style.display = 'none';
        icon.textContent = 'â–¶';
    }
}

async function generatePrompt(id, btn) {
    let originalHTML = '';
    if (btn) {
        originalHTML = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.6s linear infinite;margin-right:8px;vertical-align:-2px;"></span>Generating…';
    }
    try {
        const activeSize = document.querySelector('.prompt-size-btn.active, .prompt-size-btn.on');
        const size = activeSize ? activeSize.dataset.size : 'standard';
        const queryEl = document.getElementById('retrieval-query');
        const query = queryEl ? queryEl.value.trim() : '';
        const res = await fetch(`${API}/api/contexts/${id}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query || null, size }),
        });
        if (!res.ok) throw new Error('Failed to generate prompt');
        const data = await res.json();
        state.currentPrompt = data.prompt;

        const section = $('#prompt-section');
        section.style.display = 'block';
        $('#prompt-display').textContent = data.prompt;
        const statEl = document.getElementById('cv-prompt-stat');
        if (statEl) {
            const chars = data.prompt.length;
            const tokens = Math.round(chars / 4); // rough heuristic
            statEl.textContent = `${chars.toLocaleString()} chars · ~${tokens.toLocaleString()} tokens`;
        }
        section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
        showToast('Failed to generate prompt', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHTML;
        }
    }
}

// â”€â”€â”€ Edit Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openEditModal() {
    const ctx = state.currentContext;
    if (!ctx) return;

    const summary = typeof ctx.summary === 'string' ? {} : ctx.summary;
    $('#edit-title').value = ctx.title || '';
    $('#edit-tags').value = (ctx.tags || []).join(', ');
    $('#edit-topic').value = summary.main_topic || '';
    $('#edit-notes').value = (ctx.important_notes || []).join('\n');
    $('#edit-modal').style.display = 'flex';

    // Return focus to whatever opened the modal (the rail's edit button).
    trapFocus($('#edit-modal').querySelector('.modal'), document.activeElement);
}

function closeEditModal() {
    const overlay = $('#edit-modal');
    const inner = overlay.querySelector('.modal');
    releaseFocus(inner);
    inner.style.animation = 'shellOut 0.18s var(--ease) forwards';
    overlay.style.animation = 'fadeOut 0.18s var(--ease) forwards';
    setTimeout(() => {
        overlay.style.display = 'none';
        inner.style.animation = '';
        overlay.style.animation = '';
    }, 180);
}

async function saveEdit() {
    const ctx = state.currentContext;
    if (!ctx) return;

    const title = $('#edit-title').value.trim();
    const tags = $('#edit-tags').value.split(',').map(t => t.trim()).filter(Boolean);
    const mainTopic = $('#edit-topic').value.trim();
    const importantNotes = $('#edit-notes').value.split('\n').map(l => l.trim()).filter(Boolean);

    const summary = typeof ctx.summary === 'string' ? {} : { ...ctx.summary };
    if (mainTopic) summary.main_topic = mainTopic;

    try {
        const res = await fetch(`${API}/api/contexts/${ctx.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, tags, summary, important_notes: importantNotes }),
        });

        if (!res.ok) throw new Error('Failed to update');
        const updated = await res.json();
        state.currentContext = updated;
        renderDetail(updated);
        closeEditModal();
        showToast('Context updated', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// â”€â”€â”€ Delete â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function deleteCurrentContext() {
    const ctx = state.currentContext;
    if (!ctx) return;
    openConfirmDeleteModal(ctx);
}

function openConfirmDeleteModal(ctxOrOpts, onConfirm) {
    const overlay = $('#confirm-delete-modal');

    // Support two call shapes:
    //   openConfirmDeleteModal(ctx, onConfirm?)            — context delete
    //   openConfirmDeleteModal({title, message, confirmLabel, onConfirm})
    let title, messageHtml, confirmLabel, action;
    if (ctxOrOpts && typeof ctxOrOpts === 'object' && ('message' in ctxOrOpts || 'title' in ctxOrOpts) && !('id' in ctxOrOpts)) {
        title = ctxOrOpts.title || 'Are you sure?';
        messageHtml = ctxOrOpts.message || '';
        confirmLabel = ctxOrOpts.confirmLabel || 'Delete';
        action = ctxOrOpts.onConfirm;
    } else {
        const ctx = ctxOrOpts;
        title = 'Delete this context?';
        messageHtml = `Delete <b>"${escapeHtml(ctx.title || 'Untitled')}"</b>? You'll have 5 seconds to undo from the toast.`;
        confirmLabel = 'Delete';
        action = onConfirm || (() => _performDeleteCurrentContext(ctx));
    }

    if (!overlay) { if (action) action(); return; }
    state._pendingConfirmDeleteAction = action;

    const titleEl = $('#confirm-delete-title');
    if (titleEl) titleEl.textContent = title;
    const msg = $('#confirm-delete-message');
    if (msg) msg.innerHTML = messageHtml;
    const confirmBtn = $('#confirm-delete-btn');
    if (confirmBtn) confirmBtn.textContent = confirmLabel;

    overlay.style.display = 'flex';
    trapFocus(overlay.querySelector('.modal'), document.activeElement);
    if (confirmBtn) confirmBtn.focus();
}

function closeConfirmDeleteModal() {
    const overlay = $('#confirm-delete-modal');
    if (!overlay) return;
    const inner = overlay.querySelector('.modal');
    releaseFocus(inner);
    inner.style.animation = 'shellOut 0.18s var(--ease) forwards';
    overlay.style.animation = 'fadeOut 0.18s var(--ease) forwards';
    setTimeout(() => {
        overlay.style.display = 'none';
        inner.style.animation = '';
        overlay.style.animation = '';
    }, 180);
    state._pendingConfirmDeleteAction = null;
}

function _performDeleteCurrentContext(ctx) {
    if (!ctx) return;

    // P2-10: Undo delete from detail view
    if (state.pendingDeletes.has(ctx.id)) {
        clearTimeout(state.pendingDeletes.get(ctx.id).timer);
        state.pendingDeletes.delete(ctx.id);
    }

    state.currentContext = null;
    navigateTo('library');

    const timer = setTimeout(() => _commitDelete(ctx.id), 5000);
    state.pendingDeletes.set(ctx.id, { timer, ctx });

    // Remove from visible list immediately
    state.contexts = state.contexts.filter(c => c.id !== ctx.id);
    _rerenderGrid(ctx.id);

    _showUndoToast(`"${ctx.title}" deleted`, () => {
        clearTimeout(timer);
        state.pendingDeletes.delete(ctx.id);
        // Restore to state & re-render
        state.contexts.unshift(ctx);
        _rerenderGrid();
        showToast('Delete undone', 'success');
    });
}

// â”€â”€â”€ Export â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function exportContext(format) {
    cvCloseExportMenu();
    const ctx = state.currentContext;
    if (!ctx) return;

    if (format === 'markdown') {
        window.open(`${API}/api/contexts/${ctx.id}/export/download`, '_blank');
        showToast('Exported as Markdown', 'success');
        return;
    }

    const summary = typeof ctx.summary === 'string' ? {} : ctx.summary;

    if (format === 'json') {
        const data = { title: ctx.title, tags: ctx.tags, summary, created_at: ctx.created_at };
        await _copyText(JSON.stringify(data, null, 2));
        showToast('Summary JSON copied', 'success');
        return;
    }

    if (format === 'text') {
        const lines = [ctx.title, ''];
        if (summary.main_topic) lines.push(`Topic: ${summary.main_topic}`, '');
        if (summary.key_ideas?.length) {
            lines.push('Key Ideas:');
            summary.key_ideas.forEach(i => lines.push(`  - ${i}`));
            lines.push('');
        }
        if (summary.conclusions?.length) {
            lines.push('Conclusions:');
            summary.conclusions.forEach(c => lines.push(`  - ${c}`));
            lines.push('');
        }
        if (summary.unresolved_questions?.length) {
            lines.push('Open Questions:');
            summary.unresolved_questions.forEach(q => lines.push(`  - ${q}`));
        }
        await _copyText(lines.join('\n'));
        showToast('Summary text copied', 'success');
    }
}

async function _copyText(text) {
    await navigator.clipboard.writeText(text);
}

// â”€â”€â”€ Copy to Clipboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function copyPrompt() {
    if (!state.currentPrompt) return;
    try {
        await navigator.clipboard.writeText(state.currentPrompt);
        showToast('Copied to clipboard!', 'success');
        const btn = document.getElementById('copy-prompt-btn');
        if (btn) {
            const label = btn.querySelector('span');
            const original = label ? label.textContent : '';
            btn.classList.add('copied');
            if (label) label.textContent = 'Copied';
            setTimeout(() => {
                btn.classList.remove('copied');
                if (label) label.textContent = original || 'Copy';
            }, 1400);
        }
    } catch {
        showToast('Copy failed — clipboard access denied', 'error');
    }
}

// â”€â”€â”€ Toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showConfirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'cv-confirm-overlay';
        overlay.innerHTML = `
            <div class="cv-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="cv-confirm-title">
                <div class="cv-confirm-title" id="cv-confirm-title">${escapeHtml(title)}</div>
                ${message ? `<div class="cv-confirm-message">${escapeHtml(message)}</div>` : ''}
                <div class="cv-confirm-actions">
                    <button class="cv-confirm-cancel">Cancel</button>
                    <button class="cv-confirm-ok${danger ? ' danger' : ''}">${escapeHtml(confirmLabel)}</button>
                </div>
            </div>`;

        const dismiss = (result) => {
            overlay.classList.add('cv-confirm-out');
            setTimeout(() => { overlay.remove(); resolve(result); }, 150);
        };

        const confirmCancel = overlay.querySelector('.cv-confirm-cancel');
        const confirmOk = overlay.querySelector('.cv-confirm-ok');
        if (confirmCancel) confirmCancel.addEventListener('click', () => dismiss(false));
        if (confirmOk) confirmOk.addEventListener('click', () => dismiss(true));
        overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(false); });
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') dismiss(false); });

        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('cv-confirm-in'));
        overlay.querySelector('.cv-confirm-cancel').focus();
    });
}

function showPrompt({ title, message, defaultValue = '', placeholder = '', confirmLabel = 'Save', maxLength = 200 }) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'cv-confirm-overlay';
        overlay.innerHTML = `
            <div class="cv-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="cv-prompt-title">
                <div class="cv-confirm-title" id="cv-prompt-title">${escapeHtml(title)}</div>
                ${message ? `<div class="cv-confirm-message">${escapeHtml(message)}</div>` : ''}
                <input type="text" class="cv-confirm-input"
                       value="${escapeHtml(defaultValue)}"
                       placeholder="${escapeHtml(placeholder)}"
                       maxlength="${maxLength}" autocomplete="off" spellcheck="false" />
                <div class="cv-confirm-actions">
                    <button class="cv-confirm-cancel">Cancel</button>
                    <button class="cv-confirm-ok">${escapeHtml(confirmLabel)}</button>
                </div>
            </div>`;

        const dismiss = (result) => {
            overlay.classList.add('cv-confirm-out');
            setTimeout(() => { overlay.remove(); resolve(result); }, 150);
        };

        const input = overlay.querySelector('.cv-confirm-input');
        const cancelBtn = overlay.querySelector('.cv-confirm-cancel');
        const okBtn = overlay.querySelector('.cv-confirm-ok');

        const submit = () => {
            const v = (input.value || '').trim();
            dismiss(v || null);
        };

        cancelBtn.addEventListener('click', () => dismiss(null));
        okBtn.addEventListener('click', submit);
        overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(null); });
        overlay.addEventListener('keydown', e => {
            if (e.key === 'Escape') dismiss(null);
            if (e.key === 'Enter' && document.activeElement === input) submit();
        });

        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('cv-confirm-in'));
        // Focus input + select existing text so the user can immediately type a replacement.
        setTimeout(() => { input.focus(); input.select(); }, 0);
    });
}

function showToast(message, type = 'success') {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
        // Fallback: create the stack on the fly if it was somehow removed
        stack = document.createElement('div');
        stack.className = 'toast-stack';
        stack.id = 'toast-stack';
        stack.setAttribute('role', 'status');
        stack.setAttribute('aria-live', 'polite');
        document.body.appendChild(stack);
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '\u2705' : '\u274C'}</span><span class="toast-message">${escapeHtml(message)}</span>`;
    stack.appendChild(toast);

    // Auto-remove after 3s
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);

    // Cap at 5 visible toasts
    while (stack.children.length > 5) {
        stack.firstChild.remove();
    }

    // Mirror into the Notification Center with a smarter title
    try {
        const m = String(message || '').toLowerCase();
        let title;
        if (m.includes('summariz')) title = type === 'error' ? 'Summarization failed' : 'Summarization complete';
        else if (m.includes('embed')) title = type === 'error' ? 'Embedding failed' : 'Context saved';
        else if (m.includes('retry') || m.includes('retrying') || m.includes('re-summariz')) title = 'Retrying';
        else if (m.includes('deleted') || m.includes('delete')) title = type === 'error' ? 'Delete failed' : 'Deleted';
        else if (m.includes('copied') || m.includes('copy')) title = type === 'error' ? 'Copy failed' : 'Copied';
        else if (m.includes('failed') || m.includes('error')) title = 'Error';
        cvNotify(type, message, title ? { title } : {});
    } catch (_) {}
}

// \u2500\u2500\u2500 Notification Center \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const CV_NOTIF_KEY = 'cv_notifications_v1';
let _cvNotifs = [];
let _cvNotifLoaded = false;

function _cvLoadNotifs() {
    if (_cvNotifLoaded) return;
    try { _cvNotifs = JSON.parse(localStorage.getItem(CV_NOTIF_KEY) || '[]'); } catch (_) { _cvNotifs = []; }
    if (!Array.isArray(_cvNotifs)) _cvNotifs = [];
    _cvNotifLoaded = true;
}
function _cvSaveNotifs() {
    try { localStorage.setItem(CV_NOTIF_KEY, JSON.stringify(_cvNotifs.slice(0, 50))); } catch (_) {}
}
function _cvNotifDefaultTitle(type) {
    return ({
        success: 'Done',
        error: 'Something went wrong',
        warning: 'Heads up',
        info: 'Notice',
        retry: 'Retrying',
    })[type] || 'Notification';
}
function cvNotify(type, message, opts = {}) {
    _cvLoadNotifs();
    const t = ['success','error','warning','info','retry'].includes(type) ? type : 'info';
    const n = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: t,
        title: opts.title || _cvNotifDefaultTitle(t),
        message: message || '',
        ts: Date.now(),
        read: false,
    };
    // Collapse duplicate of the most recent (same type + message) within 2s
    const head = _cvNotifs[0];
    if (head && head.type === t && head.message === n.message && (n.ts - head.ts) < 2000) return;
    _cvNotifs.unshift(n);
    _cvNotifs = _cvNotifs.slice(0, 50);
    _cvSaveNotifs();
    _cvRenderBadge();
    if (_cvPanelOpen()) _cvRenderList();
}
window.cvNotify = cvNotify;

function _cvPanelOpen() {
    const p = document.getElementById('cv-notify-panel');
    return !!(p && !p.hasAttribute('hidden'));
}
function _cvOpenPanel() {
    const p = document.getElementById('cv-notify-panel');
    const b = document.getElementById('cv-notify-btn');
    if (!p) return;
    p.removeAttribute('hidden');
    if (b) b.setAttribute('aria-expanded', 'true');
    _cvRenderList();
    // Mark as read on open
    let dirty = false;
    _cvNotifs.forEach(n => { if (!n.read) { n.read = true; dirty = true; } });
    if (dirty) { _cvSaveNotifs(); _cvRenderBadge(); }
}
function _cvClosePanel() {
    const p = document.getElementById('cv-notify-panel');
    const b = document.getElementById('cv-notify-btn');
    if (!p) return;
    p.setAttribute('hidden', '');
    if (b) b.setAttribute('aria-expanded', 'false');
}
function _cvRenderBadge() {
    const dot = document.getElementById('cv-notify-dot');
    if (!dot) return;
    const unread = _cvNotifs.filter(n => !n.read).length;
    if (unread > 0) {
        dot.removeAttribute('hidden');
        dot.textContent = unread > 9 ? '9+' : String(unread);
    } else {
        dot.setAttribute('hidden', '');
        dot.textContent = '';
    }
}
function _cvNotifIcon(t) {
    const wrap = (inner) => `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
    if (t === 'success') return wrap('<polyline points="20 6 9 17 4 12"/>');
    if (t === 'error')   return wrap('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>');
    if (t === 'warning') return wrap('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>');
    if (t === 'retry')   return wrap('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>');
    return wrap('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>');
}
function _cvRelTime(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    if (s < 604800) return `${Math.floor(s/86400)}d ago`;
    const d = new Date(ts);
    return d.toLocaleDateString();
}
function _cvRenderList() {
    const list  = document.getElementById('cv-notify-list');
    const empty = document.getElementById('cv-notify-empty');
    const count = document.getElementById('cv-notify-count');
    if (!list) return;
    if (count) count.textContent = String(_cvNotifs.length);
    if (!_cvNotifs.length) {
        list.innerHTML = '';
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';
    list.innerHTML = _cvNotifs.map(n => `
        <div class="cv-notif-item type-${n.type}${n.read ? '' : ' unread'}" data-nid="${n.id}">
            <div class="cv-notif-icon">${_cvNotifIcon(n.type)}</div>
            <div class="cv-notif-body">
                <div class="cv-notif-title">${escapeHtml(n.title)}</div>
                <div class="cv-notif-msg">${escapeHtml(n.message)}</div>
                <div class="cv-notif-time">${_cvRelTime(n.ts)}</div>
            </div>
            <button class="cv-notif-dismiss" aria-label="Dismiss notification" data-dismiss="${n.id}" type="button">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
        </div>
    `).join('');
    list.querySelectorAll('[data-dismiss]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.getAttribute('data-dismiss');
            _cvNotifs = _cvNotifs.filter(n => n.id !== id);
            _cvSaveNotifs();
            _cvRenderList();
            _cvRenderBadge();
        });
    });
}
function _initNotifCenter() {
    _cvLoadNotifs();
    _cvRenderBadge();
    const btn   = document.getElementById('cv-notify-btn');
    const panel = document.getElementById('cv-notify-panel');
    const wrap  = document.getElementById('cv-notify-wrap');
    if (!btn || !panel || !wrap) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_cvPanelOpen()) _cvClosePanel(); else _cvOpenPanel();
    });
    const clearBtn = document.getElementById('cv-notify-clear');
    if (clearBtn) clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _cvNotifs = []; _cvSaveNotifs(); _cvRenderList(); _cvRenderBadge();
    });
    const markBtn = document.getElementById('cv-notify-mark-read');
    if (markBtn) markBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _cvNotifs.forEach(n => n.read = true);
        _cvSaveNotifs(); _cvRenderList(); _cvRenderBadge();
    });
    document.addEventListener('click', (e) => {
        if (_cvPanelOpen() && !e.target.closest('#cv-notify-wrap')) _cvClosePanel();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _cvPanelOpen()) _cvClosePanel();
    });
    // Refresh relative timestamps every 60s while open
    setInterval(() => { if (_cvPanelOpen()) _cvRenderList(); }, 60000);
}

// â”€â”€â”€ P2-10: Undo Toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _showUndoToast(message, onUndo) {
    const stack = $('#toast-stack');
    const toast = document.createElement('div');
    toast.className = 'toast undo';
    toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></span>
        <span class="toast-message">${escapeHtml(message)}</span>
        <button class="toast-undo-btn">Undo</button>
        <div class="toast-countdown"></div>
    `;
    stack.appendChild(toast);

    const undoBtn = toast.querySelector('.toast-undo-btn');
    if (undoBtn) undoBtn.addEventListener('click', () => {
        if (onUndo) onUndo();
        toast.remove();
    });

    // Auto-remove after 5.3s (a bit after the countdown animation)
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        setTimeout(() => toast.remove(), 300);
    }, 5300);

    while (stack.children.length > 5) {
        stack.firstChild.remove();
    }
}

// --- Action Toast (long-lived, with a single action button) ---
function _showActionToast(message, actionLabel, onAction) {
    const stack = $('#toast-stack');
    const toast = document.createElement('div');
    toast.className = 'toast undo';   // reuse the undo-toast styling (icon + button)
    toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true">i</span>
        <span class="toast-message">${escapeHtml(message)}</span>
        <button class="toast-undo-btn">${escapeHtml(actionLabel)}</button>
    `;
    stack.appendChild(toast);

    const actionBtn = toast.querySelector('.toast-undo-btn');
    if (actionBtn) actionBtn.addEventListener('click', () => {
        try { if (onAction) onAction(); } finally { toast.remove(); }
    });

    // Stays for 12s â€” long enough to read and act, but auto-dismisses.
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        setTimeout(() => toast.remove(), 300);
    }, 12000);

    while (stack.children.length > 5) {
        stack.firstChild.remove();
    }
}

// â”€â”€â”€ Status Indicator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function updateStatusIndicator(online, label) {
    const dot = $('.status-dot');
    const text = $('.status-text');
    if (online) {
        dot.classList.add('online');
        dot.classList.remove('offline');
        text.textContent = label || 'LLM Ready';
    } else {
        dot.classList.remove('online');
        dot.classList.add('offline');
        text.textContent = 'LLM Offline';
    }
}

// â”€â”€â”€ Rebuild Embeddings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function rebuildEmbeddings() {
    const btn = $('#btn-rebuild-embeddings');
    if (!btn) return;

    if (!await showConfirm({ title: 'Rebuild All Embeddings?', message: 'This will re-chunk and re-embed all saved contexts using the current embedding model. Existing embeddings will be replaced.', confirmLabel: 'Rebuild', danger: true })) return;

    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Starting…';

    try {
        const res = await fetch(`${API}/api/contexts/chunk-all?force=true`, { method: 'POST' });
        if (!res.ok) throw new Error('Request failed');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastData = null;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const data = JSON.parse(line);
                    lastData = data;
                    if (data.total > 0) {
                        btn.textContent = `Re-embedding… ${data.done} / ${data.total}`;
                    }
                } catch { /* ignore */ }
            }
        }

        if (lastData) {
            const msg = lastData.total === 0
                ? 'No contexts found'
                : `Re-embedded ${lastData.updated} contexts with new model (${lastData.skipped} skipped)`;
            showToast(msg, 'success');
        }
    } catch {
        showToast('Re-embed failed — check that your embed model is installed', 'error');
    } finally {
        btn.textContent = original;
        btn.disabled = false;
    }
}

// â”€â”€â”€ Settings Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _settingsConfig = null; // last loaded config from backend
let _settingsConfigPromise = null; // in-flight fetch (deduplicated)

// ─── ConVX as MCP Server panel ──────────────────────────────────────────
// Populated each time the settings modal opens. Loopback-only endpoint —
// the backend rejects non-127.0.0.1 callers, so the token is safe to display.

let _mcpServerInfoCached = null;

function _setMcpStatus(state, text) {
    const el = $('#settings-mcp-status');
    if (!el) return;
    el.dataset.state = state;
    el.textContent = text;
}

async function _loadMcpServerPanel(force = false) {
    if (_mcpServerInfoCached && !force) {
        _renderMcpServerPanel(_mcpServerInfoCached);
        // Refresh in background to pick up token regenerations from elsewhere
        _fetchMcpServerInfo().then(info => {
            if (info) { _mcpServerInfoCached = info; _renderMcpServerPanel(info); }
        });
        return;
    }
    _setMcpStatus('loading', 'checking…');
    const info = await _fetchMcpServerInfo();
    if (info) {
        _mcpServerInfoCached = info;
        _renderMcpServerPanel(info);
    }
}

async function _fetchMcpServerInfo() {
    try {
        const r = await fetch(`${API}/api/mcp_server/info`);
        if (!r.ok) {
            _setMcpStatus('error', `unreachable (${r.status})`);
            return null;
        }
        return await r.json();
    } catch (e) {
        _setMcpStatus('error', 'unreachable');
        return null;
    }
}

function _renderMcpServerPanel(info) {
    if (!info) return;
    const urlInput   = $('#settings-mcp-http-url');
    const tokenInput = $('#settings-mcp-http-token');
    const authChk    = $('#settings-mcp-auth-required');
    const snippet    = $('#settings-mcp-stdio-snippet');

    if (urlInput)   urlInput.value   = info.http?.url || '';
    if (tokenInput) tokenInput.value = info.http?.token || '';
    if (authChk)    authChk.checked  = !!info.http?.auth_required;
    if (snippet)    snippet.textContent = info.stdio?.config_snippet || '';

    _setMcpStatus('ok', 'running');
}

function _initMcpServerPanelHandlers() {
    // Generic copy buttons (any element with data-copy-target)
    document.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-copy-target]');
        if (!btn) return;
        const target = document.getElementById(btn.dataset.copyTarget);
        if (!target) return;
        const value = target.value !== undefined ? target.value : target.textContent;
        try {
            await navigator.clipboard.writeText(value || '');
            const orig = btn.textContent;
            btn.textContent = 'Copied';
            btn.classList.add('settings-mcp-btn-success');
            setTimeout(() => {
                btn.textContent = orig;
                btn.classList.remove('settings-mcp-btn-success');
            }, 1200);
        } catch {
            showToast('Copy failed', 'error');
        }
    });

    // Show/hide token
    const toggle = $('#settings-mcp-token-toggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const input = $('#settings-mcp-http-token');
            if (!input) return;
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            toggle.textContent = showing ? 'Show' : 'Hide';
            toggle.setAttribute('aria-pressed', String(!showing));
        });
    }

    // Regenerate token
    const regen = $('#settings-mcp-token-regen');
    if (regen) {
        regen.addEventListener('click', async () => {
            if (!confirm('Regenerating revokes the old token immediately. Any client using it will need the new value. Continue?')) return;
            regen.disabled = true;
            try {
                const r = await fetch(`${API}/api/mcp_server/regenerate_token`, { method: 'POST' });
                if (!r.ok) throw new Error(`status ${r.status}`);
                const data = await r.json();
                const input = $('#settings-mcp-http-token');
                if (input) input.value = data.token || '';
                if (_mcpServerInfoCached?.http) _mcpServerInfoCached.http.token = data.token;
                showToast('Token regenerated', 'success');
            } catch (e) {
                showToast(`Regenerate failed: ${e.message}`, 'error');
            } finally {
                regen.disabled = false;
            }
        });
    }

    // Auth-required toggle
    const authChk = $('#settings-mcp-auth-required');
    if (authChk) {
        authChk.addEventListener('change', async () => {
            const required = authChk.checked;
            try {
                const r = await fetch(`${API}/api/mcp_server/auth_required`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ required }),
                });
                if (!r.ok) throw new Error(`status ${r.status}`);
                if (_mcpServerInfoCached?.http) _mcpServerInfoCached.http.auth_required = required;
                showToast(required ? 'Bearer token now required' : 'Auth disabled — be careful', required ? 'success' : 'warning');
            } catch (e) {
                authChk.checked = !required; // revert
                showToast(`Update failed: ${e.message}`, 'error');
            }
        });
    }
}

// ─── Cloudflare Tunnel panel ──────────────────────────────────────────────────

let _tunnelPollTimer = null;
let _tunnelInfo = null;   // last known status

const _TUNNEL_PLATFORM_CONFIGS = {
    'claude-ai': (url, _token) => {
        const base = url.replace(/\/mcp$/, '');
        return {
            steps: [
                'Open <b>claude.ai</b> → avatar → <b>Settings</b> → <b>Integrations</b>',
                'Click <b>Add integration</b> and paste the MCP URL below',
                'Claude.ai will redirect you to a ConVX "Allow Access" page — click <b>Allow</b>',
            ],
            snippet: null,
            snippetLabel: null,
            fields: [
                { label: 'MCP URL', value: url },
                { label: 'OAuth authorize', value: `${base}/oauth/authorize` },
                { label: 'OAuth token', value: `${base}/oauth/token` },
            ],
        };
    },
    'chatgpt': (url, token) => ({
        steps: [
            'Open <b>chatgpt.com</b> → Settings → <b>Connected apps</b>',
            'Click <b>Add MCP server</b> and enter the URL below',
            'Add <code>Authorization: Bearer &lt;token&gt;</code> as a custom header',
        ],
        snippet: null,
        snippetLabel: null,
        fields: [
            { label: 'MCP URL', value: url },
            { label: 'Bearer token', value: token },
        ],
    }),
    'grok': (url, _token) => {
        const base = url.replace(/\/mcp$/, '');
        return {
            steps: [
                'Go to <b>grok.com/connectors</b> → <b>New Connector</b>',
                'Paste the values below into the OAuth form — leave Client Secret empty',
                'Click <b>Save &amp; Connect</b> → Grok opens a browser tab → click <b>Allow Access</b>',
            ],
            snippet: null,
            snippetLabel: null,
            fields: [
                { label: 'Client ID', value: 'convx' },
                { label: 'Client Secret', value: '(leave empty)' },
                { label: 'Authorization Endpoint', value: `${base}/oauth/authorize` },
                { label: 'Token Endpoint', value: `${base}/oauth/token` },
                { label: 'Scopes', value: '(leave empty)' },
                { label: 'Token Auth Method', value: 'none (PKCE only, recommended)' },
            ],
        };
    },
    'cursor': (url, token) => ({
        steps: [
            'Open <b>~/.cursor/mcp.json</b> (global) or <b>.cursor/mcp.json</b> in your project',
            'Add the snippet below, then restart Cursor',
        ],
        snippet: JSON.stringify({
            mcpServers: {
                contextvolt: {
                    url,
                    headers: { Authorization: `Bearer ${token}` },
                },
            },
        }, null, 2),
        snippetLabel: 'Paste into ~/.cursor/mcp.json',
        fields: null,
    }),
    'claude-desktop': (url, token) => ({
        steps: [
            'Open Claude Desktop → Settings → <b>Developer</b> → <b>Edit Config</b>',
            'Add the snippet below to your <code>claude_desktop_config.json</code>',
            'Restart Claude Desktop',
        ],
        snippet: JSON.stringify({
            mcpServers: {
                contextvolt: {
                    url,
                    headers: { Authorization: `Bearer ${token}` },
                },
            },
        }, null, 2),
        snippetLabel: 'Paste into claude_desktop_config.json',
        fields: null,
    }),
};

function _renderTunnelPlatformContent(platform, mcpUrl, token) {
    const el = $('#tunnel-platform-content');
    if (!el) return;
    const cfg = (_TUNNEL_PLATFORM_CONFIGS[platform] || _TUNNEL_PLATFORM_CONFIGS['claude-ai'])(mcpUrl, token);
    let html = '<div class="tunnel-platform-body">';

    // Steps
    if (cfg.steps?.length) {
        html += '<ol class="tunnel-steps">';
        cfg.steps.forEach(s => { html += `<li>${s}</li>`; });
        html += '</ol>';
    }

    // Key-value fields (URL / token)
    if (cfg.fields?.length) {
        cfg.fields.forEach(f => {
            const id = `tunnel-field-${f.label.replace(/\s+/g, '-').toLowerCase()}`;
            html += `
            <div class="settings-mcp-row" style="margin-top:8px;">
                <label class="settings-mcp-label">${f.label}</label>
                <div class="settings-mcp-input-row">
                    <input type="text" class="settings-mcp-input" id="${id}" readonly value="${_esc(f.value)}">
                    <button type="button" class="settings-mcp-btn" data-copy-target="${id}">Copy</button>
                </div>
            </div>`;
        });
    }

    // JSON snippet
    if (cfg.snippet) {
        const snippetId = 'tunnel-snippet-' + platform;
        html += `
        <div class="settings-mcp-row" style="margin-top:8px;">
            <label class="settings-mcp-label">${cfg.snippetLabel || 'Config snippet'}</label>
            <div class="settings-mcp-input-row settings-mcp-input-row-stack">
                <pre class="settings-mcp-code" id="${snippetId}">${_esc(cfg.snippet)}</pre>
                <button type="button" class="settings-mcp-btn" data-copy-target="${snippetId}">Copy JSON</button>
            </div>
        </div>`;
    }

    html += '</div>';
    el.innerHTML = html;
}

function _esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _renderTunnelPanel(data) {
    _tunnelInfo = data;
    const badge   = $('#tunnel-badge');
    const urlInput = $('#tunnel-url-input');
    const copyBtn  = $('#tunnel-copy-btn');
    const toggleBtn = $('#tunnel-toggle-btn');
    const helpText  = $('#tunnel-help-text');
    const platformSection = $('#tunnel-platform-section');

    if (!badge) return;

    const { status, mcp_url, error } = data;

    badge.dataset.state = status;
    const labels = { stopped:'stopped', downloading:'downloading…', starting:'connecting…', running:'running', error:'error' };
    badge.textContent = labels[status] || status;

    const running = status === 'running';
    const busy    = status === 'downloading' || status === 'starting';

    if (urlInput) urlInput.value = running && mcp_url ? mcp_url : '';
    if (copyBtn)  copyBtn.disabled = !running;

    if (toggleBtn) {
        toggleBtn.textContent = running ? 'Stop Tunnel' : (busy ? '…' : 'Start Tunnel');
        toggleBtn.disabled = busy;
        toggleBtn.classList.toggle('settings-mcp-btn-danger', running);
        toggleBtn.classList.toggle('settings-mcp-btn-primary', !running);
    }

    if (helpText) {
        if (error) {
            helpText.innerHTML = `<span style="color:var(--danger,#f87171)">Error: ${_esc(error)}</span>`;
        } else if (running) {
            helpText.textContent = "Tunnel active — your vault's /mcp endpoint is reachable over HTTPS. Pick a platform below to get its connection config.";
        } else if (busy) {
            helpText.textContent = status === 'downloading'
                ? 'Downloading cloudflared (~40 MB)…'
                : 'Establishing tunnel — this usually takes 5–10 seconds…';
        } else {
            helpText.textContent = 'cloudflared is downloaded once and cached. Your vault stays on your machine — only /mcp is exposed, protected by your bearer token.';
        }
    }

    if (platformSection) platformSection.style.display = running ? 'block' : 'none';

    // If running, refresh the active platform tab
    if (running && mcp_url) {
        const active = $('.tunnel-tab.active');
        const plat = active?.dataset?.platform || 'claude-ai';
        const token = _mcpServerInfoCached?.http?.token || '';
        _renderTunnelPlatformContent(plat, mcp_url, token);
    }
}

async function _fetchTunnelStatus() {
    try {
        const r = await fetch(`${API}/api/mcp_server/tunnel`);
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    }
}

async function _loadTunnelPanel() {
    const data = await _fetchTunnelStatus();
    if (data) _renderTunnelPanel(data);
}

function _startTunnelPoll() {
    _stopTunnelPoll();
    _tunnelPollTimer = setInterval(async () => {
        const data = await _fetchTunnelStatus();
        if (!data) return;
        _renderTunnelPanel(data);
        // Stop polling once stable
        if (data.status === 'running' || data.status === 'stopped' || data.status === 'error') {
            _stopTunnelPoll();
        }
    }, 2000);
}

function _stopTunnelPoll() {
    if (_tunnelPollTimer) { clearInterval(_tunnelPollTimer); _tunnelPollTimer = null; }
}

function _initTunnelPanelHandlers() {
    const toggleBtn = $('#tunnel-toggle-btn');
    if (!toggleBtn) return;

    toggleBtn.addEventListener('click', async () => {
        const status = _tunnelInfo?.status || 'stopped';
        const running = status === 'running';
        toggleBtn.disabled = true;

        try {
            const endpoint = running ? '/api/mcp_server/tunnel/stop' : '/api/mcp_server/tunnel/start';
            const r = await fetch(`${API}${endpoint}`, { method: 'POST' });
            if (!r.ok) throw new Error(`status ${r.status}`);

            // Immediately refresh and start polling for transient states
            const data = await _fetchTunnelStatus();
            if (data) _renderTunnelPanel(data);
            if (!running) _startTunnelPoll();
        } catch (e) {
            showToast(`Tunnel error: ${e.message}`, 'error');
        } finally {
            toggleBtn.disabled = false;
        }
    });

    // Platform tab switching
    document.addEventListener('click', (e) => {
        const tab = e.target.closest('.tunnel-tab');
        if (!tab) return;
        document.querySelectorAll('.tunnel-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const plat = tab.dataset.platform;
        const mcp_url = _tunnelInfo?.mcp_url || '';
        const token = _mcpServerInfoCached?.http?.token || '';
        _renderTunnelPlatformContent(plat, mcp_url, token);
    });
}

function _prefetchSettingsConfig() {
    if (_settingsConfig || _settingsConfigPromise) return;
    _settingsConfigPromise = fetch(`${API}/api/setup/config`)
        .then(r => r.json())
        .then(data => { _settingsConfig = data; _settingsConfigPromise = null; })
        .catch(() => { _settingsConfigPromise = null; });
}

function _showSettingsSkeletons() {
    const llmGrid   = $('#settings-llm-grid');
    const embedGrid = $('#settings-embed-grid');
    const skels = n => Array.from({length: n}, () => '<div class="settings-skeleton-card"></div>').join('');
    llmGrid.innerHTML   = skels(3);
    embedGrid.innerHTML = skels(4);
}

async function openSettingsModal() {
    const modal = $('#settings-modal');
    modal.style.display = 'flex';

    // Reset warning
    $('#settings-embed-warning').classList.remove('visible');

    // Keyboard trap — keep focus inside while open
    trapFocus(modal.querySelector('.settings-modal'), $('#btn-settings'));

    // Load the ConVX-as-MCP-server panel in parallel — independent of provider config
    _loadMcpServerPanel();
    _loadTunnelPanel();

    // If already cached, render instantly — no loading state needed
    if (_settingsConfig) {
        _renderSettingsCards();
        // Refresh in background to pick up any install changes
        fetch(`${API}/api/setup/config`)
            .then(r => r.json())
            .then(data => { _settingsConfig = data; _renderSettingsCards(); })
            .catch(() => {});
        return;
    }

    // Show skeleton cards while loading
    _showSettingsSkeletons();

    try {
        // Reuse the in-flight prefetch if it's already running
        if (_settingsConfigPromise) await _settingsConfigPromise;
        if (!_settingsConfig) {
            const res = await fetch(`${API}/api/setup/config`);
            _settingsConfig = await res.json();
        }
        _renderSettingsCards();
    } catch {
        showToast('Could not load config', 'error');
    }
}

function closeSettingsModal() {
    // Detach card references so downloads continue headlessly
    for (const dl of _downloads.values()) dl.card = null;

    const overlay = $('#settings-modal');
    const inner = overlay.querySelector('.settings-modal');
    releaseFocus(inner);
    inner.style.animation = 'shellOut 0.18s var(--ease) forwards';
    overlay.style.animation = 'fadeOut 0.18s var(--ease) forwards';
    setTimeout(() => {
        overlay.style.display = 'none';
        inner.style.animation = '';
        overlay.style.animation = '';
    }, 180);
}

function _makeSettingsCard(item, selectedId, containerId, onSelect) {
    const card = document.createElement('div');
    card.className = 'settings-model-card' + (item.id === selectedId ? ' selected' : '')
                     + (item.fits_vram === false ? ' too-large' : '');
    card.dataset.id = item.id;
    card.dataset.installed = item.installed ? 'true' : 'false';

    const label = item.label || item.id;
    const desc  = item.desc  || '';
    const size  = item.size  || '';
    const rec   = item.recommended;
    const inst  = item.installed;
    const fitsVram = item.fits_vram !== false;

    const statusBadge = inst
        ? '<span class="settings-installed-badge">✓ Installed</span>'
        : '<span class="settings-not-installed-badge">Not downloaded</span>';

    const downloadIcon = `<svg class="settings-download-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M3 12h10"/></svg>`;

    card.innerHTML = `
        <div class="settings-model-card-left">
            <div class="settings-model-name">${escapeHtml(label)}</div>
            <div class="settings-model-desc">${escapeHtml(desc)}</div>
            <div class="settings-download-area" id="dl-area-${item.id.replace(/[:.]/g, '-')}" style="display:none;"></div>
        </div>
        <div class="settings-model-card-right">
            <span class="settings-status-badge" id="status-badge-${item.id.replace(/[:.]/g, '-')}">${statusBadge.replace(/<\/?span[^>]*>/g, '')}</span>
            ${rec ? '<span class="settings-model-badge">Recommended for your GPU</span>' : ''}
            ${!fitsVram ? '<span class="settings-model-badge-warn" title="Too large for your VRAM — will run slowly with constant reloads">Low VRAM</span>' : ''}
            <span class="settings-model-size">${escapeHtml(size)}</span>
            ${inst
                ? `<button class="settings-delete-btn" title="Delete model" aria-label="Delete ${escapeHtml(label)}">✕</button>`
                : `<span class="settings-dl-icon" title="Not downloaded">${downloadIcon}</span>`}
            <div class="settings-model-radio"></div>
        </div>`;

    // Apply correct class to status badge
    const badge = card.querySelector('.settings-status-badge');
    if (inst) {
        badge.className = 'settings-installed-badge';
        badge.textContent = '✓ Installed';
    } else {
        badge.className = 'settings-not-installed-badge';
        badge.textContent = 'Not downloaded';
    }

    // If this model is currently downloading (settings was closed mid-download),
    // reattach the card so progress is reflected again.
    if (_downloads.has(item.id)) {
        _downloads.get(item.id).card = card;
        _attachCardDownloadUI(item.id, card);
    }

    const deleteBtn = card.querySelector('.settings-delete-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const ok = await showConfirm({
                title: `Delete "${label}"?`,
                message: `This will remove the model from Ollama. You can re-download it later.`,
                confirmLabel: 'Delete',
                danger: true,
            });
            if (ok) _deleteModelInline(item.id, card, containerId, onSelect);
        });
    }

    card.addEventListener('click', async () => {
        document.querySelectorAll(`#${containerId} .settings-model-card`)
            .forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        onSelect(item.id);

        // Auto-pull if not installed and not already downloading
        // (consult dataset, not the stale `inst` closure — it goes stale after delete)
        if (card.dataset.installed !== 'true' && !card.classList.contains('downloading') && !_downloads.has(item.id)) {
            const ok = await showConfirm({
                title: `Download "${label}"?`,
                message: `${size ? size + ' — ' : ''}${desc || 'This model will be pulled from Ollama.'}`,
                confirmLabel: 'Download',
            });
            if (ok) _pullModelInline(item.id, card);
        }
    });

    return card;
}

async function _deleteModelInline(modelId, card, containerId, onSelect) {
    // Re-resolve card in case the grid was re-rendered while confirm was open
    const liveCard = document.querySelector(`.settings-model-card[data-id="${modelId}"]`);
    if (liveCard) card = liveCard;

    if (card.classList.contains('deleting') || card.classList.contains('downloading')) return;

    const safeId = modelId.replace(/[:.]/g, '-');
    const dlArea = card.querySelector(`#dl-area-${safeId}`);
    const badge = card.querySelector('.settings-installed-badge, .settings-not-installed-badge');
    const deleteBtn = card.querySelector('.settings-delete-btn');

    card.classList.add('deleting');
    if (badge) { badge.className = 'settings-not-installed-badge'; badge.textContent = 'Deleting…'; }
    if (deleteBtn) deleteBtn.disabled = true;

    if (dlArea) {
        dlArea.style.display = 'block';
        dlArea.innerHTML = `
            <div class="settings-download-bar-bg"><div class="settings-delete-bar-fill" id="dl-fill-${safeId}"></div></div>
            <div class="settings-dl-meta-row"><span class="settings-download-status" id="dl-status-${safeId}">Removing model files…</span></div>
        `;
    }

    // Animate fake progress: eases toward 85% until the request resolves
    let pct = 0;
    const fill = document.getElementById(`dl-fill-${safeId}`);
    const ticker = setInterval(() => {
        pct = Math.min(pct + (85 - pct) * 0.12, 84);
        if (fill) fill.style.width = pct.toFixed(1) + '%';
    }, 80);

    try {
        const res = await fetch(`${API}/api/setup/delete-model/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
        clearInterval(ticker);

        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Delete failed' }));
            throw new Error(err.detail || 'Delete failed');
        }

        // Complete the bar then clean up
        if (fill) fill.style.width = '100%';
        const statusEl = document.getElementById(`dl-status-${safeId}`);
        if (statusEl) statusEl.textContent = 'Deleted';

        setTimeout(() => {
            const wasSelected = card.classList.contains('selected');
            card.classList.remove('deleting', 'selected');
            card.dataset.installed = 'false';
            if (badge) { badge.className = 'settings-not-installed-badge'; badge.textContent = 'Not downloaded'; }
            if (deleteBtn) deleteBtn.remove();
            if (dlArea) dlArea.style.display = 'none';

            // Restore download icon so the card is immediately re-downloadable without a reload
            const right = card.querySelector('.settings-model-card-right');
            if (right && !right.querySelector('.settings-dl-icon')) {
                const dlIcon = document.createElement('span');
                dlIcon.className = 'settings-dl-icon';
                dlIcon.title = 'Not downloaded';
                dlIcon.innerHTML = `<svg class="settings-download-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M3 12h10"/></svg>`;
                const radio = right.querySelector('.settings-model-radio');
                if (radio) right.insertBefore(dlIcon, radio); else right.appendChild(dlIcon);
            }

            // Mirror the change in cached config so re-opening Settings reflects reality
            const allMeta = [
                ...(_settingsConfig?.available_models || []),
                ...(_settingsConfig?.available_embed_models || []),
            ];
            const meta = allMeta.find(m => m.id === modelId);
            if (meta) meta.installed = false;

            if (wasSelected) {
                const firstOther = document.querySelector(`#${containerId} .settings-model-card:not([class*="deleting"])`);
                if (firstOther) { firstOther.classList.add('selected'); onSelect(firstOther.dataset.id); }
            }
        }, 500);

        // Refresh authoritative config from server (non-blocking)
        fetch(`${API}/api/setup/config`).then(r => r.json()).then(d => { _settingsConfig = d; }).catch(() => {});

        showToast(`Model "${modelId}" deleted`, 'success');
    } catch (err) {
        clearInterval(ticker);
        card.classList.remove('deleting');
        if (badge) { badge.className = 'settings-installed-badge'; badge.textContent = '✓ Installed'; }
        if (deleteBtn) deleteBtn.disabled = false;
        if (dlArea) {
            if (fill) fill.style.width = '0%';
            const statusEl = document.getElementById(`dl-status-${safeId}`);
            if (statusEl) { statusEl.className = 'settings-download-error'; statusEl.textContent = err.message || 'Delete failed'; }
        }
        showToast(err.message || 'Delete failed', 'error');
    }
}

// ─── Global download tracker ──────────────────────────────────────────────────
// modelId → { label, size, pct, statusText, abortController, card, done, cancelled }
const _downloads = new Map();

function _dlBadgeHtml() {
    return `
        <div class="cv-dl-badge-head">
            <span class="cv-dl-badge-spinner"></span>
            <span class="cv-dl-badge-label"></span>
            <span class="cv-dl-badge-chevron">▾</span>
        </div>
        <div class="cv-dl-badge-head-bar"><div class="cv-dl-badge-head-bar-fill" style="width:0%"></div></div>
        <div class="cv-dl-badge-panel" id="cv-dl-panel"></div>`;
}

function _ensureDlBadge() {
    if (document.getElementById('cv-dl-badge')) return;
    const el = document.createElement('div');
    el.id = 'cv-dl-badge';
    el.className = 'cv-dl-badge';
    el.innerHTML = _dlBadgeHtml();
    const head = el.querySelector('.cv-dl-badge-head');
    if (head) head.addEventListener('click', () => el.classList.toggle('cv-dl-open'));
    document.body.appendChild(el);
}

function _updateDlBadge() {
    const active = [..._downloads.entries()].filter(([, d]) => !d.done && !d.cancelled);
    const badge = document.getElementById('cv-dl-badge');

    if (active.length === 0) {
        if (badge) badge.classList.remove('cv-dl-visible', 'cv-dl-open');
        return;
    }

    _ensureDlBadge();
    const el = document.getElementById('cv-dl-badge');
    el.classList.add('cv-dl-visible', 'cv-dl-open'); // auto-open panel when downloads are active

    const labelEl = el.querySelector('.cv-dl-badge-label');
    if (labelEl) {
        labelEl.textContent = active.length === 1
            ? `${active[0][1].label} — ${active[0][1].pct}%`
            : `${active.length} downloading`;
    }

    const avgPct = active.reduce((s, [, d]) => s + d.pct, 0) / active.length;
    const headBarFill = el.querySelector('.cv-dl-badge-head-bar-fill');
    if (headBarFill) headBarFill.style.width = Math.round(avgPct) + '%';

    // Reconcile rows in place — rebuilding innerHTML on every tick caused flicker
    const panel = el.querySelector('#cv-dl-panel');
    if (!panel) return;

    const activeIds = new Set(active.map(([id]) => id));

    // Remove rows for downloads that ended
    for (const child of [...panel.children]) {
        if (!activeIds.has(child.dataset.modelId)) child.remove();
    }

    for (const [modelId, dl] of active) {
        let item = panel.querySelector(`[data-model-id="${CSS.escape(modelId)}"]`);
        if (!item) {
            item = document.createElement('div');
            item.className = 'cv-dl-panel-item';
            item.dataset.modelId = modelId;
            item.innerHTML = `
                <div class="cv-dl-panel-row">
                    <span class="cv-dl-panel-name"></span>
                    <button class="cv-dl-panel-cancel" title="Cancel">&times;</button>
                </div>
                <div class="cv-dl-bar-bg"><div class="cv-dl-bar-fill"></div></div>
                <div class="cv-dl-panel-status"></div>`;
            item.querySelector('.cv-dl-panel-name').textContent = dl.label;
            item.querySelector('.cv-dl-panel-cancel').addEventListener('click', (e) => {
                e.stopPropagation();
                _cancelDownload(modelId);
            });
            panel.appendChild(item);
        }
        // Only touch the fields that change
        const fill = item.querySelector('.cv-dl-bar-fill');
        const status = item.querySelector('.cv-dl-panel-status');
        const newWidth = dl.pct + '%';
        if (fill.style.width !== newWidth) fill.style.width = newWidth;
        const newStatus = dl.statusText || 'Starting…';
        if (status.textContent !== newStatus) status.textContent = newStatus;
    }
}

function _cancelDownload(modelId) {
    const dl = _downloads.get(modelId);
    if (!dl || dl.done) return;
    dl.cancelled = true;
    dl.abortController.abort();
    _downloads.delete(modelId);
    _updateDlBadge();
    const card = dl.card;
    if (card) {
        card.classList.remove('downloading');
        const b = card.querySelector('.settings-installed-badge, .settings-not-installed-badge');
        if (b) { b.className = 'settings-not-installed-badge'; b.textContent = 'Not downloaded'; }
        const area = card.querySelector('.settings-download-area');
        if (area) area.style.display = 'none';
    }
}

function _updateDownloadCard(modelId) {
    const dl = _downloads.get(modelId);
    if (!dl || !dl.card) return;
    const safeId = modelId.replace(/[:.]/g, '-');
    const fill = dl.card.querySelector(`#dl-fill-${safeId}`);
    const pctEl = dl.card.querySelector(`#dl-pct-${safeId}`);
    const statusEl = dl.card.querySelector(`#dl-status-${safeId}`);
    if (fill) fill.style.width = dl.pct + '%';
    if (pctEl) pctEl.textContent = dl.pct + '%';
    if (statusEl) statusEl.textContent = dl.statusText || '';
}

function _attachCardDownloadUI(modelId, card) {
    const safeId = modelId.replace(/[:.]/g, '-');
    const dl = _downloads.get(modelId);
    const dlArea = card.querySelector('.settings-download-area');
    const badge = card.querySelector('.settings-installed-badge, .settings-not-installed-badge');
    card.classList.add('downloading');
    if (badge) { badge.className = 'settings-not-installed-badge'; badge.textContent = 'Downloading…'; }
    if (dlArea) {
        dlArea.style.display = 'block';
        dlArea.innerHTML = `
            <div class="settings-download-bar-bg"><div class="settings-download-bar-fill" id="dl-fill-${safeId}" style="width:${dl ? dl.pct : 0}%"></div></div>
            <div class="settings-dl-meta-row">
                <span class="settings-download-status" id="dl-status-${safeId}">${dl ? escapeHtml(dl.statusText || 'Starting…') : 'Starting…'}</span>
                <span class="settings-dl-pct" id="dl-pct-${safeId}">${dl ? dl.pct : 0}%</span>
                <button class="settings-dl-cancel-btn" title="Cancel download">&times;</button>
            </div>`;
        const cancelBtn = dlArea.querySelector('.settings-dl-cancel-btn');
        if (cancelBtn) cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _cancelDownload(modelId);
        });
    }
}

// ─── P2-3: Inline Model Download ─────────────────────────────────────────────
async function _pullModelInline(modelId, card) {
    // Re-resolve card in case settings grid was re-rendered while confirm was open
    const liveCard = document.querySelector(`.settings-model-card[data-id="${modelId}"]`);
    if (liveCard) card = liveCard;

    // Resolve label/size from cached config
    const allMeta = [
        ...(_settingsConfig?.available_models || []),
        ...(_settingsConfig?.available_embed_models || []),
    ];
    const meta = allMeta.find(m => m.id === modelId) || {};
    const label = meta.label || modelId;
    const size  = meta.size  || '';

    // Register in global tracker
    const abortController = new AbortController();
    _downloads.set(modelId, { label, size, pct: 0, statusText: 'Starting…', abortController, card, done: false, cancelled: false });
    _updateDlBadge();

    // Set up card UI
    if (card) _attachCardDownloadUI(modelId, card);

    try {
        const res = await fetch(`${API}/api/setup/pull-model-stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelId }),
            signal: abortController.signal,
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.detail || `Download failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const data = JSON.parse(line);
                    if (data.error) throw new Error(data.error);

                    const dl = _downloads.get(modelId);
                    if (!dl) return; // cancelled externally

                    if (data.total && data.completed) {
                        const pct = Math.round((data.completed / data.total) * 100);
                        const mb = (data.completed / (1024 * 1024)).toFixed(0);
                        const totalMb = (data.total / (1024 * 1024)).toFixed(0);
                        dl.pct = pct;
                        dl.statusText = `${data.status || 'Downloading'} — ${mb} / ${totalMb} MB (${pct}%)`;
                    } else {
                        dl.statusText = data.status || 'Processing…';
                    }

                    _updateDownloadCard(modelId);
                    _updateDlBadge();
                } catch (e) {
                    if (e.message && e.message !== line) throw e;
                }
            }
        }

        // ── Success ──
        const dl = _downloads.get(modelId);
        const finishedCard = dl?.card || null;
        _downloads.delete(modelId);
        _updateDlBadge();

        if (finishedCard) {
            finishedCard.dataset.installed = 'true';
            finishedCard.classList.remove('downloading');
            const b = finishedCard.querySelector('.settings-installed-badge, .settings-not-installed-badge');
            if (b) { b.className = 'settings-installed-badge'; b.textContent = '✓ Installed'; }
            const area = finishedCard.querySelector('.settings-download-area');
            if (area) area.style.display = 'none';
            // Swap download icon for delete button
            const right = finishedCard.querySelector('.settings-model-card-right');
            right?.querySelector('.settings-dl-icon')?.remove();
            right?.querySelector('.settings-dl-cancel-btn')?.remove();
            const radio = right?.querySelector('.settings-model-radio');
            if (right && radio) {
                const delBtn = document.createElement('button');
                delBtn.className = 'settings-delete-btn';
                delBtn.title = 'Delete model';
                delBtn.textContent = '✕';
                const capturedLabel = label;
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const ok = await showConfirm({ title: `Delete “${capturedLabel}”?`, message: 'This will remove the model from Ollama. You can re-download it later.', confirmLabel: 'Delete', danger: true });
                    if (ok) _deleteModelInline(modelId, finishedCard, finishedCard.closest('[id]')?.id || '', () => {});
                });
                right.insertBefore(delBtn, radio);
            }
        }

        // Refresh config so install state is current
        fetch(`${API}/api/setup/config`).then(r => r.json()).then(d => { _settingsConfig = d; }).catch(() => {});
        showToast(`Model “${label}” downloaded!`, 'success');

    } catch (err) {
        if (err.name === 'AbortError') return; // user cancelled

        const dl = _downloads.get(modelId);
        const failedCard = dl?.card || null;
        _downloads.delete(modelId);
        _updateDlBadge();

        if (failedCard) {
            failedCard.classList.remove('downloading');
            const b = failedCard.querySelector('.settings-installed-badge, .settings-not-installed-badge');
            if (b) { b.className = 'settings-not-installed-badge'; b.textContent = 'Download failed'; }
            const statusEl = failedCard.querySelector('.settings-download-status');
            if (statusEl) { statusEl.className = 'settings-download-error'; statusEl.textContent = err.message || 'Download failed'; }
        }

        showToast(err.message || 'Download failed', 'error');
    }
}

// Provider icon/color map. Cloud providers use the exact brand SVGs from frontend/logos/.
const _PROVIDER_META = {
    ollama: {
        label: 'Local (Ollama)', color: '#888',
        svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
        useBrandLogo: false,
    },
    openai: {
        label: 'OpenAI', color: '#10a37f',
        logo: '/static/logos/openai.svg',
        useBrandLogo: true,
    },
    anthropic: {
        label: 'Anthropic', color: '#d97757',
        logo: '/static/logos/anthropic.svg',
        useBrandLogo: true,
    },
    google: {
        label: 'Google Gemini', color: '#4285f4',
        logo: '/static/logos/gemini.svg',
        useBrandLogo: true,
    },
};

let _selectedProvider = 'ollama';
let _cloudKeyValid = {};  // { openai: true/false, ... }

function _renderGpuBanner(gpu, rec) {
    let banner = document.getElementById('gpu-info-banner');
    if (!banner) {
        const llmSection = document.getElementById('ollama-llm-section');
        if (!llmSection) return;
        banner = document.createElement('div');
        banner.id = 'gpu-info-banner';
        banner.className = 'gpu-info-banner';
        llmSection.insertBefore(banner, llmSection.firstChild);
    }
    if (!gpu || !rec) { banner.style.display = 'none'; return; }
    banner.style.display = '';

    const tierClass = `gpu-info-tier-${rec.tier || 'unknown'}`;
    banner.className = `gpu-info-banner ${tierClass}`;
    const gpuLine = gpu.detected
        ? `<strong>${escapeHtml(gpu.name || 'GPU')}</strong> · ${gpu.vram_mb} MB VRAM`
        : `<strong>No GPU detected</strong>`;
    banner.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01"/></svg>
        <div class="gpu-info-text">
            <div class="gpu-info-line">${gpuLine}</div>
            <div class="gpu-info-reason">${escapeHtml(rec.reason || '')}</div>
        </div>
    `;
}

function _renderSettingsCards() {
    if (!_settingsConfig) return;

    // ── Profile fields ──
    const nameInput  = $('#profile-name-input');
    const aboutInput = $('#profile-about-input');
    if (nameInput)  nameInput.value  = _settingsConfig.user_name  || '';
    if (aboutInput) aboutInput.value = _settingsConfig.user_about || '';

    const llmGrid   = $('#settings-llm-grid');
    const embedGrid = $('#settings-embed-grid');
    llmGrid.innerHTML = '';
    embedGrid.innerHTML = '';

    // ── Provider grid ──
    _selectedProvider = _settingsConfig.provider || 'ollama';
    const provGrid = $('#settings-provider-grid');
    provGrid.innerHTML = '';

    // Ollama card
    const ollamaCard = _makeProviderCard('ollama', _settingsConfig.ollama_running !== false);
    provGrid.appendChild(ollamaCard);

    // Cloud provider cards
    (_settingsConfig.cloud_providers || []).forEach(cp => {
        provGrid.appendChild(_makeProviderCard(cp.id, cp.has_key, cp));
    });

    _updateCloudSections();

    // ── GPU/VRAM info banner ──
    _renderGpuBanner(_settingsConfig.gpu, _settingsConfig.recommendation);

    // ── LLM grid (Ollama) ──
    let selectedLlm   = _settingsConfig.model;
    let selectedEmbed = _settingsConfig.embed_model;
    const originalEmbed = _settingsConfig.embed_model;

    (_settingsConfig.available_models || []).forEach(m => {
        llmGrid.appendChild(_makeSettingsCard(m, selectedLlm, 'settings-llm-grid', id => {
            selectedLlm = id;
            llmGrid.dataset.selected = id;
        }));
    });
    llmGrid.dataset.selected = selectedLlm;

    (_settingsConfig.available_embed_models || []).forEach(m => {
        embedGrid.appendChild(_makeSettingsCard(m, selectedEmbed, 'settings-embed-grid', id => {
            selectedEmbed = id;
            embedGrid.dataset.selected = id;
            const warn = $('#settings-embed-warning');
            if (id !== originalEmbed) { warn.classList.add('visible'); }
            else { warn.classList.remove('visible'); }
        }));
    });
    embedGrid.dataset.selected = selectedEmbed;
}

function _makeProviderCard(providerId, isReady, _cpInfo) {
    const meta = _PROVIDER_META[providerId] || { svg: '', label: providerId, color: '#888' };
    const card = document.createElement('div');
    card.className = 'settings-provider-card' + (providerId === _selectedProvider ? ' selected' : '');
    card.dataset.provider = providerId;

    let metaText = '';
    if (providerId === 'ollama') {
        metaText = isReady ? '✓ Running' : '✗ Offline';
    } else {
        metaText = isReady ? '✓ Key saved' : 'No key';
    }
    const metaClass = isReady ? 'provider-card-meta has-key' : 'provider-card-meta';

    const iconHtml = meta.useBrandLogo
        ? `<img src="${meta.logo}" alt="${escapeHtml(meta.label)} logo" class="provider-brand-logo">`
        : meta.svg;
    const iconStyle = meta.useBrandLogo ? '' : `style="color:${meta.color}"`;

    card.innerHTML = `
        <div class="provider-card-icon" ${iconStyle}>${iconHtml}</div>
        <div class="provider-card-name">${escapeHtml(meta.label)}</div>
        <div class="${metaClass}">${metaText}</div>
    `;

    card.addEventListener('click', () => {
        _selectedProvider = providerId;
        $$('.settings-provider-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        _updateCloudSections();
    });

    return card;
}

function _updateCloudSections() {
    const keySection = $('#cloud-key-section');
    const modelSection = $('#cloud-model-section');
    const isCloud = _selectedProvider !== 'ollama';

    keySection.style.display = isCloud ? '' : 'none';
    modelSection.style.display = isCloud ? '' : 'none';

    if (!isCloud) return;

    // Find provider info
    const cp = (_settingsConfig.cloud_providers || []).find(p => p.id === _selectedProvider);
    if (!cp) return;

    // Update key hint
    const docsLink = $('#cloud-key-docs-link');
    if (docsLink && cp.docs_url) { docsLink.href = cp.docs_url; }

    // Pre-fill key input if saved (masked)
    const keyInput = $('#cloud-key-input');
    if (cp.has_key) {
        keyInput.placeholder = '••••••••••••••••  (key saved)';
        keyInput.value = '';
        _setKeyStatus('valid', '✓ Key saved and active');
        _cloudKeyValid[_selectedProvider] = true;
    } else {
        keyInput.placeholder = cp.key_hint || 'Enter API key…';
        keyInput.value = '';
        _setKeyStatus('', '');
        _cloudKeyValid[_selectedProvider] = false;
    }

    // Render cloud model grid
    _renderCloudModelGrid(cp);
}

function _renderCloudModelGrid(cp) {
    const grid = $('#settings-cloud-model-grid');
    grid.innerHTML = '';
    const selectedModel = cp.selected_model || (cp.models[0] && cp.models[0].id) || '';

    (cp.models || []).forEach(m => {
        const card = document.createElement('div');
        card.className = 'settings-model-card' + (m.id === selectedModel ? ' selected' : '');
        card.dataset.id = m.id;

        const costText = m.input_cost != null ? `$${m.input_cost} / $${m.output_cost}` : '';

        card.innerHTML = `
            <div class="settings-model-card-left">
                <div class="settings-model-name">${escapeHtml(m.label || m.id)}</div>
                <div class="settings-model-desc">${escapeHtml(m.desc || '')}</div>
            </div>
            <div class="settings-model-card-right">
                ${costText ? `<span class="settings-model-cost">${costText}</span>` : ''}
                ${m.recommended ? '<span class="settings-model-badge">Recommended</span>' : ''}
                <div class="settings-model-radio"></div>
            </div>
        `;
        card.addEventListener('click', () => {
            grid.querySelectorAll('.settings-model-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            grid.dataset.selected = m.id;
        });
        grid.appendChild(card);
    });
    grid.dataset.selected = selectedModel;
}

function _setKeyStatus(type, message) {
    const el = $('#cloud-key-status');
    el.className = 'cloud-key-status' + (type ? ' ' + type : '');
    el.innerHTML = type === 'validating'
        ? `<div class="cloud-key-spinner"></div> ${escapeHtml(message)}`
        : escapeHtml(message);
}

async function _validateCloudKey() {
    const keyInput = $('#cloud-key-input');
    const key = keyInput.value.trim();
    if (!key) {
        _setKeyStatus('invalid', 'Enter an API key first');
        return;
    }
    _setKeyStatus('validating', 'Validating...');
    try {
        const res = await fetch(`${API}/api/setup/validate-key`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ provider: _selectedProvider, api_key: key }),
        });
        const data = await res.json();
        if (data.valid) {
            _setKeyStatus('valid', '✓ Key is valid');
            _cloudKeyValid[_selectedProvider] = true;
        } else {
            _setKeyStatus('invalid', data.error || 'Invalid key');
            _cloudKeyValid[_selectedProvider] = false;
        }
    } catch (e) {
        _setKeyStatus('invalid', 'Validation failed: ' + (e.message || 'network error'));
    }
}

async function _deleteCloudKey() {
    if (!_selectedProvider || _selectedProvider === 'ollama') return;
    const provLabel = (_PROVIDER_META[_selectedProvider] || {}).label || _selectedProvider;
    if (!await showConfirm({ title: `Remove API key for ${provLabel}?`, message: 'The saved key will be permanently deleted.', confirmLabel: 'Remove', danger: true })) return;
    try {
        await fetch(`${API}/api/setup/cloud-key/${_selectedProvider}`, { method: 'DELETE' });
        _cloudKeyValid[_selectedProvider] = false;
        _settingsConfig = null;
        // Refresh settings config and re-render
        const res = await fetch(`${API}/api/setup/config`);
        _settingsConfig = await res.json();
        _renderSettingsCards();
        showToast(`${provLabel} API key removed`, 'success');
    } catch (e) {
        showToast('Failed to remove key', 'error');
    }
}


async function saveSettings() {
    const llmGrid   = $('#settings-llm-grid');
    const embedGrid = $('#settings-embed-grid');
    const cloudGrid = $('#settings-cloud-model-grid');
    const newModel  = llmGrid.dataset.selected;
    const newEmbed  = embedGrid.dataset.selected;
    const newCloudModel = cloudGrid ? cloudGrid.dataset.selected : '';

    // Capture the previous embed model BEFORE the config cache is invalidated below,
    // so we can detect a switch and prompt the user to re-index.
    const oldEmbed = (_settingsConfig || {}).embed_model;

    const saveBtn = $('#settings-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
        // 1. Save Ollama models + user profile sequentially.
        // Each endpoint does a read-modify-write on config.json; running them in
        // parallel races on Windows (os.replace contention → "Failed to fetch")
        // and also causes lost updates between the three snapshots.
        const profileName  = ($('#profile-name-input')  || {}).value || '';
        const profileAbout = ($('#profile-about-input') || {}).value || '';
        const _post = (url, body) => fetch(url, {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify(body),
        });
        await _post(`${API}/api/setup/select-model`,       { model: newModel });
        await _post(`${API}/api/setup/select-embed-model`, { model: newEmbed });
        await _post(`${API}/api/setup/save-profile`,       { name: profileName, about: profileAbout });

        // 2. Save cloud API key if entered
        const keyInput = $('#cloud-key-input');
        if (_selectedProvider !== 'ollama' && keyInput && keyInput.value.trim()) {
            const kr = await fetch(`${API}/api/setup/cloud-key`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ provider: _selectedProvider, api_key: keyInput.value.trim(), model: newCloudModel })
            });
            if (!kr.ok) throw new Error('Failed to save API key');
        }

        // 3. Save selected provider + model
        const pr = await fetch(`${API}/api/setup/select-provider`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ provider: _selectedProvider, model: _selectedProvider !== 'ollama' ? newCloudModel : newModel })
        });
        if (!pr.ok) {
            const err = await pr.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to set provider');
        }

        // Invalidate cache
        _settingsConfig = null;

        // Update sidebar hint
        if (_selectedProvider === 'ollama') {
            _updateSettingsHint(newModel, newEmbed);
        } else {
            const provLabel = (_PROVIDER_META[_selectedProvider] || {}).label || _selectedProvider;
            _updateSettingsHint(newCloudModel, provLabel);
        }

        // Update status indicator
        const statusText = document.querySelector('.status-text');
        const statusDot = document.querySelector('.status-dot');
        if (_selectedProvider !== 'ollama' && statusText && statusDot) {
            statusDot.classList.add('online');
            statusDot.classList.remove('offline');
            statusText.textContent = (_PROVIDER_META[_selectedProvider] || {}).label || 'Cloud AI';
        }

        const embedChanged = oldEmbed && newEmbed && newEmbed !== oldEmbed;
        closeSettingsModal();

        if (embedChanged) {
            _showActionToast(
                'Embedding model changed. Existing contexts need re-indexing for semantic search to work with the new model.',
                'Rebuild now',
                () => rebuildEmbeddings(),
            );
        } else {
            showToast('Settings saved', 'success');
        }
    } catch (e) {
        showToast(e.message || 'Failed to save settings', 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
    }
}

function _updateSettingsHint(model, extra) {
    const hint = $('#settings-current-model-hint');
    if (hint) hint.textContent = `${model} · ${extra}`;
}

// Fetch and show current models in the hint on app load
async function _initSettingsHint() {
    try {
        const res = await fetch(`${API}/api/setup/config`);
        const cfg = await res.json();
        if (cfg.is_cloud_active) {
            const provLabel = (_PROVIDER_META[cfg.active_provider] || {}).label || cfg.active_provider;
            _updateSettingsHint(cfg.active_model, provLabel);
            const st = document.querySelector('.status-text');
            const sd = document.querySelector('.status-dot');
            if (st && sd) {
                sd.classList.add('online');
                sd.classList.remove('offline');
                st.textContent = provLabel;
            }
        } else {
            _updateSettingsHint(cfg.model, cfg.embed_model);
        }
    } catch { /* ignore */ }
}

// â”€â”€â”€ Utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// â”€â”€â”€ Accessibility: Focus Trap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _focusTrapEl   = null;   // currently trapped container
let _focusTrapPrev = null;   // element that had focus before modal opened
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapFocus(container, triggerEl) {
    _focusTrapEl   = container;
    _focusTrapPrev = triggerEl || document.activeElement;

    const focusable = () => Array.from(container.querySelectorAll(FOCUSABLE));

    // Move focus to first focusable inside
    const first = focusable()[0];
    if (first) first.focus();

    container._trapHandler = (e) => {
        if (e.key !== 'Tab') return;
        const items = focusable();
        if (!items.length) { e.preventDefault(); return; }
        const firstEl = items[0];
        const lastEl  = items[items.length - 1];
        if (e.shiftKey) {
            if (document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
        } else {
            if (document.activeElement === lastEl)  { e.preventDefault(); firstEl.focus(); }
        }
    };
    container.addEventListener('keydown', container._trapHandler);
}

function releaseFocus(container) {
    if (container && container._trapHandler) {
        container.removeEventListener('keydown', container._trapHandler);
        container._trapHandler = null;
    }
    if (_focusTrapPrev && typeof _focusTrapPrev.focus === 'function') {
        _focusTrapPrev.focus();
    }
    _focusTrapEl   = null;
    _focusTrapPrev = null;
}

// Global Escape key — closes whichever modal is open
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const editModal      = $('#edit-modal');
    const settingsModal  = $('#settings-modal');
    const shortcutsModal = $('#shortcuts-modal');
    const systemModal    = $('#system-modal');
    if (shortcutsModal && shortcutsModal.style.display !== 'none') { closeShortcutsModal(); return; }
    if (systemModal    && systemModal.style.display    !== 'none') { closeSystemModal();    return; }
    if (editModal      && editModal.style.display      !== 'none') closeEditModal();
    if (settingsModal  && settingsModal.style.display   !== 'none') closeSettingsModal();
});

// â”€â”€â”€ P2-9: Keyboard Shortcuts Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openShortcutsModal() {
    const modal = $('#shortcuts-modal');
    modal.style.display = 'flex';
    trapFocus(modal.querySelector('.shortcuts-modal'), $('#btn-shortcuts'));
}

function closeShortcutsModal() {
    const overlay = $('#shortcuts-modal');
    const inner = overlay.querySelector('.shortcuts-modal');
    releaseFocus(inner);
    inner.style.animation = 'shellOut 0.18s var(--ease) forwards';
    overlay.style.animation = 'fadeOut 0.18s var(--ease) forwards';
    setTimeout(() => {
        overlay.style.display = 'none';
        inner.style.animation = '';
        overlay.style.animation = '';
    }, 180);
}

// â”€â”€â”€ Sidebar Tooltips (JS-positioned) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _initSidebarTooltips() {
    const sidebar = document.getElementById('sidebar');
    const tooltip = document.getElementById('sidebar-tooltip');
    const tooltipContent = document.getElementById('sidebar-tooltip-content');
    if (!sidebar || !tooltip || !tooltipContent) return;

    let showTimeout = null;

    function showTooltip(target) {
        const text = target.getAttribute('data-tooltip');
        if (!text) return;

        tooltipContent.textContent = text;

        // Position: to the right of the button, vertically centered
        const rect = target.getBoundingClientRect();
        const tooltipGap = 10;

        tooltip.style.left = (rect.right + tooltipGap) + 'px';
        tooltip.style.top = (rect.top + rect.height / 2) + 'px';
        tooltip.style.transform = 'translateY(-50%)';

        // Show with tiny delay to prevent flicker
        showTimeout = setTimeout(() => {
            tooltip.classList.add('visible');
        }, 200);
    }

    function hideTooltip() {
        if (showTimeout) { clearTimeout(showTimeout); showTimeout = null; }
        tooltip.classList.remove('visible');
    }

    // Delegate on sidebar
    sidebar.addEventListener('mouseenter', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (!target) return;
        hideTooltip();
        showTooltip(target);
    }, true);

    sidebar.addEventListener('mouseleave', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (!target) return;
        hideTooltip();
    }, true);

    // Also hide if we click (button activates, tooltip should disappear)
    sidebar.addEventListener('click', () => hideTooltip());
}

// â”€â”€â”€ Ask Your Vault — RAG Chat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
state.askHistory = [];     // [{role: 'user'|'assistant', content: ''}]
state.askStreaming = false; // true while streaming response
state.askSessionId = null;  // current persisted session id (null = new chat)
state.askSessions = [];     // cached list of {id, title, pinned, message_count, updated_at}
state.askSessionFilter = ''; // filter typed in the past-chats search
state.askScopeCollectionId = null; // null = whole vault; else a collection id (#10)

// Fill the Ask scope dropdown from the loaded collections, preserving selection.
function _askPopulateScopeSelect() {
    const sel = document.getElementById('ask-scope');
    if (!sel) return;
    const cols = Array.isArray(state.collections) ? state.collections : [];
    const prev = state.askScopeCollectionId;
    let html = '<option value="">All contexts</option>';
    for (const c of cols) {
        html += `<option value="${c.id}">${escapeHtml(c.name)} (${c.count ?? 0})</option>`;
    }
    sel.innerHTML = html;
    // Restore prior selection if that collection still exists; else fall back to All.
    if (prev != null && cols.some(c => c.id === prev)) {
        sel.value = String(prev);
    } else {
        sel.value = '';
        state.askScopeCollectionId = null;
    }
}

function _initAskVault() {
    const input = $('#ask-input');
    const sendBtn = $('#ask-send-btn');
    const clearBtn = $('#ask-clear-btn');
    if (!input || !sendBtn) return;

    // Search-scope selector (#10): null = whole vault, else restrict to a collection.
    const scopeSel = document.getElementById('ask-scope');
    if (scopeSel) {
        scopeSel.addEventListener('change', () => {
            const v = scopeSel.value;
            state.askScopeCollectionId = v ? Number(v) : null;
        });
    }
    _askPopulateScopeSelect();

    // Enable/disable send
    input.addEventListener('input', () => {
        sendBtn.disabled = !input.value.trim() || state.askStreaming;
    });

    // Enter to send
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && input.value.trim() && !state.askStreaming) {
            e.preventDefault();
            askVault(input.value.trim());
        }
    });

    // Send button
    sendBtn.addEventListener('click', () => {
        if (input.value.trim() && !state.askStreaming) {
            askVault(input.value.trim());
        }
    });

    // Clear chat
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            state.askHistory = [];
            const container = $('#ask-messages');
            const empty = $('#ask-empty');
            // Remove all messages
            container.querySelectorAll('.ask-msg, .ask-thinking').forEach(el => el.remove());
            if (empty) empty.style.display = '';
            clearBtn.style.display = 'none';
        });
    }

    // Suggestion pills (including new cv-ask-starter cards)
    $$('.ask-suggestion').forEach(btn => {
        btn.addEventListener('click', () => {
            const q = btn.getAttribute('data-q');
            if (q && !state.askStreaming) {
                input.value = q;
                askVault(q);
            }
        });
        // Radial spotlight that tracks the cursor, matches dashboard/library cards.
        btn.addEventListener('pointermove', e => {
            const r = btn.getBoundingClientRect();
            btn.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
            btn.style.setProperty('--my', ((e.clientY - r.top)  / r.height * 100) + '%');
        });
        btn.addEventListener('pointerleave', () => {
            btn.style.setProperty('--mx', '50%');
            btn.style.setProperty('--my', '50%');
        });
    });

    // "New chat" button in the rail — mirrors the Clear-chat behavior.
    const newChatBtn = $('#cv-ask-new-chat');
    if (newChatBtn) {
        newChatBtn.addEventListener('click', () => {
            if (state.askStreaming) return;
            _askResetChat();
        });
    }

    // Past-chats panel
    const histToggle = $('#cv-ask-history-toggle');
    const histPanel = $('#cv-ask-history-panel');
    const histSearch = $('#cv-ask-history-search');

    if (histToggle && histPanel) {
        histToggle.addEventListener('click', async (e) => {
            e.stopPropagation();
            const isOpen = !histPanel.hasAttribute('hidden');
            if (isOpen) _askCloseHistoryPanel();
            else await _askOpenHistoryPanel();
        });
    }

    // Delegated click handler on the panel (survives re-renders).
    if (histPanel) {
        histPanel.addEventListener('click', (e) => {
            try {
                e.stopPropagation();

                if (e.target.closest('#cv-ask-history-close')) {
                    _askCloseHistoryPanel();
                    return;
                }
                const actBtn = e.target.closest('button[data-act]');
                if (actBtn) {
                    const row = actBtn.closest('.cv-ask-history-item');
                    if (!row) return;
                    const sid = parseInt(row.getAttribute('data-session-id'), 10);
                    if (Number.isNaN(sid)) return;
                    const act = actBtn.getAttribute('data-act');
                    if (act === 'pin') _askToggleSessionPin(sid);
                    else if (act === 'rename') _askRenameSession(sid);
                    else if (act === 'delete') _askDeleteSession(sid);
                    return;
                }
                const row = e.target.closest('.cv-ask-history-item');
                if (row) {
                    const sid = parseInt(row.getAttribute('data-session-id'), 10);
                    if (!Number.isNaN(sid)) _askLoadSession(sid);
                }
            } catch (err) {
                console.error('[ask] panel click handler crashed:', err, err && err.stack);
            }
        });
        histPanel.addEventListener('keydown', (e) => {
            const row = e.target.closest('.cv-ask-history-item');
            if (!row) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const sid = parseInt(row.getAttribute('data-session-id'), 10);
                if (!Number.isNaN(sid)) _askLoadSession(sid);
            }
        });
    }

    // Click-outside (document level — runs only when panel is open).
    document.addEventListener('click', (e) => {
        if (!histPanel || histPanel.hasAttribute('hidden')) return;
        if (histPanel.contains(e.target)) return;
        if (histToggle && histToggle.contains(e.target)) return;
        _askCloseHistoryPanel();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && histPanel && !histPanel.hasAttribute('hidden')) {
            _askCloseHistoryPanel();
        }
    });

    if (histSearch) {
        histSearch.addEventListener('input', () => {
            state.askSessionFilter = histSearch.value.trim().toLowerCase();
            _askRenderSessionList();
        });
    }
}

// (No wrapper needed — function declarations at script scope are already
//  exposed on window, so inline onclick="_askCloseHistoryPanel()" works.)

async function _askOpenHistoryPanel() {
    const panel = $('#cv-ask-history-panel');
    const toggle = $('#cv-ask-history-toggle');
    const search = $('#cv-ask-history-search');
    if (!panel) return;
    panel.removeAttribute('hidden');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    await _askLoadSessions();
    if (search) setTimeout(() => search.focus(), 60);
}

function _askCloseHistoryPanel() {
    const panel = $('#cv-ask-history-panel');
    const toggle = $('#cv-ask-history-toggle');
    const search = $('#cv-ask-history-search');
    if (panel) panel.setAttribute('hidden', '');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    if (search) {
        search.value = '';
        state.askSessionFilter = '';
    }
}

function _askUpdateRailSession() {
    const label = $('#cv-ask-current-session');
    const sep = $('#cv-ask-current-session-sep');
    if (!label || !sep) return;
    if (!state.askSessionId) {
        label.setAttribute('hidden', '');
        sep.setAttribute('hidden', '');
        return;
    }
    const s = (state.askSessions || []).find(x => x.id === state.askSessionId);
    const title = s ? s.title : 'Saved chat';
    label.textContent = title || 'Saved chat';
    label.removeAttribute('hidden');
    sep.removeAttribute('hidden');
}

function _askResetChat() {
    state.askHistory = [];
    state.askSessionId = null;
    const container = $('#ask-messages');
    const empty = $('#ask-empty');
    const clearBtn = $('#ask-clear-btn');
    const input = $('#ask-input');
    if (container) container.querySelectorAll('.ask-msg, .ask-thinking').forEach(el => el.remove());
    if (empty) empty.style.display = '';
    if (clearBtn) clearBtn.style.display = 'none';
    if (input) input.value = '';
    _askScrollToBottom();
    _askUpdateRailSession();
    _askRenderSessionList();
}

async function _askLoadSessions() {
    const list = $('#cv-ask-history-list');
    if (!list) return;
    try {
        const res = await fetch(`${API}/api/vault/sessions`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        state.askSessions = data.sessions || [];
        _askRenderSessionList();
    } catch (err) {
        list.innerHTML = `<div class="cv-ask-history-empty">Couldn't load: ${escapeHtml(err.message)}</div>`;
    }
}

function _askRenderSessionList() {
    const list = $('#cv-ask-history-list');
    const countEl = $('#cv-ask-history-count');
    if (!list) return;

    const all = state.askSessions || [];
    const filter = (state.askSessionFilter || '').trim().toLowerCase();
    const sessions = filter
        ? all.filter(s => (s.title || '').toLowerCase().includes(filter))
        : all;

    if (countEl) {
        if (all.length > 0) {
            countEl.textContent = String(all.length);
            countEl.removeAttribute('hidden');
        } else {
            countEl.setAttribute('hidden', '');
        }
    }

    if (sessions.length === 0) {
        const msg = filter
            ? `<span>No matches for <b>${escapeHtml(filter)}</b>.</span>`
            : `<span>No past chats yet.<br>Ask something to start one.</span>`;
        list.innerHTML = `
            <div class="cv-ask-history-empty">
                <span class="cv-ask-history-empty-ic" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </span>
                ${msg}
            </div>`;
        return;
    }

    // Bucket by date relative to now: Pinned / Today / Yesterday / Last 7 days / Older.
    const now = new Date();
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const today = startOfDay(now);
    const yesterday = today - 86400000;
    const week = today - 6 * 86400000;

    const groups = { pinned: [], today: [], yesterday: [], week: [], older: [] };
    for (const s of sessions) {
        if (s.pinned) { groups.pinned.push(s); continue; }
        let ts = 0;
        try { ts = startOfDay(new Date(s.updated_at)); } catch (_) {}
        if (ts >= today) groups.today.push(s);
        else if (ts >= yesterday) groups.yesterday.push(s);
        else if (ts >= week) groups.week.push(s);
        else groups.older.push(s);
    }

    const fmt = (iso) => {
        try {
            const d = new Date(iso);
            const sameDay = d.toDateString() === now.toDateString();
            return sameDay
                ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        } catch (_) { return ''; }
    };

    const renderItem = (s) => {
        const active = state.askSessionId === s.id ? ' is-active' : '';
        const pinned = s.pinned;
        const count = s.message_count || 0;
        const pinIcon = pinned
            ? `<span class="cv-ask-history-item-pin" aria-hidden="true" title="Pinned">
                   <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V6h6v4.76a2 2 0 0 0 .59 1.41l1.59 1.59a1 1 0 0 1-.71 1.71H7.53a1 1 0 0 1-.71-1.71l1.59-1.59A2 2 0 0 0 9 10.76z"/></svg>
               </span>`
            : `<span class="cv-ask-history-item-pin" hidden></span>`;
        return `
            <div class="cv-ask-history-item${active}" data-session-id="${s.id}" tabindex="0" role="button" aria-label="${escapeHtml(s.title || 'Untitled')}">
                ${pinIcon}
                <div class="cv-ask-history-item-body">
                    <div class="cv-ask-history-item-title">${escapeHtml(s.title || 'Untitled')}</div>
                    <div class="cv-ask-history-item-meta">
                        <span>${fmt(s.updated_at)}</span>
                        <span>·</span>
                        <span>${count} msg${count === 1 ? '' : 's'}</span>
                    </div>
                </div>
                <div class="cv-ask-history-item-actions">
                    <button data-act="pin" class="${pinned ? 'is-pinned' : ''}" title="${pinned ? 'Unpin' : 'Pin'}" aria-label="${pinned ? 'Unpin chat' : 'Pin chat'}">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="${pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V6h6v4.76a2 2 0 0 0 .59 1.41l1.59 1.59a1 1 0 0 1-.71 1.71H7.53a1 1 0 0 1-.71-1.71l1.59-1.59A2 2 0 0 0 9 10.76z"/></svg>
                    </button>
                    <button data-act="rename" title="Rename" aria-label="Rename chat">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                    </button>
                    <button data-act="delete" title="Delete" aria-label="Delete chat">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                    </button>
                </div>
            </div>
        `;
    };

    const renderGroup = (label, items) => items.length
        ? `<div class="cv-ask-history-group">${label}</div>${items.map(renderItem).join('')}`
        : '';

    list.innerHTML =
        renderGroup('Pinned', groups.pinned) +
        renderGroup('Today', groups.today) +
        renderGroup('Yesterday', groups.yesterday) +
        renderGroup('Last 7 days', groups.week) +
        renderGroup('Older', groups.older);

    // Click + keyboard activation handled via delegation in _initAskVault.
}

async function _askLoadSession(sessionId) {
    if (state.askStreaming) return;
    try {
        const res = await fetch(`${API}/api/vault/sessions/${sessionId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const session = await res.json();
        const messages = session.messages || [];
        state.askSessionId = session.id;
        state.askHistory = messages.map(m => ({ role: m.role, content: m.content }));

        const container = $('#ask-messages');
        const empty = $('#ask-empty');
        const clearBtn = $('#ask-clear-btn');
        if (container) container.querySelectorAll('.ask-msg, .ask-thinking').forEach(el => el.remove());
        if (empty) empty.style.display = messages.length ? 'none' : '';
        if (clearBtn) clearBtn.style.display = messages.length ? '' : 'none';

        for (const m of messages) {
            try {
                if (m.role === 'user') _askRenderUserMsg(m.content || '');
                else _askRenderHistoricalAssistantMsg(m.content || '', m.citations || []);
            } catch (msgErr) {
                console.error('Failed rendering message', m, msgErr);
            }
        }

        _askScrollToBottom();
        _askRenderSessionList();
        _askUpdateRailSession();
        _askCloseHistoryPanel();
    } catch (err) {
        console.error('Failed to load session', err);
    }
}

// Render a saved assistant message — no streaming-bubble IDs, no data-raw,
// no shared state with the live-stream path. Self-contained DOM build.
function _askRenderHistoricalAssistantMsg(text, citations) {
    const container = $('#ask-messages');
    if (!container) return;

    const div = document.createElement('div');
    div.className = 'ask-msg ask-msg-assistant';

    const safeText = String(text || '');
    let html;
    try {
        html = _askLinkifyCitations(_askSimpleMarkdown(safeText), citations);
    } catch (err) {
        console.warn('Markdown render failed, falling back to plain text', err);
        html = `<p>${escapeHtml(safeText).replace(/\n/g, '<br>')}</p>`;
    }

    // Build the message body
    div.innerHTML = `
        <div class="ask-msg-avatar" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="0.8" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></svg>
        </div>
        <div class="ask-msg-body">
            <div class="ask-msg-content"></div>
        </div>
    `;
    div.querySelector('.ask-msg-content').innerHTML = html;
    container.appendChild(div);

    // Source chips (same dedupe rules as the streaming path).
    if (Array.isArray(citations) && citations.length > 0) {
        const bestByCtx = new Map();
        for (const s of citations) {
            const cid = s && s.context_id;
            if (cid == null) continue;
            const prev = bestByCtx.get(cid);
            const sScore = typeof s.score === 'number' ? s.score : 0;
            const pScore = prev && typeof prev.score === 'number' ? prev.score : -1;
            const sIsPrimary = !s.neighbor;
            const pIsPrimary = prev ? !prev.neighbor : false;
            const replace =
                !prev ||
                (sIsPrimary && !pIsPrimary) ||
                (sIsPrimary === pIsPrimary && sScore > pScore);
            if (replace) bestByCtx.set(cid, s);
        }
        const deduped = Array.from(bestByCtx.values());

        const body = div.querySelector('.ask-msg-body');
        const sourcesDiv = document.createElement('div');
        sourcesDiv.className = 'ask-sources';

        const chipsHtml = deduped.map(s => {
            const brand = s.source ? _AI_BRAND[s.source] : null;
            const color = brand ? brand.color : 'var(--cv-volt)';
            const title = String(s.title || 'Untitled');
            const short = title.length > 42 ? title.slice(0, 40) + '…' : title;
            const pct = typeof s.score === 'number' ? Math.round(s.score * 100) : null;
            const score = pct !== null ? `<span class="ask-source-score">${pct}%</span>` : '';
            const snippet = s.snippet ? String(s.snippet) : '';
            const tooltipParts = [title];
            if (brand) tooltipParts.push(brand.label);
            if (snippet) tooltipParts.push(snippet);
            const tooltip = tooltipParts.join(' · ');
            const snippetLine = snippet
                ? `<div class="ask-source-snippet">${escapeHtml(snippet)}</div>`
                : '';
            const cidAttr = s.context_id != null ? Number(s.context_id) : '';
            return `<div class="ask-source-card">
                        <button class="ask-source-chip" style="--src-color:${color}"
                                onclick="showDetail(${cidAttr})"
                                title="${escapeHtml(tooltip)}">
                            <span class="ask-source-dot" aria-hidden="true"></span>
                            <span class="ask-source-title">${escapeHtml(short)}</span>
                            ${score}
                        </button>
                        ${snippetLine}
                    </div>`;
        }).join('');

        sourcesDiv.innerHTML = `<span class="ask-sources-label">Sources</span>${chipsHtml}`;
        body.appendChild(sourcesDiv);
    }
}

async function _askToggleSessionPin(sessionId) {
    const s = state.askSessions.find(x => x.id === sessionId);
    if (!s) return;
    const next = !s.pinned;
    try {
        const res = await fetch(`${API}/api/vault/sessions/${sessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned: next }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await _askLoadSessions();
    } catch (err) { console.error(err); }
}

async function _askRenameSession(sessionId) {
    const s = state.askSessions.find(x => x.id === sessionId);
    if (!s) return;
    const next = await showPrompt({
        title: 'Rename chat',
        message: 'Give this conversation a clearer name.',
        defaultValue: s.title || '',
        placeholder: 'Untitled',
        confirmLabel: 'Save',
        maxLength: 200,
    });
    if (!next || next === s.title) return;
    try {
        const res = await fetch(`${API}/api/vault/sessions/${sessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: next }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await _askLoadSessions();
    } catch (err) {
        console.error(err);
        showToast('Rename failed', 'error');
    }
}

async function _askDeleteSession(sessionId) {
    const s = state.askSessions.find(x => x.id === sessionId);
    const title = s && s.title ? `"${s.title}"` : 'this chat';
    const ok = await showConfirm({
        title: 'Delete chat?',
        message: `${title} will be permanently removed from your vault. This can't be undone.`,
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;
    try {
        const res = await fetch(`${API}/api/vault/sessions/${sessionId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (state.askSessionId === sessionId) _askResetChat();
        await _askLoadSessions();
        showToast('Chat deleted', 'success');
    } catch (err) {
        console.error(err);
        showToast('Delete failed', 'error');
    }
}

// Scroll to the bottom of the Ask chat. The scrollable parent moved from
// #ask-messages to .cv-ask-scroll in the cv-ask redesign — this helper
// finds whichever one is actually scrollable.
function _askScrollToBottom() {
    const scroller = document.querySelector('.cv-ask-scroll') || $('#ask-messages');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function _askRenderUserMsg(text) {
    const container = $('#ask-messages');
    const empty = $('#ask-empty');
    if (empty) empty.style.display = 'none';

    const div = document.createElement('div');
    div.className = 'ask-msg ask-msg-user';
    div.innerHTML = `
        <div class="ask-msg-avatar">U</div>
        <div class="ask-msg-body">
            <div class="ask-msg-content">${escapeHtml(text)}</div>
            <div class="ask-msg-actions">
                <button class="ask-msg-action-btn" title="Edit this message" onclick="window._askEditMsg(this)">
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2l3 3-9 9H2v-3L11 2z"/></svg>
                    Edit
                </button>
                <button class="ask-msg-action-btn" title="Retry this message" onclick="window._askRetryMsg(this)">
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v5h5"/><path d="M1.5 9A7 7 0 1 0 4 3.5"/></svg>
                    Retry
                </button>
            </div>
        </div>
    `;
    container.appendChild(div);
    _askScrollToBottom();
}

// Shared helper: truncate history + remove DOM messages from a user bubble onward.
// Returns the question text, or null if already streaming.
function _askTruncateFromMsg(btn) {
    if (state.askStreaming) return null;
    const msgEl = btn.closest('.ask-msg-user');
    if (!msgEl) return null;

    const text = msgEl.querySelector('.ask-msg-content')?.textContent?.trim() || '';

    // Count how many user messages precede this one to find history position.
    const container = $('#ask-messages');
    const userMsgs = Array.from(container.querySelectorAll('.ask-msg-user'));
    const userIdx = userMsgs.indexOf(msgEl);
    if (userIdx === -1) return null;

    // Truncate client-side history to before this user turn.
    state.askHistory = state.askHistory.slice(0, userIdx * 2);

    // Remove this message and everything after it from the DOM.
    const allMsgs = Array.from(container.children);
    const startIdx = allMsgs.indexOf(msgEl);
    if (startIdx !== -1) {
        allMsgs.slice(startIdx).forEach(el => el.remove());
    }

    // Start a fresh session so the server doesn't append to the old one.
    state.askSessionId = null;
    _askUpdateRailSession();

    // Show empty state if no messages remain.
    const remaining = container.querySelectorAll('.ask-msg');
    const empty = $('#ask-empty');
    if (remaining.length === 0 && empty) empty.style.display = '';

    return text;
}

window._askEditMsg = function(btn) {
    const text = _askTruncateFromMsg(btn);
    if (text === null) return;

    const input = $('#ask-input');
    const sendBtn = $('#ask-send-btn');
    if (input) {
        input.value = text;
        input.classList.add('editing');
        input.focus();
        input.addEventListener('input', () => input.classList.remove('editing'), { once: true });
        if (sendBtn) sendBtn.disabled = !text.trim();
    }
};

window._askRetryMsg = function(btn) {
    const text = _askTruncateFromMsg(btn);
    if (text === null || !text) return;
    askVault(text);
};

function _askRenderThinking() {
    const container = $('#ask-messages');
    const div = document.createElement('div');
    div.className = 'ask-thinking cv-ask-thinking';
    div.id = 'ask-thinking-indicator';
    div.innerHTML = `
        <span class="cv-ask-orbit" aria-hidden="true"><span></span><span></span><span></span></span>
        <span class="cv-ask-thinking-text">Searching your vault…</span>
    `;
    container.appendChild(div);
    _askScrollToBottom();
}

function _askRemoveThinking() {
    const el = $('#ask-thinking-indicator');
    if (el) el.remove();
}

function _askSimpleMarkdown(text) {
    // Convert basic markdown to HTML
    let html = escapeHtml(text);

    // Code blocks: ```lang\n...\n```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre><code class="language-${lang}">${code}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic (but not if part of a list marker **)
    html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

    // Unordered + numbered list markers → <li>
    html = html.replace(/^[-â€¢*]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

    // Tables + lists — single line-walk (no catastrophic regex backtracking).
    {
        const lines = html.split('\n');
        const out = [];
        let inList = false;

        const splitRow = (s) => {
            let t = s.trim();
            if (t.startsWith('|')) t = t.slice(1);
            if (t.endsWith('|'))   t = t.slice(0, -1);
            return t.split('|').map(c => c.trim());
        };
        const isRow = (s) => s.includes('|') && s.trim() !== '';
        // A GFM separator row: every pipe-cell is dashes (with optional :align:)
        const isSep = (s) => {
            if (!s.includes('|')) return false;
            const cells = splitRow(s);
            return cells.length >= 1 && cells.every(c => /^:?-{2,}:?$/.test(c.replace(/\s+/g, '')));
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // GFM table: header row, then |---|---| separator, then 0+ body rows
            if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
                if (inList) { out.push('</ul>'); inList = false; }
                const headers = splitRow(line);
                i += 1; // consume the separator row
                const rows = [];
                while (i + 1 < lines.length && isRow(lines[i + 1]) && !isSep(lines[i + 1])) {
                    rows.push(splitRow(lines[i + 1]));
                    i += 1;
                }
                let tbl = '<table class="cv-md-table"><thead><tr>';
                tbl += headers.map(h => `<th>${h}</th>`).join('');
                tbl += '</tr></thead><tbody>';
                for (const r of rows) {
                    tbl += '<tr>' + headers.map((_, c) => `<td>${r[c] || ''}</td>`).join('') + '</tr>';
                }
                tbl += '</tbody></table>';
                out.push(tbl);
                continue;
            }

            const isLi = line.startsWith('<li>') && line.endsWith('</li>');
            if (isLi && !inList) { out.push('<ul>'); inList = true; }
            else if (!isLi && inList) { out.push('</ul>'); inList = false; }
            out.push(line);
        }
        if (inList) out.push('</ul>');
        html = out.join('\n');
    }

    // Line breaks â†’ paragraphs
    html = html.replace(/\n\n+/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    html = `<p>${html}</p>`;

    // Clean up empty paragraphs
    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<p>(<pre>)/g, '$1');
    html = html.replace(/(<\/pre>)<\/p>/g, '$1');
    html = html.replace(/<p>(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)<\/p>/g, '$1');
    html = html.replace(/<p>(<table)/g, '$1');
    html = html.replace(/(<\/table>)<\/p>/g, '$1');
    html = html.replace(/<br>(<table)/g, '$1');
    html = html.replace(/(<\/table>)<br>/g, '$1');

    return html;
}

function _askRenderAssistantMsg() {
    const container = $('#ask-messages');
    const div = document.createElement('div');
    div.className = 'ask-msg ask-msg-assistant';
    div.id = 'ask-streaming-msg';
    // Volt bolt avatar to match the sidebar brand mark.
    div.innerHTML = `
        <div class="ask-msg-avatar" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="0.8" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></svg>
        </div>
        <div class="ask-msg-body">
            <div class="ask-msg-content" id="ask-streaming-content"><span class="ask-cursor"></span></div>
        </div>
    `;
    container.appendChild(div);
    _askScrollToBottom();
}

let _askRafScheduled = false;

function _askAppendToken(token) {
    const content = $('#ask-streaming-content');
    if (!content) return;

    // Accumulate raw text; let rAF coalesce paints so streaming feels smooth
    // instead of strobing once per token.
    const raw = (content.getAttribute('data-raw') || '') + token;
    content.setAttribute('data-raw', raw);

    if (!_askRafScheduled) {
        _askRafScheduled = true;
        requestAnimationFrame(_askFlushStream);
    }
}

function _askFlushStream() {
    _askRafScheduled = false;
    const content = $('#ask-streaming-content');
    if (!content) return;
    const raw = content.getAttribute('data-raw') || '';
    // Render markdown progressively — partial **bold or ```code blocks just
    // stay as plain text until their closing token arrives, then snap into
    // formatted form on the next frame.
    content.innerHTML = _askSimpleMarkdown(raw) + '<span class="ask-cursor"></span>';
    _askScrollToBottom();
}

// ─── MCP tool cards ──────────────────────────────────────────────────────
// Tool events arrive between prose tokens. Each card is appended as a sibling
// to the active streaming-content; we then rotate the streaming target so the
// next `token` event starts a fresh prose block under the card.

function _askMsgBody() {
    const msg = $('#ask-streaming-msg');
    return msg ? msg.querySelector('.ask-msg-body') : null;
}

function _askRotateStreamingContent() {
    const body = _askMsgBody();
    if (!body) return;
    const old = body.querySelector('#ask-streaming-content');
    if (old) {
        // Finalize prior block: render markdown, drop streaming id + cursor.
        const raw = old.getAttribute('data-raw') || old.textContent || '';
        old.innerHTML = _askSimpleMarkdown(raw);
        old.removeAttribute('id');
        old.removeAttribute('data-raw');
    }
    const fresh = document.createElement('div');
    fresh.className = 'ask-msg-content';
    fresh.id = 'ask-streaming-content';
    fresh.innerHTML = '<span class="ask-cursor"></span>';
    body.appendChild(fresh);
}

function _askEnsureStreamingContent() {
    if ($('#ask-streaming-content')) return;
    _askRotateStreamingContent();
}

function _askEscapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


// Turn inline [n] markers the model emits into clickable citation links that
// open the matching source context. `sources` carries the n → context_id map
// (backend assigns each context block a number). Numbers without a matching
// source are left as plain text.
function _askLinkifyCitations(html, sources) {
    if (!html || !Array.isArray(sources) || sources.length === 0) return html;
    const byNum = new Map();
    for (const s of sources) {
        if (s && s.n != null && s.context_id != null) byNum.set(Number(s.n), s);
    }
    if (byNum.size === 0) return html;
    return html.replace(/\[(\d{1,3})\]/g, (m, numStr) => {
        const s = byNum.get(Number(numStr));
        if (!s) return m;
        const title = escapeHtml(String(s.title || 'source'));
        return `<sup class="ask-cite"><a href="#" title="${title}" ` +
               `onclick="showDetail(${Number(s.context_id)});return false;">[${Number(numStr)}]</a></sup>`;
    });
}

function _askFinalizeMsg(sources) {
    const content = $('#ask-streaming-content');
    if (!content) return;

    // Remove cursor
    const cursor = content.querySelector('.ask-cursor');
    if (cursor) cursor.remove();

    // Convert the accumulated raw text to markdown HTML, then linkify [n] citations.
    const raw = content.getAttribute('data-raw') || content.textContent || '';
    content.innerHTML = _askLinkifyCitations(_askSimpleMarkdown(raw), sources);

    // Drop streaming IDs now that this message is finalized.
    const msg = $('#ask-streaming-msg');
    if (msg) msg.removeAttribute('id');
    if (content) content.removeAttribute('id');

    // Source chips — each chip colored by its source AI brand (ChatGPT green,
    // Claude orange, Grok white, Gemini blue, etc.) using the shared _AI_BRAND map.
    // Backend returns chunk-level sources; dedupe by context_id (best-scoring chunk wins),
    // de-prioritize neighbor-expansion chunks, and surface the matched-passage snippet
    // as a tooltip + a faint line under the chip.
    if (sources && sources.length > 0) {
        const bestByCtx = new Map();
        for (const s of sources) {
            const cid = s.context_id;
            if (cid == null) continue;
            const prev = bestByCtx.get(cid);
            const sScore = typeof s.score === 'number' ? s.score : 0;
            const pScore = prev && typeof prev.score === 'number' ? prev.score : -1;
            // Prefer non-neighbor chunks; among same kind, prefer higher score
            const sIsPrimary = !s.neighbor;
            const pIsPrimary = prev ? !prev.neighbor : false;
            const replace =
                !prev ||
                (sIsPrimary && !pIsPrimary) ||
                (sIsPrimary === pIsPrimary && sScore > pScore);
            if (replace) bestByCtx.set(cid, s);
        }
        const deduped = Array.from(bestByCtx.values());

        const body = content.parentElement; // .ask-msg-body
        const sourcesDiv = document.createElement('div');
        sourcesDiv.className = 'ask-sources';

        const chipsHtml = deduped.map(s => {
            const brand = s.source ? _AI_BRAND[s.source] : null;
            const color = brand ? brand.color : 'var(--cv-volt)';
            const title = String(s.title || 'Untitled');
            const short = title.length > 42 ? title.slice(0, 40) + '…' : title;
            const pct = typeof s.score === 'number' ? Math.round(s.score * 100) : null;
            const score = pct !== null ? `<span class="ask-source-score">${pct}%</span>` : '';
            const snippet = s.snippet ? String(s.snippet) : '';
            const tooltipParts = [title];
            if (brand) tooltipParts.push(brand.label);
            if (snippet) tooltipParts.push(snippet);
            const tooltip = tooltipParts.join(' · ');
            const snippetLine = snippet
                ? `<div class="ask-source-snippet">${escapeHtml(snippet)}</div>`
                : '';
            return `<div class="ask-source-card">
                        <button class="ask-source-chip" style="--src-color:${color}"
                                onclick="showDetail(${s.context_id})"
                                title="${escapeHtml(tooltip)}">
                            <span class="ask-source-dot" aria-hidden="true"></span>
                            <span class="ask-source-title">${escapeHtml(short)}</span>
                            ${score}
                        </button>
                        ${snippetLine}
                    </div>`;
        }).join('');

        sourcesDiv.innerHTML = `<span class="ask-sources-label">Sources</span>${chipsHtml}`;
        body.appendChild(sourcesDiv);
    }

    _askScrollToBottom();
}

function _askSetStatus(text) {
    const el = document.getElementById('cv-ask-status-text');
    if (el) el.textContent = text;
}

async function askVault(question) {
    if (state.askStreaming || !question) return;
    state.askStreaming = true;

    const input = $('#ask-input');
    const sendBtn = $('#ask-send-btn');
    const clearBtn = $('#ask-clear-btn');
    if (input) input.value = '';
    if (sendBtn) sendBtn.disabled = true;
    if (clearBtn) clearBtn.style.display = '';
    _askSetStatus('Thinking…');

    // Add user message to history & render
    state.askHistory.push({ role: 'user', content: question });
    _askRenderUserMsg(question);
    _askRenderThinking();

    let fullResponse = '';

    try {
        const res = await fetch(`${API}/api/vault/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question,
                history: state.askHistory.slice(-6),
                session_id: state.askSessionId,
                // Scope retrieval to a collection when one is selected (#10);
                // null/undefined means search the whole vault.
                collection_id: state.askScopeCollectionId ?? null,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Server error ${res.status}`);
        }

        // Keep the thinking indicator visible until the first token actually
        // arrives — otherwise the empty bubble + blinking cursor sit on screen
        // for hundreds of ms while the model warms up, which feels broken.
        let assistantRendered = false;
        const _ensureAssistantBubble = () => {
            if (assistantRendered) return;
            assistantRendered = true;
            _askRemoveThinking();
            _askRenderAssistantMsg();
            _askSetStatus('Streaming…');
        };

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done: streamDone } = await reader.read();
            if (streamDone) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // keep incomplete line

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const data = JSON.parse(line);
                    if (data.token) {
                        _ensureAssistantBubble();
                        _askEnsureStreamingContent();
                        fullResponse += data.token;
                        _askAppendToken(data.token);
                    }
                    if (data.error) {
                        _ensureAssistantBubble();
                        fullResponse += `\n\nâš ï¸ Error: ${data.error}`;
                        _askAppendToken(`\n\nâš ï¸ Error: ${data.error}`);
                    }
                    if (data.done) {
                        _ensureAssistantBubble();
                        if (data.session_id) state.askSessionId = data.session_id;
                        _askFinalizeMsg(data.sources || []);
                    }
                } catch (_) { /* skip bad lines */ }
            }
        }

        // Process remaining buffer
        if (buffer.trim()) {
            try {
                const data = JSON.parse(buffer);
                if (data.token) {
                    _ensureAssistantBubble();
                    fullResponse += data.token;
                    _askAppendToken(data.token);
                }
                if (data.done) {
                    _ensureAssistantBubble();
                    if (data.session_id) state.askSessionId = data.session_id;
                    _askFinalizeMsg(data.sources || []);
                }
            } catch (_) {}
        }

    } catch (err) {
        _askRemoveThinking();
        // Show error as assistant message
        if (!$('#ask-streaming-msg')) {
            _askRenderAssistantMsg();
        }
        _askAppendToken(`âš ï¸ ${err.message}`);
        _askFinalizeMsg([]);
        fullResponse = `Error: ${err.message}`;
    }

    // Save assistant response to history
    state.askHistory.push({ role: 'assistant', content: fullResponse });
    state.askStreaming = false;
    if (sendBtn && input) sendBtn.disabled = !input.value.trim();
    _askSetStatus('Ready');

    // Refresh sidebar list silently so the new/updated session shows up next open
    // and the rail label has the correct title.
    try {
        const r = await fetch(`${API}/api/vault/sessions`);
        if (r.ok) {
            const d = await r.json();
            state.askSessions = d.sessions || [];
            _askUpdateRailSession();
            // If the panel happens to be open, re-render in place.
            const panel = $('#cv-ask-history-panel');
            if (panel && !panel.hasAttribute('hidden')) _askRenderSessionList();
        }
    } catch (_) {}
}

// â”€â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.addEventListener('DOMContentLoaded', () => {
    // Setup wizard
    setupInterval = setInterval(checkSetup, 2000);
    checkSetup(); // Immediate first check
    _initSettingsHint(); // Show active models in sidebar hint
    _initSidebarTooltips(); // Sidebar hover tooltips
    _initAskVault(); // Ask Your Vault chat
    _initMcpServerPanelHandlers(); // ConVX-as-MCP-server settings panel
    _initTunnelPanelHandlers();    // Cloudflare tunnel card
    _initUpdatePanel();            // Auto-update
    _initNotifCenter();            // Topbar notification center


    // Skip setup button (service phase)
    $('#skip-setup-btn').addEventListener('click', () => {
        clearInterval(setupInterval);
        transitionToApp();
    });

    // Navigation
    $$('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => navigateTo(btn.dataset.view));
    });

    // Chat input
    initChatInput();

    // Dashboard event handlers
    if ($('#quick-capture-toggle')) {
        $('#quick-capture-toggle').addEventListener('click', () => navigateTo('capture'));
    }
    if ($('#capture-back-btn')) {
        $('#capture-back-btn').addEventListener('click', () => navigateTo('input'));
    }
    if ($('#dashboard-see-all')) {
        $('#dashboard-see-all').addEventListener('click', () => navigateTo('library'));
    }

    // Search
    initSearch();

    // Detail view actions (back / edit / export / delete) are rendered inline by
    // renderDetail() in the cv-detail rail — wired via their own onclick + the
    // cv*ExportMenu handlers, so no static bindings are needed here.

    // Prompt buttons are now rendered inline by renderDetail() per context view.
    // Handlers are bound there to avoid stale node references after re-renders.

    // Backfill embeddings & chunks
    if ($('#btn-rebuild-embeddings')) $('#btn-rebuild-embeddings').addEventListener('click', rebuildEmbeddings);
    if ($('#btn-load-more')) $('#btn-load-more').addEventListener('click', loadMoreContexts);
    if ($('#btn-restart')) $('#btn-restart').addEventListener('click', restartBackend);
    if ($('#btn-backup')) $('#btn-backup').addEventListener('click', downloadBackup);

    // System modal
    if ($('#btn-system'))       $('#btn-system').addEventListener('click', openSystemModal);
    if ($('#system-modal-close')) $('#system-modal-close').addEventListener('click', closeSystemModal);
    if ($('#system-modal'))     $('#system-modal').addEventListener('click', e => { if (e.target === $('#system-modal')) closeSystemModal(); });
    document.querySelectorAll('.system-tab').forEach(tab => {
        tab.addEventListener('click', () => _switchSystemTab(tab.dataset.tab));
    });
    if ($('#btn-refresh-logs'))  $('#btn-refresh-logs').addEventListener('click', loadSystemLogs);
    if ($('#logs-lines-select')) $('#logs-lines-select').addEventListener('change', loadSystemLogs);
    if ($('#btn-copy-logs')) {
        $('#btn-copy-logs').addEventListener('click', () => {
            const text = Array.from($('#logs-viewer').querySelectorAll('.log-line')).map(el => el.textContent).join('\n');
            navigator.clipboard.writeText(text).then(() => showToast('Logs copied', 'success')).catch(() => showToast('Copy failed', 'error'));
        });
    }

    // Collections
    if ($('#btn-add-collection')) {
        $('#btn-add-collection').addEventListener('click', () => {
            const row = $('#collection-create-row');
            if (row.style.display === 'none' || !row.style.display) openCollectionCreate();
            else closeCollectionCreate();
        });
    }
    if ($('#collection-name-input')) {
        $('#collection-name-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitCollectionCreate();
            if (e.key === 'Escape') closeCollectionCreate();
        });
    }
    document.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
            swatch.classList.add('active');
            state.newCollectionColor = swatch.dataset.color;
        });
    });

    // Sort control (custom popover)
    const _sortRoot = $('#cv-sort');
    const _sortBtn = $('#cv-sort-btn');
    const _sortMenu = $('#cv-sort-menu');
    const _sortValue = $('#cv-sort-value');
    if (_sortRoot && _sortBtn && _sortMenu) {
        const SORT_LABELS = { newest: 'Newest', oldest: 'Oldest', alpha: 'A — Z' };

        const setSort = (val) => {
            state.sortOrder = val;
            if (_sortValue) _sortValue.textContent = SORT_LABELS[val] || 'Newest';
            _sortMenu.querySelectorAll('.cv-sort-opt').forEach(opt => {
                opt.setAttribute('aria-selected', String(opt.getAttribute('data-sort') === val));
            });
            try { localStorage.setItem('cv-sort-order', val); } catch (e) {}
        };

        const openMenu = () => {
            _sortMenu.hidden = false;
            _sortBtn.setAttribute('aria-expanded', 'true');
            const selected = _sortMenu.querySelector('.cv-sort-opt[aria-selected="true"]') || _sortMenu.querySelector('.cv-sort-opt');
            if (selected) selected.focus();
        };
        const closeMenu = () => {
            _sortMenu.hidden = true;
            _sortBtn.setAttribute('aria-expanded', 'false');
        };
        const toggleMenu = () => (_sortMenu.hidden ? openMenu() : closeMenu());

        // Restore saved sort
        try {
            const saved = localStorage.getItem('cv-sort-order');
            if (saved && SORT_LABELS[saved]) setSort(saved);
            else setSort(state.sortOrder || 'newest');
        } catch (e) { setSort(state.sortOrder || 'newest'); }

        _sortBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });

        _sortMenu.querySelectorAll('.cv-sort-opt').forEach(opt => {
            opt.addEventListener('click', () => {
                const val = opt.getAttribute('data-sort');
                if (!val) return;
                setSort(val);
                closeMenu();
                _sortBtn.focus();
                loadContexts($('#search-input').value.trim());
            });
        });

        // Keyboard nav inside the menu
        _sortMenu.addEventListener('keydown', (e) => {
            const opts = Array.from(_sortMenu.querySelectorAll('.cv-sort-opt'));
            const idx = opts.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); opts[(idx + 1) % opts.length]?.focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); opts[(idx - 1 + opts.length) % opts.length]?.focus(); }
            else if (e.key === 'Home') { e.preventDefault(); opts[0]?.focus(); }
            else if (e.key === 'End') { e.preventDefault(); opts[opts.length - 1]?.focus(); }
            else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); _sortBtn.focus(); }
        });

        // Click outside / Escape on button
        document.addEventListener('click', (e) => {
            if (!_sortMenu.hidden && !_sortRoot.contains(e.target)) closeMenu();
        });
        _sortBtn.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openMenu();
            } else if (e.key === 'Escape' && !_sortMenu.hidden) {
                e.preventDefault();
                closeMenu();
            }
        });
    }

    // Select mode & bulk actions
    if ($('#btn-select-mode')) $('#btn-select-mode').addEventListener('click', toggleSelectMode);
    if ($('#btn-select-all')) $('#btn-select-all').addEventListener('click', selectAllCards);
    if ($('#btn-bulk-delete')) $('#btn-bulk-delete').addEventListener('click', bulkDelete);
    if ($('#btn-cancel-select')) $('#btn-cancel-select').addEventListener('click', toggleSelectMode);

    // Deep search toggle
    if ($('#btn-deep-search')) $('#btn-deep-search').addEventListener('click', toggleDeepSearch);

    // Library view-mode seg (Grid / Rows)
    const _viewSeg = document.getElementById('cv-view-seg');
    if (_viewSeg) {
        _viewSeg.querySelectorAll('button[data-view]').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.view;
                _viewSeg.querySelectorAll('button').forEach(b => {
                    b.classList.toggle('on', b === btn);
                    b.setAttribute('aria-selected', String(b === btn));
                });
                const grid = document.getElementById('contexts-grid');
                if (grid) grid.setAttribute('data-view', mode);
                try { localStorage.setItem('cv-lib-view', mode); } catch(e) {}
            });
        });
        // Restore saved mode
        try {
            const saved = localStorage.getItem('cv-lib-view');
            if (saved === 'rows' || saved === 'grid') {
                const btn = _viewSeg.querySelector(`button[data-view="${saved}"]`);
                if (btn) btn.click();
            }
        } catch(e) {}
    }

    // Ctrl/Cmd + K focuses the library search — or the Ask input when on Ask Vault.
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
            if (state.view === 'library') {
                e.preventDefault();
                const input = document.getElementById('search-input');
                if (input) { input.focus(); input.select(); }
            } else if (state.view === 'ask') {
                e.preventDefault();
                const input = document.getElementById('ask-input');
                if (input) { input.focus(); input.select(); }
            }
        }
    });

    // Edit modal
    $('#cancel-edit-btn').addEventListener('click', closeEditModal);
    $('#save-edit-btn').addEventListener('click', saveEdit);

    // Close modal on overlay click
    $('#edit-modal').addEventListener('click', (e) => {
        if (e.target === $('#edit-modal')) closeEditModal();
    });

    // Confirm delete modal
    if ($('#cancel-delete-btn')) $('#cancel-delete-btn').addEventListener('click', closeConfirmDeleteModal);
    if ($('#confirm-delete-btn')) $('#confirm-delete-btn').addEventListener('click', () => {
        const action = state._pendingConfirmDeleteAction;
        closeConfirmDeleteModal();
        if (action) action();
    });
    if ($('#confirm-delete-modal')) $('#confirm-delete-modal').addEventListener('click', (e) => {
        if (e.target === $('#confirm-delete-modal')) closeConfirmDeleteModal();
    });

    // Theme: segmented control (Light / Dark)
    document.querySelectorAll('.settings-theme-opt').forEach(btn => {
        btn.addEventListener('click', () => setTheme(btn.dataset.theme));
    });

    // Vibe toggle (Volt / Space)
    const _vibeBtns = document.querySelectorAll('#vibeToggle button');
    _vibeBtns.forEach(b => b.addEventListener('click', () => {
        const v = b.dataset.vibe;
        document.documentElement.setAttribute('data-vibe', v);
        _vibeBtns.forEach(x => {
            x.classList.toggle('on', x === b);
            x.setAttribute('aria-selected', String(x === b));
        });
        try { localStorage.setItem('cv-vibe', v); } catch(e) {}
    }));
    try {
        const _savedVibe = localStorage.getItem('cv-vibe');
        if (_savedVibe) {
            document.documentElement.setAttribute('data-vibe', _savedVibe);
            _vibeBtns.forEach(x => {
                x.classList.toggle('on', x.dataset.vibe === _savedVibe);
                x.setAttribute('aria-selected', String(x.dataset.vibe === _savedVibe));
            });
        }
    } catch(e) {}

    // Sidebar collapse
    if ($('#sidebar-collapse-btn')) $('#sidebar-collapse-btn').addEventListener('click', toggleSidebar);

    // Shortcuts modal
    if ($('#btn-shortcuts')) $('#btn-shortcuts').addEventListener('click', openShortcutsModal);
    if ($('#shortcuts-modal-close')) $('#shortcuts-modal-close').addEventListener('click', closeShortcutsModal);
    if ($('#shortcuts-modal')) $('#shortcuts-modal').addEventListener('click', (e) => {
        if (e.target === $('#shortcuts-modal')) closeShortcutsModal();
    });

    // Settings modal
    $('#btn-settings').addEventListener('click', openSettingsModal);
    $('#settings-modal-close').addEventListener('click', closeSettingsModal);
    $('#settings-cancel-btn').addEventListener('click', closeSettingsModal);
    $('#settings-save-btn').addEventListener('click', saveSettings);
    $('#settings-modal').addEventListener('click', (e) => {
        if (e.target === $('#settings-modal')) closeSettingsModal();
    });

    // Settings sidebar nav — switch active panel
    document.querySelectorAll('.settings-nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.settingsTab;
            document.querySelectorAll('.settings-nav-item').forEach(b => {
                const on = b === btn;
                b.classList.toggle('active', on);
                b.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            document.querySelectorAll('.settings-panel').forEach(p => {
                p.classList.toggle('active', p.dataset.settingsPanel === tab);
            });
            const body = document.querySelector('.settings-modal-body');
            if (body) body.scrollTop = 0;
        });
    });

    // Cloud key validate + show/hide toggle
    $('#cloud-key-validate-btn').addEventListener('click', _validateCloudKey);
    $('#cloud-key-toggle').addEventListener('click', () => {
        const inp = $('#cloud-key-input');
        inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    $('#cloud-key-delete-btn') && $('#cloud-key-delete-btn').addEventListener('click', _deleteCloudKey);


    // â”€â”€ Keyboard Shortcuts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    document.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);

        // Esc — close modals
        if (e.key === 'Escape') {
            if ($('#confirm-delete-modal') && $('#confirm-delete-modal').style.display !== 'none') { closeConfirmDeleteModal(); return; }
            if ($('#shortcuts-modal').style.display !== 'none') { closeShortcutsModal(); return; }
            if ($('#edit-modal').style.display !== 'none') { closeEditModal(); return; }
            if ($('#settings-modal').style.display !== 'none') { closeSettingsModal(); return; }
            if ($('#prompt-section') && $('#prompt-section').style.display !== 'none') {
                $('#prompt-section').style.display = 'none'; return;
            }
        }

        // Shortcuts below only fire when not typing in an input
        if (inInput) return;

        // ? — open keyboard shortcuts cheat sheet
        if (e.key === '?' || (e.shiftKey && e.key === '/')) {
            e.preventDefault();
            const modal = $('#shortcuts-modal');
            if (modal.style.display !== 'none') {
                closeShortcutsModal();
            } else {
                openShortcutsModal();
            }
            return;
        }

        // / — focus search (when in library view)
        if (e.key === '/' && state.view === 'library') {
            e.preventDefault();
            $('#search-input').focus();
        }

        // Backspace — go back from detail to library
        if (e.key === 'Backspace' && state.view === 'detail') {
            navigateTo('library');
        }

        // N — go to New Chat
        if (e.key === 'n' || e.key === 'N') {
            navigateTo('input');
        }

        // L — go to Library
        if (e.key === 'l' || e.key === 'L') {
            navigateTo('library');
        }
    });

    // Ctrl+Enter — summarize when in chat input
    $('#chat-textarea').addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            const btn = $('#summarize-btn');
            if (!btn.disabled) summarizeAndSave();
        }
    });

    // Periodic status check
    setInterval(async () => {
        try {
            const res = await fetch(`${API}/api/setup/status`);
            const data = await res.json();
            updateStatusIndicator(data.ollama_running && data.model_ready);
        } catch {
            updateStatusIndicator(false);
        }
    }, 30000);
});

// â”€â”€â”€ Restart Backend â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function restartBackend() {
    const btn = $('#btn-restart');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('restarting');
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> Restarting…`;

    // Snapshot the current server token before restarting
    let startedAt = null;
    try {
        const r = await fetch(`${API}/api/health`);
        startedAt = (await r.json()).started_at ?? null;
    } catch { /* server already offline */ }

    try {
        await fetch(`${API}/api/restart`, { method: 'POST' });
    } catch { /* server may drop before sending a response — fine */ }

    // Hard fallback: reload after 10 s no matter what (prevents infinite spin)
    const hardTimeout = setTimeout(() => window.location.reload(), 10000);

    // Poll every 500 ms — reload as soon as started_at changes (new server instance)
    const poll = async () => {
        try {
            const r = await fetch(`${API}/api/health`);
            if (r.ok) {
                const d = await r.json();
                if (d.started_at !== startedAt) {
                    clearTimeout(hardTimeout);
                    window.location.reload();
                    return;
                }
            }
        } catch { /* still cycling */ }
        setTimeout(poll, 500);
    };
    setTimeout(poll, 800);
}

// â”€â”€â”€ Detail Collection Change â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function handleDetailCollectionChange(contextId, value) {
    const collectionId = value === '' ? null : parseInt(value, 10);
    const updated = await setContextCollection(contextId, collectionId);
    if (updated) {
        const col = collectionId ? _getCollectionForContext(collectionId) : null;
        showToast(col ? `Moved to "${col.name}"` : 'Removed from collection', 'success');
    }
}

// â”€â”€â”€ System Status Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _sysAutoRefresh = null;

function openSystemModal() {
    const modal = $('#system-modal');
    modal.style.display = 'flex';
    _switchSystemTab('health');
    loadSystemHealth();
    // Auto-refresh health every 10 s while modal is open
    _sysAutoRefresh = setInterval(loadSystemHealth, 10000);
}

function closeSystemModal() {
    $('#system-modal').style.display = 'none';
    if (_sysAutoRefresh) { clearInterval(_sysAutoRefresh); _sysAutoRefresh = null; }
}

function _switchSystemTab(tab) {
    document.querySelectorAll('.system-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    $('#panel-health').style.display = tab === 'health' ? 'block' : 'none';
    $('#panel-logs').style.display   = tab === 'logs'   ? 'flex'  : 'none';
    if (tab === 'logs') {
        $('#panel-logs').style.flexDirection = 'column';
        loadSystemLogs();
    }
}

function _fmtUptime(s) {
    if (s < 60)   return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.floor(s/60)}m ${Math.round(s%60)}s`;
    return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

async function loadSystemHealth() {
    const grid = $('#sys-status-grid');
    if (!grid) return;
    try {
        const res = await fetch(`${API}/api/system/status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();

        const ollamaDot  = d.ollama.running  ? 'ok'   : 'err';
        const modelDot   = d.model.ready     ? 'ok'   : (d.ollama.running ? 'warn' : 'err');
        const modelSub   = d.model.ready     ? 'Ready' : (d.ollama.running ? 'Not downloaded' : 'Ollama offline');

        const modelsHtml = d.installed_models.length
            ? `<ul class="sys-models-list">${d.installed_models.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
            : `<span style="color:var(--text-faint);font-size:11px;">None installed</span>`;

        grid.innerHTML = `
            <div class="sys-card">
                <div class="sys-card-header">
                    <span class="sys-card-label">Backend</span>
                    <span class="sys-dot ok"></span>
                </div>
                <div class="sys-card-value">Online</div>
                <div class="sys-card-sub">Uptime: ${_fmtUptime(d.backend.uptime_s)}</div>
            </div>
            <div class="sys-card">
                <div class="sys-card-header">
                    <span class="sys-card-label">Ollama</span>
                    <span class="sys-dot ${ollamaDot}"></span>
                </div>
                <div class="sys-card-value">${d.ollama.running ? 'Running' : 'Offline'}</div>
                <div class="sys-card-sub">${escapeHtml(d.ollama.url)}</div>
            </div>
            <div class="sys-card">
                <div class="sys-card-header">
                    <span class="sys-card-label">LLM Model</span>
                    <span class="sys-dot ${modelDot}"></span>
                </div>
                <div class="sys-card-value" style="font-size:13px;line-height:1.3">${escapeHtml(d.model.name)}</div>
                <div class="sys-card-sub">${modelSub}</div>
            </div>
            <div class="sys-card">
                <div class="sys-card-header">
                    <span class="sys-card-label">Embed Model</span>
                    <span class="sys-dot ok"></span>
                </div>
                <div class="sys-card-value" style="font-size:13px;line-height:1.3">${escapeHtml(d.embed.name)}</div>
                <div class="sys-card-sub">Embedding model</div>
            </div>
            <div class="sys-card">
                <div class="sys-card-header">
                    <span class="sys-card-label">Database</span>
                    <span class="sys-dot ok"></span>
                </div>
                <div class="sys-card-value">${d.database.contexts}</div>
                <div class="sys-card-sub">${d.database.chunks} chunks · ${d.database.collections} collections · ${d.database.size_mb} MB</div>
            </div>
            <div class="sys-card" style="grid-column: span 2;">
                <div class="sys-card-header" style="margin-bottom:6px;">
                    <span class="sys-card-label">Installed Ollama Models</span>
                </div>
                ${modelsHtml}
            </div>`;
    } catch (e) {
        grid.innerHTML = `<div class="sys-status-loading" style="color:var(--danger)">Could not reach backend: ${escapeHtml(e.message)}</div>`;
    }
}

async function loadSystemLogs() {
    const viewer = $('#logs-viewer');
    if (!viewer) return;
    const lines = parseInt($('#logs-lines-select')?.value || '100', 10);
    viewer.innerHTML = '<div class="sys-status-loading"><div class="sys-loader-spinner" aria-hidden="true"></div><span class="sys-loader-text">Loading logs\u2026</span></div>';
    try {
        const res = await fetch(`${API}/api/debug/logs?lines=${lines}`);
        if (!res.ok) throw new Error();
        const d = await res.json();
        if (!d.exists || !d.lines.length) {
            viewer.innerHTML = '<div class="log-empty">No log entries found.</div>';
            return;
        }
        viewer.innerHTML = d.lines.map(line => {
            const l = line.trimEnd();
            let cls = 'log-line';
            const u = l.toUpperCase();
            if (u.includes('[ERROR]')   || u.includes('ERROR:'))   cls += ' log-error';
            else if (u.includes('[WARNING]') || u.includes('WARNING:')) cls += ' log-warning';
            else if (u.includes('[DEBUG]'))                              cls += ' log-debug';
            else                                                          cls += ' log-info';
            return `<div class="${cls}">${escapeHtml(l)}</div>`;
        }).join('');
        if ($('#logs-autoscroll')?.checked) viewer.scrollTop = viewer.scrollHeight;
    } catch {
        viewer.innerHTML = '<div class="sys-status-loading" style="color:var(--danger)">Failed to load logs.</div>';
    }
}

// â”€â”€â”€ Backup Vault â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function downloadBackup() {
    const btn = $('#btn-backup');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Backing up…`;
    try {
        const res = await fetch(`${API}/api/backup/download`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        a.href = url;
        a.download = `contextvolt_backup_${ts}.db`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Backup downloaded', 'success');
    } catch (e) {
        showToast('Backup failed: ' + e.message, 'error');
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
}

// â”€â”€â”€ Retry Summarization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function retrySummarize() {
    const ctx = state.currentContext;
    if (!ctx) return;
    try {
        const res = await fetch(`${API}/api/contexts/${ctx.id}/resummarize`, { method: 'POST' });
        if (!res.ok) throw new Error('Retry failed');
        showToast('Re-summarizing...', 'success');
        ctx.status = 'summarizing';
        renderDetail(ctx);
        startWorkerPolling();
        _kickGlobalPoll();
    } catch (err) {
        showToast('Failed to retry summarization', 'error');
    }
}

// Re-summarize an already-completed context — e.g. after switching the LLM
// model in Settings, so the summary is regenerated with the new model. The
// backend reads the active model from config at call time, so no model arg
// is needed here. Confirms first since it overwrites the existing summary.
async function resummarizeContext() {
    const ctx = state.currentContext;
    if (!ctx || ctx.status === 'summarizing') return;

    // Best-effort: name the model the new summary will use, for clarity.
    let modelName = '';
    try {
        const r = await fetch(`${API}/api/setup/status`);
        if (r.ok) modelName = (await r.json()).model_name || '';
    } catch { /* fall back to a generic message */ }

    const ok = await showConfirm({
        title: 'Re-summarize this context?',
        message: modelName
            ? `The whole conversation will be summarized again using the current model (${modelName}). This replaces the existing summary.`
            : 'The whole conversation will be summarized again using the current model. This replaces the existing summary.',
        confirmLabel: 'Re-summarize',
    });
    if (!ok) return;

    await retrySummarize();
}

// Expose to global for inline onclick handlers
window.showDetail = showDetail;
window.deleteFromLibrary = deleteFromLibrary;
window.toggleOriginalChat = toggleOriginalChat;
window.generatePrompt = generatePrompt;
window.retrySummarize = retrySummarize;
window.resummarizeContext = resummarizeContext;
window.copyCodeSnippet = copyCodeSnippet;

// â”€â”€â”€ Feature 1: Collapsible Sidebar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function toggleSidebar() {
    const app = document.getElementById('app');
    if (!app) return;
    // Mark as animating so CSS can suppress scrollbar flicker during the
    // width transition (which is what makes the collapse feel laggy).
    app.classList.add('sidebar-animating');
    app.classList.toggle('sidebar-collapsed');
    const collapsed = app.classList.contains('sidebar-collapsed');
    localStorage.setItem('cv-sidebar-collapsed', collapsed ? '1' : '0');
    const sidebar = document.getElementById('sidebar');
    const clear = () => app.classList.remove('sidebar-animating');
    if (sidebar) {
        const onEnd = (e) => {
            if (e.propertyName !== 'width') return;
            sidebar.removeEventListener('transitionend', onEnd);
            clear();
        };
        sidebar.addEventListener('transitionend', onEnd);
        // Safety fallback in case transitionend doesn't fire (exceeds the 340ms CSS transition)
        setTimeout(clear, 440);
    } else {
        setTimeout(clear, 420);
    }
}

function _restoreSidebarState() {
    const saved = localStorage.getItem('cv-sidebar-collapsed');
    if (saved === '1') {
        const app = document.getElementById('app');
        if (app) app.classList.add('sidebar-collapsed');
    }
}

// Run immediately
_restoreSidebarState();


// ─── Onboarding Tour ──────────────────────────────────────────────────
const CV_ONBOARD_KEY = 'cv_onboarded_v1';

const CV_ONBOARD_STEPS = [
    {
        target: null,
        title: 'Welcome to ContextVolt ⚡',
        body: 'Your local-first AI memory vault. Save AI conversations, summarize them with a local LLM, and query them later — all on your machine. This 90-second tour shows what each piece does.',
        eyebrow: 'Tour'
    },
    {
        target: '#sidebar',
        title: 'The sidebar — your control deck',
        body: 'Everything lives here: views (Dashboard, Library, Ask Vault), Collections, preferences, and system tools. Press the chevron at the top to collapse it.',
        eyebrow: 'Layout'
    },
    {
        target: '#nav-input',
        title: 'Dashboard',
        body: 'The home view. See vault stats, recent contexts, and start a new capture. Press <kbd>D</kbd> to jump here from anywhere.',
        eyebrow: 'View'
    },
    {
        target: '#quick-capture-toggle',
        title: 'Quick Capture — your starting point',
        body: 'Paste any AI conversation here. ContextVolt summarizes it with your local LLM, splits it semantically, and embeds it into the vault for later retrieval.',
        eyebrow: 'Action'
    },
    {
        target: '#nav-library',
        title: 'Library',
        body: 'Browse every saved context as a grid or compact rows. Click any card to open the detail view with the full transcript and summary. Press <kbd>L</kbd>.',
        eyebrow: 'View'
    },
    {
        target: '#nav-ask',
        title: 'Ask Vault — RAG over your captures',
        body: 'Ask natural-language questions across all your saved contexts. Retrieval-augmented generation finds the most relevant chunks and answers with citations. Press <kbd>A</kbd>.',
        eyebrow: 'View'
    },
    {
        target: '#collections-section',
        title: 'Collections',
        body: 'Group related contexts by topic, project, or client. Click <b>+</b> to create one — pick a color, give it a name, then assign contexts from the Library.',
        eyebrow: 'Organize'
    },
    {
        target: '#vibeToggle',
        title: 'Visual vibes',
        body: 'Three moods: <b>Volt</b> (default), <b>Space</b> (deep cosmic), <b>Noir</b> (minimal). Pick whatever helps you focus.',
        eyebrow: 'Personalize'
    },
    {
        target: '#btn-settings',
        title: 'Settings & Models',
        body: 'Pick which Ollama model handles summarization and which handles Q&A. Tweak chunk sizes, temperature, and retrieval depth here.',
        eyebrow: 'Configure'
    },
    {
        target: '#btn-system',
        title: 'System & health',
        body: 'Backend status, Ollama connection, live logs, and a one-click <b>Backup Vault</b>. The pulsing dot at the bottom always shows live status.',
        eyebrow: 'Health'
    },
    {
        target: null,
        title: 'You are ready ⚡',
        body: 'Hit <b>Quick Capture</b> to save your first conversation, or jump to <b>Ask Vault</b> if you already have data. You can replay this tour any time from the sidebar → <i>Take the Tour</i>.',
        eyebrow: 'Done'
    }
];

let _cvOnboardIdx = 0;
let _cvOnboardActive = false;

function _cvOnboardEls() {
    return {
        root: document.getElementById('cv-onboard'),
        hole: document.getElementById('cv-onboard-hole'),
        ring: document.getElementById('cv-onboard-ring'),
        card: document.getElementById('cv-onboard-card'),
        title: document.getElementById('cv-onboard-title'),
        body: document.getElementById('cv-onboard-body'),
        step: document.getElementById('cv-onboard-step'),
        eyebrow: document.getElementById('cv-onboard-eyebrow'),
        prog: document.getElementById('cv-onboard-progress-fill'),
        back: document.getElementById('cv-onboard-back'),
        next: document.getElementById('cv-onboard-next'),
        skip: document.getElementById('cv-onboard-skip'),
    };
}

function _cvOnboardPosition(step) {
    const els = _cvOnboardEls();
    const { hole, ring, card } = els;
    const pad = 8;
    const cardMargin = 16;
    const cardW = card.offsetWidth || 380;
    const cardH = card.offsetHeight || 220;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (!step.target) {
        hole.setAttribute('width', 0);
        hole.setAttribute('height', 0);
        ring.setAttribute('width', 0);
        ring.setAttribute('height', 0);
        card.classList.add('is-centered');
        card.style.top = '';
        card.style.left = '';
        card.style.transform = '';
        return;
    }
    const targetEl = document.querySelector(step.target);
    if (!targetEl) {
        hole.setAttribute('width', 0);
        hole.setAttribute('height', 0);
        card.classList.add('is-centered');
        return;
    }
    const r = targetEl.getBoundingClientRect();
    const x = Math.max(4, r.left - pad);
    const y = Math.max(4, r.top - pad);
    const w = Math.min(vw - 8, r.width + pad * 2);
    const h = Math.min(vh - 8, r.height + pad * 2);
    hole.setAttribute('x', x);
    hole.setAttribute('y', y);
    hole.setAttribute('width', w);
    hole.setAttribute('height', h);
    ring.setAttribute('x', x);
    ring.setAttribute('y', y);
    ring.setAttribute('width', w);
    ring.setAttribute('height', h);

    card.classList.remove('is-centered');
    let cardLeft, cardTop;
    const spaceRight = vw - (x + w);
    const spaceLeft = x;
    const spaceBelow = vh - (y + h);
    const spaceAbove = y;

    if (spaceRight >= cardW + cardMargin) {
        cardLeft = x + w + cardMargin;
        cardTop = Math.max(cardMargin, Math.min(vh - cardH - cardMargin, y + h / 2 - cardH / 2));
    } else if (spaceLeft >= cardW + cardMargin) {
        cardLeft = x - cardW - cardMargin;
        cardTop = Math.max(cardMargin, Math.min(vh - cardH - cardMargin, y + h / 2 - cardH / 2));
    } else if (spaceBelow >= cardH + cardMargin) {
        cardTop = y + h + cardMargin;
        cardLeft = Math.max(cardMargin, Math.min(vw - cardW - cardMargin, x + w / 2 - cardW / 2));
    } else if (spaceAbove >= cardH + cardMargin) {
        cardTop = y - cardH - cardMargin;
        cardLeft = Math.max(cardMargin, Math.min(vw - cardW - cardMargin, x + w / 2 - cardW / 2));
    } else {
        cardLeft = (vw - cardW) / 2;
        cardTop = (vh - cardH) / 2;
    }
    card.style.left = cardLeft + 'px';
    card.style.top = cardTop + 'px';
    card.style.transform = 'none';
}

function _cvOnboardRender() {
    const els = _cvOnboardEls();
    const step = CV_ONBOARD_STEPS[_cvOnboardIdx];
    const total = CV_ONBOARD_STEPS.length;
    els.title.textContent = step.title;
    els.body.innerHTML = step.body;
    els.eyebrow.textContent = step.eyebrow || 'Tour';
    els.step.textContent = (_cvOnboardIdx + 1) + ' / ' + total;
    els.prog.style.width = (((_cvOnboardIdx + 1) / total) * 100) + '%';
    els.back.disabled = _cvOnboardIdx === 0;
    els.next.textContent = _cvOnboardIdx === total - 1 ? 'Finish' : 'Next';

    if (step.target) {
        const t = document.querySelector(step.target);
        if (t && typeof t.scrollIntoView === 'function') {
            try { t.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch (e) {}
        }
    }
    requestAnimationFrame(() => _cvOnboardPosition(step));
}

function startOnboarding() {
    const els = _cvOnboardEls();
    if (!els.root) return;
    _cvOnboardIdx = 0;
    _cvOnboardActive = true;
    els.root.classList.add('is-open');
    els.root.setAttribute('aria-hidden', 'false');
    _cvOnboardRender();
}

function endOnboarding(markComplete) {
    if (markComplete === undefined) markComplete = true;
    const els = _cvOnboardEls();
    if (!els.root) return;
    els.root.classList.remove('is-open');
    els.root.setAttribute('aria-hidden', 'true');
    _cvOnboardActive = false;
    if (markComplete) {
        try { localStorage.setItem(CV_ONBOARD_KEY, '1'); } catch (e) {}
    }
}

function _cvOnboardNext() {
    if (_cvOnboardIdx >= CV_ONBOARD_STEPS.length - 1) {
        endOnboarding(true);
        return;
    }
    _cvOnboardIdx++;
    _cvOnboardRender();
}
function _cvOnboardBack() {
    if (_cvOnboardIdx === 0) return;
    _cvOnboardIdx--;
    _cvOnboardRender();
}

function _initOnboardingControls() {
    const els = _cvOnboardEls();
    if (!els.root || els.root.dataset.bound) return;
    els.root.dataset.bound = '1';
    els.next.addEventListener('click', _cvOnboardNext);
    els.back.addEventListener('click', _cvOnboardBack);
    els.skip.addEventListener('click', () => endOnboarding(true));
    document.addEventListener('keydown', (e) => {
        if (!_cvOnboardActive) return;
        if (e.key === 'Escape') { endOnboarding(true); }
        else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); _cvOnboardNext(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); _cvOnboardBack(); }
    });
    window.addEventListener('resize', () => {
        if (_cvOnboardActive) _cvOnboardPosition(CV_ONBOARD_STEPS[_cvOnboardIdx]);
    });
    const replayBtn = document.getElementById('btn-onboard-replay');
    if (replayBtn) replayBtn.addEventListener('click', () => startOnboarding());
}

async function maybeStartOnboarding() {
    _initOnboardingControls();
    let seen = '';
    try { seen = localStorage.getItem(CV_ONBOARD_KEY) || ''; } catch (e) {}
    if (seen) return;

    // Only true new users (empty vault) get the auto-tour.
    // Anyone with existing contexts is silently marked onboarded.
    let isNewUser = false;
    try {
        const res = await fetch(`${API}/api/contexts?page=1&per_page=1`);
        if (res.ok) {
            const data = await res.json();
            const items = Array.isArray(data) ? data : (data.items || data.contexts || []);
            const total = (typeof data.total === 'number') ? data.total : items.length;
            isNewUser = total === 0;
        }
    } catch (e) {
        // Backend unreachable — don't auto-trigger; user can still replay manually.
        return;
    }

    if (isNewUser) {
        setTimeout(() => startOnboarding(), 650);
    } else {
        try { localStorage.setItem(CV_ONBOARD_KEY, '1'); } catch (e) {}
    }
}

window.startOnboarding = startOnboarding;
window.endOnboarding = endOnboarding;

// ── Auto-update ──────────────────────────────────────────────────────────────

let _updateInfo = null;

function _fmtBytes(b) {
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function _setUpdateState(state) {
    ['idle', 'available', 'downloading', 'ready'].forEach(s => {
        const el = document.getElementById(`update-state-${s}`);
        if (el) el.style.display = s === state ? '' : 'none';
    });
}

async function checkForUpdate(silent = true) {
    const statusEl = document.getElementById('update-check-status');
    if (!silent && statusEl) statusEl.textContent = 'Checking…';

    try {
        const res = await fetch(`${API}/api/update/check`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        _updateInfo = data;

        const currentEl = document.getElementById('update-current-version');
        if (currentEl) currentEl.textContent = `v${data.current_version}`;

        // Stamp last-checked time
        try {
            const stamp = Date.now();
            localStorage.setItem('cv_update_last_checked', String(stamp));
            _renderLastChecked(stamp);
        } catch (_) {}

        if (data.update_available) {
            // Show red dot on nav item
            const dot = document.getElementById('update-nav-dot');
            if (dot) dot.style.display = '';

            const latestEl = document.getElementById('update-latest-version');
            if (latestEl) latestEl.textContent = data.latest_version;

            const notesEl = document.getElementById('update-notes');
            if (notesEl) notesEl.textContent = data.release_notes || '';

            const linkEl = document.getElementById('update-changelog-link');
            if (linkEl && data.html_url) linkEl.href = data.html_url;

            _setUpdateState('available');
            if (!silent && statusEl) statusEl.textContent = '';
        } else {
            _setUpdateState('idle');
            if (!silent && statusEl) {
                statusEl.textContent = data.error
                    ? `Could not check: ${data.error}`
                    : `You're on the latest version (v${data.current_version})`;
            }
        }
    } catch (e) {
        if (!silent && statusEl) statusEl.textContent = `Check failed: ${e.message}`;
    }
}

async function _downloadAndInstallUpdate() {
    if (!_updateInfo?.download_url) return;

    _setUpdateState('downloading');
    const pctEl  = document.getElementById('update-progress-pct');
    const barEl  = document.getElementById('update-progress-bar');
    const byteEl = document.getElementById('update-progress-bytes');

    const url = encodeURIComponent(_updateInfo.download_url);
    const res = await fetch(`${API}/api/update/download?url=${url}`);
    if (!res.ok || !res.body) {
        _setUpdateState('available');
        return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
                const msg = JSON.parse(line.slice(6));
                if (msg.error) { _setUpdateState('available'); return; }
                if (msg.progress >= 0 && pctEl) pctEl.textContent = `${msg.progress}%`;
                if (barEl) barEl.style.width = `${Math.max(0, msg.progress)}%`;
                if (byteEl && msg.total > 0) byteEl.textContent = `${_fmtBytes(msg.downloaded)} / ${_fmtBytes(msg.total)}`;
                if (msg.done) { _setUpdateState('ready'); return; }
            } catch (_) {}
        }
    }
}

async function _applyUpdate() {
    await fetch(`${API}/api/update/apply`, { method: 'POST' });
}

function _renderLastChecked(stamp) {
    const el = document.getElementById('update-last-checked');
    if (!el) return;
    if (!stamp) { el.textContent = 'Never checked'; return; }
    const s = Math.floor((Date.now() - stamp) / 1000);
    let when;
    if (s < 45) when = 'just now';
    else if (s < 3600) when = `${Math.floor(s/60)}m ago`;
    else if (s < 86400) when = `${Math.floor(s/3600)}h ago`;
    else when = new Date(stamp).toLocaleString();
    el.textContent = `Last checked ${when}`;
}

function _initUpdatePanel() {
    const checkBtn = document.getElementById('btn-check-update');
    if (checkBtn) checkBtn.addEventListener('click', () => checkForUpdate(false));

    // Restore last-checked timestamp
    try {
        const raw = localStorage.getItem('cv_update_last_checked');
        if (raw) _renderLastChecked(parseInt(raw, 10));
    } catch (_) {}

    const dlBtn = document.getElementById('btn-download-update');
    if (dlBtn) dlBtn.addEventListener('click', _downloadAndInstallUpdate);

    const applyBtn = document.getElementById('btn-apply-update');
    if (applyBtn) applyBtn.addEventListener('click', _applyUpdate);

    // Populate current version immediately from health endpoint
    fetch(`${API}/api/health`).then(r => r.json()).then(d => {
        const el = document.getElementById('update-current-version');
        if (el && d.version) el.textContent = `v${d.version}`;
    }).catch(() => {});

    // Silent background check 3s after app loads
    setTimeout(() => checkForUpdate(true), 3000);
}
