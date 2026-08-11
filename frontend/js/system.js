// ContextVolt — Status indicator, system modal, restart, backup, embeddings rebuild.
import { $, API, escapeHtml } from './core.js';
import { showConfirm, showToast } from './dialogs.js';
// â”€â”€â”€ Status Indicator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function updateStatusIndicator(online, label) {
    const dot = $('.status-dot');
    const text = $('.status-text');
    if (online) {
        dot.classList.add('online');
        dot.classList.remove('offline');
        text.textContent = label || 'LLM Ready';
    } else {
        dot.classList.remove('online');
        dot.classList.add('offline');
        text.textContent = 'LLM Offline';
    }
}

// ─── GPU diagnostic banner ──────────────────────────────────────────────────
// Warns hybrid-GPU laptop users when inference landed on the integrated GPU
// instead of a faster dedicated NVIDIA card. Dismissal is per-session so we
// don't nag, but it re-checks on the next launch.
let _gpuBannerWired = false;

function _wireGpuBanner() {
    if (_gpuBannerWired) return;
    _gpuBannerWired = true;
    const dismiss = $('#cv-gpu-banner-dismiss');
    const fix = $('#cv-gpu-banner-fix');
    if (dismiss) dismiss.addEventListener('click', () => {
        sessionStorage.setItem('cv-gpu-banner-dismissed', '1');
        $('#cv-gpu-banner').hidden = true;
    });
    if (fix) fix.addEventListener('click', async () => {
        if (fix.disabled) return;
        fix.disabled = true;
        const original = fix.textContent;
        fix.textContent = 'Switching…';
        try {
            const res = await fetch(`${API}/api/gpu/prefer-nvidia`, { method: 'POST' });
            if (!res.ok) throw new Error();
            $('#cv-gpu-banner').hidden = true;
            showToast('Ollama restarted — it will use your NVIDIA GPU now', 'success');
        } catch {
            showToast('Could not restart Ollama automatically — try restarting it manually', 'error');
        } finally {
            fix.textContent = original;
            fix.disabled = false;
        }
    });
}

async function checkGpuDiagnostic() {
    const banner = $('#cv-gpu-banner');
    if (!banner) return;
    if (sessionStorage.getItem('cv-gpu-banner-dismissed')) return;
    try {
        const res = await fetch(`${API}/api/gpu/diagnostic`);
        if (!res.ok) return;
        const d = await res.json();
        if (d.warn) {
            const textEl = $('#cv-gpu-banner-text');
            if (textEl) textEl.textContent = d.detail || 'Your NVIDIA GPU is idle while a model runs on the integrated GPU.';
            _wireGpuBanner();
            banner.hidden = false;
        } else {
            banner.hidden = true;
        }
    } catch { /* backend unreachable — leave banner as-is */ }
}

// â”€â”€â”€ Rebuild Embeddings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function rebuildEmbeddings() {
    const btn = $('#btn-rebuild-embeddings');
    if (!btn) return;

    if (!await showConfirm({ title: 'Rebuild All Embeddings?', message: 'This will re-chunk and re-embed all saved contexts using the current embedding model. Existing embeddings will be replaced.', confirmLabel: 'Rebuild', danger: true })) return;

    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Starting…';

    try {
        const res = await fetch(`${API}/api/contexts/chunk-all?force=true`, { method: 'POST' });
        if (!res.ok) throw new Error('Request failed');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastData = null;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const data = JSON.parse(line);
                    lastData = data;
                    if (data.total > 0) {
                        btn.textContent = `Re-embedding… ${data.done} / ${data.total}`;
                    }
                } catch { /* ignore */ }
            }
        }

        if (lastData) {
            const msg = lastData.total === 0
                ? 'No contexts found'
                : `Re-embedded ${lastData.updated} contexts with new model (${lastData.skipped} skipped)`;
            showToast(msg, 'success');
        }
    } catch {
        showToast('Re-embed failed — check that your embed model is installed', 'error');
    } finally {
        btn.textContent = original;
        btn.disabled = false;
    }
}

