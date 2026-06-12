// ContextVolt — Entry point: global error handlers, init wiring, window exposure for inline handlers.
import { _askCloseHistoryPanel, _initAskVault, askVault } from './ask.js';
import { confirmDeleteCollection, filterByCollection, openCollectionCreate, startRenameCollection, toggleCollectionsDropdown } from './collections.js';
import { initChatInput, summarizeAndSave } from './composer.js';
import { $, $$, API, state } from './core.js';
import { closeConfirmDeleteModal, closeEditModal, copyCodeSnippet, deleteCurrentContext, exportContext, generatePrompt, handleDetailCollectionChange, openEditModal, resummarizeContext, retrySummarize, saveEdit, showDetail, toggleOriginalChat } from './detail.js';
import { closeShortcutsModal, openShortcutsModal, showToast } from './dialogs.js';
import { bulkDelete, deleteFromLibrary, initSearch, loadContexts, loadMoreContexts, selectAllCards, toggleDeepSearch, toggleSelectCard, toggleSelectMode, toggleStar, toggleStarDetail } from './library.js';
import { navigateTo } from './nav.js';
import { _initNotifCenter } from './notifications.js';
import { _deleteCloudKey, _initMcpServerPanelHandlers, _initSettingsHint, _initTunnelPanelHandlers, _validateCloudKey, closeSettingsModal, openSettingsModal, saveSettings } from './settings.js';
import { checkSetup, setupInterval, startSetupPolling, transitionToApp } from './setup.js';
import { _initSidebarTooltips, setTheme, toggleSidebar } from './shell.js';
import { _switchSystemTab, closeSystemModal, downloadBackup, loadSystemLogs, openSystemModal, rebuildEmbeddings, restartBackend, updateStatusIndicator } from './system.js';
import { _initUpdatePanel } from './updates.js';

// â”€â”€â”€ Global error handler — prevents silent freezes in pywebview â”€â”€
window.addEventListener('error', e => {
    console.error('Uncaught error:', e.message, e.filename, e.lineno, e.error && e.error.stack);
    try { showToast(`JS Error: ${e.message}`, 'error'); } catch (_) {}
});
window.addEventListener('unhandledrejection', e => {
    console.error('Unhandled promise rejection:', e.reason, e.reason && e.reason.stack);
    try { showToast(`Error: ${e.reason?.message || e.reason}`, 'error'); } catch (_) {}
});
// â”€â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.addEventListener('DOMContentLoaded', () => {
    // Setup wizard
    startSetupPolling();
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

    // Dashboard ask bar — Enter jumps to Ask Vault with the question submitted
    const dashAsk = $('#dash-ask-input');
    const _dashAskSubmit = () => {
        const q = dashAsk.value.trim();
        if (!q || state.askStreaming) return;
        dashAsk.value = '';
        navigateTo('ask');
        askVault(q);
    };
    if (dashAsk) {
        dashAsk.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            _dashAskSubmit();
        });
        if ($('#dash-ask-go')) $('#dash-ask-go').addEventListener('click', _dashAskSubmit);
    }

    // Dashboard event handlers
    // Quick Capture lives in the shared rail on every page now
    ['quick-capture-toggle', 'quick-capture-toggle-lib', 'quick-capture-toggle-ask'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.addEventListener('click', () => navigateTo('capture'));
    });
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

    // Status row → System / Restart popover menu (replaces the old sidebar buttons)
    const _statusBtn = $('#status-indicator');
    const _statusMenu = $('#cv-status-menu');
    if (_statusBtn && _statusMenu) {
        const onOutside = (e) => {
            if (!_statusMenu.contains(e.target) && !_statusBtn.contains(e.target)) closeStatusMenu();
        };
        const onEsc = (e) => { if (e.key === 'Escape') { closeStatusMenu(); _statusBtn.focus(); } };
        function closeStatusMenu() {
            if (_statusMenu.hidden) return;
            _statusMenu.hidden = true;
            _statusBtn.setAttribute('aria-expanded', 'false');
            document.removeEventListener('mousedown', onOutside, true);
            document.removeEventListener('keydown', onEsc, true);
        }
        function openStatusMenu() {
            _statusMenu.hidden = false;
            _statusBtn.setAttribute('aria-expanded', 'true');
            document.addEventListener('mousedown', onOutside, true);
            document.addEventListener('keydown', onEsc, true);
        }
        const toggle = () => (_statusMenu.hidden ? openStatusMenu() : closeStatusMenu());
        _statusBtn.addEventListener('click', toggle);
        _statusBtn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
        // Close after choosing an item (the item's own handler still fires).
        _statusMenu.addEventListener('click', (e) => { if (e.target.closest('.cv-util')) closeStatusMenu(); });
    }

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

    // Collections — opens the create modal (wiring lives in openCollectionCreate).
    if ($('#btn-add-collection')) {
        $('#btn-add-collection').addEventListener('click', openCollectionCreate);
    }

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
            } else if (state.view === 'input') {
                e.preventDefault();
                const input = document.getElementById('dash-ask-input');
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

    // Vibe toggle (Noir / Volt / Space) — Noir is the default
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
        const _savedVibe = localStorage.getItem('cv-vibe') || 'noir';
        document.documentElement.setAttribute('data-vibe', _savedVibe);
        _vibeBtns.forEach(x => {
            x.classList.toggle('on', x.dataset.vibe === _savedVibe);
            x.setAttribute('aria-selected', String(x.dataset.vibe === _savedVibe));
        });
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

        // N / D — go to Dashboard (the sidebar hints D; N is the legacy binding)
        if (e.key === 'n' || e.key === 'N' || e.key === 'd' || e.key === 'D') {
            navigateTo('input');
        }

        // L — go to Library
        if (e.key === 'l' || e.key === 'L') {
            navigateTo('library');
        }

        // A — go to Ask Vault
        if (e.key === 'a' || e.key === 'A') {
            navigateTo('ask');
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

// Expose to global for inline onclick handlers
window.showDetail = showDetail;
window.deleteFromLibrary = deleteFromLibrary;
window.toggleOriginalChat = toggleOriginalChat;
window.generatePrompt = generatePrompt;
window.retrySummarize = retrySummarize;
window.resummarizeContext = resummarizeContext;
window.copyCodeSnippet = copyCodeSnippet;

// These were implicit globals when the app was a single classic script; ES
// modules scope them, so anything called from generated onclick="..." HTML
// must be put back on window explicitly.
window._askCloseHistoryPanel = _askCloseHistoryPanel;
window.confirmDeleteCollection = confirmDeleteCollection;
window.toggleCollectionsDropdown = toggleCollectionsDropdown;
window.deleteCurrentContext = deleteCurrentContext;
window.exportContext = exportContext;
window.filterByCollection = filterByCollection;
window.handleDetailCollectionChange = handleDetailCollectionChange;
window.navigateTo = navigateTo;
window.openEditModal = openEditModal;
window.startRenameCollection = startRenameCollection;
window.toggleSelectCard = toggleSelectCard;
window.toggleStar = toggleStar;
window.toggleStarDetail = toggleStarDetail;
