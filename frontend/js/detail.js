// ContextVolt — Context detail view: render, edit, export, chunks, prompt.
import { _askSimpleMarkdown } from './ask.js';
import { _KNOWN_SOURCES } from './badges.js';
import { _getCollectionForContext, setContextCollection } from './collections.js';
import { $, API, escapeHtml, openExternal, state } from './core.js';
import { _timeAgo } from './dashboard.js';
import { _showUndoToast, releaseFocus, showConfirm, showToast, trapFocus } from './dialogs.js';
import { _commitDelete, _rerenderGrid } from './library.js';
import { navigateTo } from './nav.js';
import { _buildDetailStatusBanner, _kickGlobalPoll, startWorkerPolling } from './polling.js';

// ─── LLM web apps ─────────────────────────────────────────────────────
// Maps a captured source / detected model to its web chat app. `q` is the
// new-chat URL query param that prefills the first message (null = the app has
// no such param; we fall back to clipboard + a bare new-chat URL).
const _LLM_SERVICES = {
    chatgpt:    { label: 'ChatGPT',    newChat: 'https://chatgpt.com/',             q: 'q' },
    claude:     { label: 'Claude',     newChat: 'https://claude.ai/new',            q: 'q' },
    gemini:     { label: 'Gemini',     newChat: 'https://gemini.google.com/app',    q: null },
    grok:       { label: 'Grok',       newChat: 'https://grok.com/',                q: 'q' },
    deepseek:   { label: 'DeepSeek',   newChat: 'https://chat.deepseek.com/',       q: null },
    perplexity: { label: 'Perplexity', newChat: 'https://www.perplexity.ai/search', q: 'q' },
    copilot:    { label: 'Copilot',    newChat: 'https://copilot.microsoft.com/',   q: null },
};

// Normalise a model/source label ("ChatGPT", "AI Assistant") to a service key.
function _serviceKey(label) {
    const k = (label || '').toLowerCase().replace(/[^a-z]/g, '');
    return _LLM_SERVICES[k] ? k : '';
}
// â”€â”€â”€ Context Detail â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function showDetail(id) {
    // Show detail view immediately with a layout-shaped skeleton (avoids the
    // jarring spinner→full-page pop, gives the eye the final structure up front).
    navigateTo('detail');
    $('#detail-content').innerHTML = _detailSkeleton();
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

function _detailSkeleton() {
    // Reuses the shared .cv-skel card + .cv-skel-line primitives (lines shimmer
    // via the card's ::before sweep). Mirrors the real detail layout.
    return `
        <section class="cv-dhero">
            <div class="cv-skel" style="min-height:auto;padding:22px 24px">
                <div class="cv-skel-line w40"></div>
                <div class="cv-skel-line w80" style="height:26px;margin-top:14px"></div>
                <div class="cv-skel-line w60" style="margin-top:14px"></div>
            </div>
        </section>
        <section class="cv-dlayout">
            <div class="cv-dmain">
                <div class="cv-skel"></div>
                <div class="cv-skel"></div>
            </div>
            <aside class="cv-daside">
                <div class="cv-skel"></div>
            </aside>
        </section>`;
}

