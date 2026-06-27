// ContextVolt — Settings modal: models, providers, MCP server, tunnel.
import { $, $$, API, escapeHtml } from './core.js';
import { _showActionToast, releaseFocus, showConfirm, showToast, trapFocus } from './dialogs.js';
import { rebuildEmbeddings } from './system.js';
// â”€â”€â”€ Settings Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _settingsConfig = null; // last loaded config from backend
let _settingsConfigPromise = null; // in-flight fetch (deduplicated)

// Other modules (setup, dashboard) prime the cache from configs they already
// fetched; imported bindings are read-only, so the write lives here.
function _primeSettingsConfig(cfg) {
    _settingsConfig = _settingsConfig || cfg;
}

// ─── ConVX as MCP Server panel ──────────────────────────────────────────
// Populated each time the settings modal opens. Loopback-only endpoint —
// the backend rejects non-127.0.0.1 callers, so the token is safe to display.

let _mcpServerInfoCached = null;

function _setMcpStatus(state, text) {
    const el = $('#settings-mcp-status');
    if (!el) return;
    el.dataset.state = state;
    el.textContent = text;
}

async function _loadMcpServerPanel(force = false) {
    if (_mcpServerInfoCached && !force) {
        _renderMcpServerPanel(_mcpServerInfoCached);
        // Refresh in background to pick up token regenerations from elsewhere
        _fetchMcpServerInfo().then(info => {
            if (info) { _mcpServerInfoCached = info; _renderMcpServerPanel(info); }
        });
        return;
    }
    _setMcpStatus('loading', 'checking…');
    const info = await _fetchMcpServerInfo();
    if (info) {
        _mcpServerInfoCached = info;
        _renderMcpServerPanel(info);
    }
}

async function _fetchMcpServerInfo() {
    try {
        const r = await fetch(`${API}/api/mcp_server/info`);
        if (!r.ok) {
            _setMcpStatus('error', `unreachable (${r.status})`);
            return null;
        }
        return await r.json();
    } catch (e) {
        _setMcpStatus('error', 'unreachable');
        return null;
    }
}

function _renderMcpServerPanel(info) {
    if (!info) return;
    const urlInput   = $('#settings-mcp-http-url');
    const tokenInput = $('#settings-mcp-http-token');
    const authChk    = $('#settings-mcp-auth-required');
    const snippet    = $('#settings-mcp-stdio-snippet');

    if (urlInput)   urlInput.value   = info.http?.url || '';
    if (tokenInput) tokenInput.value = info.http?.token || '';
    if (authChk)    authChk.checked  = !!info.http?.auth_required;
    if (snippet)    snippet.textContent = info.stdio?.config_snippet || '';

    _setMcpStatus('ok', 'running');
}

function _initMcpServerPanelHandlers() {
    // Generic copy buttons (any element with data-copy-target)
    document.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-copy-target]');
        if (!btn) return;
        const target = document.getElementById(btn.dataset.copyTarget);
        if (!target) return;
        const value = target.value !== undefined ? target.value : target.textContent;
        try {
            await navigator.clipboard.writeText(value || '');
            const orig = btn.textContent;
            btn.textContent = 'Copied';
            btn.classList.add('settings-mcp-btn-success');
            setTimeout(() => {
                btn.textContent = orig;
                btn.classList.remove('settings-mcp-btn-success');
            }, 1200);
        } catch {
            showToast('Copy failed', 'error');
        }
    });

    // Show/hide token
    const toggle = $('#settings-mcp-token-toggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const input = $('#settings-mcp-http-token');
            if (!input) return;
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            toggle.textContent = showing ? 'Show' : 'Hide';
            toggle.setAttribute('aria-pressed', String(!showing));
        });
    }

    // Regenerate token
    const regen = $('#settings-mcp-token-regen');
    if (regen) {
        regen.addEventListener('click', async () => {
            if (!confirm('Regenerating revokes the old token immediately. Any client using it will need the new value. Continue?')) return;
            regen.disabled = true;
            try {
                const r = await fetch(`${API}/api/mcp_server/regenerate_token`, { method: 'POST' });
                if (!r.ok) throw new Error(`status ${r.status}`);
                const data = await r.json();
                const input = $('#settings-mcp-http-token');
                if (input) input.value = data.token || '';
                if (_mcpServerInfoCached?.http) _mcpServerInfoCached.http.token = data.token;
                showToast('Token regenerated', 'success');
            } catch (e) {
                showToast(`Regenerate failed: ${e.message}`, 'error');
            } finally {
                regen.disabled = false;
            }
        });
    }

    // Auth-required toggle
    const authChk = $('#settings-mcp-auth-required');
    if (authChk) {
        authChk.addEventListener('change', async () => {
            const required = authChk.checked;
            try {
                const r = await fetch(`${API}/api/mcp_server/auth_required`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ required }),
                });
                if (!r.ok) throw new Error(`status ${r.status}`);
                if (_mcpServerInfoCached?.http) _mcpServerInfoCached.http.auth_required = required;
                showToast(required ? 'Bearer token now required' : 'Auth disabled — be careful', required ? 'success' : 'warning');
            } catch (e) {
                authChk.checked = !required; // revert
                showToast(`Update failed: ${e.message}`, 'error');
            }
        });
    }
}

// ─── Cloudflare Tunnel panel ──────────────────────────────────────────────────

let _tunnelPollTimer = null;
let _tunnelInfo = null;   // last known status

