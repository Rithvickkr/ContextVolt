// ContextVolt — Shared constants, app state, DOM helpers.
const API = '';  // Use same-origin so fetches go to whatever host pywebview loaded (127.0.0.1 or localhost)

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
// â”€â”€â”€ DOM Refs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// â”€â”€â”€ Utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}


export { $, $$, API, escapeHtml, state };
