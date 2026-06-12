// ContextVolt — Context library: cards, search, filters, select mode.
import { _AI_BRAND, _CAPTURE_TAGS, _getAIBrand } from './badges.js';
import { _getCollectionForContext, renderCollections } from './collections.js';
import { $, API, escapeHtml, state } from './core.js';
import { _CV_ACCENTS, _attachCardEffects, _timeAgo } from './dashboard.js';
import { openConfirmDeleteModal } from './detail.js';
import { _showUndoToast, showConfirm, showToast } from './dialogs.js';
import { startWorkerPolling } from './polling.js';
// ─── Context Library ──────────────────────────────────────────────────

// Library-local filter/view state (lives on the shared state object so
// other modules — sidebar collections, nav — can read it).
state.librarySource = null;       // _AI_BRAND key or null
state.libraryStarredOnly = false;
state.libraryTime = null;         // 'today' | 'week' | 'month' | null
state.libraryView = 'grid';       // 'grid' | 'rows'
state.libraryActiveId = null;     // selected row in master–detail mode

/** Wrap matched search terms in <span class="search-highlight"> */
function _highlightText(text, query) {
    if (!query || query.length < 2) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const queryEscaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${queryEscaped})`, 'gi');
    return escaped.replace(regex, '<span class="search-highlight">$1</span>');
}

// ─── Central filter pipe ──────────────────────────────────────────────
function _visibleContexts() {
    const now = Date.now();
    const DAY = 86400000;
    const todayStr = new Date().toDateString();
    return state.contexts.filter(c => {
        if (state.activeTagFilter && !(c.tags || []).includes(state.activeTagFilter)) return false;
        if (state.libraryStarredOnly && !c.starred) return false;
        if (state.librarySource) {
            const brand = _getAIBrand(c.tags || []);
            if (!brand || brand.key !== state.librarySource) return false;
        }
        if (state.libraryTime) {
            const t = new Date(c.created_at).getTime();
            if (state.libraryTime === 'today') {
                if (new Date(c.created_at).toDateString() !== todayStr) return false;
            } else if (state.libraryTime === 'week' && now - t > 7 * DAY) {
                return false;
            } else if (state.libraryTime === 'month' && now - t > 30 * DAY) {
                return false;
            }
        }
        return true;
    });
}

function _anyLibFilter() {
    return !!(state.activeTagFilter || state.libraryStarredOnly || state.librarySource || state.libraryTime);
}

// ─── Time-group bucketing (grid mode, newest sort only) ───────────────
function _groupLabel(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((today - dayStart) / 86400000);
    if (diffDays <= 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return 'This week';
    if (diffDays < 30) return 'This month';
    return 'Earlier';
}

function _renderContextCard(ctx, idx = 0) {
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

    // Hover quick actions — act without opening the detail page.
    const quickActions = !state.selectMode
        ? `<div class="cv-card-qa" aria-hidden="true">
             <button class="cv-card-qa-btn" onclick="event.stopPropagation(); showDetail(${ctx.id})">Open</button>
             <button class="cv-card-qa-btn" onclick="event.stopPropagation(); cvExportContext(${ctx.id})">↧ Export</button>
           </div>`
        : '';

    const colDot = col
        ? `<span class="cv-card-coldot" style="background:${escapeHtml(col.color)};color:${escapeHtml(col.color)};" title="${escapeHtml(col.name)}"></span>`
        : '';

    return `
        <article class="cv-card context-card${starred ? ' starred' : ''}${selected ? ' cv-card-selected' : ''}${ctx.status === 'summarizing' ? ' cv-card-summarizing' : ''}"
                 data-id="${ctx.id}" data-anim
                 style="--accent:${accent};--card-delay:${Math.min(idx * 40, 400)}ms"
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
            ${quickActions}
        </article>
    `;
}

// Compact list row for master–detail (rows) mode.
function _renderListRow(ctx, idx = 0) {
    const summary = typeof ctx.summary === 'string' ? {} : (ctx.summary || {});
    const q = state.searchQuery;
    const title = _highlightText(ctx.title || 'Untitled', q);
    const tags = Array.isArray(ctx.tags) ? ctx.tags : [];
    const brand = _getAIBrand(tags);
    const accent = brand ? brand.color : _CV_ACCENTS[ctx.id % _CV_ACCENTS.length];
    const desc = summary.snapshot || (summary.key_ideas || [])[0] || '';
    const active = state.libraryActiveId === ctx.id;
    const selected = state.selectedIds && state.selectedIds.has(ctx.id);

    const checkbox = state.selectMode
        ? `<input type="checkbox" class="cv-card-check cv-lrow-check" ${selected ? 'checked' : ''}
                 onclick="event.stopPropagation(); toggleSelectCard(${ctx.id})"
                 aria-label="Select context ${ctx.id}" />`
        : '';

    const onRow = state.selectMode
        ? `toggleSelectCard(${ctx.id})`
        : `cvLibSelectRow(${ctx.id})`;

    return `<button type="button" class="cv-lrow${active ? ' active' : ''}${selected ? ' cv-card-selected' : ''}"
        data-id="${ctx.id}" style="--accent:${accent};--card-delay:${Math.min(idx * 30, 300)}ms"
        onclick="${onRow}" ondblclick="showDetail(${ctx.id})">
        ${checkbox}
        <span class="cv-lrow-rail" aria-hidden="true"></span>
        <span class="cv-lrow-mid">
            <span class="cv-lrow-title">${ctx.starred ? '<svg class="cv-lrow-star" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' : ''}${title}</span>
            ${desc ? `<span class="cv-lrow-sub">${escapeHtml(desc)}</span>` : ''}
        </span>
        <span class="cv-lrow-time">${_timeAgo(ctx.created_at)}</span>
    </button>`;
}

// Preview pane (rows mode) — read a context without leaving the library.
function _renderPreview(ctx) {
    const pane = document.getElementById('cv-lib-preview');
    if (!pane) return;
    if (!ctx) {
        pane.innerHTML = `<div class="cv-pv-empty">Select a context to preview it here.</div>`;
        return;
    }
    const summary = typeof ctx.summary === 'string' ? {} : (ctx.summary || {});
    const tags = Array.isArray(ctx.tags) ? ctx.tags : [];
    const brand = _getAIBrand(tags);
    const col = ctx.collection_id ? _getCollectionForContext(ctx.collection_id) : null;
    const userTags = tags.filter(t => !_AI_BRAND[t] && !_CAPTURE_TAGS.has(t));
    const date = new Date(ctx.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const aiPill = brand
        ? `<span class="cv-card-ai" data-ai="${escapeHtml(brand.key)}" style="--ai-color:${brand.color};--ai-bg:${brand.bg};--ai-border:${brand.border};">
              <span class="cv-card-ai-dot" aria-hidden="true"></span>${escapeHtml(brand.label)}</span>`
        : `<span class="cv-card-ai cv-card-ai-generic"><span class="cv-card-ai-dot" aria-hidden="true"></span>Context</span>`;

    const sec = (label, items) => {
        if (!items || items.length === 0) return '';
        const body = items.map(i => `<li>${escapeHtml(i)}</li>`).join('');
        return `<div class="cv-pv-sec"><div class="cv-pv-seclabel">${label}</div><ul class="cv-pv-list">${body}</ul></div>`;
    };

    pane.innerHTML = `
        <div class="cv-pv-head">
            ${aiPill}
            ${ctx.starred ? '<span class="cv-pv-pin">★ pinned</span>' : ''}
            ${col ? `<span class="cv-pv-col" style="color:${escapeHtml(col.color)};">${escapeHtml(col.name)}</span>` : ''}
            <span class="cv-pv-date">${date}</span>
        </div>
        <h2 class="cv-pv-title">${escapeHtml(ctx.title || 'Untitled')}</h2>
        ${userTags.length ? `<div class="cv-pv-tags">${userTags.slice(0, 5).map(t => `<span class="cv-tag">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        <div class="cv-pv-actions">
            <button class="cv-pv-btn primary" onclick="showDetail(${ctx.id})">Open full view →</button>
            <button class="cv-pv-btn" onclick="cvExportContext(${ctx.id})">↧ Export</button>
            <button class="cv-pv-btn" onclick="toggleStar(${ctx.id})">${ctx.starred ? '★ Unpin' : '☆ Pin'}</button>
        </div>
        ${summary.snapshot ? `<div class="cv-pv-sec"><div class="cv-pv-seclabel">Snapshot</div><p class="cv-pv-snap">${escapeHtml(summary.snapshot)}</p></div>` : ''}
        ${sec('Key points', summary.key_ideas)}
        ${sec('Decided', summary.conclusions)}
        ${sec('Open questions', summary.unresolved_questions)}
    `;
}

// ─── Single render path for grid + rows modes ─────────────────────────
function _renderLibrary() {
    const grid = $('#contexts-grid');
    const body = document.getElementById('cv-lib-body');
    const pane = document.getElementById('cv-lib-preview');
    const emptyState = $('#empty-state');
    if (!grid) return;

    const list = _visibleContexts();
    const mode = state.libraryView;
    if (body) body.setAttribute('data-view', mode);
    grid.setAttribute('data-view', mode);

    if (list.length === 0) {
        grid.style.display = 'none';
        if (pane) pane.style.display = 'none';
        if (emptyState && state.contexts.length === 0) emptyState.style.display = 'flex';
        _updateLibCount(0, state.contexts.length, state.searchQuery);
        _renderActiveFilters();
        return;
    }
    grid.style.display = '';
    if (emptyState) emptyState.style.display = 'none';

    if (mode === 'rows') {
        // Master–detail: list + preview pane
        if (!list.some(c => c.id === state.libraryActiveId)) {
            state.libraryActiveId = list[0].id;
        }
        grid.innerHTML = list.map((c, i) => _renderListRow(c, i)).join('');
        if (pane) {
            pane.style.display = '';
            _renderPreview(list.find(c => c.id === state.libraryActiveId));
        }
    } else {
        if (pane) pane.style.display = 'none';
        // Time-grouped sections only make sense on newest-first; other sorts flat.
        if (state.sortOrder === 'newest' || !state.sortOrder) {
            let html = '';
            let currentGroup = null;
            let groupCards = [];
            let idx = 0;
            const flush = () => {
                if (!currentGroup) return;
                html += `<div class="cv-lib-group"><span class="cv-lib-group-label">${currentGroup}</span><span class="cv-lib-group-rule"></span><span class="cv-lib-group-count">${groupCards.length}</span></div>
                         <div class="cv-lib-groupgrid">${groupCards.join('')}</div>`;
                groupCards = [];
            };
            for (const ctx of list) {
                const g = _groupLabel(ctx.created_at);
                if (g !== currentGroup) { flush(); currentGroup = g; }
                groupCards.push(_renderContextCard(ctx, idx++));
            }
            flush();
            grid.innerHTML = html;
        } else {
            grid.innerHTML = `<div class="cv-lib-groupgrid">${list.map((c, i) => _renderContextCard(c, i)).join('')}</div>`;
        }
        if (typeof _attachCardEffects === 'function') _attachCardEffects(grid);
    }

    _updateLibCount(list.length, state.contexts.length, state.searchQuery);
    _renderActiveFilters();
}

// Row click in master–detail mode: update selection + preview only.
function cvLibSelectRow(id) {
    state.libraryActiveId = id;
    const grid = $('#contexts-grid');
    grid.querySelectorAll('.cv-lrow').forEach(r => {
        r.classList.toggle('active', parseInt(r.dataset.id, 10) === id);
    });
    _renderPreview(state.contexts.find(c => c.id === id));
}
window.cvLibSelectRow = cvLibSelectRow;

function cvExportContext(id) {
    window.open(`${API}/api/contexts/${id}/export/download`, '_blank');
}
window.cvExportContext = cvExportContext;

async function loadContexts(query = '', append = false) {
    state.searchQuery = query; // Track for highlighting
    const grid = $('#contexts-grid');
    const emptyState = $('#empty-state');
    const loadMoreContainer = $('#load-more-container');

    if (!append) {
        state.libraryPage = 1;
        state.contexts = [];
        // Show skeleton loaders while fetching
        grid.style.display = '';
        grid.style.opacity = '1';
        grid.style.transition = '';
        emptyState.style.display = 'none';
        grid.innerHTML = '<div class="cv-lib-groupgrid">' + Array(8).fill(
            '<div class="cv-skel skeleton-card">' +
              '<div class="cv-skel-line w40"></div>' +
              '<div class="cv-skel-line w80"></div>' +
              '<div class="cv-skel-line w60"></div>' +
            '</div>'
        ).join('') + '</div>';
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

        _renderLibrary();
        if (!append) _renderTagsMenu(state.contexts);

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
    if (showing === total && !query && !state.activeCollection && !_anyLibFilter()) {
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
    _syncFilterChips();
    _renderLibrary();
}
function cvClearAllFilters() {
    const input = document.getElementById('search-input');
    if (input) input.value = '';
    state.searchQuery = '';
    state.activeTagFilter = null;
    state.activeCollection = null;
    state.librarySource = null;
    state.libraryStarredOnly = false;
    state.libraryTime = null;
    _syncFilterChips();
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

// ─── Filter row: source / starred / time / tags dropdowns ─────────────
function _closeFMenus(except = null) {
    document.querySelectorAll('.cv-fmenu').forEach(m => {
        if (m !== except) m.hidden = true;
    });
    document.querySelectorAll('.cv-fchip[aria-expanded]').forEach(b => {
        if (!except || b.nextElementSibling !== except) b.setAttribute('aria-expanded', 'false');
    });
}

function _bindFDrop(btnId, menuId, build) {
    const btn = document.getElementById(btnId);
    const menu = document.getElementById(menuId);
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = menu.hidden;
        _closeFMenus(willOpen ? menu : null);
        if (willOpen) build(menu);
        menu.hidden = !willOpen;
        btn.setAttribute('aria-expanded', String(willOpen));
    });
}

function _fOption(label, selected, extra = '') {
    return `<button class="cv-fopt${selected ? ' on' : ''}" role="option" aria-selected="${selected}">${extra}${escapeHtml(label)}</button>`;
}

function _syncFilterChips() {
    const srcVal = document.getElementById('cv-f-source-value');
    const srcBtn = document.getElementById('cv-f-source-btn');
    if (srcVal) srcVal.textContent = state.librarySource || 'All sources';
    if (srcBtn) srcBtn.classList.toggle('on', !!state.librarySource);

    const starBtn = document.getElementById('cv-f-starred');
    if (starBtn) {
        starBtn.classList.toggle('on', state.libraryStarredOnly);
        starBtn.setAttribute('aria-pressed', String(state.libraryStarredOnly));
    }

    const timeLabels = { today: 'Today', week: 'Last 7 days', month: 'Last 30 days' };
    const timeVal = document.getElementById('cv-f-time-value');
    const timeBtn = document.getElementById('cv-f-time-btn');
    if (timeVal) timeVal.textContent = state.libraryTime ? timeLabels[state.libraryTime] : 'Any time';
    if (timeBtn) timeBtn.classList.toggle('on', !!state.libraryTime);

    const tagsVal = document.getElementById('cv-f-tags-value');
    const tagsBtn = document.getElementById('cv-f-tags-btn');
    if (tagsVal) tagsVal.textContent = state.activeTagFilter ? `#${state.activeTagFilter}` : '# Tags';
    if (tagsBtn) tagsBtn.classList.toggle('on', !!state.activeTagFilter);
}