const _TUNNEL_PLATFORM_CONFIGS = {
    'claude-ai': (url, _token) => {
        const base = url.replace(/\/mcp$/, '');
        return {
            steps: [
                'Open <b>claude.ai</b> → avatar → <b>Settings</b> → <b>Integrations</b>',
                'Click <b>Add integration</b> and paste the MCP URL below',
                'Claude.ai will redirect you to a ContextVolt "Allow Access" page — click <b>Allow</b>',
            ],
            snippet: null,
            snippetLabel: null,
            fields: [
                { label: 'MCP URL', value: url },
                { label: 'OAuth authorize', value: `${base}/oauth/authorize` },
                { label: 'OAuth token', value: `${base}/oauth/token` },
            ],
        };
    },
    'chatgpt': (url, token) => ({
        steps: [
            'Open <b>chatgpt.com</b> → Settings → <b>Connected apps</b>',
            'Click <b>Add MCP server</b> and enter the URL below',
            'Add <code>Authorization: Bearer &lt;token&gt;</code> as a custom header',
        ],
        snippet: null,
        snippetLabel: null,
        fields: [
            { label: 'MCP URL', value: url },
            { label: 'Bearer token', value: token },
        ],
    }),
    'grok': (url, _token) => {
        const base = url.replace(/\/mcp$/, '');
        return {
            steps: [
                'Go to <b>grok.com/connectors</b> → <b>New Connector</b>',
                'Paste the values below into the OAuth form — leave Client Secret empty',
                'Click <b>Save &amp; Connect</b> → Grok opens a browser tab → click <b>Allow Access</b>',
            ],
            snippet: null,
            snippetLabel: null,
            fields: [
                { label: 'Client ID', value: 'convx' },
                { label: 'Client Secret', value: '(leave empty)' },
                { label: 'Authorization Endpoint', value: `${base}/oauth/authorize` },
                { label: 'Token Endpoint', value: `${base}/oauth/token` },
                { label: 'Scopes', value: '(leave empty)' },
                { label: 'Token Auth Method', value: 'none (PKCE only, recommended)' },
            ],
        };
    },
    'cursor': (url, token) => ({
        steps: [
            'Open <b>~/.cursor/mcp.json</b> (global) or <b>.cursor/mcp.json</b> in your project',
            'Add the snippet below, then restart Cursor',
        ],
        snippet: JSON.stringify({
            mcpServers: {
                contextvolt: {
                    url,
                    headers: { Authorization: `Bearer ${token}` },
                },
            },
        }, null, 2),
        snippetLabel: 'Paste into ~/.cursor/mcp.json',
        fields: null,
    }),
    'claude-desktop': (url, token) => ({
        steps: [
            'Open Claude Desktop → Settings → <b>Developer</b> → <b>Edit Config</b>',
            'Add the snippet below to your <code>claude_desktop_config.json</code>',
            'Restart Claude Desktop',
        ],
        snippet: JSON.stringify({
            mcpServers: {
                contextvolt: {
                    url,
                    headers: { Authorization: `Bearer ${token}` },
                },
            },
        }, null, 2),
        snippetLabel: 'Paste into claude_desktop_config.json',
        fields: null,
    }),
};

function _renderTunnelPlatformContent(platform, mcpUrl, token) {
    const el = $('#tunnel-platform-content');
    if (!el) return;
    const cfg = (_TUNNEL_PLATFORM_CONFIGS[platform] || _TUNNEL_PLATFORM_CONFIGS['claude-ai'])(mcpUrl, token);
    let html = '<div class="tunnel-platform-body">';

    // Steps
    if (cfg.steps?.length) {
        html += '<ol class="tunnel-steps">';
        cfg.steps.forEach(s => { html += `<li>${s}</li>`; });
        html += '</ol>';
    }

    // Key-value fields (URL / token)
    if (cfg.fields?.length) {
        cfg.fields.forEach(f => {
            const id = `tunnel-field-${f.label.replace(/\s+/g, '-').toLowerCase()}`;
            html += `
            <div class="settings-mcp-row" style="margin-top:8px;">
                <label class="settings-mcp-label">${f.label}</label>
                <div class="settings-mcp-input-row">
                    <input type="text" class="settings-mcp-input" id="${id}" readonly value="${_esc(f.value)}">
                    <button type="button" class="settings-mcp-btn" data-copy-target="${id}">Copy</button>
                </div>
            </div>`;
        });
    }

    // JSON snippet
    if (cfg.snippet) {
        const snippetId = 'tunnel-snippet-' + platform;
        html += `
        <div class="settings-mcp-row" style="margin-top:8px;">
            <label class="settings-mcp-label">${cfg.snippetLabel || 'Config snippet'}</label>
            <div class="settings-mcp-input-row settings-mcp-input-row-stack">
                <pre class="settings-mcp-code" id="${snippetId}">${_esc(cfg.snippet)}</pre>
                <button type="button" class="settings-mcp-btn" data-copy-target="${snippetId}">Copy JSON</button>
            </div>
        </div>`;
    }

    html += '</div>';
    el.innerHTML = html;
}

function _esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _renderTunnelPanel(data) {
    _tunnelInfo = data;
    const badge   = $('#tunnel-badge');
    const urlInput = $('#tunnel-url-input');
    const copyBtn  = $('#tunnel-copy-btn');
    const toggleBtn = $('#tunnel-toggle-btn');
    const helpText  = $('#tunnel-help-text');
    const platformSection = $('#tunnel-platform-section');

    if (!badge) return;

    const { status, mcp_url, error } = data;

    badge.dataset.state = status;
    const labels = { stopped:'stopped', downloading:'downloading…', starting:'connecting…', running:'running', error:'error' };
    badge.textContent = labels[status] || status;

    const running = status === 'running';
    const busy    = status === 'downloading' || status === 'starting';

    if (urlInput) urlInput.value = running && mcp_url ? mcp_url : '';
    if (copyBtn)  copyBtn.disabled = !running;

    if (toggleBtn) {
        toggleBtn.textContent = running ? 'Stop Tunnel' : (busy ? '…' : 'Start Tunnel');
        toggleBtn.disabled = busy;
        toggleBtn.classList.toggle('settings-mcp-btn-danger', running);
        toggleBtn.classList.toggle('settings-mcp-btn-primary', !running);
    }

    if (helpText) {
        if (error) {
            helpText.innerHTML = `<span style="color:var(--danger,#f87171)">Error: ${_esc(error)}</span>`;
        } else if (running) {
            helpText.textContent = "Tunnel active — your vault's /mcp endpoint is reachable over HTTPS. Pick a platform below to get its connection config.";
        } else if (busy) {
            helpText.textContent = status === 'downloading'
                ? 'Downloading cloudflared (~40 MB)…'
                : 'Establishing tunnel — this usually takes 5–10 seconds…';
        } else {
            helpText.textContent = 'cloudflared is downloaded once and cached. Your vault stays on your machine — only /mcp is exposed, protected by your bearer token.';
        }
    }

    if (platformSection) platformSection.style.display = running ? 'block' : 'none';

    // If running, refresh the active platform tab
    if (running && mcp_url) {
        const active = $('.tunnel-tab.active');
        const plat = active?.dataset?.platform || 'claude-ai';
        const token = _mcpServerInfoCached?.http?.token || '';
        _renderTunnelPlatformContent(plat, mcp_url, token);
    }
}

async function _fetchTunnelStatus() {
    try {
        const r = await fetch(`${API}/api/mcp_server/tunnel`);
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    }
}

async function _loadTunnelPanel() {
    const data = await _fetchTunnelStatus();
    if (data) _renderTunnelPanel(data);
}

function _startTunnelPoll() {
    _stopTunnelPoll();
    _tunnelPollTimer = setInterval(async () => {
        const data = await _fetchTunnelStatus();
        if (!data) return;
        _renderTunnelPanel(data);
        // Stop polling once stable
        if (data.status === 'running' || data.status === 'stopped' || data.status === 'error') {
            _stopTunnelPoll();
        }
    }, 2000);
}

