// ContextVolt — Ask Your Vault — RAG chat.
import { _AI_BRAND } from './badges.js';
import { $, $$, API, escapeHtml, state } from './core.js';
import { showConfirm, showPrompt, showToast } from './dialogs.js';

// â”€â”€â”€ Ask Your Vault — RAG Chat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
state.askHistory = [];     // [{role: 'user'|'assistant', content: ''}]
state.askStreaming = false; // true while streaming response
state.askSessionId = null;  // current persisted session id (null = new chat)
state.askSessions = [];     // cached list of {id, title, pinned, message_count, updated_at}
state.askSessionFilter = ''; // filter typed in the past-chats search
state.askScopeCollectionId = null; // null = whole vault; else a collection id (#10)

// Build the custom Ask scope dropdown from the loaded collections + refresh label.
function _askPopulateScopeSelect() {
    const menu = document.getElementById('ask-scope-menu');
    const label = document.getElementById('ask-scope-label');
    if (!menu) return;
    const cols = Array.isArray(state.collections) ? state.collections : [];
    // Drop the selection if that collection no longer exists.
    if (state.askScopeCollectionId != null && !cols.some(c => c.id === state.askScopeCollectionId)) {
        state.askScopeCollectionId = null;
    }
    const check = '<svg class="cv-ask-scope-opt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
    const opt = (val, name, count) => {
        const selected = (val === '') ? state.askScopeCollectionId == null : state.askScopeCollectionId === Number(val);
        return `<button type="button" class="cv-ask-scope-opt" role="option" data-val="${val}" aria-selected="${selected}">
            <span class="cv-ask-scope-opt-name">${escapeHtml(name)}</span>
            ${count != null ? `<span class="cv-ask-scope-opt-count">${count}</span>` : ''}
            ${check}
        </button>`;
    };
    let html = opt('', 'All contexts', null);
    for (const c of cols) html += opt(String(c.id), c.name, c.count ?? 0);
    menu.innerHTML = html;
    if (label) {
        const cur = state.askScopeCollectionId != null ? cols.find(c => c.id === state.askScopeCollectionId) : null;
        label.textContent = cur ? cur.name : 'All contexts';
    }
}

// Custom scope dropdown: open/close (position:fixed so the pill can't clip it),
// click-outside / Escape to dismiss, selection drives state.askScopeCollectionId.
function _initAskScopeDropdown() {
    const dd = document.getElementById('ask-scope-dd');
    const btn = document.getElementById('ask-scope-btn');
    const menu = document.getElementById('ask-scope-menu');
    if (!dd || !btn || !menu || dd._cvBound) return;
    dd._cvBound = true;

    const onOutside = (e) => { if (!dd.contains(e.target) && !menu.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { close(); btn.focus(); } };
    function close() {
        if (menu.hidden) return;
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', close);
    }
    function open() {
        _askPopulateScopeSelect();
        // Portal to <body>: the composer pill has backdrop-filter, which makes
        // position:fixed children clip to the pill's overflow. In <body> the
        // menu is truly viewport-positioned and unclipped.
        if (menu.parentElement !== document.body) document.body.appendChild(menu);
        menu.hidden = false;
        menu.style.visibility = 'hidden';
        const r = btn.getBoundingClientRect();
        const mh = menu.offsetHeight, mw = menu.offsetWidth;
        let top = r.top - mh - 8;                 // prefer above (composer sits low)
        if (top < 12) top = r.bottom + 8;         // flip below if no room
        let left = r.right - mw;                  // right-align to the trigger
        if (left < 12) left = 12;
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
        menu.style.visibility = '';
        btn.setAttribute('aria-expanded', 'true');
        document.addEventListener('mousedown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', close);
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        btn.getAttribute('aria-expanded') === 'true' ? close() : open();
    });
    menu.addEventListener('click', (e) => {
        const opt = e.target.closest('.cv-ask-scope-opt');
        if (!opt) return;
        const v = opt.getAttribute('data-val');
        state.askScopeCollectionId = v ? Number(v) : null;
        _askPopulateScopeSelect();
        close();
    });
}

