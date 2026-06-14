// ContextVolt — First-run onboarding tour.
import { API, state } from './core.js';
import { showDetail } from './detail.js';
import { navigateTo } from './nav.js';
import { _settingsConfig, closeSettingsModal } from './settings.js';
// ─── Onboarding Tour ──────────────────────────────────────────────────
const CV_ONBOARD_KEY = 'cv_onboarded_v1';

const CV_ONBOARD_STEPS = [
    {
        view: 'input',
        target: null,
        title: 'Welcome to ContextVolt ⚡',
        body: 'Your local-first AI memory vault — save AI conversations, summarize them with a local LLM, and query them later, all on your machine.<br><br>First, what should we call you?'
            + '<div class="cv-onboard-field">'
            + '<input id="cv-onboard-name-input" class="cv-onboard-input" type="text" maxlength="40" autocomplete="off" spellcheck="false" placeholder="Your name" aria-label="Your name">'
            + '</div>',
        nameCapture: true,
        eyebrow: 'Hello'
    },
    {
        view: 'input',
        target: '#sidebar',
        title: 'The sidebar — your control deck',
        body: 'Everything lives here: views (Dashboard, Library, Ask Vault), Collections, preferences, and system tools. Press the chevron at the top to collapse it.',
        eyebrow: 'Layout'
    },
    {
        view: 'input',
        target: '#nav-input',
        title: 'Dashboard',
        body: 'The home view. See vault stats, recent contexts, and start a new capture. Press <kbd>D</kbd> to jump here from anywhere.',
        eyebrow: 'View'
    },
    {
        view: 'input',
        target: '#quick-capture-toggle',
        title: 'Quick Capture — your starting point',
        body: 'Paste any AI conversation here. ContextVolt summarizes it with your local LLM, splits it semantically, and embeds it into the vault for later retrieval.',
        eyebrow: 'Action'
    },
    // ── Library walkthrough ───────────────────────────────────────────────
    {
        view: 'library',
        target: '.cv-lib-rail',
        title: 'Library — everything you’ve saved',
        body: 'Every captured conversation lives here. Browse as a grid or compact rows, then click any card to dive in. Press <kbd>L</kbd> to jump here from anywhere.',
        eyebrow: 'View'
    },
    {
        view: 'library',
        target: '.cv-search-pill',
        title: 'Search your vault',
        body: 'Filter by title, tag, or content as you type. Flip on <b>Deep</b> to search across every chunk of every conversation, not just titles. <kbd>Ctrl K</kbd> focuses it instantly.',
        eyebrow: 'Find'
    },
    {
        view: 'library',
        target: '.cv-lib-tools',
        title: 'View, sort & select',
        body: 'Toggle <b>Grid</b> / <b>Rows</b>, reorder by newest, oldest, or A–Z, and use <b>Select</b> to act on many contexts at once (assign to a collection or bulk-delete).',
        eyebrow: 'Organize'
    },
    {
        view: 'library',
        target: '#contexts-grid .cv-card',
        title: 'Open a context',
        body: 'Each card previews a saved conversation — its topic, source AI, and date. Click one to open the full detail view. Let’s open this one.',
        eyebrow: 'Tip',
        needsData: true
    },
    // ── Context detail walkthrough (only when the vault has data) ──────────
    {
        view: 'detail',
        target: '.cv-dhero',
        title: 'The distilled summary',
        body: 'Your local LLM turns a raw transcript into a clean title, one-line snapshot, key ideas, conclusions, and open questions — so you can recall a conversation in seconds.',
        eyebrow: 'Detail',
        needsData: true,
        before: () => (_cvFirstCtxId != null ? showDetail(_cvFirstCtxId) : Promise.resolve())
    },
    {
        view: 'detail',
        target: '.cv-detail-rail',
        title: 'Act on a context',
        body: 'Pin it, edit the summary, re-run summarization with your current model, export to Markdown/JSON/text, or delete it. <b>← Library</b> takes you back to the grid.',
        eyebrow: 'Detail',
        needsData: true
    },
    // ── Ask Vault walkthrough ─────────────────────────────────────────────
    {
        view: 'ask',
        target: '.cv-ask-pill',
        title: 'Ask your vault',
        body: 'Ask natural-language questions across everything you’ve saved. Retrieval-augmented generation pulls the most relevant chunks and answers with citations back to the source contexts. Press <kbd>A</kbd>.',
        eyebrow: 'RAG'
    },
    {
        view: 'ask',
        target: '#ask-scope-dd',
        title: 'Scope the search',
        body: 'Answer across <b>All contexts</b>, or narrow the search to a single collection when you only want answers from one project or topic.',
        eyebrow: 'RAG'
    },
    {
        view: 'ask',
        target: '#ask-send-btn',
        title: 'Send & cite',
        body: 'Hit send (or <kbd>Enter</kbd>) to get a grounded answer with inline citations you can click to open the exact context it came from.',
        eyebrow: 'RAG'
    },
    // ── Sidebar tools ─────────────────────────────────────────────────────
    {
        view: 'input',
        target: '#collections-section',
        title: 'Collections',
        body: 'Group related contexts by topic, project, or client. Click <b>+</b> to create one — pick a color, give it a name, then assign contexts from the Library.',
        eyebrow: 'Organize'
    },
    {
        view: 'input',
        target: '#modeToggle',
        title: 'Light & Dark',
        body: 'Switch between <b>Light</b> and <b>Dark</b> mode anytime — your choice is remembered across sessions.',
        eyebrow: 'Personalize'
    },
    {
        view: 'input',
        target: '#btn-settings',
        title: 'Settings & Models',
        body: 'Pick which Ollama model handles summarization and which handles Q&A. Tweak chunk sizes, temperature, and retrieval depth here.',
        eyebrow: 'Configure'
    },
    {
        view: 'input',
        target: '#status-indicator',
        title: 'System & health',
        body: 'The pulsing dot shows live backend status. Click it to open <b>System</b> (Ollama connection, live logs) or <b>Restart Backend</b>.',
        eyebrow: 'Health'
    },
    {
        view: 'input',
        target: null,
        title: 'You are ready ⚡',
        body: 'Hit <b>Quick Capture</b> to save your first conversation, or jump to <b>Ask Vault</b> if you already have data. You can replay this tour any time from the sidebar → <i>Take the Tour</i>.',
        eyebrow: 'Done'
    }
];