function _stopTunnelPoll() {
    if (_tunnelPollTimer) { clearInterval(_tunnelPollTimer); _tunnelPollTimer = null; }
}

function _initTunnelPanelHandlers() {
    const toggleBtn = $('#tunnel-toggle-btn');
    if (!toggleBtn) return;

    toggleBtn.addEventListener('click', async () => {
        const status = _tunnelInfo?.status || 'stopped';
        const running = status === 'running';
        toggleBtn.disabled = true;

        try {
            const endpoint = running ? '/api/mcp_server/tunnel/stop' : '/api/mcp_server/tunnel/start';
            const r = await fetch(`${API}${endpoint}`, { method: 'POST' });
            if (!r.ok) throw new Error(`status ${r.status}`);

            // Immediately refresh and start polling for transient states
            const data = await _fetchTunnelStatus();
            if (data) _renderTunnelPanel(data);
            if (!running) _startTunnelPoll();
        } catch (e) {
            showToast(`Tunnel error: ${e.message}`, 'error');
        } finally {
            toggleBtn.disabled = false;
        }
    });

    // Platform tab switching
    document.addEventListener('click', (e) => {
        const tab = e.target.closest('.tunnel-tab');
        if (!tab) return;
        document.querySelectorAll('.tunnel-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const plat = tab.dataset.platform;
        const mcp_url = _tunnelInfo?.mcp_url || '';
        const token = _mcpServerInfoCached?.http?.token || '';
        _renderTunnelPlatformContent(plat, mcp_url, token);
    });
}

function _prefetchSettingsConfig() {
    if (_settingsConfig || _settingsConfigPromise) return;
    _settingsConfigPromise = fetch(`${API}/api/setup/config`)
        .then(r => r.json())
        .then(data => { _settingsConfig = data; _settingsConfigPromise = null; })
        .catch(() => { _settingsConfigPromise = null; });
}

function _showSettingsSkeletons() {
    const llmGrid   = $('#settings-llm-grid');
    const embedGrid = $('#settings-embed-grid');
    const skels = n => Array.from({length: n}, () => '<div class="settings-skeleton-card"></div>').join('');
    llmGrid.innerHTML   = skels(3);
    embedGrid.innerHTML = skels(4);
}

// ─── Profile avatar (initial letter + chosen color) ─────────────────────
const AVATAR_KEY = 'cv-avatar-color';
const AVATAR_DEFAULT = '#6366f1';
let _avatarPickerBound = false;

function _applyAvatarColor(color) {
    document.documentElement.style.setProperty('--cv-avatar-color', color);
    document.querySelectorAll('.settings-avatar-swatch').forEach(sw => {
        sw.classList.toggle('selected', sw.dataset.avatarColor === color);
    });
}

function _updateAvatarFace() {
    const nm = (($('#profile-name-input') || {}).value || (_settingsConfig || {}).user_name || '').trim();
    const av = $('#settings-avatar');
    const nameEl = $('#settings-avatar-name');
    if (av) av.textContent = (nm[0] || 'U').toUpperCase();
    if (nameEl) nameEl.textContent = nm || 'Your profile';
}

function _initProfileAvatar() {
    _applyAvatarColor(localStorage.getItem(AVATAR_KEY) || AVATAR_DEFAULT);
    _updateAvatarFace();
    if (_avatarPickerBound) return;
    _avatarPickerBound = true;
    document.querySelectorAll('.settings-avatar-swatch').forEach(sw => {
        sw.addEventListener('click', () => {
            const color = sw.dataset.avatarColor;
            localStorage.setItem(AVATAR_KEY, color);
            _applyAvatarColor(color);
        });
    });
    const nameInput = $('#profile-name-input');
    if (nameInput) nameInput.addEventListener('input', _updateAvatarFace);
}

async function openSettingsModal() {
    const modal = $('#settings-modal');
    modal.style.display = 'flex';

    // Profile avatar (initial + saved color) + swatch handlers
    _initProfileAvatar();

    // Reset warning
    $('#settings-embed-warning').classList.remove('visible');

    // Keyboard trap — keep focus inside while open
    trapFocus(modal.querySelector('.settings-modal'), $('#btn-settings'));

    // Load the ConVX-as-MCP-server panel in parallel — independent of provider config
    _loadMcpServerPanel();
    _loadTunnelPanel();

    // If already cached, render instantly — no loading state needed
    if (_settingsConfig) {
        _renderSettingsCards();
        // Refresh in background to pick up any install changes
        fetch(`${API}/api/setup/config`)
            .then(r => r.json())
            .then(data => { _settingsConfig = data; _renderSettingsCards(); })
            .catch(() => {});
        return;
    }

    // Show skeleton cards while loading
    _showSettingsSkeletons();

    try {
        // Reuse the in-flight prefetch if it's already running
        if (_settingsConfigPromise) await _settingsConfigPromise;
        if (!_settingsConfig) {
            const res = await fetch(`${API}/api/setup/config`);
            _settingsConfig = await res.json();
        }
        _renderSettingsCards();
    } catch {
        showToast('Could not load config', 'error');
    }
}

function closeSettingsModal() {
    // Detach card references so downloads continue headlessly
    for (const dl of _downloads.values()) dl.card = null;

    const overlay = $('#settings-modal');
    const inner = overlay.querySelector('.settings-modal');
    releaseFocus(inner);
    inner.style.animation = 'shellOut 0.18s var(--ease) forwards';
    overlay.style.animation = 'fadeOut 0.18s var(--ease) forwards';
    setTimeout(() => {
        overlay.style.display = 'none';
        inner.style.animation = '';
        overlay.style.animation = '';
    }, 180);
}

function _makeSettingsCard(item, selectedId, containerId, onSelect) {
    const card = document.createElement('div');
    card.className = 'settings-model-card' + (item.id === selectedId ? ' selected' : '')
                     + (item.fits_vram === false ? ' too-large' : '');
    card.dataset.id = item.id;
    card.dataset.installed = item.installed ? 'true' : 'false';

    const label = item.label || item.id;
    const desc  = item.desc  || '';
    const size  = item.size  || '';
    const rec   = item.recommended;
    const inst  = item.installed;
    const fitsVram = item.fits_vram !== false;

    const statusBadge = inst
        ? '<span class="settings-installed-badge">✓ Installed</span>'
        : '<span class="settings-not-installed-badge">Not downloaded</span>';

    const downloadIcon = `<svg class="settings-download-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M3 12h10"/></svg>`;

    card.innerHTML = `
        <div class="settings-model-card-left">
            <div class="settings-model-name">${escapeHtml(label)}</div>
            <div class="settings-model-desc">${escapeHtml(desc)}</div>
            <div class="settings-download-area" id="dl-area-${item.id.replace(/[:.]/g, '-')}" style="display:none;"></div>
        </div>
        <div class="settings-model-card-right">
            <span class="settings-status-badge" id="status-badge-${item.id.replace(/[:.]/g, '-')}">${statusBadge.replace(/<\/?span[^>]*>/g, '')}</span>
            ${rec ? '<span class="settings-model-badge">Recommended for your GPU</span>' : ''}
            ${!fitsVram ? '<span class="settings-model-badge-warn" title="Too large for your VRAM — will run slowly with constant reloads">Low VRAM</span>' : ''}
            <span class="settings-model-size">${escapeHtml(size)}</span>
            ${inst
                ? `<button class="settings-delete-btn" title="Delete model" aria-label="Delete ${escapeHtml(label)}">✕</button>`
                : `<span class="settings-dl-icon" title="Not downloaded">${downloadIcon}</span>`}
            <div class="settings-model-radio"></div>
        </div>`;

    // Apply correct class to status badge
    const badge = card.querySelector('.settings-status-badge');
    if (inst) {
        badge.className = 'settings-installed-badge';
        badge.textContent = '✓ Installed';
    } else {
        badge.className = 'settings-not-installed-badge';
        badge.textContent = 'Not downloaded';
    }

    // If this model is currently downloading (settings was closed mid-download),
    // reattach the card so progress is reflected again.
    if (_downloads.has(item.id)) {
        _downloads.get(item.id).card = card;
        _attachCardDownloadUI(item.id, card);
    }

    const deleteBtn = card.querySelector('.settings-delete-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const ok = await showConfirm({
                title: `Delete "${label}"?`,
                message: `This will remove the model from Ollama. You can re-download it later.`,
                confirmLabel: 'Delete',
                danger: true,
            });
            if (ok) _deleteModelInline(item.id, card, containerId, onSelect);
        });
    }

    card.addEventListener('click', async () => {
        document.querySelectorAll(`#${containerId} .settings-model-card`)
            .forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        onSelect(item.id);

        // Auto-pull if not installed and not already downloading
        // (consult dataset, not the stale `inst` closure — it goes stale after delete)
        if (card.dataset.installed !== 'true' && !card.classList.contains('downloading') && !_downloads.has(item.id)) {
            const ok = await showConfirm({
                title: `Download "${label}"?`,
                message: `${size ? size + ' — ' : ''}${desc || 'This model will be pulled from Ollama.'}`,
                confirmLabel: 'Download',
            });
            if (ok) _pullModelInline(item.id, card);
        }
    });

    return card;
}