function _initAskVault() {
    const input = $('#ask-input');
    const sendBtn = $('#ask-send-btn');
    const clearBtn = $('#ask-clear-btn');
    if (!input || !sendBtn) return;

    // Search-scope selector (#10): null = whole vault, else restrict to a collection.
    _initAskScopeDropdown();
    _askPopulateScopeSelect();

    // Auto-grow the multiline composer (Enter sends, Shift+Enter inserts a newline).
    const _askAutoGrow = () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    };

    // Welcome layout: keep the composer inline (in the hero flow) while the
    // empty state is showing, and pin it to the bottom of the shell once a chat
    // is active. The empty state toggles via #ask-empty's display, so we watch
    // that and relocate the single composer element accordingly.
    (function _askComposerPlacement() {
        const bar = document.getElementById('ask-input-bar');
        const empty = document.getElementById('ask-empty');
        if (!bar || !empty) return;
        const shell = bar.closest('.cv-ask-shell');
        const scroll = shell ? shell.querySelector('.cv-ask-scroll') : null;
        const place = () => {
            const slot = document.getElementById('ask-composer-slot');
            const isEmpty = empty.style.display !== 'none';
            if (isEmpty && slot) {
                if (bar.parentElement !== slot) slot.appendChild(bar);
                bar.classList.add('cv-ask-composer-inline');
            } else if (shell) {
                if (bar.parentElement !== shell) shell.appendChild(bar);
                bar.classList.remove('cv-ask-composer-inline');
            }
            // The sticky composer reserves 140px at the bottom of the scroll;
            // in the welcome state the composer is inline, so drop that reserve.
            if (scroll) scroll.classList.toggle('cv-ask-scroll-welcome', isEmpty);
        };
        if (!window._askComposerObs) {
            window._askComposerObs = new MutationObserver(place);
            window._askComposerObs.observe(empty, { attributes: true, attributeFilter: ['style'] });
        }
        place();
    })();

    // Composer hint: surface how many contexts are indexed.
    const idxEl = document.getElementById('cv-ask-indexed');
    if (idxEl) {
        const cntEl = document.getElementById('stat-contexts-val');
        const n = cntEl ? parseInt(cntEl.textContent.trim(), 10) : NaN;
        idxEl.textContent = (Number.isFinite(n) && n > 0)
            ? `${n} contexts indexed · Grounded in your vault`
            : 'Grounded in your vault';
    }

    // Enable/disable send
    input.addEventListener('input', () => {
        sendBtn.disabled = !input.value.trim() || state.askStreaming;
        _askAutoGrow();
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
            input.focus(); // keep the cursor in the box for quick follow-ups
        }
    });

    // "/" focuses the composer from anywhere in the Ask view (like Slack/Linear).
    if (!window._askSlashBound) {
        window._askSlashBound = true;
        document.addEventListener('keydown', (e) => {
            if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
            if (state.view !== 'ask') return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            const ai = document.getElementById('ask-input');
            if (ai) { e.preventDefault(); ai.focus(); }
        });
    }

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
                if (e.target.closest('#cv-ask-switcher-new')) {
                    if (!state.askStreaming) { _askResetChat(); _askCloseHistoryPanel(); }
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

    // Switcher keyboard nav: ↑/↓ move a highlight over the rows, ↵ opens.
    // Bound on the panel so it works from the search field and from rows.
    if (histPanel) {
        histPanel.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
            const rows = Array.from(histPanel.querySelectorAll('.cv-ask-history-item'));
            if (rows.length === 0) return;
            const cur = rows.findIndex(r => r.classList.contains('kb-on'));
            if (e.key === 'Enter') {
                if (cur !== -1) {
                    e.preventDefault();
                    const sid = parseInt(rows[cur].getAttribute('data-session-id'), 10);
                    if (!Number.isNaN(sid)) _askLoadSession(sid);
                }
                return;
            }
            e.preventDefault();
            const next = e.key === 'ArrowDown'
                ? Math.min(rows.length - 1, cur + 1)
                : Math.max(0, cur === -1 ? 0 : cur - 1);
            rows.forEach((r, i) => r.classList.toggle('kb-on', i === next));
            rows[next].scrollIntoView({ block: 'nearest' });
        });
    }

    // Ctrl/Cmd+H — summon the session switcher from anywhere on the Ask page.
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H') && state.view === 'ask') {
            e.preventDefault();
            const panel = $('#cv-ask-history-panel');
            if (panel && panel.hasAttribute('hidden')) _askOpenHistoryPanel();
            else _askCloseHistoryPanel();
        }
    });
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
    if (input) { input.value = ''; input.style.height = ''; }
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
            ? `No matches for “${escapeHtml(filter)}”`
            : 'No past chats yet — ask something to start one.';
        list.innerHTML = `<div class="cv-sw-empty">${msg}</div>`;
        return;
    }

    // Two groups only: Pinned + Recent. Each row carries its own date stamp,
    // so finer date buckets are noise.
    const now = new Date();
    const pinned = sessions.filter(s => s.pinned);
    const recent = sessions.filter(s => !s.pinned);

    const fmt = (iso) => {
        try {
            const d = new Date(iso);
            const sameDay = d.toDateString() === now.toDateString();
            return sameDay
                ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        } catch (_) { return ''; }
    };

    // Single-line row: [active dot] title ……… date | hover: pin/rename/delete
    const renderItem = (s) => {
        const active = state.askSessionId === s.id ? ' is-active' : '';
        return `
            <div class="cv-ask-history-item${active}" data-session-id="${s.id}" tabindex="0" role="button" aria-label="${escapeHtml(s.title || 'Untitled')}">
                <span class="cv-sw-dot" aria-hidden="true"></span>
                <span class="cv-sw-title">${escapeHtml(s.title || 'Untitled')}</span>
                <span class="cv-sw-meta">${fmt(s.updated_at)}</span>
                <span class="cv-sw-acts">
                    <button data-act="pin" class="${s.pinned ? 'is-pinned' : ''}" title="${s.pinned ? 'Unpin' : 'Pin'}" aria-label="${s.pinned ? 'Unpin chat' : 'Pin chat'}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="${s.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V6h6v4.76a2 2 0 0 0 .59 1.41l1.59 1.59a1 1 0 0 1-.71 1.71H7.53a1 1 0 0 1-.71-1.71l1.59-1.59A2 2 0 0 0 9 10.76z"/></svg>
                    </button>
                    <button data-act="rename" title="Rename" aria-label="Rename chat">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                    </button>
                    <button data-act="delete" title="Delete" aria-label="Delete chat">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                    </button>
                </span>
            </div>
        `;
    };

    const renderGroup = (label, items) => items.length
        ? `<div class="cv-ask-history-group">${label}</div>${items.map(renderItem).join('')}`
        : '';

    list.innerHTML =
        renderGroup('Pinned', pinned) +
        renderGroup('Recent', recent);

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
        body.appendChild(_askBuildSourcesRow(deduped));
    }
    // Meta strip leads the answer; model label fills in when resolved.
    const histBody = div.querySelector('.ask-msg-body');
    const histStrip = _askBuildMetaStrip('');
    histBody.insertBefore(histStrip, histBody.querySelector('.ask-msg-content'));
    _askGetModelLabel().then(label => {
        const m = histStrip.querySelector('.ask-meta-model');
        if (m && label) m.textContent = `· ${label}`;
    });
    _askAppendAnswerFooter(div, safeText);
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

