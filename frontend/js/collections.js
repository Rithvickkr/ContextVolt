// ContextVolt — Collections sidebar, modal, CRUD.
import { _askPopulateScopeSelect } from './ask.js';
import { $, API, escapeHtml, state } from './core.js';
import { openConfirmDeleteModal } from './detail.js';
import { showToast } from './dialogs.js';
import { loadContexts } from './library.js';
import { navigateTo } from './nav.js';
// â”€â”€â”€ Collections â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadCollections() {
    try {
        const res = await fetch(`${API}/api/collections`);
        state.collections = await res.json();
        renderCollections();
        _askPopulateScopeSelect();
    } catch { /* non-fatal */ }
}

// Markup for one collection row (reused by the sidebar and the "Show all" modal).
// Pass null for the "All" row.
function _collectionItemHtml(col, forModal = false) {
    if (col === null) {
        const active = state.activeCollection === null;
        // In the "Show all" modal the All row is a plain filter, not the
        // sidebar dropdown header.
        if (forModal) {
            return `<div class="collection-item${active ? ' active' : ''}" role="button" tabindex="0" onclick="filterByCollection(null)" onkeydown="if(event.key==='Enter'||event.key===' ')filterByCollection(null)">
                <span class="collection-dot" style="background:var(--text-faint)"></span>
                <span class="collection-item-name">All</span>
                <span class="collection-item-count">${state.totalContextCount}</span>
            </div>`;
        }
        const open = _collectionsDropdownOpen();
        return `<div class="collection-item collection-all${active ? ' active' : ''}${open ? ' open' : ''}" role="button" tabindex="0" aria-expanded="${open}" onclick="toggleCollectionsDropdown()" onkeydown="if(event.key==='Enter'||event.key===' ')toggleCollectionsDropdown()">
            <span class="collection-dot" style="background:var(--text-faint)"></span>
            <span class="collection-item-name">All</span>
            <span class="collection-item-count">${state.totalContextCount}</span>
            <svg class="collection-chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        </div>`;
    }
    const active = state.activeCollection === col.id;
    const safeName = escapeHtml(col.name).replace(/'/g, '&#39;');
    return `<div class="collection-item${active ? ' active' : ''}" role="button" tabindex="0" onclick="filterByCollection(${col.id})" onkeydown="if(event.key==='Enter'||event.key===' ')filterByCollection(${col.id})" data-col-id="${col.id}">
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

const _CV_SIDEBAR_COLLECTION_LIMIT = 5;

function renderCollections() {
    const list = $('#collections-list');
    if (!list) return;

    let html = _collectionItemHtml(null);
    const cols = state.collections;
    let inner = '';
    for (const col of cols.slice(0, _CV_SIDEBAR_COLLECTION_LIMIT)) inner += _collectionItemHtml(col);
    if (cols.length > _CV_SIDEBAR_COLLECTION_LIMIT) {
        inner += `<button type="button" class="collection-showall" onclick="_openCollectionsModal()">
            <span>Show all ${cols.length}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>`;
    }
    html += `<div class="collections-dropdown${_collectionsDropdownOpen() ? '' : ' closed'}" id="collections-dropdown">
        <div class="collections-dropdown-inner">${inner}</div>
    </div>`;
    list.innerHTML = html;

    // Keep the "Show all" modal in sync if it's open.
    if (document.getElementById('cv-collections-modal-list')) {
        const q = document.getElementById('cv-coll-search-input');
        _renderCollectionsModalList(q ? q.value : '');
    }
}

// ── "Show all collections" modal (searchable) ───────────────────
function _openCollectionsModal() {
    document.getElementById('cv-collections-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'cv-collections-modal';
    overlay.innerHTML = `
        <div class="modal cv-collections-modal" role="dialog" aria-modal="true" aria-labelledby="cv-coll-list-title">
            <div class="cv-collections-modal-head">
                <h2 id="cv-coll-list-title">Collections</h2>
                <button type="button" class="cv-insight-modal-close" id="cv-coll-list-close" aria-label="Close">×</button>
            </div>
            <div class="cv-coll-search">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="text" id="cv-coll-search-input" placeholder="Search collections…" autocomplete="off" spellcheck="false">
            </div>
            <div class="cv-collections-modal-list collections-list" id="cv-collections-modal-list"></div>
        </div>`;
    document.body.appendChild(overlay);
    _renderCollectionsModalList('');
    const search = overlay.querySelector('#cv-coll-search-input');
    search.focus();
    search.addEventListener('input', () => _renderCollectionsModalList(search.value));
    const close = () => overlay.remove();
    overlay.querySelector('#cv-coll-list-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
}
window._openCollectionsModal = _openCollectionsModal;

function _renderCollectionsModalList(q) {
    const el = document.getElementById('cv-collections-modal-list');
    if (!el) return;
    const query = (q || '').trim().toLowerCase();
    const cols = query
        ? state.collections.filter(c => c.name.toLowerCase().includes(query))
        : state.collections;
    let html = query ? '' : _collectionItemHtml(null, true);
    for (const col of cols) html += _collectionItemHtml(col, true);
    if (query && !cols.length) {
        html = `<div class="cv-coll-empty">No collections match “${escapeHtml(q.trim())}”</div>`;
    }
    el.innerHTML = html;
}

// Sidebar collections fold under the "All" row. Collapsed state persists;
// an active collection filter forces the list open so it's never hidden.
let _collectionsOpen = (() => {
    try { return localStorage.getItem('cv-collections-open') === '1'; } catch (_) { return false; }
})();

function _collectionsDropdownOpen() {
    return _collectionsOpen || state.activeCollection !== null;
}

function toggleCollectionsDropdown() {
    // With a collection selected, "All" keeps its old meaning: clear the filter.
    if (state.activeCollection !== null) {
        _collectionsOpen = true;
        try { localStorage.setItem('cv-collections-open', '1'); } catch (_) {}
        filterByCollection(null);
        return;
    }
    _collectionsOpen = !_collectionsOpen;
    try { localStorage.setItem('cv-collections-open', _collectionsOpen ? '1' : '0'); } catch (_) {}
    // Toggle classes in place (re-rendering innerHTML would kill the transition).
    const dd = document.getElementById('collections-dropdown');
    if (dd) dd.classList.toggle('closed', !_collectionsOpen);
    const allRow = document.querySelector('#collections-list .collection-all');
    if (allRow) {
        allRow.classList.toggle('open', _collectionsOpen);
        allRow.setAttribute('aria-expanded', String(_collectionsOpen));
    }
}

function filterByCollection(id) {
    state.activeCollection = id;
    state.activeTagFilter = null;
    // Picking from the "Show all" modal closes it.
    document.getElementById('cv-collections-modal')?.remove();
    renderCollections();
    // Open the Library showing this collection's contexts (or refilter if already there).
    if (state.view === 'library') loadContexts('', false);
    else navigateTo('library');
}

const _CV_COLLECTION_COLORS = [
    ['#6366f1', 'Indigo'], ['#ec4899', 'Pink'], ['#f59e0b', 'Amber'], ['#10b981', 'Emerald'],
    ['#3b82f6', 'Blue'], ['#8b5cf6', 'Violet'], ['#ef4444', 'Red'], ['#06b6d4', 'Cyan'],
];

function openCollectionCreate() {
    document.getElementById('cv-collection-modal')?.remove();
    if (!state.newCollectionColor) state.newCollectionColor = '#6366f1';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'cv-collection-modal';
    overlay.innerHTML = `
        <div class="modal cv-collection-modal" role="dialog" aria-modal="true" aria-labelledby="cv-coll-modal-title">
            <h2 id="cv-coll-modal-title">New collection</h2>
            <div class="form-group">
                <label for="cv-coll-modal-input">Name</label>
                <input type="text" id="cv-coll-modal-input" class="form-input" placeholder="Collection name…" maxlength="40" autocomplete="off" spellcheck="false">
            </div>
            <div class="form-group">
                <label>Color</label>
                <div class="cv-coll-modal-colors" id="cv-coll-modal-colors">
                    ${_CV_COLLECTION_COLORS.map(([c, t]) =>
                        `<button type="button" class="color-swatch${c === state.newCollectionColor ? ' active' : ''}" data-color="${c}" style="background:${c}" title="${t}" aria-label="${t}"></button>`
                    ).join('')}
                </div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn btn-ghost" id="cv-coll-modal-cancel">Cancel</button>
                <button type="button" class="btn btn-primary" id="cv-coll-modal-create">Create</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#cv-coll-modal-input');
    input.focus();
    overlay.querySelector('#cv-coll-modal-colors').addEventListener('click', (e) => {
        const sw = e.target.closest('.color-swatch');
        if (!sw) return;
        overlay.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        sw.classList.add('active');
        state.newCollectionColor = sw.dataset.color;
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitCollectionCreate(); }
        if (e.key === 'Escape') closeCollectionCreate();
    });
    overlay.querySelector('#cv-coll-modal-cancel').addEventListener('click', closeCollectionCreate);
    overlay.querySelector('#cv-coll-modal-create').addEventListener('click', submitCollectionCreate);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeCollectionCreate(); });
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { closeCollectionCreate(); document.removeEventListener('keydown', esc); }
    });
}

function closeCollectionCreate() {
    document.getElementById('cv-collection-modal')?.remove();
    state.newCollectionColor = '#6366f1';
}

async function submitCollectionCreate() {
    const inp = document.getElementById('cv-coll-modal-input');
    const name = inp ? inp.value.trim() : '';
    if (!name) { if (inp) inp.focus(); return; }
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

    // Prefer the modal row if the "Show all" modal is open, else the sidebar row.
    const row = document.querySelector(`#cv-collections-modal-list .collection-item[data-col-id="${id}"]`)
        || document.querySelector(`.collection-item[data-col-id="${id}"]`);
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


export { _getCollectionForContext, confirmDeleteCollection, filterByCollection, loadCollections, openCollectionCreate, renderCollections, setContextCollection, startRenameCollection, toggleCollectionsDropdown };