let _cvOnboardIdx = 0;
let _cvOnboardActive = false;
let _cvOnboardName = null; // typed name, preserved across step navigation
let _cvSteps = CV_ONBOARD_STEPS;  // active steps for the current run (data-filtered)
let _cvFirstCtxId = null;          // a real context id, for the detail-page walkthrough
let _cvOnboardBusy = false;        // guards against navigating while a step is loading

// Wait until `selector` exists in the DOM (views/data render async), or time out.
function _cvWaitFor(selector, timeout = 1600) {
    return new Promise(resolve => {
        if (!selector || document.querySelector(selector)) return resolve(true);
        const start = performance.now();
        (function check() {
            if (document.querySelector(selector)) return resolve(true);
            if (performance.now() - start > timeout) return resolve(false);
            requestAnimationFrame(check);
        })();
    });
}

function _cvOnboardEls() {
    return {
        root: document.getElementById('cv-onboard'),
        hole: document.getElementById('cv-onboard-hole'),
        ring: document.getElementById('cv-onboard-ring'),
        card: document.getElementById('cv-onboard-card'),
        title: document.getElementById('cv-onboard-title'),
        body: document.getElementById('cv-onboard-body'),
        step: document.getElementById('cv-onboard-step'),
        eyebrow: document.getElementById('cv-onboard-eyebrow'),
        prog: document.getElementById('cv-onboard-progress-fill'),
        back: document.getElementById('cv-onboard-back'),
        next: document.getElementById('cv-onboard-next'),
        skip: document.getElementById('cv-onboard-skip'),
    };
}

