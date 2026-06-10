// ContextVolt — Context library: cards, search, filters, select mode.
import { _AI_BRAND, _CAPTURE_TAGS, _getAIBrand } from './badges.js';
import { _getCollectionForContext, renderCollections } from './collections.js';
import { $, API, escapeHtml, state } from './core.js';
import { _CV_ACCENTS, _attachCardEffects, _timeAgo } from './dashboard.js';
import { openConfirmDeleteModal } from './detail.js';
import { _showUndoToast, showConfirm, showToast } from './dialogs.js';
import { startWorkerPolling } from './polling.js';
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

    const tagHtml = userTags.slice(0, 3).map(t =>
        `<span class="cv-tag">#${_highlightText(t, q)}</span>`
    ).join('');

    // Top-left AI brand pill (replaces the old generic mark/topic combo).
    const aiPill = brand
        ? `<span class="cv-card-ai" data-ai="${escapeHtml(brand.key)}" style="--ai-color:${brand.color};--ai-bg:${brand.bg};--ai-border:${brand.border};">
              <span class="cv-card-ai-dot" aria-hidden="true"></span>${escapeHtml(brand.label)}
           </span>`
        : `<span class="cv-card-ai cv-card-ai-generic"><span class="cv-card-ai-dot" aria-hidden="true"></span>Context</span>`;

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
            </div>
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
            if (_CAPTURE_TAGS.has(t)) return; // capture method ≠ content; lives in the AI pill, not the filter bar
            tagCounts[t] = (tagCounts[t] || 0) + 1;
        });
    });

    const tags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 14);

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


export { _commitDelete, _rerenderGrid, bulkDelete, deleteFromLibrary, initSearch, loadContexts, loadMoreContexts, selectAllCards, toggleDeepSearch, toggleSelectCard, toggleSelectMode, toggleStar, toggleStarDetail };
