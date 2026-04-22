/**
 * ContextVolt â€” Frontend SPA
 *
 * Vanilla JS single-page application.
 * Handles: Setup Wizard, Chat Input, Context Library, Detail View, Prompt Builder.
 */

const API = 'http://localhost:8000';

// â”€â”€â”€ Global error handler â€” prevents silent freezes in pywebview â”€â”€
window.addEventListener('error', e => {
    console.error('Uncaught error:', e.message, e.filename, e.lineno);
    try { showToast(`JS Error: ${e.message}`, 'error'); } catch (_) {}
});
window.addEventListener('unhandledrejection', e => {
    console.error('Unhandled promise rejection:', e.reason);
    try { showToast(`Error: ${e.reason?.message || e.reason}`, 'error'); } catch (_) {}
});

// â”€â”€â”€ Theme â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const isDark = theme === 'dark';
    const iconDark = document.getElementById('theme-icon-dark');
    const iconLight = document.getElementById('theme-icon-light');
    const label = document.getElementById('theme-label');
    if (iconDark) iconDark.style.display = isDark ? 'inline' : 'none';
    if (iconLight) iconLight.style.display = isDark ? 'none' : 'inline';
    if (label) label.textContent = isDark ? 'Light Mode' : 'Dark Mode';
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    _applyTheme(next);
    localStorage.setItem('cv-theme', next);
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
        // Nothing pending â€” stop polling
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
                    // Banner was removed (status changed) â€” re-render full detail
                    renderDetail(fresh);
                }
            }

            // If status changed from summarizing, refresh the card in the library grid
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
                <strong>Summarizing in backgroundâ€¦</strong>
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
    }, 500);
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
        loadDashboard();
    }

    // Start/stop background polling depending on view
    if (view === 'library' || view === 'detail') {
        startWorkerPolling();
    } else {
        stopWorkerPolling();
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

function _renderRecentCard(ctx) {
    const summary = typeof ctx.summary === 'string' ? {} : ctx.summary;
    const title = escapeHtml(ctx.title || 'Untitled');
    const date = _timeAgo(ctx.created_at);
    const sourceBadge = _getSourceBadge(ctx.tags);
    const snippet = summary.key_ideas && summary.key_ideas.length > 0
        ? escapeHtml(summary.key_ideas[0])
        : (summary.snapshot ? escapeHtml(summary.snapshot) : '');

    return `<div class="dashboard-recent-card" onclick="showDetail(${ctx.id})">
        <div class="dashboard-recent-card-header">
            <span class="dashboard-recent-card-title">${title}</span>
            ${sourceBadge}
        </div>
        ${snippet ? `<div class="dashboard-recent-card-summary">${snippet}</div>` : ''}
        <div class="dashboard-recent-card-footer">
            ${sourceBadge}
            <span class="dashboard-recent-card-date">${date}</span>
        </div>
    </div>`;
}

async function loadDashboard() {
    // Update greeting
    const greetingEl = document.getElementById('view-input-heading');
    if (greetingEl) {
        greetingEl.innerHTML = `${_getGreeting()},<br><span class="dashboard-greeting-name">User</span>`;
    }

    try {
        const res = await fetch(`${API}/api/dashboard`);
        if (!res.ok) throw new Error('Dashboard fetch failed');
        const data = await res.json();
        const stats = data.stats || {};
        const recent = data.recent || [];

        // Animate stat values
        const ctxVal = document.getElementById('stat-contexts-val');
        const chunkVal = document.getElementById('stat-chunks-val');
        const storageVal = document.getElementById('stat-storage-val');

        if (ctxVal) _animateCountUp(ctxVal, stats.contexts || 0);
        if (chunkVal) _animateCountUp(chunkVal, stats.chunks || 0);
        if (storageVal) {
            const mb = stats.size_mb || 0;
            if (mb >= 1024) {
                storageVal.textContent = (mb / 1024).toFixed(1) + ' GB';
            } else {
                storageVal.textContent = mb.toFixed(1) + ' MB';
            }
        }

        // Render recent contexts
        const gridEl = document.getElementById('dashboard-recent-grid');
        const emptyEl = document.getElementById('dashboard-recent-empty');
        if (gridEl) {
            if (recent.length > 0) {
                if (emptyEl) emptyEl.style.display = 'none';
                const cardsHtml = recent.map(ctx => _renderRecentCard(ctx)).join('');
                gridEl.innerHTML = cardsHtml;
            } else {
                gridEl.innerHTML = '';
                gridEl.appendChild(emptyEl);
                emptyEl.style.display = 'flex';
            }
        }

        _dashboardLoaded = true;
    } catch (err) {
        console.error('Dashboard load error:', err);
    }
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
        charCount.textContent = `${len.toLocaleString()} chars Â· ${tokenStr} tokens`;
        summarizeBtn.disabled = len < 20;
    });

    summarizeBtn.addEventListener('click', () => summarizeAndSave());
}