// â”€â”€â”€ Restart Backend â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function restartBackend(btnEl) {
    // Bound as a click handler (receives an Event) and also called explicitly
    // with the hero button — fall back to the sidebar restart button otherwise.
    const btn = (btnEl instanceof HTMLElement) ? btnEl : $('#btn-restart');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('restarting');
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> Restarting…`;

    // Snapshot the current server token before restarting
    let startedAt = null;
    try {
        const r = await fetch(`${API}/api/health`);
        startedAt = (await r.json()).started_at ?? null;
    } catch { /* server already offline */ }

    try {
        await fetch(`${API}/api/restart`, { method: 'POST' });
    } catch { /* server may drop before sending a response — fine */ }

    // Hard fallback: reload after 10 s no matter what (prevents infinite spin)
    const hardTimeout = setTimeout(() => window.location.reload(), 10000);

    // Poll every 500 ms — reload as soon as started_at changes (new server instance)
    const poll = async () => {
        try {
            const r = await fetch(`${API}/api/health`);
            if (r.ok) {
                const d = await r.json();
                if (d.started_at !== startedAt) {
                    clearTimeout(hardTimeout);
                    window.location.reload();
                    return;
                }
            }
        } catch { /* still cycling */ }
        setTimeout(poll, 500);
    };
    setTimeout(poll, 800);
}

// â”€â”€â”€ System Status Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _sysAutoRefresh = null;

function openSystemModal() {
    const modal = $('#system-modal');
    modal.style.display = 'flex';
    _switchSystemTab('health');
    loadSystemHealth();
    // Auto-refresh health every 10 s while modal is open
    _sysAutoRefresh = setInterval(loadSystemHealth, 10000);
}

function closeSystemModal() {
    $('#system-modal').style.display = 'none';
    if (_sysAutoRefresh) { clearInterval(_sysAutoRefresh); _sysAutoRefresh = null; }
}

function _switchSystemTab(tab) {
    document.querySelectorAll('.system-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    $('#panel-health').style.display = tab === 'health' ? 'block' : 'none';
    $('#panel-logs').style.display   = tab === 'logs'   ? 'flex'  : 'none';
    if (tab === 'logs') {
        $('#panel-logs').style.flexDirection = 'column';
        loadSystemLogs();
    }
}

function _fmtUptime(s) {
    if (s < 60)   return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.floor(s/60)}m ${Math.round(s%60)}s`;
    return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

// SVG glyphs for the health cards / hero (kept tiny & inline)
const _SYS_ICONS = {
    backend:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    ollama:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>',
    llm:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4 4 4 0 0 1-4 4 4 4 0 0 1-4-4 4 4 0 0 1 4-4z"/><path d="M5 22v-5a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v5"/></svg>',
    embed:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>',
    database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>',
    models:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>',
    bolt:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    warn:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    restart:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
};

function _sysCard({ icon, label, dot, value, sub, mono = false, wide = false, bodyHtml = null }) {
    return `
        <div class="sys-card${wide ? ' wide' : ''}">
            <span class="sys-card-ic">${_SYS_ICONS[icon] || ''}</span>
            <div class="sys-card-body">
                ${bodyHtml !== null ? bodyHtml : `
                <div class="sys-card-header">
                    <span class="sys-card-label">${escapeHtml(label)}</span>
                    ${dot ? `<span class="sys-dot ${dot}"></span>` : ''}
                </div>
                <div class="sys-card-value${mono ? ' mono' : ''}">${escapeHtml(value)}</div>
                ${sub ? `<div class="sys-card-sub">${escapeHtml(sub)}</div>` : ''}`}
            </div>
        </div>`;
}

function _setOverall(state, text) {
    const pill = $('#sys-overall-pill');
    const txt  = $('#sys-overall-text');
    const hero = $('#sys-health-hero');
    if (pill) pill.dataset.state = state;
    if (txt)  txt.textContent = text;
    if (hero) hero.dataset.state = state;
}