// Inner markup of a user bubble — extracted so cancel-edit can rebuild it.
function _askUserMsgBodyHtml(text) {
    return `
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
        </div>`;
}

function _askRenderUserMsg(text) {
    const container = $('#ask-messages');
    const empty = $('#ask-empty');
    if (empty) empty.style.display = 'none';

    const div = document.createElement('div');
    div.className = 'ask-msg ask-msg-user';
    div.innerHTML = `
        <div class="ask-msg-avatar">U</div>
        <div class="ask-msg-body">${_askUserMsgBodyHtml(text)}</div>
    `;
    container.appendChild(div);
    _askScrollToBottom();
}

// Shared helper: truncate history + remove DOM messages from a user bubble onward.
// Returns the question text, or null if already streaming.
function _askTruncateFromMsg(btn, keepChatView = false) {
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

    // Show empty/welcome state if no messages remain — unless the caller wants
    // to stay in the chat view (e.g. editing, where we load the text into the
    // composer rather than bouncing the user back to the welcome screen).
    const remaining = container.querySelectorAll('.ask-msg');
    const empty = $('#ask-empty');
    if (!keepChatView && remaining.length === 0 && empty) empty.style.display = '';

    return text;
}

// Inline editing — the bubble turns into an editable box (Claude/ChatGPT style).
window._askEditMsg = function(btn) {
    if (state.askStreaming) return;
    const msgEl = btn.closest('.ask-msg-user');
    if (!msgEl) return;
    const body = msgEl.querySelector('.ask-msg-body');
    const contentEl = msgEl.querySelector('.ask-msg-content');
    if (!body || !contentEl) return; // already editing (no content node)

    const original = contentEl.textContent;
    msgEl.classList.add('editing');
    body.innerHTML = `
        <div class="ask-msg-edit">
            <textarea class="ask-msg-edit-input" spellcheck="false" rows="1"></textarea>
            <div class="ask-msg-edit-actions">
                <button type="button" class="ask-msg-edit-btn ask-msg-edit-cancel" onclick="window._askCancelEdit(this)">Cancel</button>
                <button type="button" class="ask-msg-edit-btn ask-msg-edit-save" onclick="window._askSaveEdit(this)">Save &amp; submit</button>
            </div>
        </div>`;
    const ta = body.querySelector('.ask-msg-edit-input');
    ta.value = original;
    ta._cvOriginal = original;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px'; };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window._askSaveEdit(ta); }
        else if (e.key === 'Escape') { e.preventDefault(); window._askCancelEdit(ta); }
    });
    grow();
    ta.focus();
    try { ta.setSelectionRange(original.length, original.length); } catch (e) {}
    msgEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};

