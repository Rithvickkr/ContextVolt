/**
 * ContextVolt — Frontend SPA
 *
 * Vanilla JS single-page application.
 * Handles: Setup Wizard, Chat Input, Context Library, Detail View, Prompt Builder.
 */

const API = 'http://localhost:8000';

// ─── Theme ──────────────────────────────────────────────────────
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

// ─── State ───────────────────────────────────────────────────────
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
};

// ─── Worker Status Polling ───────────────────────────────────────
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
        return `<span class="status-badge status-failed">⚠ Failed</span>`;
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

// ─── DOM Refs ────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Setup Wizard ────────────────────────────────────────────────
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

        // LLM ready → go to app
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
    }, 500);
}

// ─── Navigation ──────────────────────────────────────────────────
function navigateTo(view) {
    state.view = view;

    // Hide all views
    $$('.view').forEach(v => v.style.display = 'none');

    // Show target view
    $(`#view-${view}`).style.display = 'block';

    // Update nav
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    const navBtn = $(`[data-view="${view === 'detail' ? 'library' : view}"]`);
    if (navBtn) navBtn.classList.add('active');

    // Load data if library
    if (view === 'library') {
        loadContexts();
    }

    // Start/stop background polling depending on view
    if (view === 'library' || view === 'detail') {
        startWorkerPolling();
    } else {
        stopWorkerPolling();
    }
}