function _initLibraryFilters() {
    // Source dropdown — brand-dot options from _AI_BRAND
    _bindFDrop('cv-f-source-btn', 'cv-f-source-menu', (menu) => {
        const opts = [_fOption('All sources', !state.librarySource)];
        Object.keys(_AI_BRAND).forEach(key => {
            const b = _AI_BRAND[key];
            opts.push(_fOption(b.label, state.librarySource === key,
                `<span class="cv-fopt-dot" style="background:${b.color};"></span>`));
        });
        menu.innerHTML = opts.join('');
        menu.querySelectorAll('.cv-fopt').forEach((opt, i) => {
            opt.addEventListener('click', () => {
                state.librarySource = i === 0 ? null : Object.keys(_AI_BRAND)[i - 1];
                _closeFMenus(); _syncFilterChips(); _renderLibrary();
            });
        });
    });

    // Starred toggle
    const starBtn = document.getElementById('cv-f-starred');
    if (starBtn) starBtn.addEventListener('click', () => {
        state.libraryStarredOnly = !state.libraryStarredOnly;
        _syncFilterChips(); _renderLibrary();
    });

    // Time dropdown
    _bindFDrop('cv-f-time-btn', 'cv-f-time-menu', (menu) => {
        const items = [[null, 'Any time'], ['today', 'Today'], ['week', 'Last 7 days'], ['month', 'Last 30 days']];
        menu.innerHTML = items.map(([v, l]) => _fOption(l, state.libraryTime === v)).join('');
        menu.querySelectorAll('.cv-fopt').forEach((opt, i) => {
            opt.addEventListener('click', () => {
                state.libraryTime = items[i][0];
                _closeFMenus(); _syncFilterChips(); _renderLibrary();
            });
        });
    });

    // Tags dropdown (rebuilt from loaded contexts each open)
    _bindFDrop('cv-f-tags-btn', 'cv-f-tags-menu', (menu) => _renderTagsMenu(state.contexts, menu));

    document.addEventListener('click', () => _closeFMenus());
    _syncFilterChips();
}