let _summarizing = false;
async function summarizeAndSave() {
    if (_summarizing) return;
    const textarea = $('#chat-textarea');
    const btn = $('#summarize-btn');
    const text = textarea.value.trim();
    if (!text) return;

    _summarizing = true;
    // Show loading
    btn.querySelector('.btn-text').style.display = 'none';
    btn.querySelector('.btn-loader').style.display = 'inline-flex';
    btn.disabled = true;

    try {
        // Step 1: Summarize via Ollama (streaming progress)
        const _setProgress = (msg, pct = null) => {
            const textEl = document.getElementById('summarize-progress-text');
            const fillEl = document.getElementById('summarize-progress-fill');
            if (textEl) textEl.textContent = ' ' + msg;
            if (fillEl && pct !== null) fillEl.style.width = pct + '%';
        };
        _setProgress('Summarizingâ€¦', 5);

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
                    }
                    if (evt.result) summary = evt.result;
                } catch (e) { if (e.message !== line) throw e; }
            }
        }

        if (!summary) throw new Error('Summarization produced no result');

        // Step 2: Create a title from the main topic
        const title = summary.main_topic || 'Untitled Context';

        // Step 3: Auto-generate tags from summary content (LLM-derived)
        const tags = generateTags(summary);

        // Step 4: Save to database
        _setProgress('Savingâ€¦', 90);
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

        // Step 5: Chunk and embed the conversation
        _setProgress('Embeddingâ€¦', 97);
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
            showToast('Context saved, but chunking failed â€” use Rebuild Embeddings later', 'error');
        }

        // Clear textarea
        textarea.value = '';
        $('#char-count').textContent = '0 characters';
        btn.disabled = true;

        showToast('Context saved and embedded!', 'success');

        // Navigate to detail view
        setTimeout(() => showDetail(created.id), 500);

    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        _summarizing = false;
        btn.querySelector('.btn-text').style.display = 'inline-flex';
        btn.querySelector('.btn-loader').style.display = 'none';
        btn.disabled = false;
        // Reset progress bar
        const fillEl = document.getElementById('summarize-progress-fill');
        if (fillEl) fillEl.style.width = '0%';
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

    // Known tech keywords â€” still useful for canonical naming
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

async function confirmDeleteCollection(id, name) {
    if (!confirm(`Delete collection "${name}"?\n\nContexts inside will not be deleted â€” they'll just become uncollected.`)) return;
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
    const summary = typeof ctx.summary === 'string' ? {} : ctx.summary;
    const q = state.searchQuery;
    const tags = (ctx.tags || []).map(t =>
        `<span class="tag">${escapeHtml(t)}</span>`
    ).join('');
    const date = new Date(ctx.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric'
    });
    const statusBadge = _buildCardStatusBadge(ctx.status);
    const starred = ctx.starred;
    const checked = state.selectedIds.has(ctx.id) ? ' checked' : '';
    const sourceBadge = _getSourceBadge(ctx.tags);
    const _cardCol = ctx.collection_id ? _getCollectionForContext(ctx.collection_id) : null;
    const colDot = _cardCol ? `<span class="card-collection-dot" style="background:${escapeHtml(_cardCol.color)}" title="${escapeHtml(_cardCol.name)}"></span>` : '';
    return `
        <div class="context-card${starred ? ' starred' : ''}" data-id="${ctx.id}" onclick="${state.selectMode ? `toggleSelectCard(${ctx.id})` : `showDetail(${ctx.id})`}">
            ${state.selectMode ? `<input type="checkbox" class="card-checkbox" ${checked} onclick="event.stopPropagation(); toggleSelectCard(${ctx.id})" />` : ''}
            ${statusBadge}
            <div class="card-header-row">
                <h3 class="card-title">${_highlightText(ctx.title, q)}</h3>
                <div style="display:flex;align-items:center;gap:6px;">
                    ${colDot}
                    ${sourceBadge}
                    ${!state.selectMode ? `<button class="card-star${starred ? ' active' : ''}" onclick="event.stopPropagation(); toggleStar(${ctx.id})" title="${starred ? 'Unpin' : 'Pin'}" aria-label="${starred ? 'Unpin context' : 'Pin context'}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="${starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                    </button>` : ''}
                </div>
            </div>
            ${(() => {
                const ideas = summary.key_ideas || [];
                const sub = ideas.length > 0 ? ideas[0] : (summary.snapshot || '');
                return sub ? `<p class="card-topic">${_highlightText(sub, q)}</p>` : '';
            })()}
            <div class="card-tags">${tags}</div>
            <div class="card-meta">
                <span>${date}</span>
                ${!state.selectMode ? `<button class="card-delete" onclick="event.stopPropagation(); deleteFromLibrary(${ctx.id})" title="Delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>` : ''}
            </div>
        </div>
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
        grid.innerHTML = Array(6).fill('<div class="skeleton-card"></div>').join('');
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
            showToast('Semantic search unavailable â€” showing keyword results', 'error');
        }

        if (append) {
            state.contexts = state.contexts.concat(contexts);
        } else {
            state.contexts = contexts;
        }

        if (state.contexts.length === 0) {
            grid.style.display = 'none';
            loadMoreContainer.style.display = 'none';
            emptyState.style.display = 'block';
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

        // Build tag filter bar
        if (!append) _renderTagFilterBar(state.contexts);

        loadMoreContainer.style.display = state.libraryHasMore && !query ? 'flex' : 'none';

        if (state.contexts.some(c => c.status === 'summarizing')) {
            startWorkerPolling();
        }

    } catch (err) {
        showToast('Failed to load contexts', 'error');
    }
}

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
        // Cards match state â€” toggle visibility in-place
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
        // Cards out of sync â€” fall back to full re-render
        const filtered = tag
            ? state.contexts.filter(c => (c.tags || []).includes(tag))
            : state.contexts;
        grid.innerHTML = _staggeredCards(filtered);
    }
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
        input.placeholder = 'Deep search across all chunksâ€¦';
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
    container.innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--text-muted)"><span class="spinner" style="display:inline-block;width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--text-primary);border-radius:50%;animation:spin 0.55s linear infinite"></span> Searching all chunksâ€¦</div>';

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
        ? ' <span style="font-size:0.75rem;opacity:0.6;font-weight:normal">(keyword match â€” run Rebuild Embeddings for semantic search)</span>'
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
            const excerpt = escapeHtml(chunk.text.length > 300 ? chunk.text.slice(0, 300) + 'â€¦' : chunk.text);
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
    // P2-10: Undo delete â€” hide card immediately, commit after 5s
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

    // Optimistic DOM update â€” no full re-render
    const wasStarred = ctx.starred;
    ctx.starred = !wasStarred;

    const card = document.querySelector(`.context-card[data-id="${id}"]`);
    const starBtn = card?.querySelector('.card-star');
    if (starBtn) {
        starBtn.classList.toggle('active', ctx.starred);
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
            starBtn.classList.toggle('active', wasStarred);
            const svg = starBtn.querySelector('svg');
            if (svg) svg.setAttribute('fill', wasStarred ? 'currentColor' : 'none');
        }
        if (card) card.classList.toggle('starred', wasStarred);
        showToast('Failed to toggle pin', 'error');
    }
}