async function _deleteModelInline(modelId, card, containerId, onSelect) {
    // Re-resolve card in case the grid was re-rendered while confirm was open
    const liveCard = document.querySelector(`.settings-model-card[data-id="${modelId}"]`);
    if (liveCard) card = liveCard;

    if (card.classList.contains('deleting') || card.classList.contains('downloading')) return;

    const safeId = modelId.replace(/[:.]/g, '-');
    const dlArea = card.querySelector(`#dl-area-${safeId}`);
    const badge = card.querySelector('.settings-installed-badge, .settings-not-installed-badge');
    const deleteBtn = card.querySelector('.settings-delete-btn');

    card.classList.add('deleting');
    if (badge) { badge.className = 'settings-not-installed-badge'; badge.textContent = 'Deleting…'; }
    if (deleteBtn) deleteBtn.disabled = true;

    if (dlArea) {
        dlArea.style.display = 'block';
        dlArea.innerHTML = `
            <div class="settings-download-bar-bg"><div class="settings-delete-bar-fill" id="dl-fill-${safeId}"></div></div>
            <div class="settings-dl-meta-row"><span class="settings-download-status" id="dl-status-${safeId}">Removing model files…</span></div>
        `;
    }

    // Animate fake progress: eases toward 85% until the request resolves
    let pct = 0;
    const fill = document.getElementById(`dl-fill-${safeId}`);
    const ticker = setInterval(() => {
        pct = Math.min(pct + (85 - pct) * 0.12, 84);
        if (fill) fill.style.width = pct.toFixed(1) + '%';
    }, 80);

    try {
        const res = await fetch(`${API}/api/setup/delete-model/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
        clearInterval(ticker);

        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Delete failed' }));
            throw new Error(err.detail || 'Delete failed');
        }

        // Complete the bar then clean up
        if (fill) fill.style.width = '100%';
        const statusEl = document.getElementById(`dl-status-${safeId}`);
        if (statusEl) statusEl.textContent = 'Deleted';

        setTimeout(() => {
            const wasSelected = card.classList.contains('selected');
            card.classList.remove('deleting', 'selected');
            card.dataset.installed = 'false';
            if (badge) { badge.className = 'settings-not-installed-badge'; badge.textContent = 'Not downloaded'; }
            if (deleteBtn) deleteBtn.remove();
            if (dlArea) dlArea.style.display = 'none';

            // Restore download icon so the card is immediately re-downloadable without a reload
            const right = card.querySelector('.settings-model-card-right');
            if (right && !right.querySelector('.settings-dl-icon')) {
                const dlIcon = document.createElement('span');
                dlIcon.className = 'settings-dl-icon';
                dlIcon.title = 'Not downloaded';
                dlIcon.innerHTML = `<svg class="settings-download-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M3 12h10"/></svg>`;
                const radio = right.querySelector('.settings-model-radio');
                if (radio) right.insertBefore(dlIcon, radio); else right.appendChild(dlIcon);
            }

            // Mirror the change in cached config so re-opening Settings reflects reality
            const allMeta = [
                ...(_settingsConfig?.available_models || []),
                ...(_settingsConfig?.available_embed_models || []),
            ];
            const meta = allMeta.find(m => m.id === modelId);
            if (meta) meta.installed = false;

            if (wasSelected) {
                const firstOther = document.querySelector(`#${containerId} .settings-model-card:not([class*="deleting"])`);
                if (firstOther) { firstOther.classList.add('selected'); onSelect(firstOther.dataset.id); }
            }
        }, 500);

        // Refresh authoritative config from server (non-blocking)
        fetch(`${API}/api/setup/config`).then(r => r.json()).then(d => { _settingsConfig = d; }).catch(() => {});

        showToast(`Model "${modelId}" deleted`, 'success');
    } catch (err) {
        clearInterval(ticker);
        card.classList.remove('deleting');
        if (badge) { badge.className = 'settings-installed-badge'; badge.textContent = '✓ Installed'; }
        if (deleteBtn) deleteBtn.disabled = false;
        if (dlArea) {
            if (fill) fill.style.width = '0%';
            const statusEl = document.getElementById(`dl-status-${safeId}`);
            if (statusEl) { statusEl.className = 'settings-download-error'; statusEl.textContent = err.message || 'Delete failed'; }
        }
        showToast(err.message || 'Delete failed', 'error');
    }
}