// Restore the bubble to its original (non-editing) display.
window._askCancelEdit = function(el) {
    const msgEl = el.closest('.ask-msg-user');
    if (!msgEl) return;
    const body = msgEl.querySelector('.ask-msg-body');
    const ta = msgEl.querySelector('.ask-msg-edit-input');
    const original = ta ? (ta._cvOriginal || '') : '';
    msgEl.classList.remove('editing');
    if (body) body.innerHTML = _askUserMsgBodyHtml(original);
};

// Save the edit: truncate this turn onward, then resend the edited text.
window._askSaveEdit = function(el) {
    if (state.askStreaming) return;
    const msgEl = el.closest('.ask-msg-user');
    if (!msgEl) return;
    const ta = msgEl.querySelector('.ask-msg-edit-input');
    if (!ta) return;
    const newText = ta.value.trim();
    const original = (ta._cvOriginal || '').trim();
    if (!newText) return;                                  // empty → ignore
    if (newText === original) { window._askCancelEdit(el); return; } // unchanged → just close
    // Truncate this user turn + everything after (el sits inside .ask-msg-user),
    // then send the edited text so a fresh answer streams in.
    _askTruncateFromMsg(el, true);
    askVault(newText);
};

window._askRetryMsg = function(btn) {
    const text = _askTruncateFromMsg(btn);
    if (text === null || !text) return;
    askVault(text);
};