async function toggleStarDetail(id) {
    try {
        const res = await fetch(`${API}/api/contexts/${id}/star`, { method: 'POST' });
        if (!res.ok) throw new Error();
        const updated = await res.json();
        state.currentContext = updated;
        renderDetail(updated);
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
        bar.style.display = 'flex';
        btn.classList.add('active');
    } else {
        bar.style.display = 'none';
        btn.classList.remove('active');
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
    // Update checkbox without full re-render
    const card = document.querySelector(`.context-card[data-id="${id}"]`);
    if (card) {
        const cb = card.querySelector('.card-checkbox');
        if (cb) cb.checked = state.selectedIds.has(id);
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
    if (!confirm(`Delete ${count} context${count > 1 ? 's' : ''}? This cannot be undone.`)) return;

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
        $('#bulk-actions-bar').style.display = 'none';
        $('#btn-select-mode').classList.remove('active');
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
}

// â”€â”€â”€ Context Detail â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function showDetail(id) {
    // Show detail view immediately with loading state
    navigateTo('detail');
    $('#detail-content').innerHTML = '<div style="text-align:center;padding:60px 0;color:var(--text-muted)"><span class="spinner" style="display:inline-block;width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--text-primary);border-radius:50%;animation:spin 0.55s linear infinite"></span></div>';
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

function renderDetail(ctx) {
    _chunksLoaded = false; // Reset chunk viewer for new context
    _currentSnippets = _extractFinalCodeSnippets(ctx.original_chat || '');
    const container = $('#detail-content');
    const summary = typeof ctx.summary === 'string' ? {} : ctx.summary;
    const tags = (ctx.tags || []).map(t =>
        `<span class="tag">${escapeHtml(t)}</span>`
    ).join('');
    const date = new Date(ctx.created_at).toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });
    const timeAgo = _timeAgo(ctx.created_at);

    const keyIdeas = (summary.key_ideas || []).map(i =>
        `<li>${escapeHtml(i)}</li>`
    ).join('');
    const conclusions = (summary.conclusions || []).map(c =>
        `<li>${escapeHtml(c)}</li>`
    ).join('');
    const unresolved = (summary.unresolved_questions || []).map(q =>
        `<li>${escapeHtml(q)}</li>`
    ).join('');
    const importantNotes = (ctx.important_notes || []);
    const vitals = (summary.vitals || []);
    const snapshot = summary.snapshot && summary.snapshot.toLowerCase() !== 'n/a' ? summary.snapshot : '';

    const statusInfo = _buildDetailStatusBanner(ctx.status);
    const sourceBadge = _getSourceBadge(ctx.tags);

    const starredClass = ctx.starred ? ' active' : '';
    const starFill = ctx.starred ? 'currentColor' : 'none';
    const aiModel = _detectAIModel(ctx.tags);

    container.innerHTML = `
        <div class="detail-sticky-header" id="detail-sticky-header">
            <button class="btn btn-ghost" onclick="navigateTo('library')" style="padding:6px 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <span class="detail-sticky-title">${escapeHtml(ctx.title)}</span>
        </div>

        <div class="ctx-header">
            <div class="ctx-header-top">
                <div class="ctx-header-meta">
                    <span class="ctx-date">${date} Â· ${timeAgo}</span>
                    ${sourceBadge || ''}
                </div>
                <button class="detail-star${starredClass}" onclick="toggleStarDetail(${ctx.id})" title="${ctx.starred ? 'Unpin' : 'Pin'}">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="${starFill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </button>
            </div>
            <h2 class="ctx-title">${escapeHtml(ctx.title)}</h2>
            ${statusInfo}
            <div class="ctx-tags-row">
                <div class="detail-tags">${tags || '<span class="ctx-no-tags">No tags</span>'}</div>
                <div class="ctx-collection-inline">
                    <select class="collection-select" id="detail-collection-select" onchange="handleDetailCollectionChange(${ctx.id}, this.value)">
                        <option value="">Collection: None</option>
                        ${state.collections.map(c =>
                            `<option value="${c.id}"${ctx.collection_id === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
                        ).join('')}
                    </select>
                </div>
            </div>
        </div>

        ${(summary.main_topic && summary.main_topic !== ctx.title && summary.main_topic !== 'No topic extracted') || snapshot ? `
        <div class="ctx-overview">
            ${(summary.main_topic && summary.main_topic !== ctx.title && summary.main_topic !== 'No topic extracted') ? `
            <div class="ctx-topic">${escapeHtml(summary.main_topic)}</div>` : ''}
            ${snapshot ? `<p class="ctx-snapshot">${escapeHtml(snapshot)}</p>` : ''}
        </div>` : ''}

        ${importantNotes.length ? `
        <div class="ctx-section ctx-important">
            <div class="ctx-section-label"><span class="ctx-important-dot"></span>Pinned Notes</div>
            <ul class="ctx-list ctx-list--important">
                ${importantNotes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}
            </ul>
        </div>` : ''}

        ${vitals.length ? `
        <div class="ctx-section">
            <div class="ctx-section-label">Technical Vitals</div>
            <div class="ctx-vitals">
                ${vitals.map(v => `<code class="ctx-vital-chip">${escapeHtml(v)}</code>`).join('')}
            </div>
        </div>` : ''}

        ${keyIdeas || conclusions || unresolved ? `
        <div class="ctx-insights">
            ${keyIdeas ? `
            <div class="ctx-insight-block">
                <div class="ctx-section-label">Key Ideas</div>
                <ul class="ctx-list">${keyIdeas}</ul>
            </div>` : ''}
            ${conclusions ? `
            <div class="ctx-insight-block">
                <div class="ctx-section-label">Conclusions</div>
                <ul class="ctx-list">${conclusions}</ul>
            </div>` : ''}
            ${unresolved ? `
            <div class="ctx-insight-block">
                <div class="ctx-section-label">Open Questions</div>
                <ul class="ctx-list">${unresolved}</ul>
            </div>` : ''}
        </div>` : ''}

        ${_currentSnippets.length ? `
        <div class="ctx-section">
            <div class="ctx-section-label">Code Snippets <span class="snippets-count">${_currentSnippets.length}</span></div>
            <div class="code-snippets-list">
                ${_currentSnippets.map((s, i) => `
                <div class="code-snippet-card">
                    <div class="code-snippet-header">
                        <span class="code-snippet-lang">${escapeHtml(s.label)}</span>
                        <span class="code-snippet-lines">${s.code.split('\n').filter(l => l.trim()).length} lines</span>
                        <button class="code-snippet-copy" data-idx="${i}" onclick="copyCodeSnippet(${i})">Copy</button>
                    </div>
                    <pre class="code-snippet-pre"><code>${escapeHtml(s.code.replace(/\n$/, ''))}</code></pre>
                </div>`).join('')}
            </div>
        </div>` : ''}

        <div class="ctx-collapsibles">
            <div class="original-chat-section">
                <button class="ctx-collapse-btn" onclick="toggleOriginalChat()">
                    <span id="chat-toggle-icon" class="ctx-collapse-icon">â–¶</span>
                    Original Conversation
                </button>
                <div class="original-chat-content" id="original-chat-box" style="display:none;">${_renderChatBubbles(ctx.original_chat, aiModel)}</div>
            </div>
            <div class="chunks-section">
                <button class="ctx-collapse-btn" id="chunks-toggle" onclick="toggleChunkViewer(${ctx.id})">
                    <span class="ctx-collapse-icon" id="chunks-toggle-icon">â–¶</span>
                    View Chunks
                </button>
                <div id="chunks-viewer-content" style="display:none;"></div>
            </div>
        </div>

        <div class="ctx-prompt-builder">
            <div class="ctx-prompt-header">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                <span>Continuation Prompt</span>
            </div>
            <div class="prompt-size-selector">
                <span class="prompt-size-label">Size</span>
                <div class="prompt-size-group">
                    <button class="prompt-size-btn" data-size="compact" title="~2k chars">Compact</button>
                    <button class="prompt-size-btn active" data-size="standard" title="~5k chars">Standard</button>
                    <button class="prompt-size-btn" data-size="full" title="~12k chars">Full</button>
                </div>
            </div>
            <div class="query-input-section">
                <input type="text" id="retrieval-query" class="query-input"
                       placeholder="Focus onâ€¦ (optional)" />
            </div>
            <button class="btn btn-primary generate-prompt-btn" onclick="generatePrompt(${ctx.id}, this)">
                Generate Prompt
            </button>
        </div>
    `;

    document.querySelectorAll('.prompt-size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.prompt-size-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
    $('#prompt-section').style.display = 'none';
}


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
    if (!text) return '<div class="chat-empty">No conversation data available.</div>';
    const lines = text.split('\n');
    let html = '<div class="chat-bubbles">';
    let currentRole = null;
    let buffer = [];

    function flushBuffer() {
        if (!currentRole || !buffer.length) return;
        const content = escapeHtml(buffer.join('\n').trim());
        if (!content) return;
        const isUser = currentRole === 'user';
        const avatar = isUser ? 'U' : 'AI';
        const name = isUser ? 'You' : aiModel;
        const bubbleClass = isUser ? 'chat-bubble--user' : 'chat-bubble--ai';
        html += `<div class="chat-bubble ${bubbleClass}">
            <div class="chat-bubble-avatar ${isUser ? 'chat-avatar--user' : 'chat-avatar--ai'}">${avatar}</div>
            <div class="chat-bubble-body">
                <div class="chat-bubble-name">${name}</div>
                <div class="chat-bubble-text">${content}</div>
            </div>
        </div>`;
        buffer = [];
    }

    for (const line of lines) {
        const trimmed = line.trim();
        // Detect role markers
        if (/^(User|Human|You):/i.test(trimmed)) {
            flushBuffer();
            currentRole = 'user';
            buffer.push(trimmed.replace(/^(User|Human|You):\s*/i, ''));
        } else if (/^(Assistant|AI|Agent|ChatGPT|Claude|Grok|Gemini|Copilot|DeepSeek|Llama|Mistral|Bot):/i.test(trimmed)) {
            flushBuffer();
            currentRole = 'ai';
            buffer.push(trimmed.replace(/^(Assistant|AI|Agent|ChatGPT|Claude|Grok|Gemini|Copilot|DeepSeek|Llama|Mistral|Bot):\s*/i, ''));
        } else {
            if (!currentRole) currentRole = 'user'; // default
            buffer.push(line);
        }
    }
    flushBuffer();
    html += '</div>';
    return html;
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
    const content = $('#chunks-viewer-content');
    const toggle = $('#chunks-toggle');
    const icon = $('#chunks-toggle-icon');

    if (content.style.display !== 'none') {
        content.style.display = 'none';
        toggle.classList.remove('open');
        icon.textContent = 'â–¶';
        return;
    }

    toggle.classList.add('open');
    icon.textContent = 'â–¼';
    content.style.display = 'block';

    if (!_chunksLoaded) {
        content.innerHTML = `
            <div class="chunks-query-row">
                <input type="text" class="chunks-query-input" id="chunks-query" placeholder="Enter a query to see similarity scoresâ€¦" />
                <button class="btn btn-secondary chunks-score-btn" id="chunks-score-btn" onclick="loadChunks(${contextId})">Score</button>
            </div>
            <div id="chunks-list-container"><div class="chunks-empty">Loading chunksâ€¦</div></div>
        `;
        await loadChunks(contextId);
    }
}

async function loadChunks(contextId) {
    const container = $('#chunks-list-container');
    const queryInput = $('#chunks-query');
    const query = queryInput ? queryInput.value.trim() : '';

    container.innerHTML = '<div class="chunks-empty"><span class="spinner" style="display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--text-primary);border-radius:50%;animation:spin 0.55s linear infinite"></span> Loadingâ€¦</div>';

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
        let html = `<div class="chunks-summary">${data.total} chunks${query ? ' â€” scored against: "' + escapeHtml(query) + '"' : ''}</div><div class="chunks-list">`;

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

            const text = ch.text.length > 300 ? ch.text.slice(0, 300) + 'â€¦' : ch.text;
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
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Generatingâ€¦';
    }
    try {
        const activeSize = document.querySelector('.prompt-size-btn.active');
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
        section.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
        showToast('Failed to generate prompt', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Generate Continuation Prompt';
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
    
    trapFocus($('#edit-modal').querySelector('.modal'), $('#edit-btn'));
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
function toggleExportMenu() {
    const menu = $('#export-menu');
    const btn = $('#export-btn');
    const isOpen = menu.classList.toggle('open');
    if (isOpen) {
        menu.removeAttribute('hidden');
        btn.setAttribute('aria-expanded', 'true');
    } else {
        menu.setAttribute('hidden', '');
        btn.setAttribute('aria-expanded', 'false');
    }
}

function closeExportMenu() {
    const menu = $('#export-menu');
    const btn = $('#export-btn');
    if (menu) {
        menu.classList.remove('open');
        menu.setAttribute('hidden', '');
    }
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

async function exportContext(format) {
    closeExportMenu();
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
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
}

// â”€â”€â”€ Copy to Clipboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function copyPrompt() {
    if (!state.currentPrompt) return;
    try {
        await navigator.clipboard.writeText(state.currentPrompt);
        showToast('Copied to clipboard!', 'success');
    } catch {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = state.currentPrompt;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Copied to clipboard!', 'success');
    }
}

// â”€â”€â”€ Toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showToast(message, type = 'success') {
    const stack = $('#toast-stack');
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
}

// â”€â”€â”€ P2-10: Undo Toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _showUndoToast(message, onUndo) {
    const stack = $('#toast-stack');
    const toast = document.createElement('div');
    toast.className = 'toast undo';
    toast.innerHTML = `
        <span class="toast-icon">ðŸ—‘ï¸</span>
        <span class="toast-message">${escapeHtml(message)}</span>
        <button class="toast-undo-btn">Undo</button>
        <div class="toast-countdown"></div>
    `;
    stack.appendChild(toast);

    const undoBtn = toast.querySelector('.toast-undo-btn');
    undoBtn.addEventListener('click', () => {
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

// â”€â”€â”€ Status Indicator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function updateStatusIndicator(online) {
    const dot = $('.status-dot');
    const text = $('.status-text');
    if (online) {
        dot.classList.add('online');
        text.textContent = 'LLM Ready';
    } else {
        dot.classList.remove('online');
        text.textContent = 'LLM Offline';
    }
}

// â”€â”€â”€ Rebuild Embeddings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function rebuildEmbeddings() {
    const btn = $('#btn-rebuild-embeddings');
    if (!btn) return;

    if (!confirm('This will re-chunk and re-embed all saved contexts using the current embedding model.\n\nExisting embeddings will be replaced. Continue?')) return;

    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Startingâ€¦';

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
                        btn.textContent = `Re-embeddingâ€¦ ${data.done} / ${data.total}`;
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
        showToast('Re-embed failed â€” check that your embed model is installed', 'error');
    } finally {
        btn.textContent = original;
        btn.disabled = false;
    }
}

// â”€â”€â”€ Settings Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _settingsConfig = null; // last loaded config from backend
let _settingsConfigPromise = null; // in-flight fetch (deduplicated)

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

    // Keyboard trap â€” keep focus inside while open
    trapFocus(modal.querySelector('.settings-modal'), $('#btn-settings'));

    // If already cached, render instantly â€” no loading state needed
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
    card.className = 'settings-model-card' + (item.id === selectedId ? ' selected' : '');
    card.dataset.id = item.id;

    const label = item.label || item.id;
    const desc  = item.desc  || '';
    const size  = item.size  || '';
    const rec   = item.recommended;
    const inst  = item.installed;

    const statusBadge = inst
        ? '<span class="settings-installed-badge">âœ“ Installed</span>'
        : '<span class="settings-not-installed-badge">Not downloaded</span>';

    card.innerHTML = `
        <div class="settings-model-card-left">
            <div class="settings-model-name">${escapeHtml(label)}</div>
            <div class="settings-model-desc">${escapeHtml(desc)}</div>
            <div class="settings-download-area" id="dl-area-${item.id.replace(/[:.]/g, '-')}" style="display:none;"></div>
        </div>
        <div class="settings-model-card-right">
            <span class="settings-status-badge" id="status-badge-${item.id.replace(/[:.]/g, '-')}">${statusBadge.replace(/<\/?span[^>]*>/g, '')}</span>
            ${rec ? '<span class="settings-model-badge">Recommended</span>' : ''}
            <span class="settings-model-size">${escapeHtml(size)}</span>
            <div class="settings-model-radio"></div>
        </div>`;

    // Apply correct class to status badge
    const badge = card.querySelector('.settings-status-badge');
    if (inst) {
        badge.className = 'settings-installed-badge';
        badge.textContent = 'âœ“ Installed';
    } else {
        badge.className = 'settings-not-installed-badge';
        badge.textContent = 'Not downloaded';
    }

    card.addEventListener('click', () => {
        document.querySelectorAll(`#${containerId} .settings-model-card`)
            .forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        onSelect(item.id);

        // P2-3: Auto-pull if not installed
        if (!inst && !card.classList.contains('downloading')) {
            _pullModelInline(item.id, card);
        }
    });

    return card;
}