// ─── Global download tracker ──────────────────────────────────────────────────
// modelId → { label, size, pct, statusText, abortController, card, done, cancelled }
const _downloads = new Map();

function _dlBadgeHtml() {
    return `
        <div class="cv-dl-badge-head">
            <span class="cv-dl-badge-spinner"></span>
            <span class="cv-dl-badge-label"></span>
            <span class="cv-dl-badge-chevron">▾</span>
        </div>
        <div class="cv-dl-badge-head-bar"><div class="cv-dl-badge-head-bar-fill" style="width:0%"></div></div>
        <div class="cv-dl-badge-panel" id="cv-dl-panel"></div>`;
}

function _ensureDlBadge() {
    if (document.getElementById('cv-dl-badge')) return;
    const el = document.createElement('div');
    el.id = 'cv-dl-badge';
    el.className = 'cv-dl-badge';
    el.innerHTML = _dlBadgeHtml();
    const head = el.querySelector('.cv-dl-badge-head');
    if (head) head.addEventListener('click', () => el.classList.toggle('cv-dl-open'));
    document.body.appendChild(el);
}

function _updateDlBadge() {
    const active = [..._downloads.entries()].filter(([, d]) => !d.done && !d.cancelled);
    const badge = document.getElementById('cv-dl-badge');

    if (active.length === 0) {
        if (badge) badge.classList.remove('cv-dl-visible', 'cv-dl-open');
        return;
    }

    _ensureDlBadge();
    const el = document.getElementById('cv-dl-badge');
    el.classList.add('cv-dl-visible', 'cv-dl-open'); // auto-open panel when downloads are active

    const labelEl = el.querySelector('.cv-dl-badge-label');
    if (labelEl) {
        labelEl.textContent = active.length === 1
            ? `${active[0][1].label} — ${active[0][1].pct}%`
            : `${active.length} downloading`;
    }

    const avgPct = active.reduce((s, [, d]) => s + d.pct, 0) / active.length;
    const headBarFill = el.querySelector('.cv-dl-badge-head-bar-fill');
    if (headBarFill) headBarFill.style.width = Math.round(avgPct) + '%';

    // Reconcile rows in place — rebuilding innerHTML on every tick caused flicker
    const panel = el.querySelector('#cv-dl-panel');
    if (!panel) return;

    const activeIds = new Set(active.map(([id]) => id));

    // Remove rows for downloads that ended
    for (const child of [...panel.children]) {
        if (!activeIds.has(child.dataset.modelId)) child.remove();
    }

    for (const [modelId, dl] of active) {
        let item = panel.querySelector(`[data-model-id="${CSS.escape(modelId)}"]`);
        if (!item) {
            item = document.createElement('div');
            item.className = 'cv-dl-panel-item';
            item.dataset.modelId = modelId;
            item.innerHTML = `
                <div class="cv-dl-panel-row">
                    <span class="cv-dl-panel-name"></span>
                    <button class="cv-dl-panel-cancel" title="Cancel">&times;</button>
                </div>
                <div class="cv-dl-bar-bg"><div class="cv-dl-bar-fill"></div></div>
                <div class="cv-dl-panel-status"></div>`;
            item.querySelector('.cv-dl-panel-name').textContent = dl.label;
            item.querySelector('.cv-dl-panel-cancel').addEventListener('click', (e) => {
                e.stopPropagation();
                _cancelDownload(modelId);
            });
            panel.appendChild(item);
        }
        // Only touch the fields that change
        const fill = item.querySelector('.cv-dl-bar-fill');
        const status = item.querySelector('.cv-dl-panel-status');
        const newWidth = dl.pct + '%';
        if (fill.style.width !== newWidth) fill.style.width = newWidth;
        const newStatus = dl.statusText || 'Starting…';
        if (status.textContent !== newStatus) status.textContent = newStatus;
    }
}

function _cancelDownload(modelId) {
    const dl = _downloads.get(modelId);
    if (!dl || dl.done) return;
    dl.cancelled = true;
    dl.abortController.abort();
    _downloads.delete(modelId);
    _updateDlBadge();
    const card = dl.card;
    if (card) {
        card.classList.remove('downloading');
        const b = card.querySelector('.settings-installed-badge, .settings-not-installed-badge');
        if (b) { b.className = 'settings-not-installed-badge'; b.textContent = 'Not downloaded'; }
        const area = card.querySelector('.settings-download-area');
        if (area) area.style.display = 'none';
    }
}

function _updateDownloadCard(modelId) {
    const dl = _downloads.get(modelId);
    if (!dl || !dl.card) return;
    const safeId = modelId.replace(/[:.]/g, '-');
    const fill = dl.card.querySelector(`#dl-fill-${safeId}`);
    const pctEl = dl.card.querySelector(`#dl-pct-${safeId}`);
    const statusEl = dl.card.querySelector(`#dl-status-${safeId}`);
    if (fill) fill.style.width = dl.pct + '%';
    if (pctEl) pctEl.textContent = dl.pct + '%';
    if (statusEl) statusEl.textContent = dl.statusText || '';
}

function _attachCardDownloadUI(modelId, card) {
    const safeId = modelId.replace(/[:.]/g, '-');
    const dl = _downloads.get(modelId);
    const dlArea = card.querySelector('.settings-download-area');
    const badge = card.querySelector('.settings-installed-badge, .settings-not-installed-badge');
    card.classList.add('downloading');
    if (badge) { badge.className = 'settings-not-installed-badge'; badge.textContent = 'Downloading…'; }
    if (dlArea) {
        dlArea.style.display = 'block';
        dlArea.innerHTML = `
            <div class="settings-download-bar-bg"><div class="settings-download-bar-fill" id="dl-fill-${safeId}" style="width:${dl ? dl.pct : 0}%"></div></div>
            <div class="settings-dl-meta-row">
                <span class="settings-download-status" id="dl-status-${safeId}">${dl ? escapeHtml(dl.statusText || 'Starting…') : 'Starting…'}</span>
                <span class="settings-dl-pct" id="dl-pct-${safeId}">${dl ? dl.pct : 0}%</span>
                <button class="settings-dl-cancel-btn" title="Cancel download">&times;</button>
            </div>`;
        const cancelBtn = dlArea.querySelector('.settings-dl-cancel-btn');
        if (cancelBtn) cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _cancelDownload(modelId);
        });
    }
}