function _askRenderThinking() {
    // Same shape as a real reply — identity row + typing dots — so the answer
    // appears to materialize in place instead of swapping a big banner out.
    const container = $('#ask-messages');
    const div = document.createElement('div');
    div.className = 'ask-thinking ask-msg ask-msg-assistant';
    div.id = 'ask-thinking-indicator';
    const body = document.createElement('div');
    body.className = 'ask-msg-body';
    const strip = _askBuildMetaStrip('▍ searching your vault…');
    strip.querySelector('.ask-meta-model').classList.add('streaming');
    body.appendChild(strip);
    const dots = document.createElement('div');
    dots.className = 'ask-typing';
    dots.innerHTML = '<i></i><i></i><i></i>';
    body.appendChild(dots);
    div.appendChild(body);
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
        <div class="ask-msg-body">
            <div class="ask-msg-content" id="ask-streaming-content"><span class="ask-cursor"></span></div>
        </div>
    `;
    const streamBody = div.querySelector('.ask-msg-body');
    const streamStrip = _askBuildMetaStrip('▍ streaming');
    streamStrip.querySelector('.ask-meta-model').classList.add('streaming');
    streamBody.insertBefore(streamStrip, streamBody.firstChild);
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
        // Jump to (and flash) the matching source card below the answer;
        // the card itself opens the context detail.
        return `<sup class="ask-cite"><a href="#" title="${title}" ` +
               `onclick="window._askCiteJump(this, ${Number(numStr)});return false;">[${Number(numStr)}]</a></sup>`;
    });
}

// Inline [n] click → scroll to the answer's sources row and flash card n.
window._askCiteJump = function(link, n) {
    const msg = link.closest('.ask-msg');
    if (!msg) return;
    const card = msg.querySelector(`.ask-source-chip[data-n="${n}"]`) ||
                 msg.querySelector('.ask-sources');
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash');
    requestAnimationFrame(() => card.classList.add('flash'));
    card.addEventListener('animationend', () => card.classList.remove('flash'), { once: true });
};

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
        body.appendChild(_askBuildSourcesRow(deduped));
    }
    const finalizedMsg = content.closest('.ask-msg');
    if (finalizedMsg) {
        // Streaming state → model attribution in the meta strip.
        const stripModel = finalizedMsg.querySelector('.ask-meta-model');
        if (stripModel) {
            stripModel.classList.remove('streaming');
            _askGetModelLabel().then(label => { if (label) stripModel.textContent = `· ${label}`; });
        }
        _askAppendAnswerFooter(finalizedMsg, raw);
    }

    _askScrollToBottom();
}

// ─── Shared answer-block pieces (sources row + footer) ────────────────

// Build the sources section: label + horizontal card row, placed AFTER the
// answer. Each card carries the backend's citation number (s.n) so it lines
// up with the inline [n] superscripts.
function _askBuildSourcesRow(deduped) {
    const sourcesDiv = document.createElement('div');
    sourcesDiv.className = 'ask-sources';
    const cardsHtml = deduped.map(s => {
        const brand = s.source ? _AI_BRAND[s.source] : null;
        const color = brand ? brand.color : 'var(--cv-volt)';
        const title = String(s.title || 'Untitled');
        const snippet = s.snippet ? String(s.snippet) : '';
        const tooltipParts = [title];
        if (brand) tooltipParts.push(brand.label);
        if (snippet) tooltipParts.push(snippet);
        const tooltip = tooltipParts.join(' · ');
        const n = s.n != null ? Number(s.n) : null;
        const num = n != null ? `<span class="ask-source-n">${n}</span>` : '';
        const cidAttr = s.context_id != null ? Number(s.context_id) : '';
        const short = title.length > 46 ? title.slice(0, 44) + '…' : title;
        return `<button class="ask-source-chip" style="--src-color:${color}"${n != null ? ` data-n="${n}"` : ''}
                        onclick="showDetail(${cidAttr})"
                        title="${escapeHtml(tooltip)}">
                    ${num}
                    <span class="ask-source-dot" aria-hidden="true"></span>
                    <span class="ask-source-title">${escapeHtml(short)}</span>
                </button>`;
    }).join('');
    sourcesDiv.innerHTML = `<span class="ask-sources-label">Sources · ${deduped.length}</span><div class="ask-sources-row">${cardsHtml}</div>`;
    return sourcesDiv;
}

// Identity row above each reply: bolt mark + "Vault" + state/model.
// Doubles as the status line: "▍ streaming" → "· model-name" on finalize.
function _askBuildMetaStrip(stateText) {
    const strip = document.createElement('div');
    strip.className = 'ask-ident';
    strip.innerHTML = `
        <span class="ask-ident-bolt" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></svg>
        </span>
        <span class="ask-ident-name">Vault</span>
        <span class="ask-meta-model">${escapeHtml(stateText || '')}</span>`;
    return strip;
}

// Active provider/model label for the footer — fetched once, cached.
let _askModelLabel = null;
async function _askGetModelLabel() {
    if (_askModelLabel) return _askModelLabel;
    try {
        const res = await fetch(`${API}/api/setup/config`);
        if (res.ok) {
            const d = await res.json();
            const prov = d.provider || 'ollama';
            _askModelLabel = prov === 'ollama'
                ? (d.model || 'local model')
                : ((d.cloud_models && d.cloud_models[prov]) || prov);
        }
    } catch (_) {}
    return _askModelLabel || '';
}

// Footer under each finished answer: copy · re-ask · model used.
function _askAppendAnswerFooter(msgEl, rawText) {
    const body = msgEl.querySelector('.ask-msg-body');
    if (!body || body.querySelector('.ask-answer-foot')) return;
    const foot = document.createElement('div');
    foot.className = 'ask-answer-foot';
    foot.innerHTML = `
        <button class="ask-foot-btn" data-foot="copy">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy
        </button>
        <button class="ask-foot-btn" data-foot="reask">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/></svg>
            Re-ask
        </button>
        `;
    foot.querySelector('[data-foot="copy"]').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(rawText || '');
            showToast('Answer copied', 'success');
        } catch (_) { showToast('Copy failed', 'error'); }
    });
    foot.querySelector('[data-foot="reask"]').addEventListener('click', () => {
        if (state.askStreaming) return;
        // Walk back to the question this answer belongs to and retry it.
        let el = msgEl.previousElementSibling;
        while (el && !el.classList.contains('ask-msg-user')) el = el.previousElementSibling;
        const actionBtn = el && el.querySelector('.ask-msg-action-btn');
        if (actionBtn) window._askRetryMsg(actionBtn);
    });
    body.appendChild(foot);
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
    if (input) { input.value = ''; input.style.height = ''; }
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


export { _askCloseHistoryPanel, _askLoadSession, _askPopulateScopeSelect, _askSimpleMarkdown, _initAskVault, askVault };