function _cvOnboardPosition(step) {
    const els = _cvOnboardEls();
    const { hole, ring, card } = els;
    const pad = 8;
    const cardMargin = 16;
    const cardW = card.offsetWidth || 380;
    const cardH = card.offsetHeight || 220;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (!step.target) {
        hole.setAttribute('width', 0);
        hole.setAttribute('height', 0);
        ring.setAttribute('width', 0);
        ring.setAttribute('height', 0);
        card.classList.add('is-centered');
        card.style.top = '';
        card.style.left = '';
        card.style.transform = '';
        return;
    }
    const targetEl = document.querySelector(step.target);
    if (!targetEl) {
        hole.setAttribute('width', 0);
        hole.setAttribute('height', 0);
        card.classList.add('is-centered');
        return;
    }
    const r = targetEl.getBoundingClientRect();
    // Clamp each edge independently to the viewport, then derive size from the
    // clamped edges. Deriving w/h from r.width + pad*2 instead would push the
    // cutout sideways whenever an edge clamps (e.g. the left-flush sidebar),
    // leaving an asymmetric, slightly-off highlight.
    const x = Math.max(4, r.left - pad);
    const y = Math.max(4, r.top - pad);
    const w = Math.min(vw - 4, r.right + pad) - x;
    const h = Math.min(vh - 4, r.bottom + pad) - y;
    hole.setAttribute('x', x);
    hole.setAttribute('y', y);
    hole.setAttribute('width', w);
    hole.setAttribute('height', h);
    ring.setAttribute('x', x);
    ring.setAttribute('y', y);
    ring.setAttribute('width', w);
    ring.setAttribute('height', h);

    card.classList.remove('is-centered');
    let cardLeft, cardTop;
    const spaceRight = vw - (x + w);
    const spaceLeft = x;
    const spaceBelow = vh - (y + h);
    const spaceAbove = y;

    if (spaceRight >= cardW + cardMargin) {
        cardLeft = x + w + cardMargin;
        cardTop = Math.max(cardMargin, Math.min(vh - cardH - cardMargin, y + h / 2 - cardH / 2));
    } else if (spaceLeft >= cardW + cardMargin) {
        cardLeft = x - cardW - cardMargin;
        cardTop = Math.max(cardMargin, Math.min(vh - cardH - cardMargin, y + h / 2 - cardH / 2));
    } else if (spaceBelow >= cardH + cardMargin) {
        cardTop = y + h + cardMargin;
        cardLeft = Math.max(cardMargin, Math.min(vw - cardW - cardMargin, x + w / 2 - cardW / 2));
    } else if (spaceAbove >= cardH + cardMargin) {
        cardTop = y - cardH - cardMargin;
        cardLeft = Math.max(cardMargin, Math.min(vw - cardW - cardMargin, x + w / 2 - cardW / 2));
    } else {
        cardLeft = (vw - cardW) / 2;
        cardTop = (vh - cardH) / 2;
    }
    card.style.left = cardLeft + 'px';
    card.style.top = cardTop + 'px';
    card.style.transform = 'none';
}

