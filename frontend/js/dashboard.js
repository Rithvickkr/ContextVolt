// ContextVolt — Dashboard view.
import { _AI_BRAND, _CAPTURE_TAGS, _getAIBrand } from './badges.js';
import { API, escapeHtml, state } from './core.js';
import { _primeSettingsConfig, _settingsConfig, _settingsConfigPromise } from './settings.js';
import { _askLoadSession, askVault } from './ask.js';
// ─── Dashboard ────────────────────────────────────────────────────────
function _getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
}

function _getDayString() {
    return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function _animateCountUp(el, target, suffix = '') {
    const duration = 600;
    const start = performance.now();
    const from = 0;
    function step(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        // ease-out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(from + (target - from) * eased);
        el.textContent = current.toLocaleString() + suffix;
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}
function _timeAgo(dateStr) {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diff = Math.max(0, now - then);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Accent colours per collection/tag category
const _CV_ACCENTS = [
    'var(--cv-volt)',
    'oklch(0.72 0.18 280)',
    'oklch(0.78 0.18 145)',
    'oklch(0.78 0.15 30)',
    'oklch(0.72 0.18 200)',
    'oklch(0.75 0.18 320)',
];

function _ctxTags(ctx) {
    return Array.isArray(ctx.tags) ? ctx.tags
        : (ctx.tags ? String(ctx.tags).split(',').map(t => t.trim()).filter(Boolean) : []);
}

// Recent contexts — dense list rows (replaces the old 3×2 card grid).
function _renderRecentRow(ctx, idx = 0) {
    const summary = typeof ctx.summary === 'string' ? {} : (ctx.summary || {});
    const title = escapeHtml(ctx.title || 'Untitled');
    const date = _timeAgo(ctx.created_at);
    const tags = _ctxTags(ctx);
    const brand = _getAIBrand(tags);
    const accent = brand ? brand.color : _CV_ACCENTS[ctx.id % _CV_ACCENTS.length];

    const desc = summary.snapshot ? escapeHtml(summary.snapshot)
        : (summary.key_ideas && summary.key_ideas.length > 0 ? escapeHtml(summary.key_ideas[0]) : '');

    const aiPill = brand
        ? `<span class="cv-card-ai" data-ai="${escapeHtml(brand.key)}" style="--ai-color:${brand.color};">
              <span class="cv-card-ai-dot" aria-hidden="true"></span>${escapeHtml(brand.label)}
           </span>`
        : `<span class="cv-card-ai cv-card-ai-generic"><span class="cv-card-ai-dot" aria-hidden="true"></span>Context</span>`;

    const star = (ctx.starred || ctx.is_starred)
        ? `<svg class="cv-row-star" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
        : '';

    const tagHtml = tags
        .filter(t => !_AI_BRAND[t] && !_CAPTURE_TAGS.has(t))
        .slice(0, 1)
        .map(t => `<span class="cv-tag">#${escapeHtml(t)}</span>`)
        .join('');

    return `<button type="button" class="cv-row" style="--accent:${accent};--i:${idx};" onclick="showDetail(${ctx.id})">
        <span class="cv-row-rail" aria-hidden="true"></span>
        <div class="cv-row-mid">
            <span class="cv-row-title">${star}${title}</span>
            ${desc ? `<span class="cv-row-sub">${desc}</span>` : ''}
        </div>
        <span class="cv-row-meta">
            ${tagHtml}
            ${aiPill}
            <span class="cv-row-time">${date}</span>
        </span>
    </button>`;
}

// Pinned rail cards — brand pill + age on top, 2-line title below.
function _renderPinnedCard(ctx, idx = 0) {
    const title = escapeHtml(ctx.title || 'Untitled');
    const tags = _ctxTags(ctx);
    const brand = _getAIBrand(tags);
    const aiPill = brand
        ? `<span class="cv-card-ai" data-ai="${escapeHtml(brand.key)}" style="--ai-color:${brand.color};">
              <span class="cv-card-ai-dot" aria-hidden="true"></span>${escapeHtml(brand.label)}
           </span>`
        : `<span class="cv-card-ai cv-card-ai-generic"><span class="cv-card-ai-dot" aria-hidden="true"></span>Context</span>`;
    return `<button type="button" class="cv-pin-card" style="--i:${idx};" onclick="showDetail(${ctx.id})" title="${title}">
        <span class="cv-pin-top">
            <svg class="cv-pin-star" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            ${aiPill}
            <span class="cv-pin-date">${_timeAgo(ctx.created_at)}</span>
        </span>
        <span class="cv-pin-title">${title}</span>
    </button>`;
}

function _renderPinnedRail(pinned) {
    const panel = document.getElementById('dashboard-pinned-panel');
    const row   = document.getElementById('dashboard-pinned-row');
    const count = document.getElementById('cv-pinned-count');
    if (!panel || !row) return;
    if (!pinned || pinned.length === 0) {
        panel.style.display = 'none';
        row.innerHTML = '';
        return;
    }
    panel.style.display = '';
    if (count) count.textContent = String(pinned.length);
    row.classList.toggle('scroll', pinned.length > 4);
    row.innerHTML = pinned.map((ctx, i) => _renderPinnedCard(ctx, i)).join('');
}

// Activity sparkline — stacked capture/ask bars, one per day.
function _renderActivity(activity) {
    const el = document.getElementById('dashboard-activity');
    const axisEl = document.getElementById('dashboard-activity-axis');
    if (!el) return;
    if (!activity || activity.length === 0) {
        el.innerHTML = '';
        if (axisEl) axisEl.innerHTML = '';
        return;
    }
    const max = Math.max(1, ...activity.map(d => (d.captures || 0) + (d.asks || 0)));
    const fmtDay = d => new Date(d.date + 'T00:00:00')
        .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const lastIdx = activity.length - 1;
    el.innerHTML = activity.map((d, idx) => {
        const cap = d.captures || 0, ask = d.asks || 0;
        const total = cap + ask;
        const hCap = Math.round((cap / max) * 100);
        const hAsk = Math.round((ask / max) * 100);
        const dayName = idx === lastIdx ? 'Today' : fmtDay(d);
        const tip = `${dayName} — ${cap} capture${cap === 1 ? '' : 's'}, ${ask} ask${ask === 1 ? '' : 's'}`;
        const cls = 'cv-spark-col' + (total === 0 ? ' empty' : '') + (idx === lastIdx ? ' today' : '');
        return `<span class="${cls}" style="--i:${idx};" title="${tip}">
            <i class="ask" style="height:${hAsk}%"></i>
            <i class="cap" style="height:${hCap}%"></i>
        </span>`;
    }).join('');
    if (axisEl) {
        const fmtShort = d => new Date(d.date + 'T00:00:00')
            .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const mid = activity[Math.floor(activity.length / 2)];
        axisEl.innerHTML = `<span>${fmtShort(activity[0])}</span><span>${fmtShort(mid)}</span><span>Today</span>`;
    }
}

// System rail — light status rows, fetched separately so a slow/down
// Ollama probe never blocks the main dashboard paint.
async function _renderSystem() {
    const el = document.getElementById('dashboard-system');
    if (!el) return;
    try {
        const res = await fetch(`${API}/api/system/status`);
        if (!res.ok) throw new Error('status fetch failed');
        const s = await res.json();
        const ollamaOk = s.ollama && s.ollama.running;
        const modelOk  = s.model && s.model.ready;
        const prov     = s.active_provider || {};
        const db       = s.database || {};
        const row = (ok, label, value) => `
            <div class="cv-sys-row">
                <span class="cv-sys-dot ${ok ? 'ok' : 'warn'}" aria-hidden="true"></span>
                <span class="cv-sys-label">${escapeHtml(label)}</span>
                <span class="cv-sys-val">${escapeHtml(value)}</span>
            </div>`;
        el.innerHTML = [
            row(ollamaOk && modelOk, `Local · ${s.model ? s.model.name : '—'}`, ollamaOk ? (modelOk ? 'ready' : 'no model') : 'offline'),
            row(true, `Provider · ${prov.model || '—'}`, prov.is_cloud ? 'cloud' : 'local'),
            row(true, 'Vault', `${db.contexts ?? 0} ctx · ${db.size_mb ?? 0} MB`),
        ].join('');
    } catch (err) {
        el.innerHTML = `<div class="cv-sys-row"><span class="cv-sys-dot warn"></span><span class="cv-sys-label">Status unavailable</span></div>`;
    }
}

// Suggestion chips under the ask bar: two starters + resume-last-session.
const _STARTER_QS = [
    'What topics have I discussed most?',
    'Summarize my recent conversations',
];

function _renderAskChips(sessions) {
    const el = document.getElementById('dash-ask-chips');
    if (!el) return;
    el.innerHTML = '';

    const mkChip = (label, cls = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `cv-dash-chip${cls ? ' ' + cls : ''}`;
        b.innerHTML = label;
        return b;
    };

    const tryLabel = document.createElement('span');
    tryLabel.className = 'cv-dash-chips-label';
    tryLabel.textContent = 'Try:';
    el.appendChild(tryLabel);

    _STARTER_QS.forEach(q => {
        const chip = mkChip(escapeHtml(q));
        chip.addEventListener('click', () => {
            if (state.askStreaming) return;
            window.navigateTo('ask');
            askVault(q);
        });
        el.appendChild(chip);
    });

    const last = sessions && sessions[0];
    if (last && last.title) {
        const t = last.title.length > 38 ? last.title.slice(0, 35) + '…' : last.title;
        const chip = mkChip(`↻ Resume: “${escapeHtml(t)}”`, 'resume');
        chip.addEventListener('click', () => {
            if (state.askStreaming) return;
            window.navigateTo('ask');
            _askLoadSession(last.id);
        });
        el.appendChild(chip);
    }
}

// Sidebar — last three Ask sessions, one click resumes.
function _renderRecentAsks(sessions) {
    const sec  = document.getElementById('recent-asks-section');
    const list = document.getElementById('recent-asks-list');
    if (!sec || !list) return;
    if (!sessions || sessions.length === 0) {
        sec.style.display = 'none';
        list.innerHTML = '';
        return;
    }
    sec.style.display = '';
    list.innerHTML = '';
    sessions.forEach(s => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cv-recent-ask';
        b.title = s.title || 'Untitled session';
        b.innerHTML = `
            <span class="cv-recent-ask-ic" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/></svg>
            </span>
            <span class="cv-recent-ask-t">${escapeHtml(s.title || 'Untitled session')}</span>`;
        b.addEventListener('click', () => {
            if (state.askStreaming) return;
            window.navigateTo('ask');
            _askLoadSession(s.id);
        });
        list.appendChild(b);
    });
}

// True after the first successful render this session. Revisits then skip the
// skeletons and entrance animations — the dashboard updates in place instead
// of visibly "reloading" every time you navigate back to it.
let _dashRendered = false;

async function loadDashboard() {
    const firstRender = !_dashRendered;
    if (!firstRender) document.body.classList.add('cv-dash-settled');

    // Update hero greeting synchronously
    const eyebrow = document.getElementById('cv-hero-eyebrow');
    if (eyebrow) eyebrow.textContent = `${_getGreeting()} · ${_getDayString()}`;

    // Show skeleton immediately — before any network call (first load only;
    // on revisits the previous content stays put until fresh data swaps in)
    const gridEl  = document.getElementById('dashboard-recent-grid');
    const emptyEl = document.getElementById('dashboard-recent-empty');
    if (firstRender) {
        document.querySelectorAll('.cv-stat').forEach(el => el.classList.add('skel'));
        if (gridEl) {
            if (emptyEl) emptyEl.style.display = 'none';
            for (let i = 0; i < 4; i++) {
                const d = document.createElement('div');
                d.className = 'cv-skel-row';
                gridEl.appendChild(d);
            }
        }
    }

    // System panel loads independently — never blocks the main paint.
    _renderSystem();

    // Fetch user name in background — does not block stats fetch
    const nameEl = document.getElementById('cv-greeting-name');
    if (nameEl) {
        const nameP = (_settingsConfig && _settingsConfig.user_name)
            ? Promise.resolve(_settingsConfig.user_name)
            : (_settingsConfigPromise
                ? _settingsConfigPromise.then(() => (_settingsConfig && _settingsConfig.user_name) || '')
                : fetch(`${API}/api/setup/config`).then(r => r.json()).then(d => { _primeSettingsConfig(d); return d.user_name || ''; }).catch(() => ''));
        nameP.then(name => { nameEl.textContent = (name || 'User') + '.'; });
    }

    try {
        const res = await fetch(`${API}/api/dashboard`);
        if (!res.ok) throw new Error('Dashboard fetch failed');
        const data = await res.json();
        const stats = data.stats || {};
        const recent = data.recent || [];

        // Animate stat values
        const ctxVal         = document.getElementById('stat-contexts-val');
        const collectionsVal = document.getElementById('stat-collections-val');
        const asksVal        = document.getElementById('stat-asks-val');
        const weekVal        = document.getElementById('stat-week-val');

        // Count-up only on the first load; on revisits set values directly so
        // the numbers don't visibly re-roll every time.
        const setStat = (el, v) => {
            if (!el) return;
            if (firstRender) _animateCountUp(el, v);
            else el.textContent = v.toLocaleString();
        };
        setStat(ctxVal,         stats.contexts           || 0);
        setStat(collectionsVal, stats.collections        || 0);
        setStat(asksVal,        stats.questions_asked    || 0);
        setStat(weekVal,        stats.contexts_this_week || 0);

        _renderPinnedRail(data.pinned || []);
        _renderActivity(data.activity || []);
        _renderAskChips(data.ask_sessions || []);
        _renderRecentAsks(data.ask_sessions || []);

        const shown = recent.slice(0, 8);

        // Update idx badge
        const idxEl = document.getElementById('cv-recent-idx');
        if (idxEl && stats.contexts) idxEl.textContent = `showing ${shown.length} of ${stats.contexts}`;

        // Render recent contexts
        if (gridEl) {
            if (shown.length > 0) {
                const rowsHtml = shown.map((ctx, i) => _renderRecentRow(ctx, i)).join('');
                gridEl.innerHTML = '';
                if (emptyEl) { emptyEl.style.display = 'none'; gridEl.appendChild(emptyEl); }
                gridEl.insertAdjacentHTML('beforeend', rowsHtml);
            } else {
                gridEl.innerHTML = '';
                if (emptyEl) { gridEl.appendChild(emptyEl); emptyEl.style.display = ''; }
            }
        }

        // Stat card spotlight
        document.querySelectorAll('.cv-stat').forEach(el => {
            if (el.dataset.fxBound) return;
            el.dataset.fxBound = '1';
            el.addEventListener('pointermove', e => {
                const r = el.getBoundingClientRect();
                el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
                el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
            });
            el.addEventListener('pointerleave', () => {
                el.style.setProperty('--mx', '50%');
                el.style.setProperty('--my', '50%');
            });
        });

        _dashRendered = true;

    } catch (err) {
        console.error('Dashboard load error:', err);
        // Restore empty state on error
        if (gridEl && emptyEl) { gridEl.innerHTML = ''; gridEl.appendChild(emptyEl); emptyEl.style.display = ''; }
    } finally {
        document.querySelectorAll('.cv-stat').forEach(el => el.classList.remove('skel'));
        document.querySelectorAll('.cv-skel-row').forEach(el => el.remove());
    }
}

function _attachCardEffects(container) {
    container.querySelectorAll('.cv-card').forEach(el => {
        // Radial spotlight
        el.addEventListener('pointermove', e => {
            const r = el.getBoundingClientRect();
            el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
            el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
        });
        el.addEventListener('pointerleave', () => {
            el.style.setProperty('--mx', '50%');
            el.style.setProperty('--my', '50%');
            el.style.transform = '';
        });
        // Subtle 3-D tilt
        el.addEventListener('pointermove', e => {
            const r = el.getBoundingClientRect();
            const x = (e.clientX - r.left) / r.width - 0.5;
            const y = (e.clientY - r.top) / r.height - 0.5;
            el.style.transform = `translateY(-2px) perspective(900px) rotateX(${(-y * 3).toFixed(2)}deg) rotateY(${(x * 3).toFixed(2)}deg)`;
        });
    });
}


export { _CV_ACCENTS, _attachCardEffects, _timeAgo, loadDashboard };