function renderDetail(ctx) {
    _chunksLoaded = false;
    _currentSnippets = _extractFinalCodeSnippets(ctx.original_chat || '');
    const container = $('#detail-content');
    const summary = typeof ctx.summary === 'string' ? {} : (ctx.summary || {});

    const date = new Date(ctx.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
    });
    const timeAgo = _timeAgo(ctx.created_at);

    const keyIdeas      = (summary.key_ideas || []);
    const conclusions   = (summary.conclusions || []);
    const unresolved    = (summary.unresolved_questions || []);
    const importantNotes = (ctx.important_notes || []);
    const vitals        = (summary.vitals || []);
    const snapshot      = summary.snapshot && summary.snapshot.toLowerCase() !== 'n/a' ? summary.snapshot : '';
    const mainTopic     = (summary.main_topic && summary.main_topic !== ctx.title && summary.main_topic !== 'No topic extracted') ? summary.main_topic : '';

    const statusInfo = _buildDetailStatusBanner(ctx.status);
    const source     = (ctx.tags || []).find(t => _KNOWN_SOURCES.includes(t)) || '';
    const aiModel    = _detectAIModel(ctx.tags);
    const starred    = !!ctx.starred;
    // The exact thread this context was captured from (if the extension saved it),
    // and the LLM web app it came from — used for the "open original" links and to
    // default the "Continue in…" picker to the source service.
    const convUrl    = (ctx.conversation_url || '').trim();
    const srcKey     = _serviceKey(aiModel) || _serviceKey(source);

    // Derive quick metrics for the hero eyebrow + facts grid
    const chatText = ctx.original_chat || '';
    const wordCount = chatText ? chatText.trim().split(/\s+/).length : 0;
    const turnCount = chatText ? (chatText.match(/^(User|Human|You|Assistant|AI|Agent|ChatGPT|Claude|Grok|Gemini|Copilot|DeepSeek|Llama|Mistral|Bot):/gmi) || []).length : 0;
    const tagCount  = (ctx.tags || []).length;

    // Accent the final word of the title — but only when it's a "real" word,
    // so we don't italicize trailing punctuation, numbers, or 1–2 char fragments.
    const titleWords = (ctx.title || '').trim().split(/\s+/);
    const safeTitle = (() => {
        const last = titleWords[titleWords.length - 1] || '';
        if (titleWords.length >= 2 && /^[A-Za-z][A-Za-z'-]{2,}$/.test(last)) {
            const head = titleWords.slice(0, -1).join(' ');
            return `${escapeHtml(head)} <span class="voltword">${escapeHtml(last)}</span>`;
        }
        return escapeHtml(ctx.title || 'Untitled');
    })();

    // Tags render as chips on the hero meta line (capped, with a +N tail) —
    // they no longer get a whole rail card to themselves.
    const userTagList = (ctx.tags || []).filter(t => !_KNOWN_SOURCES.includes(t));
    const heroTagsHtml = userTagList.slice(0, 4).map(t => `<span class="cv-tag">#${escapeHtml(t)}</span>`).join('')
        + (userTagList.length > 4 ? `<span class="cv-tag cv-tag-more" title="${escapeHtml(userTagList.slice(4).join(', '))}">+${userTagList.length - 4}</span>` : '');

    const icon = {
        pin:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        pinO:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        edit:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
        export: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        del:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
        back:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
        idea:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>',
        done:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
        open:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/></svg>',
        code:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
        chat:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        chev:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
        pinIc:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v7M5 9l7-7 7 7M12 22v-6"/></svg>',
        vitals: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
        bolt:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></svg>',
        chunks: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
        redo:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>',
        ext:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    };

    // (The old aside Details rows are gone — model/turns/words live on the
    // hero facts line, created/updated in the overview Record card.)

    // "Continue in…" picker — the source service (if known) leads, then the rest.
    const continueKeys = [...new Set([srcKey, ...Object.keys(_LLM_SERVICES)].filter(Boolean))];
    // In-sheet picker (a prompt is already generated): just open it.
    const continueOptsHtml = continueKeys.map(k => {
        const s = _LLM_SERVICES[k];
        const isSrc = k === srcKey;
        return `<button class="cv-export-opt" role="menuitem" onclick="continueInService('${k}'); cvCloseContinueMenu();">${escapeHtml(s.label)}${isSrc ? ' <span class="cv-continue-src">source</span>' : ''}</button>`;
    }).join('');
    // Aside primary target: the source service, or ChatGPT as a sensible default
    // when the source isn't a known LLM; the rest become inline "open in" chips.
    const primaryKey = srcKey || 'chatgpt';
    const primaryLabel = _LLM_SERVICES[primaryKey].label;
    const altChipsHtml = Object.keys(_LLM_SERVICES)
        .filter(k => k !== primaryKey)
        .map(k => `<button type="button" class="cv-dcontinue-chip" onclick="continueGenerate(${ctx.id}, '${k}')">${escapeHtml(_LLM_SERVICES[k].label)}</button>`)
        .join('');

    container.innerHTML = `
        <!-- Rail: island matching the app navbar — back + meta + actions -->
        <div class="cv-detail-rail cv-disland">
            <button class="cv-back" onclick="navigateTo('library')" aria-label="Back to library">
                ${icon.back} Library
            </button>
            <div class="cv-rail-meta">
                <span>Context <b>#${ctx.id}</b></span>
                ${source ? `<span class="cv-rail-sep">·</span>${convUrl
                    ? `<a class="cv-source-link" href="${escapeHtml(convUrl)}" target="_blank" rel="noopener" title="Open the original ${escapeHtml(source)} conversation in a new tab">${escapeHtml(source)} ${icon.ext}</a>`
                    : `<span>${escapeHtml(source)}</span>`}` : ''}
            </div>
            <div class="cv-rail-actions">
                <button class="cv-ibtn${starred ? ' on' : ''}" id="cv-btn-pin"
                        onclick="toggleStarDetail(${ctx.id})"
                        title="${starred ? 'Unpin' : 'Pin'}" aria-label="${starred ? 'Unpin' : 'Pin'} context">
                    ${starred ? icon.pin : icon.pinO}
                </button>
                <button class="cv-ibtn" onclick="openEditModal()" title="Edit" aria-label="Edit context">${icon.edit}</button>
                <button class="cv-ibtn" id="cv-btn-resummarize"${ctx.status === 'summarizing' ? ' disabled' : ''}
                        onclick="resummarizeContext()"
                        title="Re-summarize with current model" aria-label="Re-summarize context with current model">${icon.redo}</button>
                <div style="position:relative;">
                    <button class="cv-ibtn" id="cv-export-trigger" onclick="cvToggleExportMenu(event)" title="Export" aria-label="Export context" aria-haspopup="menu" aria-expanded="false">${icon.export}</button>
                    <div class="cv-export-menu" id="cv-export-menu" role="menu">
                        <button class="cv-export-opt" role="menuitem" onclick="exportContext('markdown'); cvCloseExportMenu();">Markdown (.md)</button>
                        <button class="cv-export-opt" role="menuitem" onclick="exportContext('json'); cvCloseExportMenu();">Copy as JSON</button>
                        <button class="cv-export-opt" role="menuitem" onclick="exportContext('text'); cvCloseExportMenu();">Copy as Plain Text</button>
                    </div>
                </div>
                <button class="cv-ibtn cv-ibtn-danger" onclick="deleteCurrentContext()" title="Delete" aria-label="Delete context">${icon.del}</button>
            </div>
        </div>

        <!-- Hero: one meta line + title + single lede -->
        <section class="cv-dhero cv-dhero2">
            <div class="cv-dhero-meta">
                ${starred ? `<span class="cv-dhero-pin">★ pinned</span>` : ''}
                <span class="cv-collection-inline cv-coll-dd${ctx.collection_id ? ' has-coll' : ''}" data-ctx="${ctx.id}">
                    <button type="button" class="cv-coll-dd-btn" aria-haspopup="listbox" aria-expanded="false" title="Move to a collection">
                        <svg class="cv-coll-dd-ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
                        <span class="cv-coll-dd-label">${ctx.collection_id ? escapeHtml((state.collections.find(c => c.id === ctx.collection_id) || {}).name || 'Collection') : 'No collection'}</span>
                        <svg class="cv-coll-dd-chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                    <div class="cv-coll-dd-menu" role="listbox" aria-label="Collection" hidden>
                        <button type="button" class="cv-coll-dd-opt" role="option" data-val="" aria-selected="${!ctx.collection_id}">No collection</button>
                        ${state.collections.map(c =>
                            `<button type="button" class="cv-coll-dd-opt" role="option" data-val="${c.id}" aria-selected="${ctx.collection_id === c.id}">${escapeHtml(c.name)}</button>`
                        ).join('')}
                    </div>
                </span>
                ${heroTagsHtml}
                <span class="cv-dhero-facts">captured ${escapeHtml(date)}${aiModel && aiModel !== source ? ` · ${escapeHtml(aiModel)}` : ''}${turnCount ? ` · ${turnCount} turns` : ''}${wordCount ? ` · ${wordCount.toLocaleString()} words` : ''}</span>
            </div>
            <h1 class="cv-dtitle" id="detail-title-heading">${safeTitle}</h1>
            ${(snapshot || mainTopic) ? `<p class="cv-dsnap">${escapeHtml(snapshot || mainTopic)}</p>` : ''}
            ${statusInfo ? `<div class="cv-dstatus${ctx.status === 'failed' ? ' err' : ''}">${statusInfo}</div>` : ''}
        </section>

        <!-- Sticky tab row: Overview / Conversation / Code -->
        <div class="cv-dtabs" id="cv-dtabs">
            <span class="cv-dtabs-title" aria-hidden="true">${escapeHtml(ctx.title || 'Untitled')}</span>
            <button class="cv-dtab on" data-dtab="overview" role="tab" aria-selected="true">Overview</button>
            <button class="cv-dtab" data-dtab="conversation" role="tab" aria-selected="false">Conversation${turnCount ? ` <span class="cv-dtab-n">${turnCount}</span>` : ''}</button>
            ${_currentSnippets.length ? `<button class="cv-dtab" data-dtab="code" role="tab" aria-selected="false">Code <span class="cv-dtab-n">${_currentSnippets.length}</span></button>` : ''}
        </div>

        <!-- Body: 2-column layout — tabbed main content + sticky aside -->
        <section class="cv-dlayout">
          <div class="cv-dmain">
            <div class="cv-dtab-panel" data-dpanel="overview">

            ${importantNotes.length ? `
            <div class="cv-block cv-block-pinned cv-collapse${_pinnedOpen() ? ' open' : ''}" id="pinnedBlock">
                <button class="cv-block-head cv-collapse-head" onclick="cvTogglePinned(this)">
                    <span class="cv-block-ic cv-ic-volt">${icon.pinIc}</span>
                    <h3>Pinned notes</h3>
                    <span class="cv-count">${importantNotes.length}</span>
                    <span class="cv-collapse-chev">${icon.chev}</span>
                </button>
                <div class="cv-collapse-body"><div class="cv-collapse-inner">
                <div class="cv-pinned">
                    ${importantNotes.map(n => `<div class="cv-note">${_askSimpleMarkdown(String(n))}</div>`).join('')}
                </div>
                </div></div>
            </div>` : ''}

            ${(keyIdeas.length || conclusions.length || unresolved.length) ? `
            <div class="cv-insights cv-spotlight${keyIdeas.length ? '' : ' cv-spotlight--nohero'}">
                ${keyIdeas.length ? `
                <div class="cv-block cv-ins2-hero">
                    <div class="cv-block-head">
                        <span class="cv-block-ic cv-ic-idea">${icon.idea}</span>
                        <h3>Key ideas</h3>
                        <span class="cv-count">${keyIdeas.length}</span>
                    </div>
                    <ul class="cv-list">${keyIdeas.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
                </div>` : ''}
                <div class="cv-ins2-side">
                    ${conclusions.length ? `
                    <div class="cv-block cv-ins2-card cv-ins2-concl">
                        <div class="cv-block-head">
                            <span class="cv-block-ic cv-ic-done">${icon.done}</span>
                            <h3>${conclusions.length > 1 ? 'Conclusions' : 'Conclusion'}</h3>
                            ${conclusions.length > 1 ? `<span class="cv-count">${conclusions.length}</span>` : ''}
                        </div>
                        <ul class="cv-list">${conclusions.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
                    </div>` : ''}
                    <div class="cv-block cv-ins2-card cv-ins2-open cv-block-open">
                        <div class="cv-block-head">
                            <span class="cv-block-ic cv-ic-open">${icon.open}</span>
                            <h3>${unresolved.length > 1 ? 'Open questions' : 'Open question'}</h3>
                            ${unresolved.length > 1 ? `<span class="cv-count">${unresolved.length}</span>` : ''}
                        </div>
                        ${unresolved.length
                            ? `<ul class="cv-list">${unresolved.map(q => `<li>${escapeHtml(q)}</li>`).join('')}</ul>
                               <button type="button" class="cv-ins2-pickup" onclick="cvFocusContinue()">${icon.bolt}<span>Pick up in a new chat</span></button>`
                            : `<p class="cv-block-empty">No open questions — nothing left hanging.</p>`}
                    </div>
                </div>
            </div>` : ''}

            ${(!keyIdeas.length && !conclusions.length && !unresolved.length && ctx.status !== 'summarizing' && ctx.status !== 'failed') ? `
            <div class="cv-block cv-empty-insights">
                <span class="cv-block-ic cv-ic-idea">${icon.idea}</span>
                <div class="cv-empty-insights-text">
                    <h3>No structured insights</h3>
                    <p>No AI summary was extracted for this context. You can still generate a continuation prompt or read the original conversation below.</p>
                </div>
                <button class="cv-empty-insights-btn" onclick="retrySummarize()">Re-run summary</button>
            </div>` : ''}

            <!-- Meta band: vitals are content insights, record holds the two
                 facts the hero line doesn't carry. (Replaces three rail cards.) -->
            <div class="cv-metaband">
                ${vitals.length ? `
                <div class="cv-aside-card cv-meta-card">
                    <div class="cv-aside-head">
                        <span class="cv-aside-eyebrow">Technical vitals</span>
                        <span class="cv-aside-pill">${vitals.length}</span>
                    </div>
                    <div class="cv-aside-vitals">
                        ${vitals.map(v => `<code>${escapeHtml(v)}</code>`).join('')}
                    </div>
                </div>` : ''}
                <div class="cv-aside-card cv-meta-card">
                    <div class="cv-aside-head">
                        <span class="cv-aside-eyebrow">Record</span>
                    </div>
                    <div class="cv-record-rows">
                        <span class="cv-record-row">created <b>${escapeHtml(date)}</b></span>
                        <span class="cv-record-row">updated <b>${escapeHtml(timeAgo)}</b></span>
                    </div>
                </div>
            </div>

            </div><!-- /overview panel -->

            <!-- Conversation: full-height reader with role filter + turn scrubber -->
            <div class="cv-dtab-panel" data-dpanel="conversation" hidden>
                <div class="cv-conv-bar">
                    <div class="cv-conv-filter" id="cv-conv-filter" role="group" aria-label="Filter by role">
                        <button class="cv-conv-chip on" data-role="all">All</button>
                        <button class="cv-conv-chip" data-role="user">You</button>
                        <button class="cv-conv-chip" data-role="ai">AI</button>
                    </div>
                    <span class="cv-conv-count">${turnCount || '—'} turns</span>
                </div>
                <div class="cv-conv-wrap">
                    <div class="cv-chat" id="original-chat-box" data-role-filter="all">${_renderChatBubbles(ctx.original_chat, aiModel)}</div>
                    <div class="cv-conv-scrub" id="cv-conv-scrub" aria-hidden="true"></div>
                </div>
            </div>

            ${_currentSnippets.length ? `
            <!-- Code: snippet gallery -->
            <div class="cv-dtab-panel" data-dpanel="code" hidden>
                <div class="cv-snips">
                    ${_currentSnippets.map((s, i) => `
                    <div class="cv-snip">
                        <div class="cv-snip-head">
                            <span class="cv-snip-lang">${escapeHtml(s.label)}</span>
                            <span class="cv-snip-lines">${s.code.split('\n').filter(l => l.trim()).length} lines</span>
                            <button class="cv-snip-copy code-snippet-copy" data-idx="${i}" onclick="copyCodeSnippet(${i})">Copy</button>
                        </div>
                        <pre class="cv-snip-pre"><code>${escapeHtml(s.code.replace(/\n$/, ''))}</code></pre>
                    </div>`).join('')}
                </div>
            </div>` : ''}

          </div>

          <!-- Sticky aside (B): compact Continue card + Next steps filler -->
          <aside class="cv-daside">
            <div class="cv-aside-card cv-act2" id="cv-action-card">
                <div class="cv-aside-head">
                    <span class="cv-aside-eyebrow cv-act2-eyebrow">${icon.bolt} Continuation prompt</span>
                </div>
                <p class="cv-act2-sub">Pack this conversation into a ready-to-paste prompt for any AI chat.</p>
                <input type="text" id="retrieval-query" class="cv-action-input"
                       placeholder="Focus on… (optional)" />

                <div class="cv-size-seg" id="cv-size-seg" role="tablist" aria-label="Prompt size">
                    <button class="prompt-size-btn" role="tab" aria-selected="false" data-size="compact" data-hint="Compact · ~2,000 chars — fits 4k context windows">Compact</button>
                    <button class="prompt-size-btn on" role="tab" aria-selected="true" data-size="standard" data-hint="Standard · ~5,200 chars — fits most 8k context windows">Standard</button>
                    <button class="prompt-size-btn" role="tab" aria-selected="false" data-size="full" data-hint="Full · ~12,000 chars — for 16k+ context windows">Full</button>
                </div>
                <button class="cv-act2-primary" id="cv-generate-link" onclick="generatePrompt(${ctx.id}, this)">
                    ${icon.bolt}<span>Generate prompt</span><kbd class="cv-act2-kbd">Ctrl ↵</kbd>
                </button>

                <div class="cv-act2-divider" aria-hidden="true"></div>

                <div class="cv-dcontinue" id="cv-dcontinue">
                    <span class="cv-act2-prompt-lbl">Or jump straight into a chat</span>
                    <button type="button" class="cv-act2-secondary"
                            onclick="continueGenerate(${ctx.id}, '${primaryKey}')"
                            title="Build a full continuation prompt and open ${escapeHtml(primaryLabel)} in your browser">
                        ${icon.ext}<span>Continue in ${escapeHtml(primaryLabel)}</span>
                    </button>
                    <span class="cv-dcontinue-busy-label">Preparing full prompt…</span>
                    ${altChipsHtml ? `
                    <div class="cv-dcontinue-alt">
                        <span class="cv-dcontinue-alt-lbl">or open in</span>
                        <div class="cv-dcontinue-chips">${altChipsHtml}</div>
                    </div>` : ''}
                </div>
            </div>

            <div class="cv-aside-card cv-nextsteps">
                <div class="cv-aside-head">
                    <span class="cv-aside-eyebrow">Next steps</span>
                </div>
                <div class="cv-nextsteps-list">
                    <button type="button" class="cv-nextstep" id="cv-askbridge-go">${icon.chat}<span>Ask about this context</span></button>
                    ${convUrl ? `<a class="cv-nextstep cv-source-link" href="${escapeHtml(convUrl)}" target="_blank" rel="noopener">${icon.ext}<span>Open original ${escapeHtml(source || 'conversation')}</span></a>` : ''}
                    <button type="button" class="cv-nextstep" onclick="exportContext('markdown')">${icon.export}<span>Export as Markdown</span></button>
                </div>
            </div>
          </aside>
        </section>

        <!-- Generated prompt: overlay sheet over the page (not an inline reveal) -->
        <div class="cv-prompt-sheet" id="prompt-section" role="dialog" aria-modal="true" aria-labelledby="prompt-section-heading" style="display:none;">
            <div class="cv-prompt-sheet-card">
                <div class="cv-prompt-out-head">
                    <h3 id="prompt-section-heading">Generated prompt</h3>
                    <span class="cv-prompt-stat" id="cv-prompt-stat"></span>
                    <div class="cv-prompt-out-acts">
                        <div class="cv-continue-wrap" style="position:relative;">
                            <button class="cv-prompt-continue" id="cv-continue-trigger" type="button"
                                    onclick="cvToggleContinueMenu(event)" aria-haspopup="menu" aria-expanded="false"
                                    title="Open a new chat with this prompt">
                                ${icon.bolt}<span>Continue in…</span>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                            </button>
                            <div class="cv-export-menu" id="cv-continue-menu" role="menu">${continueOptsHtml}</div>
                        </div>
                        <button class="cv-prompt-copy" id="copy-prompt-btn" type="button">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            <span>Copy</span>
                        </button>
                        <button class="cv-prompt-close" id="close-prompt-btn" type="button" aria-label="Close">×</button>
                    </div>
                </div>
                <pre class="prompt-display" id="prompt-display" tabindex="0"></pre>
            </div>
        </div>
    `;

    // Bind copy/close on the prompt sheet (rendered fresh each view).
    // Backdrop click and Escape also close it.
    const copyBtn  = document.getElementById('copy-prompt-btn');
    const closeBtn = document.getElementById('close-prompt-btn');
    const sheet    = document.getElementById('prompt-section');
    const closeSheet = () => { if (sheet) sheet.style.display = 'none'; };
    if (copyBtn)  copyBtn.addEventListener('click', copyPrompt);
    if (closeBtn) closeBtn.addEventListener('click', closeSheet);
    if (sheet) sheet.addEventListener('mousedown', (e) => { if (e.target === sheet) closeSheet(); });
    document.addEventListener('keydown', function escSheet(e) {
        if (e.key === 'Escape' && sheet && sheet.style.display !== 'none') closeSheet();
        if (!document.getElementById('prompt-section')) document.removeEventListener('keydown', escSheet);
    });

    // Segmented size control — toggle .on class + update live hint
    const hintEl = document.getElementById('cv-action-hint');
    document.querySelectorAll('#cv-size-seg .prompt-size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#cv-size-seg .prompt-size-btn').forEach(b => {
                b.classList.remove('on');
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            btn.classList.add('on');
            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');
            if (hintEl && btn.dataset.hint) hintEl.textContent = btn.dataset.hint;
        });
    });

    // ⌘/Ctrl+Enter on the focus input triggers Generate
    const focusInput = document.getElementById('retrieval-query');
    if (focusInput) {
        focusInput.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                const goBtn = document.getElementById('cv-generate-link');
                if (goBtn && !goBtn.disabled) goBtn.click();
            }
        });
    }

    _initInsightExpand();
    _bindInsightResize();
    _initDetailTabs();
    _initConvReader();
    _initAskBridge(ctx);
    $('#prompt-section').style.display = 'none';
}