async function loadSystemHealth() {
    const grid = $('#sys-status-grid');
    if (!grid) return;
    try {
        const res = await fetch(`${API}/api/system/status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();

        const isCloud = d.active_provider?.is_cloud;
        // The backend's "ollama" block reports whichever local engine is active
        // (built-in llama.cpp or Ollama); engine_label names it for display.
        const engineLabel = d.engine_label || 'Ollama';
        const isNativeEngine = d.inference_backend === 'native';
        const ollamaDot = d.ollama.running ? 'ok' : 'err';
        const modelReady = d.model.ready;
        const modelDot  = modelReady ? 'ok' : (d.ollama.running ? 'warn' : 'err');
        const modelSub  = modelReady ? 'Ready' : (d.ollama.running ? 'Not downloaded' : `${engineLabel} offline`);

        // ── Overall verdict ──
        let state = 'ok', verdict = "Everything's running", pillText = 'All systems operational';
        if (isCloud) {
            state = 'ok'; verdict = 'Running on cloud provider'; pillText = 'All systems operational';
        } else if (!d.ollama.running) {
            state = 'err';
            verdict = isNativeEngine ? 'No local model installed' : 'Ollama is offline';
            pillText = isNativeEngine ? 'Needs attention' : 'Service offline';
        } else if (!modelReady) {
            state = 'warn'; verdict = 'Model not downloaded'; pillText = 'Needs attention';
        }
        _setOverall(state, pillText);

        const heroEl = $('#sys-health-hero');
        if (heroEl) {
            const bits = [`Backend up ${_fmtUptime(d.backend.uptime_s)}`];
            bits.push(d.ollama.running ? `${engineLabel} ready` : `${engineLabel} offline`);
            bits.push(`${d.database.contexts} contexts indexed`);
            heroEl.hidden = false;
            heroEl.innerHTML = `
                <span class="sys-hero-ring">${state === 'ok' ? _SYS_ICONS.bolt : _SYS_ICONS.warn}</span>
                <div class="sys-hero-text">
                    <div class="sys-hero-title">${escapeHtml(verdict)}</div>
                    <div class="sys-hero-sub">${escapeHtml(bits.join(' · '))}</div>
                </div>
                <button class="sys-hero-restart" id="sys-hero-restart" type="button">${_SYS_ICONS.restart}Restart backend</button>`;
            const rb = $('#sys-hero-restart');
            if (rb) rb.addEventListener('click', () => restartBackend(rb));
        }

        const modelsHtml = d.installed_models.length
            ? `<div class="sys-models">${d.installed_models.map(m => `<span class="sys-model-chip"><span class="d"></span>${escapeHtml(m)}</span>`).join('')}</div>`
            : `<div class="sys-card-value" style="font-size:12px;color:var(--text-faint);font-weight:400;">None installed</div>`;

        grid.innerHTML = `
            <div class="sys-grouplabel">Services</div>
            ${_sysCard({ icon: 'backend', label: 'Backend', dot: 'ok', value: 'Online', sub: `Uptime: ${_fmtUptime(d.backend.uptime_s)}` })}
            ${_sysCard({ icon: 'ollama', label: engineLabel, dot: ollamaDot,
                         bodyHtml: `<div class="sys-card-header"><span class="sys-card-label">${escapeHtml(engineLabel)}</span><span class="sys-dot ${ollamaDot}"></span></div>
                                    <div class="sys-card-value">${d.ollama.running ? 'Running' : 'Offline'}</div>
                                    <div class="sys-card-sub" style="font-family:var(--font-mono);font-size:11px;">${escapeHtml(d.ollama.url)}</div>` })}

            <div class="sys-grouplabel">Models</div>
            ${_sysCard({ icon: 'llm', label: 'LLM Model', dot: modelDot, value: d.model.name, sub: modelSub, mono: true })}
            ${_sysCard({ icon: 'embed', label: 'Embed Model', dot: 'ok', value: d.embed.name, sub: 'local · always private', mono: true })}

            <div class="sys-grouplabel">Storage</div>
            ${_sysCard({ icon: 'database', label: 'Vault Database', dot: 'ok', wide: true,
                         bodyHtml: `<div class="sys-card-header"><span class="sys-card-label">Vault Database</span><span class="sys-dot ok"></span></div>
                                    <div class="sys-card-value">${d.database.contexts} contexts</div>
                                    <div class="sys-card-sub">${d.database.chunks} chunks · ${d.database.collections} collections · ${d.database.size_mb} MB on disk</div>` })}
            <div class="sys-card wide">
                <span class="sys-card-ic">${_SYS_ICONS.models}</span>
                <div class="sys-card-body">
                    <div class="sys-card-header"><span class="sys-card-label">Installed ${escapeHtml(engineLabel)} Models</span></div>
                    ${modelsHtml}
                </div>
            </div>`;
    } catch (e) {
        _setOverall('err', 'Unreachable');
        const hero = $('#sys-health-hero');
        if (hero) hero.hidden = true;
        grid.innerHTML = `<div class="sys-status-loading" style="color:var(--danger)">Could not reach backend: ${escapeHtml(e.message)}</div>`;
    }
}

// \u2500\u2500\u2500 Logs \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
let _logEntries = [];
let _logLevel = 'all';

function _logClass(level) {
    switch ((level || '').toUpperCase()) {
        case 'ERROR':   case 'CRITICAL': return 'log-error';
        case 'WARNING': case 'WARN':     return 'log-warning';
        case 'DEBUG':                    return 'log-debug';
        default:                         return 'log-info';
    }
}
function _logShortLevel(level) {
    const u = (level || 'INFO').toUpperCase();
    return u === 'WARNING' ? 'WARN' : (u.length > 5 ? u.slice(0, 5) : u);
}

function _renderLogs() {
    const viewer = $('#logs-viewer');
    if (!viewer) return;
    const term = ($('#logs-search')?.value || '').trim().toLowerCase();

    const matches = _logEntries.filter(e => {
        const u = (e.level || '').toUpperCase();
        if (_logLevel === 'info'    && u !== 'INFO') return false;
        if (_logLevel === 'warning' && u !== 'WARNING' && u !== 'WARN') return false;
        if (_logLevel === 'error'   && u !== 'ERROR' && u !== 'CRITICAL') return false;
        if (term && !(`${e.ts} ${e.level} ${e.msg}`.toLowerCase().includes(term))) return false;
        return true;
    });

    if (!matches.length) {
        viewer.innerHTML = '<div class="log-empty">No matching log entries.</div>';
        return;
    }

    viewer.innerHTML = matches.map(e => {
        const raw = `${e.ts ? e.ts + ' ' : ''}[${e.level}] ${e.msg}`;
        const rawAttr = escapeHtml(raw).replace(/"/g, '&quot;');
        return `<div class="log-line ${_logClass(e.level)}" data-raw="${rawAttr}">` +
               `<span class="log-ts">${escapeHtml(e.ts || '')}</span>` +
               `<span class="log-lvl">${escapeHtml(_logShortLevel(e.level))}</span>` +
               `<span class="log-msg">${escapeHtml(e.msg)}</span></div>`;
    }).join('');

    if ($('#logs-autoscroll')?.checked) viewer.scrollTop = viewer.scrollHeight;
}

function _updateLogCounts(entries, counts) {
    const lvl = (k) => counts?.[k] || 0;
    const setN = (id, n) => { const el = $(id); if (el) el.textContent = n; };
    setN('#logcnt-all', entries.length);
    setN('#logcnt-info', lvl('INFO'));
    setN('#logcnt-warning', lvl('WARNING') + lvl('WARN'));
    setN('#logcnt-error', lvl('ERROR') + lvl('CRITICAL'));

    const errBadge = $('#logs-error-count');
    const errN = lvl('ERROR') + lvl('CRITICAL');
    if (errBadge) {
        errBadge.hidden = errN === 0;
        errBadge.textContent = errN === 1 ? '1 error' : `${errN} errors`;
    }
}

// Wired in main.js \u2014 filter chips + search box.
function setLogLevel(level) {
    _logLevel = level;
    document.querySelectorAll('#log-filters .log-filter').forEach(b =>
        b.classList.toggle('on', b.dataset.lvl === level));
    _renderLogs();
}
function filterLogs() { _renderLogs(); }

async function loadSystemLogs() {
    const viewer = $('#logs-viewer');
    if (!viewer) return;
    const lines = parseInt($('#logs-lines-select')?.value || '100', 10);
    viewer.innerHTML = '<div class="sys-status-loading"><div class="sys-loader-spinner" aria-hidden="true"></div><span class="sys-loader-text">Loading logs\u2026</span></div>';
    try {
        const res = await fetch(`${API}/api/debug/logs?lines=${lines}`);
        if (!res.ok) throw new Error();
        const d = await res.json();
        _logEntries = Array.isArray(d.entries) ? d.entries : [];
        _updateLogCounts(_logEntries, d.counts || {});
        if (!d.exists || !_logEntries.length) {
            viewer.innerHTML = '<div class="log-empty">No log entries found.</div>';
            return;
        }
        _renderLogs();
    } catch {
        viewer.innerHTML = '<div class="sys-status-loading" style="color:var(--danger)">Failed to load logs.</div>';
    }
}

// â”€â”€â”€ Backup Vault â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function downloadBackup() {
    const btn = $('#btn-backup');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Backing up…`;
    try {
        const res = await fetch(`${API}/api/backup/download`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        a.href = url;
        a.download = `contextvolt_backup_${ts}.db`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Backup downloaded', 'success');
    } catch (e) {
        showToast('Backup failed: ' + e.message, 'error');
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
}


export { _switchSystemTab, checkGpuDiagnostic, closeSystemModal, downloadBackup, filterLogs, loadSystemLogs, openSystemModal, rebuildEmbeddings, restartBackend, setLogLevel, updateStatusIndicator };
