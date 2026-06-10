// ContextVolt — Auto-update panel.
import { API } from './core.js';

// ── Auto-update ──────────────────────────────────────────────────────────────

let _updateInfo = null;

function _fmtBytes(b) {
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function _setUpdateState(state) {
    ['idle', 'available', 'downloading', 'ready'].forEach(s => {
        const el = document.getElementById(`update-state-${s}`);
        if (el) el.style.display = s === state ? '' : 'none';
    });
}

async function checkForUpdate(silent = true) {
    const statusEl = document.getElementById('update-check-status');
    if (!silent && statusEl) statusEl.textContent = 'Checking…';

    try {
        const res = await fetch(`${API}/api/update/check`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        _updateInfo = data;

        const currentEl = document.getElementById('update-current-version');
        if (currentEl) currentEl.textContent = `v${data.current_version}`;

        // Stamp last-checked time
        try {
            const stamp = Date.now();
            localStorage.setItem('cv_update_last_checked', String(stamp));
            _renderLastChecked(stamp);
        } catch (_) {}

        if (data.update_available) {
            // Show red dot on nav item
            const dot = document.getElementById('update-nav-dot');
            if (dot) dot.style.display = '';

            const latestEl = document.getElementById('update-latest-version');
            if (latestEl) latestEl.textContent = data.latest_version;

            const notesEl = document.getElementById('update-notes');
            if (notesEl) notesEl.textContent = data.release_notes || '';

            const linkEl = document.getElementById('update-changelog-link');
            if (linkEl && data.html_url) linkEl.href = data.html_url;

            _setUpdateState('available');
            if (!silent && statusEl) statusEl.textContent = '';
        } else {
            _setUpdateState('idle');
            if (!silent && statusEl) {
                statusEl.textContent = data.error
                    ? `Could not check: ${data.error}`
                    : `You're on the latest version (v${data.current_version})`;
            }
        }
    } catch (e) {
        if (!silent && statusEl) statusEl.textContent = `Check failed: ${e.message}`;
    }
}

async function _downloadAndInstallUpdate() {
    if (!_updateInfo?.download_url) return;

    _setUpdateState('downloading');
    const pctEl  = document.getElementById('update-progress-pct');
    const barEl  = document.getElementById('update-progress-bar');
    const byteEl = document.getElementById('update-progress-bytes');

    const url = encodeURIComponent(_updateInfo.download_url);
    const res = await fetch(`${API}/api/update/download?url=${url}`);
    if (!res.ok || !res.body) {
        _setUpdateState('available');
        return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
                const msg = JSON.parse(line.slice(6));
                if (msg.error) { _setUpdateState('available'); return; }
                if (msg.progress >= 0 && pctEl) pctEl.textContent = `${msg.progress}%`;
                if (barEl) barEl.style.width = `${Math.max(0, msg.progress)}%`;
                if (byteEl && msg.total > 0) byteEl.textContent = `${_fmtBytes(msg.downloaded)} / ${_fmtBytes(msg.total)}`;
                if (msg.done) { _setUpdateState('ready'); return; }
            } catch (_) {}
        }
    }
}

async function _applyUpdate() {
    await fetch(`${API}/api/update/apply`, { method: 'POST' });
}

function _renderLastChecked(stamp) {
    const el = document.getElementById('update-last-checked');
    if (!el) return;
    if (!stamp) { el.textContent = 'Never checked'; return; }
    const s = Math.floor((Date.now() - stamp) / 1000);
    let when;
    if (s < 45) when = 'just now';
    else if (s < 3600) when = `${Math.floor(s/60)}m ago`;
    else if (s < 86400) when = `${Math.floor(s/3600)}h ago`;
    else when = new Date(stamp).toLocaleString();
    el.textContent = `Last checked ${when}`;
}

function _initUpdatePanel() {
    const checkBtn = document.getElementById('btn-check-update');
    if (checkBtn) checkBtn.addEventListener('click', () => checkForUpdate(false));

    // Restore last-checked timestamp
    try {
        const raw = localStorage.getItem('cv_update_last_checked');
        if (raw) _renderLastChecked(parseInt(raw, 10));
    } catch (_) {}

    const dlBtn = document.getElementById('btn-download-update');
    if (dlBtn) dlBtn.addEventListener('click', _downloadAndInstallUpdate);

    const applyBtn = document.getElementById('btn-apply-update');
    if (applyBtn) applyBtn.addEventListener('click', _applyUpdate);

    // Populate current version immediately from health endpoint
    fetch(`${API}/api/health`).then(r => r.json()).then(d => {
        if (!d.version) return;
        const el = document.getElementById('update-current-version');
        if (el) el.textContent = `v${d.version}`;
        const brand = document.querySelector('.cv-brand-text .v');
        if (brand) brand.textContent = `v${d.version}`;
    }).catch(() => {});

    // Silent background check 3s after app loads
    setTimeout(() => checkForUpdate(true), 3000);
}

export { _initUpdatePanel };