function _renderTagsMenu(contexts, menuEl = null) {
    const menu = menuEl || document.getElementById('cv-f-tags-menu');
    if (!menu) return;

    const tagCounts = {};
    contexts.forEach(ctx => {
        (ctx.tags || []).forEach(t => {
            if (_CAPTURE_TAGS.has(t) || _AI_BRAND[t]) return; // sources have their own filter
            tagCounts[t] = (tagCounts[t] || 0) + 1;
        });
    });
    const tags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);

    if (tags.length === 0) {
        menu.innerHTML = '<div class="cv-fopt-none">No tags yet</div>';
        return;
    }
    menu.innerHTML = [_fOption('All tags', !state.activeTagFilter)]
        .concat(tags.map(([tag, count]) =>
            `<button class="cv-fopt${state.activeTagFilter === tag ? ' on' : ''}" role="option">#${escapeHtml(tag)}<span class="cv-fopt-count">${count}</span></button>`
        )).join('');
    menu.querySelectorAll('.cv-fopt').forEach((opt, i) => {
        opt.addEventListener('click', () => {
            state.activeTagFilter = i === 0 ? null : tags[i - 1][0];
            _closeFMenus(); _syncFilterChips(); _renderLibrary();
        });
    });
}

let _deepSearchMode = false;

