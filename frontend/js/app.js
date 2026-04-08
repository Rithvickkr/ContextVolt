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
    sortOrder: 'newest',
    selectMode: false,
    selectedIds: new Set(),
    pendingDeletes: new Map(),  // id -> { timer, ctx }
    collections: [],           // [{id, name, color, count}]
    activeCollection: null,    // collection id or null (all)
    newCollectionColor: '#6366f1',
};

// ─── P2-2: Source badge constants ────────────────────────────────
const _KNOWN_SOURCES = ['ChatGPT', 'Claude', 'Gemini', 'Grok', 'DeepSeek', 'Perplexity', 'Copilot'];

function _getSourceBadge(tags) {
    if (!tags || !tags.length) return '';
    const source = tags.find(t => _KNOWN_SOURCES.includes(t));
    if (!source) return '';
    const cls = 'source-' + source.toLowerCase();
    return `<span class="source-badge ${cls}">${escapeHtml(source)}</span>`;
}

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
        loadCollections();
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
        const tokens = Math.round(len / 4);
        const tokenStr = tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${tokens}`;
        charCount.textContent = `${len.toLocaleString()} chars · ${tokenStr} tokens`;
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
        const _setProgress = (msg) => {
            const loader = btn.querySelector('.btn-loader');
            const textNode = loader.querySelector('.spinner').nextSibling;
            if (textNode) textNode.textContent = ' ' + msg;
        };
        _setProgress('Summarizing…');

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
                        const pct = evt.total > 0 ? Math.round((evt.done / evt.total) * 100) : 0;
                        _setProgress(`${evt.step} (${pct}%)`);
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
        btn.querySelector('.btn-loader').querySelector('.spinner').nextSibling.textContent = ' Saving…';
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
        btn.querySelector('.btn-loader').querySelector('.spinner').nextSibling.textContent = ' Chunking & embedding…';
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

// ─── Collections ─────────────────────────────────────────────────
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
    const totalAll = state.contexts.length;

    let html = `<button class="collection-item${allActive ? ' active' : ''}" onclick="filterByCollection(null)">
        <span class="collection-dot" style="background:var(--text-faint)"></span>
        <span class="collection-item-name">All</span>
        <span class="collection-item-count">${totalAll}</span>
    </button>`;

    for (const col of state.collections) {
        const active = state.activeCollection === col.id;
        html += `<button class="collection-item${active ? ' active' : ''}" onclick="filterByCollection(${col.id})">
            <span class="collection-dot" style="background:${escapeHtml(col.color)}"></span>
            <span class="collection-item-name">${escapeHtml(col.name)}</span>
            <span class="collection-item-count">${col.count}</span>
            <button class="collection-item-delete" onclick="event.stopPropagation(); confirmDeleteCollection(${col.id}, '${escapeHtml(col.name)}')" title="Delete collection" aria-label="Delete ${escapeHtml(col.name)}">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
        </button>`;
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

async function confirmDeleteCollection(id, name) {
    if (!confirm(`Delete collection "${name}"?\n\nContexts inside will not be deleted — they'll just become uncollected.`)) return;
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
                <h3 class="card-title">${escapeHtml(ctx.title)}</h3>
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
                return sub ? `<p class="card-topic">${escapeHtml(sub)}</p>` : '';
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
    const grid = $('#contexts-grid');
    const emptyState = $('#empty-state');
    const loadMoreContainer = $('#load-more-container');

    if (!append) {
        state.libraryPage = 1;
        state.contexts = [];
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

// ─── Star / Select / Bulk ────────────────────────────────────────
async function toggleStar(id) {
    try {
        const res = await fetch(`${API}/api/contexts/${id}/star`, { method: 'POST' });
        if (!res.ok) throw new Error();
        const updated = await res.json();
        const idx = state.contexts.findIndex(c => c.id === id);
        if (idx !== -1) state.contexts[idx] = updated;
        _rerenderGrid();
    } catch {
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

function _rerenderGrid() {
    const grid = $('#contexts-grid');
    const filtered = state.activeTagFilter
        ? state.contexts.filter(c => (c.tags || []).includes(state.activeTagFilter))
        : state.contexts;
    grid.innerHTML = filtered.map(_renderContextCard).join('');
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
    _chunksLoaded = false; // Reset chunk viewer for new context
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

    const starredClass = ctx.starred ? ' active' : '';
    const starFill = ctx.starred ? 'currentColor' : 'none';

    container.innerHTML = `
        <div class="detail-title-row">
            <h2 class="detail-title">${escapeHtml(ctx.title)}</h2>
            <button class="detail-star${starredClass}" onclick="toggleStarDetail(${ctx.id})" title="${ctx.starred ? 'Unpin' : 'Pin'}" aria-label="${ctx.starred ? 'Unpin context' : 'Pin context'}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="${starFill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </button>
        </div>
        ${statusInfo}
        <div class="detail-meta">
            <span>${date}</span>
        </div>
        <div class="detail-collection-row">
            <span class="detail-collection-label">Collection</span>
            <select class="collection-select" id="detail-collection-select" onchange="handleDetailCollectionChange(${ctx.id}, this.value)">
                <option value="">— None —</option>
                ${state.collections.map(c =>
                    `<option value="${c.id}"${ctx.collection_id === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
                ).join('')}
            </select>
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

        <div class="chunks-section">
            <button class="chunks-toggle" id="chunks-toggle" onclick="toggleChunkViewer(${ctx.id})">
                <span class="chunks-toggle-icon" id="chunks-toggle-icon">▶</span> View Chunks
            </button>
            <div id="chunks-viewer-content" style="display:none;"></div>
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

// ─── P2-4: Chunk Viewer ──────────────────────────────────────────
let _chunksLoaded = false;

async function toggleChunkViewer(contextId) {
    const content = $('#chunks-viewer-content');
    const toggle = $('#chunks-toggle');
    const icon = $('#chunks-toggle-icon');

    if (content.style.display !== 'none') {
        content.style.display = 'none';
        toggle.classList.remove('open');
        icon.textContent = '▶';
        return;
    }

    toggle.classList.add('open');
    icon.textContent = '▼';
    content.style.display = 'block';

    if (!_chunksLoaded) {
        content.innerHTML = `
            <div class="chunks-query-row">
                <input type="text" class="chunks-query-input" id="chunks-query" placeholder="Enter a query to see similarity scores…" />
                <button class="btn btn-secondary chunks-score-btn" id="chunks-score-btn" onclick="loadChunks(${contextId})">Score</button>
            </div>
            <div id="chunks-list-container"><div class="chunks-empty">Loading chunks…</div></div>
        `;
        await loadChunks(contextId);
    }
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
            if (ch.is_starred) badges.push('<span class="chunk-badge starred">★ important</span>');

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
    $('#edit-notes').value = (ctx.important_notes || []).join('\n');
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

// ─── Delete ──────────────────────────────────────────────────────
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
    _rerenderGrid();

    _showUndoToast(`"${ctx.title}" deleted`, () => {
        clearTimeout(timer);
        state.pendingDeletes.delete(ctx.id);
        // Restore to state & re-render
        state.contexts.unshift(ctx);
        _rerenderGrid();
        showToast('Delete undone', 'success');
    });
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

// ─── P2-10: Undo Toast ───────────────────────────────────────────
function _showUndoToast(message, onUndo) {
    const stack = $('#toast-stack');
    const toast = document.createElement('div');
    toast.className = 'toast undo';
    toast.innerHTML = `
        <span class="toast-icon">🗑️</span>
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
        badge.textContent = '✓ Installed';
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

// ─── P2-3: Inline Model Download ─────────────────────────────────
async function _pullModelInline(modelId, card) {
    const safeId = modelId.replace(/[:.]/g, '-');
    const dlArea = card.querySelector(`#dl-area-${safeId}`);
    const badge = card.querySelector('.settings-installed-badge, .settings-not-installed-badge');

    card.classList.add('downloading');
    if (badge) {
        badge.className = 'settings-not-installed-badge';
        badge.textContent = 'Downloading…';
    }

    if (dlArea) {
        dlArea.style.display = 'block';
        dlArea.innerHTML = `
            <div class="settings-download-bar-bg"><div class="settings-download-bar-fill" id="dl-fill-${safeId}"></div></div>
            <div class="settings-download-status" id="dl-status-${safeId}">Starting download…</div>
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
                        if (statusEl) statusEl.textContent = `${data.status || 'Downloading'} — ${mb} / ${totalMb} MB (${pct}%)`;
                    } else if (statusEl) {
                        statusEl.textContent = data.status || 'Processing…';
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
            badge.textContent = '✓ Installed';
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
    const editModal      = $('#edit-modal');
    const settingsModal  = $('#settings-modal');
    const shortcutsModal = $('#shortcuts-modal');
    if (shortcutsModal && shortcutsModal.style.display !== 'none') { closeShortcutsModal(); return; }
    if (editModal      && editModal.style.display      !== 'none') closeEditModal();
    if (settingsModal  && settingsModal.style.display   !== 'none') closeSettingsModal();
});

// ─── P2-9: Keyboard Shortcuts Modal ──────────────────────────────
function openShortcutsModal() {
    const modal = $('#shortcuts-modal');
    modal.style.display = 'flex';
    trapFocus(modal.querySelector('.shortcuts-modal'), $('#btn-shortcuts'));
}

function closeShortcutsModal() {
    const modal = $('#shortcuts-modal');
    releaseFocus(modal.querySelector('.shortcuts-modal'));
    modal.style.display = 'none';
}

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
    if ($('#btn-backup')) $('#btn-backup').addEventListener('click', downloadBackup);

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


    // ── Keyboard Shortcuts ──────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);

        // Esc — close modals
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

// ─── Detail Collection Change ────────────────────────────────────
async function handleDetailCollectionChange(contextId, value) {
    const collectionId = value === '' ? null : parseInt(value, 10);
    const updated = await setContextCollection(contextId, collectionId);
    if (updated) {
        const col = collectionId ? _getCollectionForContext(collectionId) : null;
        showToast(col ? `Moved to "${col.name}"` : 'Removed from collection', 'success');
    }
}

// ─── Backup Vault ────────────────────────────────────────────────
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