// â”€â”€â”€ P2-3: Inline Model Download â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function _pullModelInline(modelId, card) {
    const safeId = modelId.replace(/[:.]/g, '-');
    const dlArea = card.querySelector(`#dl-area-${safeId}`);
    const badge = card.querySelector('.settings-installed-badge, .settings-not-installed-badge');

    card.classList.add('downloading');
    if (badge) {
        badge.className = 'settings-not-installed-badge';
        badge.textContent = 'Downloadingâ€¦';
    }

    if (dlArea) {
        dlArea.style.display = 'block';
        dlArea.innerHTML = `
            <div class="settings-download-bar-bg"><div class="settings-download-bar-fill" id="dl-fill-${safeId}"></div></div>
            <div class="settings-download-status" id="dl-status-${safeId}">Starting downloadâ€¦</div>
        `;
    }

    try {
        const res = await fetch(`${API}/api/setup/pull-model-stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelId }),
        });

        if (!res.ok) throw new Error('Pull request failed');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let lastStatus = '';

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
                    const fill = document.getElementById(`dl-fill-${safeId}`);
                    const statusEl = document.getElementById(`dl-status-${safeId}`);

                    if (data.error) throw new Error(data.error);

                    lastStatus = data.status || '';

                    if (data.total && data.completed) {
                        const pct = Math.round((data.completed / data.total) * 100);
                        if (fill) fill.style.width = pct + '%';
                        const mb = (data.completed / (1024 * 1024)).toFixed(0);
                        const totalMb = (data.total / (1024 * 1024)).toFixed(0);
                        if (statusEl) statusEl.textContent = `${data.status || 'Downloading'} â€” ${mb} / ${totalMb} MB (${pct}%)`;
                    } else if (statusEl) {
                        statusEl.textContent = data.status || 'Processingâ€¦';
                    }
                } catch (e) {
                    if (e.message && e.message !== line) {
                        throw e;
                    }
                }
            }
        }

        // Success
        card.classList.remove('downloading');
        if (badge) {
            badge.className = 'settings-installed-badge';
            badge.textContent = 'âœ“ Installed';
        }
        if (dlArea) dlArea.style.display = 'none';
        showToast(`Model "${modelId}" downloaded!`, 'success');

    } catch (err) {
        card.classList.remove('downloading');
        if (badge) {
            badge.className = 'settings-not-installed-badge';
            badge.textContent = 'Download failed';
        }
        const statusEl = document.getElementById(`dl-status-${safeId}`);
        if (statusEl) {
            statusEl.className = 'settings-download-error';
            statusEl.textContent = err.message || 'Download failed';
        }
    }
}

function _renderSettingsCards() {
    if (!_settingsConfig) return;

    const llmGrid   = $('#settings-llm-grid');
    const embedGrid = $('#settings-embed-grid');
    llmGrid.innerHTML = '';
    embedGrid.innerHTML = '';

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
            // Show warning if embed model has changed
            const warn = $('#settings-embed-warning');
            if (id !== originalEmbed) {
                warn.classList.add('visible');
            } else {
                warn.classList.remove('visible');
            }
        }));
    });
    embedGrid.dataset.selected = selectedEmbed;
}

async function saveSettings() {
    const llmGrid   = $('#settings-llm-grid');
    const embedGrid = $('#settings-embed-grid');
    const newModel  = llmGrid.dataset.selected;
    const newEmbed  = embedGrid.dataset.selected;

    const saveBtn = $('#settings-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Savingâ€¦';

    try {
        const [r1, r2] = await Promise.all([
            fetch(`${API}/api/setup/select-model`,       { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ model: newModel }) }),
            fetch(`${API}/api/setup/select-embed-model`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ model: newEmbed }) }),
        ]);
        if (!r1.ok || !r2.ok) throw new Error('Save failed');

        // Update sidebar hint
        _updateSettingsHint(newModel, newEmbed);

        const embedChanged = _settingsConfig && newEmbed !== _settingsConfig.embed_model;
        closeSettingsModal();

        if (embedChanged) {
            showToast('Models saved. Click "Rebuild Embeddings" to apply the new embedding model.', 'success');
        } else {
            showToast('Settings saved', 'success');
        }
    } catch {
        showToast('Failed to save settings', 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
    }
}

function _updateSettingsHint(model, embed) {
    const hint = $('#settings-current-model-hint');
    if (hint) hint.textContent = `${model} Â· ${embed}`;
}

// Fetch and show current models in the hint on app load
async function _initSettingsHint() {
    try {
        const res = await fetch(`${API}/api/setup/config`);
        const cfg = await res.json();
        _updateSettingsHint(cfg.model, cfg.embed_model);
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

// Global Escape key â€” closes whichever modal is open
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

// â”€â”€â”€ Ask Your Vault â€” RAG Chat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
state.askHistory = [];     // [{role: 'user'|'assistant', content: ''}]
state.askStreaming = false; // true while streaming response

function _initAskVault() {
    const input = $('#ask-input');
    const sendBtn = $('#ask-send-btn');
    const clearBtn = $('#ask-clear-btn');
    if (!input || !sendBtn) return;

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

    // Suggestion pills
    $$('.ask-suggestion').forEach(btn => {
        btn.addEventListener('click', () => {
            const q = btn.getAttribute('data-q');
            if (q && !state.askStreaming) {
                input.value = q;
                askVault(q);
            }
        });
    });
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
        </div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function _askRenderThinking() {
    const container = $('#ask-messages');
    const div = document.createElement('div');
    div.className = 'ask-thinking';
    div.id = 'ask-thinking-indicator';
    div.innerHTML = `
        <div class="ask-thinking-dots"><span></span><span></span><span></span></div>
        <span>Searching your vaultâ€¦</span>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
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

    // Unordered lists
    html = html.replace(/^[-â€¢*]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

    // Numbered lists
    html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

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

    return html;
}

function _askRenderAssistantMsg() {
    const container = $('#ask-messages');
    const div = document.createElement('div');
    div.className = 'ask-msg ask-msg-assistant';
    div.id = 'ask-streaming-msg';
    div.innerHTML = `
        <div class="ask-msg-avatar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="ask-msg-body">
            <div class="ask-msg-content" id="ask-streaming-content"><span class="ask-cursor"></span></div>
        </div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function _askAppendToken(token) {
    const content = $('#ask-streaming-content');
    if (!content) return;

    // Remove cursor, append token, add cursor back
    const cursor = content.querySelector('.ask-cursor');
    if (cursor) cursor.remove();

    // Store raw text in a data attribute for final markdown rendering
    const rawAttr = content.getAttribute('data-raw') || '';
    content.setAttribute('data-raw', rawAttr + token);

    // For streaming: just append as text with cursor
    content.textContent = rawAttr + token;
    const newCursor = document.createElement('span');
    newCursor.className = 'ask-cursor';
    content.appendChild(newCursor);

    // Auto-scroll
    const container = $('#ask-messages');
    container.scrollTop = container.scrollHeight;
}

function _askFinalizeMsg(sources) {
    const content = $('#ask-streaming-content');
    if (!content) return;

    // Remove cursor
    const cursor = content.querySelector('.ask-cursor');
    if (cursor) cursor.remove();

    // Convert raw text to markdown HTML
    const raw = content.getAttribute('data-raw') || content.textContent || '';
    content.innerHTML = _askSimpleMarkdown(raw);

    // Remove streaming ID
    const msg = $('#ask-streaming-msg');
    if (msg) msg.removeAttribute('id');
    if (content) content.removeAttribute('id');

    // Render source chips
    if (sources && sources.length > 0) {
        const body = content.parentElement; // .ask-msg-body
        const sourcesDiv = document.createElement('div');
        sourcesDiv.className = 'ask-sources';
        sourcesDiv.innerHTML = `
            <span class="ask-sources-label">Sources from your vault</span>
            ${sources.map(s => `
                <button class="ask-source-chip" onclick="showDetail(${s.context_id})" title="${escapeHtml(s.title)}">
                    ðŸ“„ ${escapeHtml(s.title.length > 40 ? s.title.slice(0, 37) + 'â€¦' : s.title)}
                    <span class="ask-source-score">${s.score}</span>
                </button>
            `).join('')}
        `;
        body.appendChild(sourcesDiv);
    }

    // Auto-scroll
    const container = $('#ask-messages');
    container.scrollTop = container.scrollHeight;
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
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Server error ${res.status}`);
        }

        _askRemoveThinking();
        _askRenderAssistantMsg();

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
                        fullResponse += data.token;
                        _askAppendToken(data.token);
                    }
                    if (data.error) {
                        fullResponse += `\n\nâš ï¸ Error: ${data.error}`;
                        _askAppendToken(`\n\nâš ï¸ Error: ${data.error}`);
                    }
                    if (data.done) {
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
                    fullResponse += data.token;
                    _askAppendToken(data.token);
                }
                if (data.done) {
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
}