// ─── Chat Input ──────────────────────────────────────────────────
function initChatInput() {
    const textarea = $('#chat-textarea');
    const charCount = $('#char-count');
    const summarizeBtn = $('#summarize-btn');

    textarea.addEventListener('input', () => {
        const len = textarea.value.length;
        charCount.textContent = `${len.toLocaleString()} characters`;
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
        // Step 1: Summarize via Ollama
        const summaryRes = await fetch(`${API}/api/summarize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        });

        if (!summaryRes.ok) {
            const err = await summaryRes.json();
            throw new Error(err.detail || 'Summarization failed');
        }

        const summary = await summaryRes.json();

        // Step 2: Create a title from the main topic
        const title = summary.main_topic || 'Untitled Context';

        // Step 3: Auto-generate tags from key ideas
        const tags = generateTags(summary);

        // Step 4: Save to database
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

        // Clear textarea
        textarea.value = '';
        $('#char-count').textContent = '0 characters';
        btn.disabled = true;

        showToast('Context saved successfully!', 'success');

        // Navigate to detail view
        setTimeout(() => showDetail(created.id), 500);

    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        _summarizing = false;
        btn.querySelector('.btn-text').style.display = 'inline-flex';
        btn.querySelector('.btn-loader').style.display = 'none';
        btn.disabled = false;
    }
}

function generateTags(summary) {
    // Simple auto-tagging from key ideas
    const tags = [];
    const text = [
        summary.main_topic || '',
        ...(summary.key_ideas || []),
    ].join(' ').toLowerCase();

    const tagMap = {
        'python': 'python', 'javascript': 'javascript', 'react': 'react',
        'ai': 'ai', 'machine learning': 'ml', 'deep learning': 'deep-learning',
        'api': 'api', 'database': 'database', 'css': 'css', 'html': 'html',
        'node': 'nodejs', 'docker': 'docker', 'git': 'git',
        'algorithm': 'algorithms', 'design': 'design', 'testing': 'testing',
        'security': 'security', 'performance': 'performance',
        'debug': 'debugging', 'architecture': 'architecture',
    };

    for (const [keyword, tag] of Object.entries(tagMap)) {
        if (text.includes(keyword)) tags.push(tag);
    }

    return tags.slice(0, 5); // Max 5 auto-tags
}

// ─── Context Library ─────────────────────────────────────────────
function _renderContextCard(ctx) {
    const summary = typeof ctx.summary === 'string' ? {} : ctx.summary;
    const tags = (ctx.tags || []).map(t =>
        `<span class="tag">${escapeHtml(t)}</span>`
    ).join('');
    const date = new Date(ctx.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric'
    });
    const statusBadge = _buildCardStatusBadge(ctx.status);
    return `
        <div class="context-card" onclick="showDetail(${ctx.id})">
            ${statusBadge}
            <h3 class="card-title">${escapeHtml(ctx.title)}</h3>
            ${(() => {
                const ideas = summary.key_ideas || [];
                const sub = ideas.length > 0 ? ideas[0] : (summary.snapshot || '');
                return sub ? `<p class="card-topic">${escapeHtml(sub)}</p>` : '';
            })()}
            <div class="card-tags">${tags}</div>
            <div class="card-meta">
                <span>${date}</span>
                <button class="card-delete" onclick="event.stopPropagation(); deleteFromLibrary(${ctx.id})" title="Delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
            </div>
        </div>
    `;
}

async function loadContexts(query = '', append = false) {
    const grid = $('#contexts-grid');
    const emptyState = $('#empty-state');
    const loadMoreContainer = $('#load-more-container');

    if (!append) {
        state.libraryPage = 1;
        state.contexts = [];
    }

    try {
        let url = query
            ? `${API}/api/contexts?q=${encodeURIComponent(query)}`
            : `${API}/api/contexts?page=${state.libraryPage}&per_page=50`;

        const res = await fetch(url);
        const data = await res.json();
        const contexts = data.contexts || data;
        state.libraryHasMore = !!data.has_more;

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
            grid.insertAdjacentHTML('beforeend', contexts.map(_renderContextCard).join(''));
        } else {
            grid.innerHTML = filtered.map(_renderContextCard).join('');
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

    // Re-render grid with filter
    const filtered = state.activeTagFilter
        ? state.contexts.filter(c => (c.tags || []).includes(state.activeTagFilter))
        : state.contexts;

    grid.innerHTML = filtered.map(_renderContextCard).join('');
}

function initSearch() {
    let debounce = null;
    const input = $('#search-input');
    input.addEventListener('input', () => {
        clearTimeout(debounce);
        state.activeTagFilter = null;
        debounce = setTimeout(() => loadContexts(input.value.trim()), 300);
    });
}

async function deleteFromLibrary(id) {
    if (!confirm('Delete this context?')) return;
    try {
        await fetch(`${API}/api/contexts/${id}`, { method: 'DELETE' });
        showToast('Context deleted', 'success');
        loadContexts($('#search-input').value.trim());
    } catch (err) {
        showToast('Failed to delete', 'error');
    }
}

// ─── Context Detail ──────────────────────────────────────────────
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
    const container = $('#detail-content');
    const summary = typeof ctx.summary === 'string' ? {} : ctx.summary;
    const tags = (ctx.tags || []).map(t =>
        `<span class="tag">${escapeHtml(t)}</span>`
    ).join('');
    const date = new Date(ctx.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
    });

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

    container.innerHTML = `
        <h2 class="detail-title">${escapeHtml(ctx.title)}</h2>
        ${statusInfo}
        <div class="detail-meta">
            <span>${date}</span>
        </div>
        <div class="detail-tags">${tags || '<span style="color:var(--text-faint);font-size:12px;">No tags</span>'}</div>

        ${(summary.main_topic && summary.main_topic !== ctx.title && summary.main_topic !== 'No topic extracted') ? `
        <div class="summary-section">
            <h3 class="section-title">Main Topic</h3>
            <div class="topic-text">${escapeHtml(summary.main_topic)}</div>
        </div>` : ''}

        ${importantNotes.length ? `
        <div class="summary-section important-notes-section">
            <h3 class="section-title">⭐ Marked Important</h3>
            <ul class="summary-list important-notes-list">
                ${importantNotes.map(n => `<li class="important-note-item">${escapeHtml(n)}</li>`).join('')}
            </ul>
        </div>` : ''}

        ${snapshot ? `
        <div class="summary-section">
            <h3 class="section-title">Active State</h3>
            <div class="snapshot-text">${escapeHtml(snapshot)}</div>
        </div>` : ''}

        ${vitals.length ? `
        <div class="summary-section">
            <h3 class="section-title">Technical Vitals</h3>
            <ul class="vitals-list">
                ${vitals.map(v => `<li class="vitals-item"><code>${escapeHtml(v)}</code></li>`).join('')}
            </ul>
        </div>` : ''}

        ${keyIdeas ? `
        <div class="summary-section">
            <h3 class="section-title">Key Ideas</h3>
            <ul class="summary-list">${keyIdeas}</ul>
        </div>` : ''}

        ${conclusions ? `
        <div class="summary-section">
            <h3 class="section-title">Conclusions</h3>
            <ul class="summary-list">${conclusions}</ul>
        </div>` : ''}

        ${unresolved ? `
        <div class="summary-section">
            <h3 class="section-title">Open Questions</h3>
            <ul class="summary-list">${unresolved}</ul>
        </div>` : ''}

        <div class="original-chat-section">
            <button class="original-chat-toggle" onclick="toggleOriginalChat()">
                <span id="chat-toggle-icon">▶</span> View Original Conversation
            </button>
            <div class="original-chat-content" id="original-chat-box" style="display:none;">${escapeHtml(ctx.original_chat)}</div>
        </div>

        <div class="prompt-size-selector">
            <span class="prompt-size-label">Prompt size:</span>
            <button class="prompt-size-btn" data-size="compact" title="~2k chars — last exchange only, no code">Compact</button>
            <button class="prompt-size-btn active" data-size="standard" title="~5k chars — smart-selected messages + code">Standard</button>
            <button class="prompt-size-btn" data-size="full" title="~12k chars — maximum context + all code">Full</button>
        </div>
        <div class="query-input-section">
            <label for="retrieval-query" class="query-label">Focus query (optional):</label>
            <input type="text" id="retrieval-query" class="query-input"
                   placeholder="What do you want to continue working on?" />
            <div class="query-hint">Leave empty for a general continuation prompt, or describe what you want to focus on for targeted context retrieval.</div>
        </div>
        <button class="btn btn-primary generate-prompt-btn" onclick="generatePrompt(${ctx.id}, this)">
            Generate Continuation Prompt
        </button>
    `;

    // Wire up size selector toggles
    document.querySelectorAll('.prompt-size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.prompt-size-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    // Hide prompt section
    $('#prompt-section').style.display = 'none';
}

function toggleOriginalChat() {
    const box = $('#original-chat-box');
    const icon = $('#chat-toggle-icon');
    if (box.style.display === 'none') {
        box.style.display = 'block';
        icon.textContent = '▼';
    } else {
        box.style.display = 'none';
        icon.textContent = '▶';
    }
}

async function generatePrompt(id, btn) {
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Generating…';
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

// ─── Edit Modal ──────────────────────────────────────────────────
function openEditModal() {
    const ctx = state.currentContext;
    if (!ctx) return;

    const summary = typeof ctx.summary === 'string' ? {} : ctx.summary;
    $('#edit-title').value = ctx.title || '';
    $('#edit-tags').value = (ctx.tags || []).join(', ');
    $('#edit-topic').value = summary.main_topic || '';
    $('#edit-modal').style.display = 'flex';
    
    trapFocus($('#edit-modal').querySelector('.modal'), $('#edit-btn'));
}

function closeEditModal() {
    const modal = $('#edit-modal');
    releaseFocus(modal.querySelector('.modal'));
    modal.style.display = 'none';
}

async function saveEdit() {
    const ctx = state.currentContext;
    if (!ctx) return;

    const title = $('#edit-title').value.trim();
    const tags = $('#edit-tags').value.split(',').map(t => t.trim()).filter(Boolean);
    const mainTopic = $('#edit-topic').value.trim();

    const summary = typeof ctx.summary === 'string' ? {} : { ...ctx.summary };
    if (mainTopic) summary.main_topic = mainTopic;

    try {
        const res = await fetch(`${API}/api/contexts/${ctx.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, tags, summary }),
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

// ─── Delete ──────────────────────────────────────────────────────
async function deleteCurrentContext() {
    const ctx = state.currentContext;
    if (!ctx) return;
    if (!confirm('Are you sure you want to delete this context?')) return;

    try {
        await fetch(`${API}/api/contexts/${ctx.id}`, { method: 'DELETE' });
        showToast('Context deleted', 'success');
        state.currentContext = null;
        navigateTo('library');
    } catch (err) {
        showToast('Failed to delete', 'error');
    }
}

// ─── Export ──────────────────────────────────────────────────────
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

// ─── Copy to Clipboard ──────────────────────────────────────────
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

// ─── Toast ───────────────────────────────────────────────────────
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

// ─── Status Indicator ────────────────────────────────────────────
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

// ─── Rebuild Embeddings ──────────────────────────────────────────
async function rebuildEmbeddings() {
    const btn = $('#btn-rebuild-embeddings');
    if (!btn) return;

    if (!confirm('This will re-chunk and re-embed all saved contexts using the current embedding model.\n\nExisting embeddings will be replaced. Continue?')) return;

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

// ─── Settings Modal ──────────────────────────────────────────────
let _settingsConfig = null; // last loaded config from backend

async function openSettingsModal() {
    const modal = $('#settings-modal');
    modal.style.display = 'flex';

    // Reset warning
    $('#settings-embed-warning').classList.remove('visible');

    // Keyboard trap — keep focus inside while open
    trapFocus(modal.querySelector('.settings-modal'), $('#btn-settings'));

    try {
        const res = await fetch(`${API}/api/setup/config`);
        _settingsConfig = await res.json();
        _renderSettingsCards();
    } catch {
        showToast('Could not load config', 'error');
    }
}

function closeSettingsModal() {
    const modal = $('#settings-modal');
    releaseFocus(modal.querySelector('.settings-modal'));
    modal.style.display = 'none';
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
        ? '<span class="settings-installed-badge">✓ Installed</span>'
        : '<span class="settings-not-installed-badge">Not downloaded</span>';

    card.innerHTML = `
        <div class="settings-model-card-left">
            <div class="settings-model-name">${escapeHtml(label)}</div>
            <div class="settings-model-desc">${escapeHtml(desc)}</div>
        </div>
        <div class="settings-model-card-right">
            ${statusBadge}
            ${rec ? '<span class="settings-model-badge">Recommended</span>' : ''}
            <span class="settings-model-size">${escapeHtml(size)}</span>
            <div class="settings-model-radio"></div>
        </div>`;

    card.addEventListener('click', () => {
        document.querySelectorAll(`#${containerId} .settings-model-card`)
            .forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        onSelect(item.id);
    });

    return card;
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
    saveBtn.textContent = 'Saving…';

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
    if (hint) hint.textContent = `${model} · ${embed}`;
}

// Fetch and show current models in the hint on app load
async function _initSettingsHint() {
    try {
        const res = await fetch(`${API}/api/setup/config`);
        const cfg = await res.json();
        _updateSettingsHint(cfg.model, cfg.embed_model);
    } catch { /* ignore */ }
}

// ─── Utilities ───────────────────────────────────────────────────
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Accessibility: Focus Trap ───────────────────────────────────
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
    const editModal     = $('#edit-modal');
    const settingsModal = $('#settings-modal');
    if (editModal     && editModal.style.display     !== 'none') closeEditModal();
    if (settingsModal && settingsModal.style.display !== 'none') closeSettingsModal();
});

// ─── Init ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Setup wizard
    setupInterval = setInterval(checkSetup, 2000);
    checkSetup(); // Immediate first check
    _initSettingsHint(); // Show active models in sidebar hint


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

    // Edit modal
    $('#cancel-edit-btn').addEventListener('click', closeEditModal);
    $('#save-edit-btn').addEventListener('click', saveEdit);

    // Close modal on overlay click
    $('#edit-modal').addEventListener('click', (e) => {
        if (e.target === $('#edit-modal')) closeEditModal();
    });

    // Theme toggle
    if ($('#btn-theme-toggle')) $('#btn-theme-toggle').addEventListener('click', toggleTheme);

    // Settings modal
    $('#btn-settings').addEventListener('click', openSettingsModal);
    $('#settings-modal-close').addEventListener('click', closeSettingsModal);
    $('#settings-cancel-btn').addEventListener('click', closeSettingsModal);
    $('#settings-save-btn').addEventListener('click', saveSettings);
    $('#settings-modal').addEventListener('click', (e) => {
        if (e.target === $('#settings-modal')) closeSettingsModal();
    });


    // ── Keyboard Shortcuts ──────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);

        // Esc — close modals
        if (e.key === 'Escape') {
            if ($('#edit-modal').style.display !== 'none') { closeEditModal(); return; }
            if ($('#settings-modal').style.display !== 'none') { closeSettingsModal(); return; }
            if ($('#prompt-section') && $('#prompt-section').style.display !== 'none') {
                $('#prompt-section').style.display = 'none'; return;
            }
        }

        // Shortcuts below only fire when not typing in an input
        if (inInput) return;

        // / — focus search (when in library view)
        if (e.key === '/' && state.view === 'library') {
            e.preventDefault();
            $('#search-input').focus();
        }

        // Backspace — go back from detail to library
        if (e.key === 'Backspace' && state.view === 'detail') {
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

// ─── Restart Backend ─────────────────────────────────────────────
async function restartBackend() {
    const btn = $('#btn-restart');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('restarting');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> Restarting…`;

    try {
        await fetch(`${API}/api/restart`, { method: 'POST' });
    } catch { /* expected — server drops */ }

    // Poll until backend is back
    const poll = async () => {
        try {
            const res = await fetch(`${API}/api/setup/status`);
            if (res.ok) {
                showToast('Backend restarted', 'success');
                btn.innerHTML = originalHTML;
                btn.disabled = false;
                btn.classList.remove('restarting');
                return;
            }
        } catch { /* still down */ }
        setTimeout(poll, 800);
    };
    setTimeout(poll, 1200);
}

// ─── Retry Summarization ────────────────────────────────────────
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