// ─── P2-3: Inline Model Download ─────────────────────────────────────────────
async function _pullModelInline(modelId, card) {
    // Re-resolve card in case settings grid was re-rendered while confirm was open
    const liveCard = document.querySelector(`.settings-model-card[data-id="${modelId}"]`);
    if (liveCard) card = liveCard;

    // Resolve label/size from cached config
    const allMeta = [
        ...(_settingsConfig?.available_models || []),
        ...(_settingsConfig?.available_embed_models || []),
    ];
    const meta = allMeta.find(m => m.id === modelId) || {};
    const label = meta.label || modelId;
    const size  = meta.size  || '';

    // Register in global tracker
    const abortController = new AbortController();
    _downloads.set(modelId, { label, size, pct: 0, statusText: 'Starting…', abortController, card, done: false, cancelled: false });
    _updateDlBadge();

    // Set up card UI
    if (card) _attachCardDownloadUI(modelId, card);

    try {
        const res = await fetch(`${API}/api/setup/pull-model-stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelId }),
            signal: abortController.signal,
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.detail || `Download failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const data = JSON.parse(line);
                    if (data.error) throw new Error(data.error);

                    const dl = _downloads.get(modelId);
                    if (!dl) return; // cancelled externally

                    if (data.total && data.completed) {
                        const pct = Math.round((data.completed / data.total) * 100);
                        const mb = (data.completed / (1024 * 1024)).toFixed(0);
                        const totalMb = (data.total / (1024 * 1024)).toFixed(0);
                        dl.pct = pct;
                        dl.statusText = `${data.status || 'Downloading'} — ${mb} / ${totalMb} MB (${pct}%)`;
                    } else {
                        dl.statusText = data.status || 'Processing…';
                    }

                    _updateDownloadCard(modelId);
                    _updateDlBadge();
                } catch (e) {
                    if (e.message && e.message !== line) throw e;
                }
            }
        }

        // ── Success ──
        const dl = _downloads.get(modelId);
        const finishedCard = dl?.card || null;
        _downloads.delete(modelId);
        _updateDlBadge();

        if (finishedCard) {
            finishedCard.dataset.installed = 'true';
            finishedCard.classList.remove('downloading');
            const b = finishedCard.querySelector('.settings-installed-badge, .settings-not-installed-badge');
            if (b) { b.className = 'settings-installed-badge'; b.textContent = '✓ Installed'; }
            const area = finishedCard.querySelector('.settings-download-area');
            if (area) area.style.display = 'none';
            // Swap download icon for delete button
            const right = finishedCard.querySelector('.settings-model-card-right');
            right?.querySelector('.settings-dl-icon')?.remove();
            right?.querySelector('.settings-dl-cancel-btn')?.remove();
            const radio = right?.querySelector('.settings-model-radio');
            if (right && radio) {
                const delBtn = document.createElement('button');
                delBtn.className = 'settings-delete-btn';
                delBtn.title = 'Delete model';
                delBtn.textContent = '✕';
                const capturedLabel = label;
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const ok = await showConfirm({ title: `Delete “${capturedLabel}”?`, message: 'This will remove the model from Ollama. You can re-download it later.', confirmLabel: 'Delete', danger: true });
                    if (ok) _deleteModelInline(modelId, finishedCard, finishedCard.closest('[id]')?.id || '', () => {});
                });
                right.insertBefore(delBtn, radio);
            }
        }

        // Refresh config so install state is current
        fetch(`${API}/api/setup/config`).then(r => r.json()).then(d => { _settingsConfig = d; }).catch(() => {});
        showToast(`Model “${label}” downloaded!`, 'success');

    } catch (err) {
        if (err.name === 'AbortError') return; // user cancelled

        const dl = _downloads.get(modelId);
        const failedCard = dl?.card || null;
        _downloads.delete(modelId);
        _updateDlBadge();

        if (failedCard) {
            failedCard.classList.remove('downloading');
            const b = failedCard.querySelector('.settings-installed-badge, .settings-not-installed-badge');
            if (b) { b.className = 'settings-not-installed-badge'; b.textContent = 'Download failed'; }
            const statusEl = failedCard.querySelector('.settings-download-status');
            if (statusEl) { statusEl.className = 'settings-download-error'; statusEl.textContent = err.message || 'Download failed'; }
        }

        showToast(err.message || 'Download failed', 'error');
    }
}

// Provider icon/color map. Cloud providers use the exact brand SVGs from frontend/logos/.
const _PROVIDER_META = {
    ollama: {
        label: 'Local (Ollama)', color: '#888',
        svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
        useBrandLogo: false,
    },
    openai: {
        label: 'OpenAI', color: '#10a37f',
        logo: '/static/logos/openai.svg',
        useBrandLogo: true,
    },
    anthropic: {
        label: 'Anthropic', color: '#d97757',
        logo: '/static/logos/anthropic.svg',
        useBrandLogo: true,
    },
    google: {
        label: 'Google Gemini', color: '#4285f4',
        logo: '/static/logos/gemini.svg',
        useBrandLogo: true,
    },
};

let _selectedProvider = 'ollama';
let _cloudKeyValid = {};  // { openai: true/false, ... }