function initSearch() {
    let debounce = null;
    const input = $('#search-input');
    input.addEventListener('input', () => {
        clearTimeout(debounce);
        state.activeTagFilter = null;
        _syncFilterChips();
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

    _initLibraryFilters();
    _initLibraryViewSync();
    _initInfiniteScroll();
    _initRowsKeyboardNav();
    _initBulkCollection();
}

// Keep state.libraryView in sync with the Grid/Rows seg (main.js owns the
// seg's visual state + localStorage; we re-render on change).
function _initLibraryViewSync() {
    try {
        const saved = localStorage.getItem('cv-lib-view');
        if (saved === 'rows' || saved === 'grid') state.libraryView = saved;
    } catch (e) {}
    const seg = document.getElementById('cv-view-seg');
    if (!seg) return;
    seg.querySelectorAll('button[data-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.libraryView = btn.dataset.view;
            _renderLibrary();
        });
    });
}

// Infinite scroll — sentinel on the load-more container; the button stays
// as a fallback if IntersectionObserver is unavailable.
let _autoLoading = false;
function _initInfiniteScroll() {
    const sentinel = document.getElementById('load-more-container');
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(async (entries) => {
        if (!entries.some(e => e.isIntersecting)) return;
        if (_autoLoading || !state.libraryHasMore || state.searchQuery || state.view !== 'library') return;
        _autoLoading = true;
        try { await loadMoreContexts(); } finally { _autoLoading = false; }
    }, { rootMargin: '600px 0px' });
    io.observe(sentinel);
}