// ─── Tabs: Overview / Conversation / Code ─────────────────────────────
function _initDetailTabs() {
    const tabs = Array.from(document.querySelectorAll('#cv-dtabs .cv-dtab'));
    const panels = Array.from(document.querySelectorAll('.cv-dtab-panel'));
    tabs.forEach(tab => tab.addEventListener('click', () => {
        tabs.forEach(t => {
            t.classList.toggle('on', t === tab);
            t.setAttribute('aria-selected', String(t === tab));
        });
        panels.forEach(p => { p.hidden = p.dataset.dpanel !== tab.dataset.dtab; });
        // Re-measure insight clamps when returning to Overview (display:none
        // while hidden means scrollHeight was 0 during the first measure).
        if (tab.dataset.dtab === 'overview') _initInsightExpand();
    }));
    // The tab row picks up the context title once the hero scrolls away.
    const view = document.getElementById('view-detail');
    const bar = document.getElementById('cv-dtabs');
    if (view && bar) view.onscroll = () => bar.classList.toggle('scrolled', view.scrollTop > 140);
}

// ─── Conversation reader: role filter + turn scrubber ─────────────────
function _initConvReader() {
    const box = document.getElementById('original-chat-box');
    const filter = document.getElementById('cv-conv-filter');
    if (filter && box) {
        filter.querySelectorAll('.cv-conv-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                filter.querySelectorAll('.cv-conv-chip').forEach(c => c.classList.toggle('on', c === chip));
                box.dataset.roleFilter = chip.dataset.role;
            });
        });
    }
    const scrub = document.getElementById('cv-conv-scrub');
    if (!box || !scrub) return;
    const msgs = Array.from(box.querySelectorAll('.cv-msg'));
    if (msgs.length < 8) { scrub.style.display = 'none'; return; }
    // Cap the dots so very long chats stay scannable.
    const step = Math.ceil(msgs.length / 40);
    const picks = msgs.map((m, i) => ({ m, i })).filter(({ i }) => i % step === 0);
    scrub.innerHTML = picks.map(({ m, i }) =>
        `<button class="cv-scrub-dot${m.classList.contains('cv-msg-user') ? ' u' : ''}" data-i="${i}" title="Turn ${i + 1}" aria-label="Jump to turn ${i + 1}"></button>`
    ).join('');
    scrub.querySelectorAll('.cv-scrub-dot').forEach(dot => {
        dot.addEventListener('click', () => {
            const m = msgs[parseInt(dot.dataset.i, 10)];
            if (m) m.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    });
}

// ─── Ask-about-this bridge → Ask Vault with a prefilled question ──────
function _initAskBridge(ctx) {
    const btn = document.getElementById('cv-askbridge-go');
    if (!btn) return;
    btn.addEventListener('click', () => {
        navigateTo('ask');
        // Prefill, don't auto-send — the user supplies the actual question.
        setTimeout(() => {
            const input = document.getElementById('ask-input');
            if (input && !input.disabled) {
                input.value = `About "${ctx.title || 'this context'}": `;
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, 120);
    });
}

function _initInsightExpand() {
    requestAnimationFrame(() => {
        document.querySelectorAll('.cv-insights .cv-block').forEach(block => {
            const list = block.querySelector('.cv-list');
            if (!list) return;
            // Reset prior state so this is safe to re-run (e.g. after a resize
            // flips the insights grid between 1/2/3 columns).
            block.classList.remove('cv-expanded');
            block.style.maxHeight = '';
            list.classList.remove('cv-list--full');
            const oldBtn = block.querySelector('.cv-expand-btn');
            if (oldBtn) oldBtn.remove();

            const overflows = list.scrollHeight > list.clientHeight + 4;
            if (!overflows) {
                list.classList.add('cv-list--full');
                return;
            }
            const total = list.querySelectorAll('li').length;
            const btn = document.createElement('button');
            btn.className = 'cv-expand-btn';
            btn.textContent = `Show all ${total}`;
            btn.onclick = () => {
                // Open the full list in a popup so the card stays fixed/even and
                // the page layout never distorts.
                const title = block.querySelector('.cv-block-head h3')?.textContent || 'Details';
                const iconHtml = block.querySelector('.cv-block-ic')?.outerHTML || '';
                const itemsHtml = Array.from(list.querySelectorAll('li')).map(li => li.outerHTML).join('');
                _openInsightModal(title, itemsHtml, block, iconHtml);
            };
            block.appendChild(btn);
        });
    });
}

// "Show all" popup for an insights section — full list, scrolls inside the
// modal so the underlying card and grid stay put.
function _openInsightModal(title, itemsHtml, originEl, iconHtml = '') {
    document.getElementById('cv-insight-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'cv-insight-modal';
    const count = (itemsHtml.match(/<li/g) || []).length;
    overlay.innerHTML = `
        <div class="modal cv-insight-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
            <div class="cv-insight-modal-head cv-block-head">
                ${iconHtml}
                <h3>${escapeHtml(title)}</h3>
                ${count ? `<span class="cv-count">${count}</span>` : ''}
                <button class="cv-insight-modal-close" type="button" aria-label="Close">×</button>
            </div>
            <ul class="cv-list cv-insight-modal-list">${itemsHtml}</ul>
        </div>`;
    document.body.appendChild(overlay);
    const modal = overlay.querySelector('.modal');

    // Expand-from-card: grow the modal out of the clicked section's position/size,
    // and collapse back into it on close. Falls back to the CSS spring if WAAPI
    // or an origin element isn't available.
    let dx = 0, dy = 0, s = 0.85;
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animate = originEl && typeof modal.animate === 'function' && !reduceMotion;
    if (animate) {
        overlay.style.animation = 'none';
        modal.style.animation = 'none';
        const o = originEl.getBoundingClientRect();
        const m = modal.getBoundingClientRect();
        dx = (o.left + o.width / 2) - (m.left + m.width / 2);
        dy = (o.top + o.height / 2) - (m.top + m.height / 2);
        s = Math.min(1, Math.max(0.3, o.width / m.width));
        overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out', fill: 'both' });
        modal.animate([
            { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0 },
            { transform: 'translate(0, 0) scale(1)', opacity: 1 }
        ], { duration: 340, easing: 'cubic-bezier(0.2, 0.85, 0.25, 1)', fill: 'both' });
    }

    let closing = false;
    const close = () => {
        if (closing) return;
        closing = true;
        if (animate) {
            overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-in', fill: 'forwards' });
            const a = modal.animate([
                { transform: 'translate(0, 0) scale(1)', opacity: 1 },
                { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0 }
            ], { duration: 240, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
            a.onfinish = a.oncancel = () => overlay.remove();
        } else {
            overlay.remove();
        }
    };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.cv-insight-modal-close').addEventListener('click', close);
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
}

// The insights grid changes column count at breakpoints, so the clamp/overflow
// decision has to be re-measured on resize. Bound once, debounced.
let _insightResizeBound = false;
function _bindInsightResize() {
    if (_insightResizeBound) return;
    _insightResizeBound = true;
    let t;
    window.addEventListener('resize', () => {
        if (!document.querySelector('.cv-insights')) return;
        clearTimeout(t);
        t = setTimeout(_initInsightExpand, 150);
    });
}

// ─── Export menu toggle (used by new cv-detail rail) ─────────────
function cvToggleExportMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('cv-export-menu');
    const trigger = document.getElementById('cv-export-trigger');
    if (!menu) return;
    const open = menu.classList.toggle('open');
    if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Move focus into the menu so keyboard users can arrow through the options.
    if (open) { const first = menu.querySelector('.cv-export-opt'); if (first) first.focus(); }
}
function cvCloseExportMenu(refocus) {
    const menu = document.getElementById('cv-export-menu');
    const trigger = document.getElementById('cv-export-trigger');
    if (menu) menu.classList.remove('open');
    if (trigger) {
        trigger.setAttribute('aria-expanded', 'false');
        if (refocus) trigger.focus();
    }
}
window.cvToggleExportMenu = cvToggleExportMenu;
window.cvCloseExportMenu  = cvCloseExportMenu;

// ─── "Continue in…" picker (prompt sheet) ─────────────────────────
function cvToggleContinueMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('cv-continue-menu');
    const trigger = document.getElementById('cv-continue-trigger');
    if (!menu) return;
    const open = menu.classList.toggle('open');
    if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { const first = menu.querySelector('.cv-export-opt'); if (first) first.focus(); }
}
function cvCloseContinueMenu() {
    const menu = document.getElementById('cv-continue-menu');
    const trigger = document.getElementById('cv-continue-trigger');
    if (menu) menu.classList.remove('open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

// Open a fresh chat in the chosen LLM web app, carrying a continuation prompt.
// Prompts can be long, so the clipboard is the reliable transport (always
// copied); when the app supports a prefill query param AND the encoded prompt is
// short enough to survive URL-length limits, we also prefill it so the user
// often lands with the prompt already typed. The actual open goes through the
// pywebview bridge so it lands in the user's default browser, not the WebView.
async function _openServiceWithPrompt(serviceKey, prompt) {
    const svc = _LLM_SERVICES[serviceKey];
    if (!svc) return;
    let copied = false;
    if (prompt) {
        try { await navigator.clipboard.writeText(prompt); copied = true; } catch { /* clipboard blocked */ }
    }
    // Prefill via the app's ?q= param ONLY when the prompt is short enough to be
    // safe. Long prompts can't ride in a URL: the LLM apps drop/ignore an oversized
    // ?q=, and the Windows "open in browser" bridge (ShellExecute) has a command
    // line length limit a long URL blows past — so the browser fails to launch.
    // Continuation prompts are almost always long, so the reliable path is the
    // clipboard: we copy, open a clean new chat, and the user pastes (Ctrl/⌘+V).
    const PREFILL_MAX = 1600; // encoded chars — conservative, keeps the URL launchable
    let url = svc.newChat;
    let prefilled = false;
    if (svc.q && prompt) {
        const enc = encodeURIComponent(prompt);
        if (enc.length <= PREFILL_MAX) {
            url += (url.includes('?') ? '&' : '?') + svc.q + '=' + enc;
            prefilled = true;
        }
    }
    // The success toast lives in THIS window — once the browser grabs focus the
    // user never sees it, so they'd land in a blank chat not knowing to paste.
    // The first time we hand off via the clipboard, show an in-app explainer they
    // must acknowledge before we open the browser. After that we trust they know.
    if (prompt && copied && !prefilled && !_continueHowtoSeen()) {
        const ok = await showConfirm({
            title: `Continue in ${svc.label}`,
            message: `The full prompt is now on your clipboard. We'll open a new ${svc.label} chat in your browser — paste it there with Ctrl/⌘+V and press Enter to pick up where you left off.`,
            confirmLabel: `Open ${svc.label}`,
        });
        if (!ok) return;
        try { localStorage.setItem(_CONTINUE_HOWTO_KEY, '1'); } catch { /* storage blocked */ }
    }
    openExternal(url);
    if (!prompt) {
        showToast(`Opening ${svc.label}`, 'success');
    } else if (prefilled) {
        showToast(`Opening ${svc.label} with your prompt prefilled.`, 'success');
    } else if (copied) {
        showToast(`Prompt copied — paste it into ${svc.label} (Ctrl/⌘+V).`, 'success');
    } else {
        showToast(`Opening ${svc.label} — copy the prompt manually.`, 'error');
    }
}

// Remember once the user has seen the "paste into the new chat" explainer, so we
// only interrupt the very first hand-off, not every continuation after.
const _CONTINUE_HOWTO_KEY = 'cv-continue-howto-seen';
function _continueHowtoSeen() {
    try { return localStorage.getItem(_CONTINUE_HOWTO_KEY) === '1'; } catch { return false; }
}

// Sheet flow: a prompt has already been generated and shown — just open it.
function continueInService(serviceKey) {
    return _openServiceWithPrompt(serviceKey, state.currentPrompt || '');
}

// Main detail-page flow: generate the full continuation prompt on the fly (using
// the optional focus query), copy it to the clipboard, then open a clean new chat
// in the chosen LLM. One click → land in the chat, paste (Ctrl/⌘+V), send. We use
// the full prompt because the clipboard has no length limit (unlike a URL).
async function continueGenerate(id, serviceKey) {
    const svc = _LLM_SERVICES[serviceKey];
    if (!svc) return;
    const card = document.getElementById('cv-dcontinue');
    if (card) card.classList.add('cv-dcontinue-busy');
    try {
        const queryEl = document.getElementById('retrieval-query');
        const query = queryEl ? queryEl.value.trim() : '';
        await _requestPrompt(id, 'full', query);
        await _openServiceWithPrompt(serviceKey, state.currentPrompt || '');
    } catch (err) {
        showToast('Failed to prepare the continuation prompt', 'error');
    } finally {
        if (card) card.classList.remove('cv-dcontinue-busy');
    }
}

window.cvToggleContinueMenu = cvToggleContinueMenu;
window.cvCloseContinueMenu  = cvCloseContinueMenu;
window.continueInService    = continueInService;
window.continueGenerate     = continueGenerate;

// "Pick up in a new chat" from the Open questions card → bring the aside Continue
// card into view and briefly pulse it, so the next action is obvious.
function cvFocusContinue() {
    const card = document.getElementById('cv-action-card');
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('cv-continue-pulse');
    void card.offsetWidth; // restart the animation if it's already played
    card.classList.add('cv-continue-pulse');
    setTimeout(() => card.classList.remove('cv-continue-pulse'), 1300);
    const input = document.getElementById('retrieval-query');
    if (input) setTimeout(() => { try { input.focus({ preventScroll: true }); } catch { input.focus(); } }, 380);
}
window.cvFocusContinue = cvFocusContinue;

// ─── Pinned notes collapse (detail page) ─────────────────────────
// Persisted so the choice sticks across re-renders / contexts. Defaults collapsed.
function _pinnedOpen() {
    try { return localStorage.getItem('cv-pinned-open') === '1'; } catch (e) { return false; }
}
function cvTogglePinned(btn) {
    const block = btn.closest('.cv-collapse');
    if (!block) return;
    const open = block.classList.toggle('open');
    try { localStorage.setItem('cv-pinned-open', open ? '1' : '0'); } catch (e) {}
}
window.cvTogglePinned = cvTogglePinned;

// Generic collapse toggle for grid-rows sections (code snippets, original chat).
window.cvToggleBlock = function(btn) {
    const block = btn.closest('.cv-collapse');
    if (block) block.classList.toggle('open');
};
document.addEventListener('click', (e) => {
    if (!e.target.closest('#cv-export-menu') && !e.target.closest('[onclick*="cvToggleExportMenu"]')) {
        cvCloseExportMenu();
    }
    if (!e.target.closest('#cv-continue-menu') && !e.target.closest('[onclick*="cvToggleContinueMenu"]')) {
        cvCloseContinueMenu();
    }
});

// Original-thread badges (rail + hero eyebrow) must open in the user's default
// browser, not navigate the WebView — intercept and route through the bridge.
document.addEventListener('click', (e) => {
    const link = e.target.closest('.cv-source-link, .cv-ebadge-link');
    if (link && link.getAttribute('href')) {
        e.preventDefault();
        openExternal(link.href);
    }
});
// Keyboard nav for the open export menu: Esc closes (refocusing the trigger),
// Arrow Up/Down cycle through the options.
document.addEventListener('keydown', (e) => {
    const menu = document.getElementById('cv-export-menu');
    if (!menu || !menu.classList.contains('open')) return;
    const opts = [...menu.querySelectorAll('.cv-export-opt')];
    if (!opts.length) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        cvCloseExportMenu(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = opts.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown'
            ? (i + 1) % opts.length
            : (i - 1 + opts.length) % opts.length;
        opts[next].focus();
    }
});


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
    if (!text) return '<div class="cv-msg" style="color:var(--cv-text-3);font-size:12.5px;">No conversation data available.</div>';
    const lines = text.split('\n');
    let html = '';
    let currentRole = null;
    let buffer = [];

    function flushBuffer() {
        if (!currentRole || !buffer.length) return;
        const content = escapeHtml(buffer.join('\n').trim());
        if (!content) return;
        const isUser = currentRole === 'user';
        const avatar = isUser ? 'U' : 'AI';
        const name = isUser ? 'You' : aiModel;
        html += `<div class="cv-msg ${isUser ? 'cv-msg-user' : 'cv-msg-ai'}">
            <div class="cv-msg-av ${isUser ? 'cv-msg-av-user' : 'cv-msg-av-ai'}">${avatar}</div>
            <div class="cv-msg-body">
                <div class="cv-msg-name">${name}</div>
                <div class="cv-msg-text">${content}</div>
            </div>
        </div>`;
        buffer = [];
    }

    for (const line of lines) {
        const trimmed = line.trim();
        if (/^(User|Human|You):/i.test(trimmed)) {
            flushBuffer();
            currentRole = 'user';
            buffer.push(trimmed.replace(/^(User|Human|You):\s*/i, ''));
        } else if (/^(Assistant|AI|Agent|ChatGPT|Claude|Grok|Gemini|Copilot|DeepSeek|Llama|Mistral|Bot):/i.test(trimmed)) {
            flushBuffer();
            currentRole = 'ai';
            buffer.push(trimmed.replace(/^(Assistant|AI|Agent|ChatGPT|Claude|Grok|Gemini|Copilot|DeepSeek|Llama|Mistral|Bot):\s*/i, ''));
        } else {
            if (!currentRole) currentRole = 'user';
            buffer.push(line);
        }
    }
    flushBuffer();
    return html || '<div class="cv-msg" style="color:var(--cv-text-3);font-size:12.5px;">No conversation data available.</div>';
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
    // Collapse state is handled by the parent .cv-collapse.open class in the new design.
    // This function is now only responsible for lazy-loading chunk data on first open.
    const content = $('#chunks-viewer-content');
    if (!content) return;
    if (_chunksLoaded) return;

    content.innerHTML = `
        <div class="chunks-query-row" style="display:flex;gap:8px;margin-bottom:10px;">
            <input type="text" class="chunks-query-input" id="chunks-query" placeholder="Enter a query to see similarity scores…"
                   style="flex:1;padding:8px 10px;border-radius:8px;background:rgba(6,6,8,0.6);border:1px solid var(--cv-line);color:var(--cv-text-0);font:400 12.5px/1 var(--cv-body);" />
            <button class="cv-snip-copy chunks-score-btn" id="chunks-score-btn" onclick="loadChunks(${contextId})">Score</button>
        </div>
        <div id="chunks-list-container"><div class="chunks-empty" style="color:var(--cv-text-3);font-size:12.5px;">Loading chunks…</div></div>
    `;
    await loadChunks(contextId);
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
        icon.textContent = 'â–¼';
    } else {
        box.style.display = 'none';
        icon.textContent = 'â–¶';
    }
}

// Request a continuation prompt from the backend and stash it on state.
// Shared by the "Generate" preview button and the "Continue in…" flow.
async function _requestPrompt(id, size, query) {
    const res = await fetch(`${API}/api/contexts/${id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query || null, size }),
    });
    if (!res.ok) throw new Error('Failed to generate prompt');
    const data = await res.json();
    state.currentPrompt = data.prompt;
    return data.prompt;
}

async function generatePrompt(id, btn) {
    let originalHTML = '';
    if (btn) {
        originalHTML = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.6s linear infinite;margin-right:8px;vertical-align:-2px;"></span>Generating…';
    }
    try {
        const activeSize = document.querySelector('.prompt-size-btn.active, .prompt-size-btn.on');
        const size = activeSize ? activeSize.dataset.size : 'standard';
        const queryEl = document.getElementById('retrieval-query');
        const query = queryEl ? queryEl.value.trim() : '';
        const data = { prompt: await _requestPrompt(id, size, query) };

        const section = $('#prompt-section');
        section.style.display = 'block';
        $('#prompt-display').textContent = data.prompt;
        const statEl = document.getElementById('cv-prompt-stat');
        if (statEl) {
            const chars = data.prompt.length;
            const tokens = Math.round(chars / 4); // rough heuristic
            statEl.textContent = `${chars.toLocaleString()} chars · ~${tokens.toLocaleString()} tokens`;
        }
        section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
        showToast('Failed to generate prompt', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHTML;
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

    // Return focus to whatever opened the modal (the rail's edit button).
    trapFocus($('#edit-modal').querySelector('.modal'), document.activeElement);
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
    openConfirmDeleteModal(ctx);
}

function openConfirmDeleteModal(ctxOrOpts, onConfirm) {
    const overlay = $('#confirm-delete-modal');

    // Support two call shapes:
    //   openConfirmDeleteModal(ctx, onConfirm?)            — context delete
    //   openConfirmDeleteModal({title, message, confirmLabel, onConfirm})
    let title, messageHtml, confirmLabel, action;
    if (ctxOrOpts && typeof ctxOrOpts === 'object' && ('message' in ctxOrOpts || 'title' in ctxOrOpts) && !('id' in ctxOrOpts)) {
        title = ctxOrOpts.title || 'Are you sure?';
        messageHtml = ctxOrOpts.message || '';
        confirmLabel = ctxOrOpts.confirmLabel || 'Delete';
        action = ctxOrOpts.onConfirm;
    } else {
        const ctx = ctxOrOpts;
        title = 'Delete this context?';
        messageHtml = `Delete <b>"${escapeHtml(ctx.title || 'Untitled')}"</b>? You'll have 5 seconds to undo from the toast.`;
        confirmLabel = 'Delete';
        action = onConfirm || (() => _performDeleteCurrentContext(ctx));
    }

    if (!overlay) { if (action) action(); return; }
    state._pendingConfirmDeleteAction = action;

    const titleEl = $('#confirm-delete-title');
    if (titleEl) titleEl.textContent = title;
    const msg = $('#confirm-delete-message');
    if (msg) msg.innerHTML = messageHtml;
    const confirmBtn = $('#confirm-delete-btn');
    if (confirmBtn) confirmBtn.textContent = confirmLabel;

    overlay.style.display = 'flex';
    trapFocus(overlay.querySelector('.modal'), document.activeElement);
    if (confirmBtn) confirmBtn.focus();
}

function closeConfirmDeleteModal() {
    const overlay = $('#confirm-delete-modal');
    if (!overlay) return;
    const inner = overlay.querySelector('.modal');
    releaseFocus(inner);
    inner.style.animation = 'shellOut 0.18s var(--ease) forwards';
    overlay.style.animation = 'fadeOut 0.18s var(--ease) forwards';
    setTimeout(() => {
        overlay.style.display = 'none';
        inner.style.animation = '';
        overlay.style.animation = '';
    }, 180);
    state._pendingConfirmDeleteAction = null;
}

function _performDeleteCurrentContext(ctx) {
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
async function exportContext(format) {
    cvCloseExportMenu();
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
    await navigator.clipboard.writeText(text);
}

// â”€â”€â”€ Copy to Clipboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function copyPrompt() {
    if (!state.currentPrompt) return;
    try {
        await navigator.clipboard.writeText(state.currentPrompt);
        showToast('Copied to clipboard!', 'success');
        const btn = document.getElementById('copy-prompt-btn');
        if (btn) {
            const label = btn.querySelector('span');
            const original = label ? label.textContent : '';
            btn.classList.add('copied');
            if (label) label.textContent = 'Copied';
            setTimeout(() => {
                btn.classList.remove('copied');
                if (label) label.textContent = original || 'Copy';
            }, 1400);
        }
    } catch {
        showToast('Copy failed — clipboard access denied', 'error');
    }
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

// Custom collection dropdown on the detail hero — delegated once, survives re-renders.
let _collDdBound = false;
function _initDetailCollDd() {
    if (_collDdBound) return;
    _collDdBound = true;
    const closeAll = (except) => {
        document.querySelectorAll('.cv-coll-dd-menu:not([hidden])').forEach(m => {
            if (m.parentElement === except) return;
            m.hidden = true;
            m.parentElement.querySelector('.cv-coll-dd-btn')?.setAttribute('aria-expanded', 'false');
        });
    };
    document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.cv-coll-dd-btn');
        const opt = e.target.closest('.cv-coll-dd-opt');
        const root = e.target.closest('.cv-coll-dd');
        closeAll(root);
        if (btn) {
            const dd = btn.closest('.cv-coll-dd');
            const menu = dd.querySelector('.cv-coll-dd-menu');
            const willOpen = menu.hidden;
            menu.hidden = !willOpen;
            btn.setAttribute('aria-expanded', String(willOpen));
            return;
        }
        if (opt) {
            const dd = opt.closest('.cv-coll-dd');
            const ctxId = Number(dd.dataset.ctx);
            const val = opt.dataset.val || '';
            dd.querySelector('.cv-coll-dd-menu').hidden = true;
            dd.querySelector('.cv-coll-dd-btn')?.setAttribute('aria-expanded', 'false');
            dd.querySelectorAll('.cv-coll-dd-opt').forEach(o => o.setAttribute('aria-selected', String(o === opt)));
            const lbl = dd.querySelector('.cv-coll-dd-label');
            if (lbl) lbl.textContent = opt.textContent.trim();
            dd.classList.toggle('has-coll', !!val);
            await handleDetailCollectionChange(ctxId, val);
        }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(null); });
}
_initDetailCollDd();

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
        _kickGlobalPoll();
    } catch (err) {
        showToast('Failed to retry summarization', 'error');
    }
}

// Re-summarize an already-completed context — e.g. after switching the LLM
// model in Settings, so the summary is regenerated with the new model. The
// backend reads the active model from config at call time, so no model arg
// is needed here. Confirms first since it overwrites the existing summary.
async function resummarizeContext() {
    const ctx = state.currentContext;
    if (!ctx || ctx.status === 'summarizing') return;

    // Best-effort: name the model the new summary will use, for clarity.
    let modelName = '';
    try {
        const r = await fetch(`${API}/api/setup/status`);
        if (r.ok) modelName = (await r.json()).model_name || '';
    } catch { /* fall back to a generic message */ }

    const ok = await showConfirm({
        title: 'Re-summarize this context?',
        message: modelName
            ? `The whole conversation will be summarized again using the current model (${modelName}). This replaces the existing summary.`
            : 'The whole conversation will be summarized again using the current model. This replaces the existing summary.',
        confirmLabel: 'Re-summarize',
    });
    if (!ok) return;

    await retrySummarize();
}


export { closeConfirmDeleteModal, closeEditModal, copyCodeSnippet, deleteCurrentContext, exportContext, generatePrompt, handleDetailCollectionChange, openConfirmDeleteModal, openEditModal, renderDetail, resummarizeContext, retrySummarize, saveEdit, showDetail, toggleOriginalChat };
