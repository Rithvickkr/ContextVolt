/**
 * ContextVolt — Frontend SPA
 *
 * Vanilla JS single-page application.
 * Handles: Setup Wizard, Chat Input, Context Library, Detail View, Prompt Builder.
 */

const API = 'http://localhost:8000';

// ─── State ───────────────────────────────────────────────────────
const state = {
    view: 'input',           // 'input' | 'library' | 'detail'
    contexts: [],
    currentContext: null,
    currentPrompt: null,
    setupComplete: false,
    ollamaReady: false,
};

// ─── DOM Refs ────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Setup Wizard ────────────────────────────────────────────────
let setupInterval = null;
let setupAttempts = 0;

async function checkSetup() {
    setupAttempts++;
    const stepBackend = $('#step-backend');
    const stepOllama = $('#step-ollama');
    const stepModel = $('#step-model');
    const skipBtn = $('#skip-setup-btn');

    function setStepState(el, state, statusText) {
        el.classList.remove('pending', 'ok', 'warn');
        el.classList.add(state);
        el.querySelector('.step-status').textContent = statusText;
    }

    try {
        const res = await fetch(`${API}/api/setup/status`);
        const data = await res.json();

        // Backend
        setStepState(stepBackend, 'ok', 'Connected');
        stepBackend.classList.add('ready');

        // Ollama
        if (data.ollama_running) {
            setStepState(stepOllama, 'ok', 'Running');
            stepOllama.classList.add('ready');
        } else {
            setStepState(stepOllama, 'pending', 'Waiting for Ollama...');
            stepOllama.classList.remove('ready');
        }

        // Model
        if (data.model_ready) {
            setStepState(stepModel, 'ok', `${data.model_name} ready`);
            stepModel.classList.add('ready');
        } else if (data.ollama_running) {
            setStepState(stepModel, 'pending', 'Downloading model...');
            fetch(`${API}/api/setup/pull-model`, { method: 'POST' }).catch(() => {});
        } else {
            setStepState(stepModel, 'pending', 'Waiting...');
        }

        // Update status indicator
        state.ollamaReady = data.ollama_running && data.model_ready;
        updateStatusIndicator(data.ollama_running && data.model_ready);

        // All ready → transition to app
        if (data.ollama_running && data.model_ready) {
            state.setupComplete = true;
            clearInterval(setupInterval);
            setTimeout(() => transitionToApp(), 800);
            return;
        }

        // Show skip button after 15 seconds
        if (setupAttempts > 7) {
            skipBtn.style.display = 'block';
        }

    } catch (err) {
        // Backend not yet reachable
        setStepState(stepBackend, 'pending', 'Connecting...');

        if (setupAttempts > 15) {
            setStepState(stepBackend, 'warn', 'Cannot reach backend');
            stepBackend.classList.add('error');
            skipBtn.style.display = 'block';
        }
    }
}