// â”€â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.addEventListener('DOMContentLoaded', () => {
    // Setup wizard
    setupInterval = setInterval(checkSetup, 2000);
    checkSetup(); // Immediate first check
    _initSettingsHint(); // Show active models in sidebar hint
    _initSidebarTooltips(); // Sidebar hover tooltips
    _initAskVault(); // Ask Your Vault chat


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

    // Detail view buttons
    $('#back-to-library').addEventListener('click', () => navigateTo('library'));
    $('#edit-btn').addEventListener('click', openEditModal);
    $('#export-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleExportMenu(); });
    $$('.export-option').forEach(opt => {
        opt.addEventListener('click', () => exportContext(opt.dataset.format));
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#export-dropdown')) closeExportMenu();
    });
    $('#delete-btn').addEventListener('click', deleteCurrentContext);

    // Prompt buttons
    $('#copy-prompt-btn').addEventListener('click', copyPrompt);
    $('#close-prompt-btn').addEventListener('click', () => {
        $('#prompt-section').style.display = 'none';
    });

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

    // Sort control
    if ($('#sort-select')) {
        $('#sort-select').addEventListener('change', (e) => {
            state.sortOrder = e.target.value;
            loadContexts($('#search-input').value.trim());
        });
    }

    // Select mode & bulk actions
    if ($('#btn-select-mode')) $('#btn-select-mode').addEventListener('click', toggleSelectMode);
    if ($('#btn-select-all')) $('#btn-select-all').addEventListener('click', selectAllCards);
    if ($('#btn-bulk-delete')) $('#btn-bulk-delete').addEventListener('click', bulkDelete);
    if ($('#btn-cancel-select')) $('#btn-cancel-select').addEventListener('click', toggleSelectMode);

    // Deep search toggle
    if ($('#btn-deep-search')) $('#btn-deep-search').addEventListener('click', toggleDeepSearch);

    // Edit modal
    $('#cancel-edit-btn').addEventListener('click', closeEditModal);
    $('#save-edit-btn').addEventListener('click', saveEdit);

    // Close modal on overlay click
    $('#edit-modal').addEventListener('click', (e) => {
        if (e.target === $('#edit-modal')) closeEditModal();
    });

    // Theme toggle
    if ($('#btn-theme-toggle')) $('#btn-theme-toggle').addEventListener('click', toggleTheme);

    // Sidebar collapse
    if ($('#sidebar-collapse-btn')) $('#sidebar-collapse-btn').addEventListener('click', toggleSidebar);

    // Sticky detail header
    _initStickyDetailHeader();

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


    // â”€â”€ Keyboard Shortcuts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    document.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);

        // Esc â€” close modals
        if (e.key === 'Escape') {
            if ($('#shortcuts-modal').style.display !== 'none') { closeShortcutsModal(); return; }
            if ($('#edit-modal').style.display !== 'none') { closeEditModal(); return; }
            if ($('#settings-modal').style.display !== 'none') { closeSettingsModal(); return; }
            if ($('#prompt-section') && $('#prompt-section').style.display !== 'none') {
                $('#prompt-section').style.display = 'none'; return;
            }
        }

        // Shortcuts below only fire when not typing in an input
        if (inInput) return;

        // ? â€” open keyboard shortcuts cheat sheet
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

        // / â€” focus search (when in library view)
        if (e.key === '/' && state.view === 'library') {
            e.preventDefault();
            $('#search-input').focus();
        }

        // Backspace â€” go back from detail to library
        if (e.key === 'Backspace' && state.view === 'detail') {
            navigateTo('library');
        }

        // N â€” go to New Chat
        if (e.key === 'n' || e.key === 'N') {
            navigateTo('input');
        }

        // L â€” go to Library
        if (e.key === 'l' || e.key === 'L') {
            navigateTo('library');
        }
    });

    // Ctrl+Enter â€” summarize when in chat input
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
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> Restartingâ€¦`;

    // Snapshot the current server token before restarting
    let startedAt = null;
    try {
        const r = await fetch(`${API}/api/health`);
        startedAt = (await r.json()).started_at ?? null;
    } catch { /* server already offline */ }

    try {
        await fetch(`${API}/api/restart`, { method: 'POST' });
    } catch { /* server may drop before sending a response â€” fine */ }

    // Hard fallback: reload after 10 s no matter what (prevents infinite spin)
    const hardTimeout = setTimeout(() => window.location.reload(), 10000);

    // Poll every 500 ms â€” reload as soon as started_at changes (new server instance)
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
                <div class="sys-card-sub">${d.database.chunks} chunks Â· ${d.database.collections} collections Â· ${d.database.size_mb} MB</div>
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
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Backing upâ€¦`;
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
    } catch (err) {
        showToast('Failed to retry summarization', 'error');
    }
}