function _renderGpuBanner(gpu, rec) {
    let banner = document.getElementById('gpu-info-banner');
    if (!banner) {
        const llmSection = document.getElementById('ollama-llm-section');
        if (!llmSection) return;
        banner = document.createElement('div');
        banner.id = 'gpu-info-banner';
        banner.className = 'gpu-info-banner';
        llmSection.insertBefore(banner, llmSection.firstChild);
    }
    if (!gpu || !rec) { banner.style.display = 'none'; return; }
    banner.style.display = '';

    const tierClass = `gpu-info-tier-${rec.tier || 'unknown'}`;
    banner.className = `gpu-info-banner ${tierClass}`;
    const gpuLine = gpu.detected
        ? `<strong>${escapeHtml(gpu.name || 'GPU')}</strong> · ${gpu.vram_mb} MB VRAM`
        : `<strong>No GPU detected</strong>`;
    banner.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01"/></svg>
        <div class="gpu-info-text">
            <div class="gpu-info-line">${gpuLine}</div>
            <div class="gpu-info-reason">${escapeHtml(rec.reason || '')}</div>
        </div>
    `;
}

// Embed-on-CPU toggle: reflect current config, and wire its change handler once.
let _embedCpuWired = false;
function _syncEmbedCpuToggle() {
    const chk = $('#settings-embed-on-cpu');
    if (!chk) return;
    if (_settingsConfig) chk.checked = !!_settingsConfig.embed_on_cpu;
    if (_embedCpuWired) return;
    _embedCpuWired = true;
    chk.addEventListener('change', async () => {
        const enabled = chk.checked;
        try {
            const r = await fetch(`${API}/api/setup/embed-on-cpu`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            });
            if (!r.ok) throw new Error(`status ${r.status}`);
            if (_settingsConfig) _settingsConfig.embed_on_cpu = enabled;
            showToast(enabled ? 'Embeddings will run on CPU' : 'Embeddings will run on GPU', 'success');
        } catch (e) {
            chk.checked = !enabled; // revert on failure
            showToast(`Update failed: ${e.message}`, 'error');
        }
    });
}

function _renderSettingsCards() {
    if (!_settingsConfig) return;

    // ── Profile fields ──
    const nameInput  = $('#profile-name-input');
    const aboutInput = $('#profile-about-input');
    if (nameInput)  nameInput.value  = _settingsConfig.user_name  || '';
    if (aboutInput) aboutInput.value = _settingsConfig.user_about || '';
    _updateAvatarFace();
    _syncEmbedCpuToggle();

    const llmGrid   = $('#settings-llm-grid');
    const embedGrid = $('#settings-embed-grid');
    llmGrid.innerHTML = '';
    embedGrid.innerHTML = '';

    // ── Provider grid ──
    _selectedProvider = _settingsConfig.provider || 'ollama';
    const provGrid = $('#settings-provider-grid');
    provGrid.innerHTML = '';

    // Ollama card
    const ollamaCard = _makeProviderCard('ollama', _settingsConfig.ollama_running !== false);
    provGrid.appendChild(ollamaCard);

    // Cloud provider cards
    (_settingsConfig.cloud_providers || []).forEach(cp => {
        provGrid.appendChild(_makeProviderCard(cp.id, cp.has_key, cp));
    });

    _updateCloudSections();

    // ── GPU/VRAM info banner ──
    _renderGpuBanner(_settingsConfig.gpu, _settingsConfig.recommendation);

    // ── LLM grid (Ollama) ──
    let selectedLlm   = _settingsConfig.model;
    let selectedEmbed = _settingsConfig.embed_model;
    const originalEmbed = _settingsConfig.embed_model;

    (_settingsConfig.available_models || []).forEach(m => {
        llmGrid.appendChild(_makeSettingsCard(m, selectedLlm, 'settings-llm-grid', id => {
            selectedLlm = id;
            llmGrid.dataset.selected = id;
        }));
    });
    llmGrid.dataset.selected = selectedLlm;

    (_settingsConfig.available_embed_models || []).forEach(m => {
        embedGrid.appendChild(_makeSettingsCard(m, selectedEmbed, 'settings-embed-grid', id => {
            selectedEmbed = id;
            embedGrid.dataset.selected = id;
            const warn = $('#settings-embed-warning');
            if (id !== originalEmbed) { warn.classList.add('visible'); }
            else { warn.classList.remove('visible'); }
        }));
    });
    embedGrid.dataset.selected = selectedEmbed;
}

function _makeProviderCard(providerId, isReady, _cpInfo) {
    const meta = _PROVIDER_META[providerId] || { svg: '', label: providerId, color: '#888' };
    const card = document.createElement('div');
    card.className = 'settings-provider-card' + (providerId === _selectedProvider ? ' selected' : '');
    card.dataset.provider = providerId;

    let metaText = '';
    if (providerId === 'ollama') {
        metaText = isReady ? '✓ Running' : '✗ Offline';
    } else {
        metaText = isReady ? '✓ Key saved' : 'No key';
    }
    const metaClass = isReady ? 'provider-card-meta has-key' : 'provider-card-meta';

    const iconHtml = meta.useBrandLogo
        ? `<img src="${meta.logo}" alt="${escapeHtml(meta.label)} logo" class="provider-brand-logo">`
        : meta.svg;
    const iconStyle = meta.useBrandLogo ? '' : `style="color:${meta.color}"`;

    card.innerHTML = `
        <div class="provider-card-icon" ${iconStyle}>${iconHtml}</div>
        <div class="provider-card-name">${escapeHtml(meta.label)}</div>
        <div class="${metaClass}">${metaText}</div>
    `;

    card.addEventListener('click', () => {
        _selectedProvider = providerId;
        $$('.settings-provider-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        _updateCloudSections();
    });

    return card;
}

function _updateCloudSections() {
    const keySection = $('#cloud-key-section');
    const modelSection = $('#cloud-model-section');
    const isCloud = _selectedProvider !== 'ollama';

    keySection.style.display = isCloud ? '' : 'none';
    modelSection.style.display = isCloud ? '' : 'none';

    if (!isCloud) return;

    // Find provider info
    const cp = (_settingsConfig.cloud_providers || []).find(p => p.id === _selectedProvider);
    if (!cp) return;

    // Update key hint
    const docsLink = $('#cloud-key-docs-link');
    if (docsLink && cp.docs_url) { docsLink.href = cp.docs_url; }

    // Pre-fill key input if saved (masked)
    const keyInput = $('#cloud-key-input');
    if (cp.has_key) {
        keyInput.placeholder = '••••••••••••••••  (key saved)';
        keyInput.value = '';
        _setKeyStatus('valid', '✓ Key saved and active');
        _cloudKeyValid[_selectedProvider] = true;
    } else {
        keyInput.placeholder = cp.key_hint || 'Enter API key…';
        keyInput.value = '';
        _setKeyStatus('', '');
        _cloudKeyValid[_selectedProvider] = false;
    }

    // Render cloud model grid
    _renderCloudModelGrid(cp);
}

function _renderCloudModelGrid(cp) {
    const grid = $('#settings-cloud-model-grid');
    grid.innerHTML = '';
    const selectedModel = cp.selected_model || (cp.models[0] && cp.models[0].id) || '';

    (cp.models || []).forEach(m => {
        const card = document.createElement('div');
        card.className = 'settings-model-card' + (m.id === selectedModel ? ' selected' : '');
        card.dataset.id = m.id;

        const costText = m.input_cost != null ? `$${m.input_cost} / $${m.output_cost}` : '';

        card.innerHTML = `
            <div class="settings-model-card-left">
                <div class="settings-model-name">${escapeHtml(m.label || m.id)}</div>
                <div class="settings-model-desc">${escapeHtml(m.desc || '')}</div>
            </div>
            <div class="settings-model-card-right">
                ${costText ? `<span class="settings-model-cost">${costText}</span>` : ''}
                ${m.recommended ? '<span class="settings-model-badge">Recommended</span>' : ''}
                <div class="settings-model-radio"></div>
            </div>
        `;
        card.addEventListener('click', () => {
            grid.querySelectorAll('.settings-model-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            grid.dataset.selected = m.id;
        });
        grid.appendChild(card);
    });
    grid.dataset.selected = selectedModel;
}

function _setKeyStatus(type, message) {
    const el = $('#cloud-key-status');
    el.className = 'cloud-key-status' + (type ? ' ' + type : '');
    el.innerHTML = type === 'validating'
        ? `<div class="cloud-key-spinner"></div> ${escapeHtml(message)}`
        : escapeHtml(message);
}

async function _validateCloudKey() {
    const keyInput = $('#cloud-key-input');
    const key = keyInput.value.trim();
    if (!key) {
        _setKeyStatus('invalid', 'Enter an API key first');
        return;
    }
    _setKeyStatus('validating', 'Validating...');
    try {
        const res = await fetch(`${API}/api/setup/validate-key`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ provider: _selectedProvider, api_key: key }),
        });
        const data = await res.json();
        if (data.valid) {
            _setKeyStatus('valid', '✓ Key is valid');
            _cloudKeyValid[_selectedProvider] = true;
        } else {
            _setKeyStatus('invalid', data.error || 'Invalid key');
            _cloudKeyValid[_selectedProvider] = false;
        }
    } catch (e) {
        _setKeyStatus('invalid', 'Validation failed: ' + (e.message || 'network error'));
    }
}

async function _deleteCloudKey() {
    if (!_selectedProvider || _selectedProvider === 'ollama') return;
    const provLabel = (_PROVIDER_META[_selectedProvider] || {}).label || _selectedProvider;
    if (!await showConfirm({ title: `Remove API key for ${provLabel}?`, message: 'The saved key will be permanently deleted.', confirmLabel: 'Remove', danger: true })) return;
    try {
        await fetch(`${API}/api/setup/cloud-key/${_selectedProvider}`, { method: 'DELETE' });
        _cloudKeyValid[_selectedProvider] = false;
        _settingsConfig = null;
        // Refresh settings config and re-render
        const res = await fetch(`${API}/api/setup/config`);
        _settingsConfig = await res.json();
        _renderSettingsCards();
        showToast(`${provLabel} API key removed`, 'success');
    } catch (e) {
        showToast('Failed to remove key', 'error');
    }
}


async function saveSettings() {
    const llmGrid   = $('#settings-llm-grid');
    const embedGrid = $('#settings-embed-grid');
    const cloudGrid = $('#settings-cloud-model-grid');
    const newModel  = llmGrid.dataset.selected;
    const newEmbed  = embedGrid.dataset.selected;
    const newCloudModel = cloudGrid ? cloudGrid.dataset.selected : '';

    // Capture the previous embed model BEFORE the config cache is invalidated below,
    // so we can detect a switch and prompt the user to re-index.
    const oldEmbed = (_settingsConfig || {}).embed_model;

    const saveBtn = $('#settings-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
        // 1. Save Ollama models + user profile sequentially.
        // Each endpoint does a read-modify-write on config.json; running them in
        // parallel races on Windows (os.replace contention → "Failed to fetch")
        // and also causes lost updates between the three snapshots.
        const profileName  = ($('#profile-name-input')  || {}).value || '';
        const profileAbout = ($('#profile-about-input') || {}).value || '';
        const _post = (url, body) => fetch(url, {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify(body),
        });
        await _post(`${API}/api/setup/select-model`,       { model: newModel });
        await _post(`${API}/api/setup/select-embed-model`, { model: newEmbed });
        await _post(`${API}/api/setup/save-profile`,       { name: profileName, about: profileAbout });

        // 2. Save cloud API key if entered
        const keyInput = $('#cloud-key-input');
        if (_selectedProvider !== 'ollama' && keyInput && keyInput.value.trim()) {
            const kr = await fetch(`${API}/api/setup/cloud-key`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ provider: _selectedProvider, api_key: keyInput.value.trim(), model: newCloudModel })
            });
            if (!kr.ok) throw new Error('Failed to save API key');
        }

        // 3. Save selected provider + model
        const pr = await fetch(`${API}/api/setup/select-provider`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ provider: _selectedProvider, model: _selectedProvider !== 'ollama' ? newCloudModel : newModel })
        });
        if (!pr.ok) {
            const err = await pr.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to set provider');
        }

        // Invalidate cache
        _settingsConfig = null;

        // Update sidebar hint
        if (_selectedProvider === 'ollama') {
            _updateSettingsHint(newModel, newEmbed);
        } else {
            const provLabel = (_PROVIDER_META[_selectedProvider] || {}).label || _selectedProvider;
            _updateSettingsHint(newCloudModel, provLabel);
        }

        // Update status indicator
        const statusText = document.querySelector('.status-text');
        const statusDot = document.querySelector('.status-dot');
        if (_selectedProvider !== 'ollama' && statusText && statusDot) {
            statusDot.classList.add('online');
            statusDot.classList.remove('offline');
            statusText.textContent = (_PROVIDER_META[_selectedProvider] || {}).label || 'Cloud AI';
        }

        const embedChanged = oldEmbed && newEmbed && newEmbed !== oldEmbed;
        closeSettingsModal();

        if (embedChanged) {
            _showActionToast(
                'Embedding model changed. Existing contexts need re-indexing for semantic search to work with the new model.',
                'Rebuild now',
                () => rebuildEmbeddings(),
            );
        } else {
            showToast('Settings saved', 'success');
        }
    } catch (e) {
        showToast(e.message || 'Failed to save settings', 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
    }
}

function _updateSettingsHint(model, extra) {
    const hint = $('#settings-current-model-hint');
    if (hint) hint.textContent = `${model} · ${extra}`;
}

// Fetch and show current models in the hint on app load
async function _initSettingsHint() {
    try {
        const res = await fetch(`${API}/api/setup/config`);
        const cfg = await res.json();
        if (cfg.is_cloud_active) {
            const provLabel = (_PROVIDER_META[cfg.active_provider] || {}).label || cfg.active_provider;
            _updateSettingsHint(cfg.active_model, provLabel);
            const st = document.querySelector('.status-text');
            const sd = document.querySelector('.status-dot');
            if (st && sd) {
                sd.classList.add('online');
                sd.classList.remove('offline');
                st.textContent = provLabel;
            }
        } else {
            _updateSettingsHint(cfg.model, cfg.embed_model);
        }
    } catch { /* ignore */ }
}


export { _PROVIDER_META, _primeSettingsConfig, _deleteCloudKey, _initMcpServerPanelHandlers, _initSettingsHint, _initTunnelPanelHandlers, _prefetchSettingsConfig, _settingsConfig, _settingsConfigPromise, _validateCloudKey, closeSettingsModal, openSettingsModal, saveSettings };