function transitionToApp() {
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

async function summarizeAndSave() {
    const textarea = $('#chat-textarea');
    const btn = $('#summarize-btn');
    const text = textarea.value.trim();
    if (!text) return;

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
async function loadContexts(query = '') {
    const grid = $('#contexts-grid');
    const emptyState = $('#empty-state');

    try {
        const url = query
            ? `${API}/api/contexts?q=${encodeURIComponent(query)}`
            : `${API}/api/contexts`;

        const res = await fetch(url);
        const contexts = await res.json();
        state.contexts = contexts;

        if (contexts.length === 0) {
            grid.style.display = 'none';
            emptyState.style.display = 'block';
            return;
        }

        grid.style.display = 'grid';
        emptyState.style.display = 'none';

        grid.innerHTML = contexts.map(ctx => {
            const summary = typeof ctx.summary === 'string' ? {} : ctx.summary;
            const tags = (ctx.tags || []).map(t =>
                `<span class="tag">${escapeHtml(t)}</span>`
            ).join('');
            const date = new Date(ctx.created_at).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric'
            });

            return `
                <div class="context-card" onclick="showDetail(${ctx.id})">
                    <h3 class="card-title">${escapeHtml(ctx.title)}</h3>
                    <p class="card-topic">${escapeHtml(summary.main_topic || '')}</p>
                    <div class="card-tags">${tags}</div>
                    <div class="card-meta">
                        <span>${date}</span>
                        <button class="card-delete" onclick="event.stopPropagation(); deleteFromLibrary(${ctx.id})" title="Delete">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

    } catch (err) {
        showToast('Failed to load contexts', 'error');
    }
}

function initSearch() {
    let debounce = null;
    const input = $('#search-input');
    input.addEventListener('input', () => {
        clearTimeout(debounce);
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
    try {
        const res = await fetch(`${API}/api/contexts/${id}`);
        if (!res.ok) throw new Error('Not found');
        const ctx = await res.json();
        state.currentContext = ctx;

        navigateTo('detail');
        renderDetail(ctx);
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

    container.innerHTML = `
        <h2 class="detail-title">${escapeHtml(ctx.title)}</h2>
        <div class="detail-meta">
            <span>${date}</span>
        </div>
        <div class="detail-tags">${tags || '<span style="color:var(--text-faint);font-size:12px;">No tags</span>'}</div>

        <div class="summary-section">
            <h3 class="section-title">Main Topic</h3>
            <div class="topic-text">${escapeHtml(summary.main_topic || 'No topic')}</div>
        </div>

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

        <button class="btn btn-primary generate-prompt-btn" onclick="generatePrompt(${ctx.id}, this)">
            Generate Continuation Prompt
        </button>
    `;

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
        const res = await fetch(`${API}/api/contexts/${id}/prompt`, { method: 'POST' });
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
}

function closeEditModal() {
    $('#edit-modal').style.display = 'none';
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
async function exportMarkdown() {
    const ctx = state.currentContext;
    if (!ctx) return;

    try {
        // Open the download endpoint directly — works in pywebview and browsers
        window.open(`${API}/api/contexts/${ctx.id}/export/download`, '_blank');
        showToast('Exported as Markdown', 'success');
    } catch (err) {
        showToast(err.message, 'error');
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
let toastTimer = null;

function showToast(message, type = 'success') {
    const toast = $('#toast');
    clearTimeout(toastTimer);

    toast.className = `toast ${type}`;
    toast.querySelector('.toast-icon').textContent = type === 'success' ? '✅' : '❌';
    toast.querySelector('.toast-message').textContent = message;
    toast.style.display = 'flex';

    toastTimer = setTimeout(() => {
        toast.style.display = 'none';
    }, 3000);
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

// ─── Backfill Embeddings ─────────────────────────────────────────
async function embedAll() {
    const btn = $('#btn-embed-all');
    const original = btn.textContent;
    btn.disabled = true;

    try {
        const res = await fetch(`${API}/api/contexts/embed-all`, { method: 'POST' });
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
            buffer = lines.pop(); // keep incomplete last line

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const data = JSON.parse(line);
                    lastData = data;
                    if (data.total > 0) {
                        btn.textContent = `Backfilling… ${data.done} / ${data.total}`;
                    } else {
                        btn.textContent = 'No contexts found';
                    }
                } catch { /* ignore malformed line */ }
            }
        }

        if (lastData) {
            const msg = lastData.total === 0
                ? 'No contexts to embed'
                : `Embedded ${lastData.updated} contexts (${lastData.skipped} already done)`;
            showToast(msg, 'success');
        }
    } catch {
        showToast('Backfill failed — is nomic-embed-text installed?', 'error');
    } finally {
        btn.textContent = original;
        btn.disabled = false;
    }
}

// ─── Utilities ───────────────────────────────────────────────────
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Init ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Setup wizard
    setupInterval = setInterval(checkSetup, 2000);
    checkSetup(); // Immediate first check

    // Skip setup button
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
    $('#export-btn').addEventListener('click', exportMarkdown);
    $('#delete-btn').addEventListener('click', deleteCurrentContext);

    // Prompt buttons
    $('#copy-prompt-btn').addEventListener('click', copyPrompt);
    $('#close-prompt-btn').addEventListener('click', () => {
        $('#prompt-section').style.display = 'none';
    });

    // Backfill embeddings
    $('#btn-embed-all').addEventListener('click', embedAll);

    // Edit modal
    $('#cancel-edit-btn').addEventListener('click', closeEditModal);
    $('#save-edit-btn').addEventListener('click', saveEdit);

    // Close modal on overlay click
    $('#edit-modal').addEventListener('click', (e) => {
        if (e.target === $('#edit-modal')) closeEditModal();
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

// Expose to global for inline onclick handlers
window.showDetail = showDetail;
window.deleteFromLibrary = deleteFromLibrary;
window.toggleOriginalChat = toggleOriginalChat;
window.generatePrompt = generatePrompt;