// ↑/↓ navigate rows, Enter opens — master–detail mode only.
function _initRowsKeyboardNav() {
    document.addEventListener('keydown', (e) => {
        if (state.view !== 'library' || state.libraryView !== 'rows' || state.selectMode) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;

        const list = _visibleContexts();
        if (list.length === 0) return;
        const idx = list.findIndex(c => c.id === state.libraryActiveId);

        if (e.key === 'Enter') {
            if (idx !== -1) { e.preventDefault(); window.showDetail(list[idx].id); }
            return;
        }
        e.preventDefault();
        const next = e.key === 'ArrowDown'
            ? Math.min(list.length - 1, idx + 1)
            : Math.max(0, idx === -1 ? 0 : idx - 1);
        cvLibSelectRow(list[next].id);
        const row = document.querySelector(`.cv-lrow[data-id="${list[next].id}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
    });
}

// Bulk "+ Collection" — assign every selected context to a collection.
function _initBulkCollection() {
    const btn = document.getElementById('btn-bulk-collection');
    const menu = document.getElementById('cv-bulk-coll-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!menu.hidden) { menu.hidden = true; return; }
        const cols = state.collections || [];
        if (cols.length === 0) {
            menu.innerHTML = '<div class="cv-fopt-none">No collections yet</div>';
        } else {
            menu.innerHTML = cols.map(c =>
                `<button class="cv-fopt" data-col="${c.id}"><span class="cv-fopt-dot" style="background:${escapeHtml(c.color)};"></span>${escapeHtml(c.name)}</button>`
            ).join('') + '<button class="cv-fopt" data-col="">Remove from collection</button>';
            menu.querySelectorAll('.cv-fopt').forEach(opt => {
                opt.addEventListener('click', () => _bulkAssignCollection(opt.dataset.col ? parseInt(opt.dataset.col, 10) : null));
            });
        }
        menu.hidden = false;
    });
    document.addEventListener('click', () => { menu.hidden = true; });
}

async function _bulkAssignCollection(collectionId) {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    try {
        await Promise.all(ids.map(id => fetch(`${API}/api/contexts/${id}/collection`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collection_id: collectionId }),
        })));
        showToast(collectionId
            ? `Moved ${ids.length} context${ids.length > 1 ? 's' : ''} to collection`
            : `Removed ${ids.length} context${ids.length > 1 ? 's' : ''} from collections`, 'success');
        toggleSelectMode();
        loadContexts($('#search-input').value.trim());
        if (typeof renderCollections === 'function') renderCollections();
    } catch {
        showToast('Failed to update collection', 'error');
    }
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
        input.placeholder = 'Search contexts, tags, or content…';
        _hideDeepResults();
        loadContexts(input.value.trim());
    }
}

function _hideDeepResults() {
    const container = $('#deep-search-results');
    if (container) { container.style.display = 'none'; container.innerHTML = ''; }
    const body = document.getElementById('cv-lib-body');
    if (body) body.style.display = '';
}

async function _runDeepSearch(query) {
    const container = $('#deep-search-results');
    const body = document.getElementById('cv-lib-body');
    const loadMore = $('#load-more-container');
    const emptyState = $('#empty-state');

    // Show loading
    if (body) body.style.display = 'none';
    loadMore.style.display = 'none';
    emptyState.style.display = 'none';
    container.style.display = 'block';
    container.innerHTML = '<div class="cv-deep-loading"><span class="spinner" style="display:inline-block;width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--text-primary);border-radius:50%;animation:spin 0.55s linear infinite"></span> Searching all chunks…</div>';

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
        container.innerHTML = `<div class="cv-deep-loading" style="color:var(--danger)">${escapeHtml(err.message)}</div>`;
    }
}

function _renderDeepResults(data, query) {
    const container = $('#deep-search-results');
    if (!data.results || data.results.length === 0) {
        const msg = data.low_confidence
            ? `<div class="cv-deep-loading">
                <div style="font-size:1.1rem;margin-bottom:8px">No strong matches found for <strong>${escapeHtml(data.query || query)}</strong></div>
                <div style="font-size:0.85rem;opacity:0.7">If this conversation was recently captured, try <strong>Rebuild Embeddings</strong> in Settings.<br>Otherwise, try a more specific query.</div>
               </div>`
            : '<div class="cv-deep-loading">No matching chunks found across your conversations.</div>';
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
            const raw = chunk.text.length > 300 ? chunk.text.slice(0, 300) + '…' : chunk.text;
            const excerpt = _highlightText(raw, query);
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
    const card = document.querySelector(`.context-card[data-id="${id}"], .cv-lrow[data-id="${id}"]`);
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

// ─── Star / Select / Bulk ──────────────────────────────────────────────
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
    // Rows mode renders stars + preview from data — refresh both
    if (state.libraryView === 'rows') _renderLibrary();

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
        if (state.libraryView === 'rows') _renderLibrary();
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
    _renderLibrary();
    _updateBulkCount();
}

function toggleSelectCard(id) {
    if (state.selectedIds.has(id)) {
        state.selectedIds.delete(id);
    } else {
        state.selectedIds.add(id);
    }
    // Update the card visual + checkbox without a full re-render
    const card = document.querySelector(`.context-card[data-id="${id}"], .cv-lrow[data-id="${id}"]`);
    if (card) {
        const cb = card.querySelector('.cv-card-check, .card-checkbox');
        if (cb) cb.checked = state.selectedIds.has(id);
        card.classList.toggle('cv-card-selected', state.selectedIds.has(id));
    }
    _updateBulkCount();
}

function selectAllCards() {
    _visibleContexts().forEach(c => state.selectedIds.add(c.id));
    _renderLibrary();
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

function _rerenderGrid(changedId) {
    const grid = $('#contexts-grid');
    // Targeted update: if a single card changed, replace just that card
    if (changedId != null && state.libraryView !== 'rows') {
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
    _renderLibrary();
}


export { _commitDelete, _rerenderGrid, bulkDelete, deleteFromLibrary, initSearch, loadContexts, loadMoreContexts, selectAllCards, toggleDeepSearch, toggleSelectCard, toggleSelectMode, toggleStar, toggleStarDetail };
