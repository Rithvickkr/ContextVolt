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
async function restartBackend() {
    const btn = $('#btn-restart');
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

async function loadSystemHealth() {
    const grid = $('#sys-status-grid');
    if (!grid) return;
    try {
        const res = await fetch(`${API}/api/system/status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();

        const ollamaDot  = d.ollama.running  ? 'ok'   : 'err';
        const modelDot   = d.model.ready     ? 'ok'   : (d.ollama.running ? 'warn' : 'err');
        const modelSub   = d.model.ready     ? 'Ready' : (d.ollama.running ? 'Not downloaded' : 'Ollama offline');

        const modelsHtml = d.installed_models.length
            ? `<ul class="sys-models-list">${d.installed_models.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
            : `<span style="color:var(--text-faint);font-size:11px;">None installed</span>`;

        grid.innerHTML = `
            <div class="sys-card">
                <div class="sys-card-header">
                    <span class="sys-card-label">Backend</span>
                    <span class="sys-dot ok"></span>
                </div>
                <div class="sys-card-value">Online</div>
                <div class="sys-card-sub">Uptime: ${_fmtUptime(d.backend.uptime_s)}</div>
            </div>
            <div class="sys-card">
                <div class="sys-card-header">
                    <span class="sys-card-label">Ollama</span>
                    <span class="sys-dot ${ollamaDot}"></span>
                </div>
                <div class="sys-card-value">${d.ollama.running ? 'Running' : 'Offline'}</div>
                <div class="sys-card-sub">${escapeHtml(d.ollama.url)}</div>
            </div>
            <div class="sys-card">
                <div class="sys-card-header">
                    <span class="sys-card-label">LLM Model</span>
                    <span class="sys-dot ${modelDot}"></span>
                </div>
                <div class="sys-card-value" style="font-size:13px;line-height:1.3">${escapeHtml(d.model.name)}</div>
                <div class="sys-card-sub">${modelSub}</div>
            </div>
            <div class="sys-card">
                <div class="sys-card-header">
                    <span class="sys-card-label">Embed Model</span>
                    <span class="sys-dot ok"></span>
                </div>
                <div class="sys-card-value" style="font-size:13px;line-height:1.3">${escapeHtml(d.embed.name)}</div>
                <div class="sys-card-sub">Embedding model</div>
            </div>
            <div class="sys-card">
                <div class="sys-card-header">
                    <span class="sys-card-label">Database</span>
                    <span class="sys-dot ok"></span>
                </div>
                <div class="sys-card-value">${d.database.contexts}</div>
                <div class="sys-card-sub">${d.database.chunks} chunks · ${d.database.collections} collections · ${d.database.size_mb} MB</div>
            </div>
            <div class="sys-card" style="grid-column: span 2;">
                <div class="sys-card-header" style="margin-bottom:6px;">
                    <span class="sys-card-label">Installed Ollama Models</span>
                </div>
                ${modelsHtml}
            </div>`;
    } catch (e) {
        grid.innerHTML = `<div class="sys-status-loading" style="color:var(--danger)">Could not reach backend: ${escapeHtml(e.message)}</div>`;
    }
}

async function loadSystemLogs() {
    const viewer = $('#logs-viewer');
    if (!viewer) return;
    const lines = parseInt($('#logs-lines-select')?.value || '100', 10);
    viewer.innerHTML = '<div class="sys-status-loading"><div class="sys-loader-spinner" aria-hidden="true"></div><span class="sys-loader-text">Loading logs\u2026</span></div>';
    try {
        const res = await fetch(`${API}/api/debug/logs?lines=${lines}`);
        if (!res.ok) throw new Error();
        const d = await res.json();
        if (!d.exists || !d.lines.length) {
            viewer.innerHTML = '<div class="log-empty">No log entries found.</div>';
            return;
        }
        viewer.innerHTML = d.lines.map(line => {
            const l = line.trimEnd();
            let cls = 'log-line';
            const u = l.toUpperCase();
            if (u.includes('[ERROR]')   || u.includes('ERROR:'))   cls += ' log-error';
            else if (u.includes('[WARNING]') || u.includes('WARNING:')) cls += ' log-warning';
            else if (u.includes('[DEBUG]'))                              cls += ' log-debug';
            else                                                          cls += ' log-info';
            return `<div class="${cls}">${escapeHtml(l)}</div>`;
        }).join('');
        if ($('#logs-autoscroll')?.checked) viewer.scrollTop = viewer.scrollHeight;
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


export { _switchSystemTab, closeSystemModal, downloadBackup, loadSystemLogs, openSystemModal, rebuildEmbeddings, restartBackend, updateStatusIndicator };