function _cvOnboardRender() {
    const els = _cvOnboardEls();
    const step = _cvSteps[_cvOnboardIdx];
    const total = _cvSteps.length;
    els.title.textContent = step.title;
    els.body.innerHTML = step.body;
    els.eyebrow.textContent = step.eyebrow || 'Tour';
    els.step.textContent = (_cvOnboardIdx + 1) + ' / ' + total;
    els.prog.style.width = (((_cvOnboardIdx + 1) / total) * 100) + '%';
    els.back.disabled = _cvOnboardIdx === 0;
    els.next.textContent = _cvOnboardIdx === total - 1 ? 'Finish' : 'Next';

    if (step.nameCapture) {
        const input = document.getElementById('cv-onboard-name-input');
        if (input) {
            // Restore typed value, falling back to any name already on file.
            const seed = (_cvOnboardName !== null)
                ? _cvOnboardName
                : ((_settingsConfig && _settingsConfig.user_name) || '');
            input.value = seed;
            input.addEventListener('input', () => { _cvOnboardName = input.value; });
            input.addEventListener('keydown', (e) => {
                // Enter advances; let the global handler do it, but stop arrow keys
                // from being hijacked into step navigation while typing.
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation();
            });
            setTimeout(() => { try { input.focus(); input.select(); } catch (e) {} }, 60);
        }
    }

    if (step.target) {
        const t = document.querySelector(step.target);
        if (t && typeof t.scrollIntoView === 'function') {
            try { t.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch (e) {}
        }
    }
    // The target keeps moving for a beat after render — the view fades in with a
    // translateY transition (~0.2s) and scrollIntoView animates. Track it every
    // frame for a short window so the spotlight settles exactly on the element
    // instead of snapping to where it started.
    requestAnimationFrame(() => _cvOnboardSettle(step));
}

// Re-position the spotlight each frame for ~0.5s so it follows the target
// through the view's fade-in transform and any smooth-scroll before it rests.
function _cvOnboardSettle(step) {
    const start = performance.now();
    (function tick() {
        if (!_cvOnboardActive || _cvSteps[_cvOnboardIdx] !== step) return;
        _cvOnboardPosition(step);
        if (performance.now() - start < 520) requestAnimationFrame(tick);
    })();
}

// Persist the onboarding name to config and refresh the dashboard greeting.
async function _cvOnboardSaveName() {
    const name = (_cvOnboardName || '').trim();
    if (!name) return;
    try {
        await fetch(`${API}/api/setup/save-profile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                about: (_settingsConfig && _settingsConfig.user_about) || '',
            }),
        });
        if (_settingsConfig) _settingsConfig.user_name = name;
        const nameEl = document.getElementById('cv-greeting-name');
        if (nameEl) nameEl.textContent = name + '.';
    } catch (e) {
        console.warn('Failed to save onboarding name', e);
    }
}

// Navigate to a step: run its `before` hook, switch views, wait for the target
// to render, then draw the spotlight. Async because views/data load lazily.
async function _cvOnboardGoto(idx) {
    if (idx < 0 || idx >= _cvSteps.length) return;
    _cvOnboardBusy = true;
    _cvOnboardIdx = idx;
    const step = _cvSteps[idx];
    try {
        if (typeof step.before === 'function') { try { await step.before(); } catch (e) {} }
        if (step.view && typeof navigateTo === 'function' && state.view !== step.view) {
            try { navigateTo(step.view); } catch (e) {}
        }
        if (step.target) await _cvWaitFor(step.target);
    } finally {
        _cvOnboardBusy = false;
    }
    // Re-check we weren't dismissed while awaiting.
    if (_cvOnboardActive) _cvOnboardRender();
}

async function startOnboarding() {
    const els = _cvOnboardEls();
    if (!els.root) return;

    // Find out whether the vault has data — drives which steps are shown and
    // which real context we open for the detail-page walkthrough.
    _cvFirstCtxId = null;
    try {
        const res = await fetch(`${API}/api/contexts?page=1&per_page=1`);
        if (res.ok) {
            const data = await res.json();
            const items = Array.isArray(data) ? data : (data.items || data.contexts || []);
            if (items.length) _cvFirstCtxId = items[0].id;
        }
    } catch (e) {}
    const hasData = _cvFirstCtxId != null;
    _cvSteps = CV_ONBOARD_STEPS.filter(s => !s.needsData || hasData);

    _cvOnboardIdx = 0;
    _cvOnboardActive = true;
    els.root.classList.add('is-open');
    els.root.setAttribute('aria-hidden', 'false');
    _cvOnboardGoto(0);
}

function endOnboarding(markComplete) {
    if (markComplete === undefined) markComplete = true;
    // Capture a name the user typed even if they skip before advancing.
    if (_cvOnboardName && _cvOnboardName.trim()
        && _cvOnboardName.trim() !== ((_settingsConfig && _settingsConfig.user_name) || '')) {
        _cvOnboardSaveName();
    }
    const els = _cvOnboardEls();
    if (!els.root) return;
    els.root.classList.remove('is-open');
    els.root.setAttribute('aria-hidden', 'true');
    _cvOnboardActive = false;
    _cvOnboardBusy = false;
    if (markComplete) {
        try { localStorage.setItem(CV_ONBOARD_KEY, '1'); } catch (e) {}
    }
    // Leave the user back on the dashboard, not wherever the tour wandered.
    if (typeof navigateTo === 'function' && state.view !== 'input') {
        try { navigateTo('input'); } catch (e) {}
    }
}

function _cvOnboardNext() {
    if (_cvOnboardBusy) return;
    const cur = _cvSteps[_cvOnboardIdx];
    if (cur && cur.nameCapture) _cvOnboardSaveName();
    if (_cvOnboardIdx >= _cvSteps.length - 1) {
        endOnboarding(true);
        return;
    }
    _cvOnboardGoto(_cvOnboardIdx + 1);
}
function _cvOnboardBack() {
    if (_cvOnboardBusy || _cvOnboardIdx === 0) return;
    _cvOnboardGoto(_cvOnboardIdx - 1);
}

function _initOnboardingControls() {
    const els = _cvOnboardEls();
    if (!els.root || els.root.dataset.bound) return;
    els.root.dataset.bound = '1';
    els.next.addEventListener('click', _cvOnboardNext);
    els.back.addEventListener('click', _cvOnboardBack);
    els.skip.addEventListener('click', () => endOnboarding(true));
    document.addEventListener('keydown', (e) => {
        if (!_cvOnboardActive) return;
        if (e.key === 'Escape') { endOnboarding(true); }
        else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); _cvOnboardNext(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); _cvOnboardBack(); }
    });
    window.addEventListener('resize', () => {
        if (_cvOnboardActive) _cvOnboardPosition(_cvSteps[_cvOnboardIdx]);
    });
    const replayBtn = document.getElementById('btn-onboard-replay');
    if (replayBtn) replayBtn.addEventListener('click', () => {
        // It now lives in the Settings modal — close that first so the tour can
        // point at the sidebar/app elements behind it.
        try { closeSettingsModal(); } catch (e) {}
        startOnboarding();
    });
}

async function maybeStartOnboarding() {
    _initOnboardingControls();
    let seen = '';
    try { seen = localStorage.getItem(CV_ONBOARD_KEY) || ''; } catch (e) {}
    if (seen) return;

    // Only true new users (empty vault) get the auto-tour.
    // Anyone with existing contexts is silently marked onboarded.
    let isNewUser = false;
    try {
        const res = await fetch(`${API}/api/contexts?page=1&per_page=1`);
        if (res.ok) {
            const data = await res.json();
            const items = Array.isArray(data) ? data : (data.items || data.contexts || []);
            const total = (typeof data.total === 'number') ? data.total : items.length;
            isNewUser = total === 0;
        }
    } catch (e) {
        // Backend unreachable — don't auto-trigger; user can still replay manually.
        return;
    }

    if (isNewUser) {
        setTimeout(() => startOnboarding(), 650);
    } else {
        try { localStorage.setItem(CV_ONBOARD_KEY, '1'); } catch (e) {}
    }
}

window.startOnboarding = startOnboarding;
window.endOnboarding = endOnboarding;

export { maybeStartOnboarding };