// Expose to global for inline onclick handlers
window.showDetail = showDetail;
window.deleteFromLibrary = deleteFromLibrary;
window.toggleOriginalChat = toggleOriginalChat;
window.generatePrompt = generatePrompt;
window.retrySummarize = retrySummarize;
window.copyCodeSnippet = copyCodeSnippet;

// â”€â”€â”€ Feature 1: Collapsible Sidebar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function toggleSidebar() {
    const app = document.getElementById('app');
    app.classList.toggle('sidebar-collapsed');
    const collapsed = app.classList.contains('sidebar-collapsed');
    localStorage.setItem('cv-sidebar-collapsed', collapsed ? '1' : '0');
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

// â”€â”€â”€ Feature 4: Sticky Detail Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _stickyObserver = null;

function _initStickyDetailHeader() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    mainContent.addEventListener('scroll', () => {
        const stickyEl = document.getElementById('detail-sticky-header');
        const titleRow = document.querySelector('.detail-title-row');
        if (!stickyEl || !titleRow) return;

        const titleRect = titleRow.getBoundingClientRect();
        const mainRect = mainContent.getBoundingClientRect();

        if (titleRect.bottom < mainRect.top + 10) {
            stickyEl.classList.add('visible');
        } else {
            stickyEl.classList.remove('visible');
        }
    });
}
