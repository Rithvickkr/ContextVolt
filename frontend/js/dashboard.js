// ContextVolt — Dashboard view.
import { _AI_BRAND, _CAPTURE_TAGS, _getAIBrand } from './badges.js';
import { API, escapeHtml } from './core.js';
import { _primeSettingsConfig, _settingsConfig, _settingsConfigPromise } from './settings.js';
// â”€â”€â”€ Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// Mirrors the Library card language (AI dot + label, title, snapshot, quiet
// tags) so recently-saved items look the same everywhere they appear.
function _renderRecentCard(ctx) {
    const summary = typeof ctx.summary === 'string' ? {} : (ctx.summary || {});
    const title = escapeHtml(ctx.title || 'Untitled');
    const date = _timeAgo(ctx.created_at);
    const tags = Array.isArray(ctx.tags) ? ctx.tags : (ctx.tags ? String(ctx.tags).split(',').map(t => t.trim()).filter(Boolean) : []);
    const brand = _getAIBrand(tags);
    const accent = brand ? brand.color : _CV_ACCENTS[ctx.id % _CV_ACCENTS.length];

    const desc = summary.snapshot ? escapeHtml(summary.snapshot)
        : (summary.key_ideas && summary.key_ideas.length > 0 ? escapeHtml(summary.key_ideas[0]) : '');

    const tagHtml = tags
        .filter(t => !_AI_BRAND[t] && !_CAPTURE_TAGS.has(t))
        .slice(0, 2)
        .map(t => `<span class="cv-tag">#${escapeHtml(t)}</span>`)
        .join('');

    const aiPill = brand
        ? `<span class="cv-card-ai" data-ai="${escapeHtml(brand.key)}" style="--ai-color:${brand.color};">
              <span class="cv-card-ai-dot" aria-hidden="true"></span>${escapeHtml(brand.label)}
           </span>`
        : `<span class="cv-card-ai cv-card-ai-generic"><span class="cv-card-ai-dot" aria-hidden="true"></span>Context</span>`;

    return `<article class="cv-card" style="--accent:${accent};" onclick="showDetail(${ctx.id})">
        <div class="cv-card-top">
            ${aiPill}
            <span class="cv-card-date">${date}</span>
        </div>
        <h3>${title}</h3>
        ${desc ? `<p>${desc}</p>` : ''}
        <div class="cv-card-foot">
            ${tagHtml}
        </div>
    </article>`;
}

// Pinned strip: one-line chip-cards — star, brand dot, title, age.
function _renderPinnedCard(ctx) {
    const title = escapeHtml(ctx.title || 'Untitled');
    const tags = Array.isArray(ctx.tags) ? ctx.tags : [];
    const brand = _getAIBrand(tags);
    const dotColor = brand ? brand.color : 'var(--cv-text-3)';
    return `<button type="button" class="cv-pin-card" onclick="showDetail(${ctx.id})" title="${title}">
        <svg class="cv-pin-star" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        <span class="cv-card-ai-dot" style="--ai-color:${dotColor};" aria-hidden="true"></span>
        <span class="cv-pin-title">${title}</span>
        <span class="cv-pin-date">${_timeAgo(ctx.created_at)}</span>
    </button>`;
}

function _renderPinnedRow(pinned) {
    const head = document.getElementById('dashboard-pinned-head');
    const row  = document.getElementById('dashboard-pinned-row');
    if (!head || !row) return;
    if (!pinned || pinned.length === 0) {
        head.style.display = 'none';
        row.style.display = 'none';
        row.innerHTML = '';
        return;
    }
    head.style.display = '';
    row.style.display = '';
    row.innerHTML = pinned.map(_renderPinnedCard).join('');
}

async function loadDashboard() {
    // Update hero greeting synchronously
    const eyebrow = document.getElementById('cv-hero-eyebrow');
    if (eyebrow) eyebrow.textContent = `${_getGreeting()} · ${_getDayString()}`;

    // Show skeleton immediately — before any network call
    document.querySelectorAll('.cv-stat').forEach(el => el.classList.add('skel'));
    const gridEl  = document.getElementById('dashboard-recent-grid');
    const emptyEl = document.getElementById('dashboard-recent-empty');
    if (gridEl) {
        if (emptyEl) emptyEl.style.display = 'none';
        for (let i = 0; i < 3; i++) {
            const d = document.createElement('div');
            d.className = 'cv-skel-card';
            gridEl.appendChild(d);
        }
    }

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

        if (ctxVal)         _animateCountUp(ctxVal,         stats.contexts            || 0);
        if (collectionsVal) _animateCountUp(collectionsVal, stats.collections         || 0);
        if (asksVal)        _animateCountUp(asksVal,        stats.questions_asked     || 0);
        if (weekVal)        _animateCountUp(weekVal,        stats.contexts_this_week  || 0);

        _renderPinnedRow(data.pinned || []);

        // Show at most 6 — keeps the grid an even 3×2; "See all" covers the rest.
        const shown = recent.slice(0, 6);

        // Update idx badge
        const idxEl = document.getElementById('cv-recent-idx');
        if (idxEl && stats.contexts) idxEl.textContent = `${shown.length} / ${stats.contexts}`;

        // Render recent contexts
        if (gridEl) {
            if (shown.length > 0) {
                const cardsHtml = shown.map(ctx => _renderRecentCard(ctx)).join('');
                gridEl.innerHTML = '';
                if (emptyEl) { emptyEl.style.display = 'none'; gridEl.appendChild(emptyEl); }
                gridEl.insertAdjacentHTML('beforeend', cardsHtml);
                _attachCardEffects(gridEl);
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

    } catch (err) {
        console.error('Dashboard load error:', err);
        // Restore empty state on error
        if (gridEl && emptyEl) { gridEl.innerHTML = ''; gridEl.appendChild(emptyEl); emptyEl.style.display = ''; }
    } finally {
        document.querySelectorAll('.cv-stat').forEach(el => el.classList.remove('skel'));
        document.querySelectorAll('.cv-skel-card').forEach(el => el.remove());
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
