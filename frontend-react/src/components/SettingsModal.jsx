import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Check, Cloud, Copy, Cpu, Eye, EyeOff, Globe, Plug, RefreshCw, Trash2, User,
} from 'lucide-react';
import Modal from './Modal';
import { api } from '../api/client';
import { useApp } from '../state/AppContext';
import { useToast } from '../state/ToastContext';
import '../styles/settings.css';

const TABS = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'cloud', label: 'Cloud', icon: Cloud },
  { id: 'mcp', label: 'MCP', icon: Plug },
];

const paneMotion = {
  initial: { opacity: 0, x: 10 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -10 },
  transition: { duration: 0.16, ease: [0, 0, 0.2, 1] },
};

// Models / providers may arrive as strings or objects — normalize defensively.
const idOf = (m) => (typeof m === 'string' ? m : (m?.id ?? m?.name ?? m?.model ?? ''));
const labelOf = (m) => (typeof m === 'string' ? m : (m?.label ?? m?.name ?? m?.id ?? m?.model ?? ''));

export default function SettingsModal({ open, onClose }) {
  const { refreshConfig } = useApp();
  const { showToast } = useToast();

  const [tab, setTab] = useState('profile');
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Profile
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');

  // Models
  const [confirmDelete, setConfirmDelete] = useState(null);

  // Cloud
  const [keyInputs, setKeyInputs] = useState({});
  const [modelSel, setModelSel] = useState({});
  const [validating, setValidating] = useState(null);

  // MCP
  const [mcp, setMcp] = useState(null);
  const [mcpError, setMcpError] = useState(false);
  const [tunnel, setTunnel] = useState(null);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(null);

  const loadCfg = useCallback(async () => {
    try {
      const c = await api.setupConfig();
      setCfg(c);
      setName(c.user_name || '');
      setAbout(c.user_about || '');
    } catch (e) {
      setCfg(null);
      showToast(e.message || 'Could not load settings', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { if (open) loadCfg(); }, [open, loadCfg]);

  // MCP info + tunnel polling while the MCP tab is open.
  useEffect(() => {
    if (!open || tab !== 'mcp') return undefined;
    let alive = true;
    (async () => {
      try {
        const info = await api.mcpInfo();
        if (alive) { setMcp(info); setMcpError(false); }
      } catch { if (alive) { setMcp(null); setMcpError(true); } }
    })();
    const poll = async () => {
      try { const t = await api.mcpTunnel(); if (alive) setTunnel(t); }
      catch { if (alive) setTunnel(null); }
    };
    poll();
    const iv = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, [open, tab]);

  const copy = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1600);
      showToast('Copied to clipboard');
    } catch {
      showToast('Copy failed', 'error');
    }
  };

  // ── Profile ──────────────────────────────────────────────────
  const saveProfile = async () => {
    setBusy(true);
    try {
      await api.saveProfile(name.trim(), about.trim());
      await refreshConfig();
      showToast('Profile saved');
    } catch (e) {
      showToast(e.message || 'Could not save profile', 'error');
    } finally {
      setBusy(false);
    }
  };

  // ── Models ───────────────────────────────────────────────────
  const pickModel = async (id) => {
    if (!id || id === cfg?.model || busy) return;
    setBusy(true);
    try {
      await api.selectModel(id);
      showToast(`Model set to ${id}`);
      await Promise.all([loadCfg(), refreshConfig()]);
    } catch (e) {
      showToast(e.message || 'Could not select model', 'error');
    } finally {
      setBusy(false);
    }
  };

  const pickEmbedModel = async (id) => {
    if (!id || id === cfg?.embed_model || busy) return;
    setBusy(true);
    try {
      await api.selectEmbedModel(id);
      showToast(`Embedding model set to ${id}`);
      await Promise.all([loadCfg(), refreshConfig()]);
    } catch (e) {
      showToast(e.message || 'Could not select embedding model', 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeModel = async (id) => {
    if (confirmDelete !== id) { setConfirmDelete(id); return; }
    setConfirmDelete(null);
    setBusy(true);
    try {
      await api.deleteModel(id);
      showToast(`Deleted ${id}`);
      await loadCfg();
    } catch (e) {
      showToast(e.message || 'Could not delete model', 'error');
    } finally {
      setBusy(false);
    }
  };

  // ── Cloud ────────────────────────────────────────────────────
  const connectProvider = async (p) => {
    const pid = idOf(p);
    const key = (keyInputs[pid] || '').trim();
    const models = Array.isArray(p?.models) ? p.models : [];
    const model = modelSel[pid] || idOf(models[0]);
    if (!key) { showToast('Enter an API key first', 'error'); return; }
    setValidating(pid);
    try {
      const r = await api.validateKey(pid, key);
      if (!r?.valid) {
        showToast(r?.error || 'Invalid API key', 'error');
        return;
      }
      await api.selectProvider(pid, model);
      showToast(`Connected to ${labelOf(p)}`);
      setKeyInputs((k) => ({ ...k, [pid]: '' }));
      await Promise.all([loadCfg(), refreshConfig()]);
    } catch (e) {
      showToast(e.message || 'Validation failed', 'error');
    } finally {
      setValidating(null);
    }
  };

  const removeKey = async (p) => {
    const pid = idOf(p);
    try {
      await api.deleteCloudKey(pid);
      showToast(`Removed ${labelOf(p)} key`);
      await Promise.all([loadCfg(), refreshConfig()]);
    } catch (e) {
      showToast(e.message || 'Could not remove key', 'error');
    }
  };

  // ── MCP ──────────────────────────────────────────────────────
  const regenToken = async () => {
    setBusy(true);
    try {
      const r = await api.mcpRegenToken();
      setMcp((m) => (m ? { ...m, http: { ...m.http, token: r?.token ?? m.http?.token } } : m));
      showToast('Token regenerated');
    } catch (e) {
      showToast(e.message || 'Could not regenerate token', 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleAuth = async () => {
    const next = !mcp?.http?.auth_required;
    try {
      await api.mcpAuthRequired(next);
      setMcp((m) => (m ? { ...m, http: { ...m.http, auth_required: next } } : m));
      showToast(next ? 'Auth required enabled' : 'Auth required disabled');
    } catch (e) {
      showToast(e.message || 'Could not update auth setting', 'error');
    }
  };

  const tunnelAction = async (start) => {
    setBusy(true);
    try {
      await (start ? api.mcpTunnelStart() : api.mcpTunnelStop());
      showToast(start ? 'Tunnel starting…' : 'Tunnel stopped');
      try { setTunnel(await api.mcpTunnel()); } catch { /* next poll will catch up */ }
    } catch (e) {
      showToast(e.message || 'Tunnel action failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  // ── Render helpers ───────────────────────────────────────────
  const renderModelGrid = (models, current, onPick, deletable) => (
    <div className="model-grid">
      {(models || []).map((m) => {
        const id = idOf(m);
        const selected = id === current;
        const desc = typeof m === 'object' ? (m.desc || m.description || m.size || '') : '';
        return (
          <div
            key={id}
            className={`model-card ${selected ? 'selected' : ''}`}
            role="radio"
            aria-checked={selected}
            tabIndex={0}
            onClick={() => onPick(id)}
            onKeyDown={(e) => e.key === 'Enter' && onPick(id)}
          >
            <span className={`model-radio ${selected ? 'on' : ''}`} />
            <div className="model-card-text">
              <span className="model-name">{labelOf(m)}</span>
              {desc && <span className="model-desc">{String(desc)}</span>}
            </div>
            {deletable && (
              <button
                className={`model-del ${confirmDelete === id ? 'confirm' : ''}`}
                onClick={(e) => { e.stopPropagation(); removeModel(id); }}
                title={confirmDelete === id ? 'Click again to confirm' : 'Delete model'}
                aria-label={`Delete ${id}`}
              >
                {confirmDelete === id ? 'Delete?' : <Trash2 size={13} />}
              </button>
            )}
          </div>
        );
      })}
      {(!models || models.length === 0) && (
        <div className="settings-empty">No models available.</div>
      )}
    </div>
  );

  const token = mcp?.http?.token || '';
  const maskedToken = token ? (reveal ? token : '•'.repeat(Math.min(token.length, 32))) : '—';
  const tunnelStatus = tunnel?.status || 'unknown';
  const tunnelRunning = ['running', 'connected', 'up', 'active'].includes(String(tunnelStatus).toLowerCase());

  return (
    <Modal open={open} onClose={onClose} title="Settings" wide>
      <div className="settings-tabs" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`settings-tab ${tab === id ? 'on' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="settings-loading"><div className="spinner" /></div>
      ) : (
        <AnimatePresence mode="wait">
          {tab === 'profile' && (
            <motion.div key="profile" className="settings-pane" {...paneMotion}>
              <div className="field">
                <label htmlFor="set-name">Your name</label>
                <input
                  id="set-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="How should answers address you?"
                />
              </div>
              <div className="field">
                <label htmlFor="set-about">About you</label>
                <textarea
                  id="set-about"
                  rows={4}
                  value={about}
                  onChange={(e) => setAbout(e.target.value)}
                  placeholder="Context the model should know — role, interests, projects…"
                />
              </div>
              <div className="settings-actions">
                <button className="btn-primary" onClick={saveProfile} disabled={busy}>
                  {busy ? 'Saving…' : 'Save profile'}
                </button>
              </div>
            </motion.div>
          )}

          {tab === 'models' && (
            <motion.div key="models" className="settings-pane" {...paneMotion}>
              {cfg?.recommendation && (
                <div className="settings-hint">
                  {cfg.gpu ? `GPU: ${cfg.gpu} · ` : ''}{String(cfg.recommendation)}
                </div>
              )}
              <div className="settings-section-label">Chat model</div>
              {renderModelGrid(cfg?.available_models, cfg?.model, pickModel, true)}
              <div className="settings-section-label">Embedding model</div>
              {renderModelGrid(cfg?.available_embed_models, cfg?.embed_model, pickEmbedModel, false)}
            </motion.div>
          )}

          {tab === 'cloud' && (
            <motion.div key="cloud" className="settings-pane" {...paneMotion}>
              {cfg?.is_cloud_active && (
                <div className="cloud-active-badge">
                  <Globe size={13} />
                  Cloud active — {cfg.active_provider}{cfg.active_model ? ` · ${cfg.active_model}` : ''}
                </div>
              )}
              {(cfg?.cloud_providers || []).map((p) => {
                const pid = idOf(p);
                const models = Array.isArray(p?.models) ? p.models : [];
                const hasKey = !!(p?.has_key ?? p?.hasKey);
                const isActive = cfg?.is_cloud_active && cfg?.active_provider === pid;
                return (
                  <div key={pid} className={`provider-card ${isActive ? 'active' : ''}`}>
                    <div className="provider-head">
                      <span className="provider-name">{labelOf(p)}</span>
                      {isActive && <span className="chip on">Active</span>}
                      {hasKey && !isActive && <span className="chip">Key saved</span>}
                      {hasKey && (
                        <button className="provider-delkey" onClick={() => removeKey(p)} title="Remove saved key">
                          <Trash2 size={12} /> Remove key
                        </button>
                      )}
                    </div>
                    <div className="provider-row">
                      <input
                        type="password"
                        placeholder={hasKey ? 'Replace API key…' : 'API key'}
                        value={keyInputs[pid] || ''}
                        onChange={(e) => setKeyInputs((k) => ({ ...k, [pid]: e.target.value }))}
                        autoComplete="off"
                      />
                      {models.length > 0 && (
                        <select
                          value={modelSel[pid] || idOf(models[0])}
                          onChange={(e) => setModelSel((s) => ({ ...s, [pid]: e.target.value }))}
                          aria-label={`${labelOf(p)} model`}
                        >
                          {models.map((m) => (
                            <option key={idOf(m)} value={idOf(m)}>{labelOf(m)}</option>
                          ))}
                        </select>
                      )}
                      <button
                        className="btn-ghost provider-validate"
                        onClick={() => connectProvider(p)}
                        disabled={validating === pid || !(keyInputs[pid] || '').trim()}
                      >
                        {validating === pid ? 'Validating…' : 'Validate'}
                      </button>
                    </div>
                  </div>
                );
              })}
              {(!cfg?.cloud_providers || cfg.cloud_providers.length === 0) && (
                <div className="settings-empty">No cloud providers available.</div>
              )}
            </motion.div>
          )}

          {tab === 'mcp' && (
            <motion.div key="mcp" className="settings-pane" {...paneMotion}>
              {mcpError && <div className="settings-empty">MCP server info unavailable.</div>}
              {mcp && (
                <>
                  <div className="settings-section-label">HTTP server</div>
                  <div className="mcp-row">
                    <span className="mcp-label">URL</span>
                    <code className="mcp-value">{mcp.http?.url || '—'}</code>
                    {mcp.http?.url && (
                      <button className="mcp-iconbtn" onClick={() => copy(mcp.http.url, 'url')} title="Copy URL">
                        {copied === 'url' ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    )}
                  </div>
                  <div className="mcp-row">
                    <span className="mcp-label">Token</span>
                    <code className="mcp-value mcp-token">{maskedToken}</code>
                    <button className="mcp-iconbtn" onClick={() => setReveal((v) => !v)} title={reveal ? 'Hide token' : 'Reveal token'}>
                      {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    {token && (
                      <button className="mcp-iconbtn" onClick={() => copy(token, 'token')} title="Copy token">
                        {copied === 'token' ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    )}
                    <button className="mcp-iconbtn" onClick={regenToken} disabled={busy} title="Regenerate token">
                      <RefreshCw size={13} />
                    </button>
                  </div>
                  <label className="mcp-toggle">
                    <input
                      type="checkbox"
                      checked={!!mcp.http?.auth_required}
                      onChange={toggleAuth}
                    />
                    Require auth token for HTTP connections
                  </label>

                  <div className="settings-section-label">Tunnel</div>
                  <div className="mcp-row">
                    <span className={`tunnel-dot ${tunnelRunning ? 'up' : ''}`} />
                    <span className="mcp-tunnel-status">{tunnelStatus}</span>
                    {tunnel?.mcp_url && <code className="mcp-value">{tunnel.mcp_url}</code>}
                    <div className="mcp-row-spacer" />
                    {tunnelRunning ? (
                      <button className="btn-danger mcp-tunnel-btn" onClick={() => tunnelAction(false)} disabled={busy}>Stop</button>
                    ) : (
                      <button className="btn-ghost mcp-tunnel-btn" onClick={() => tunnelAction(true)} disabled={busy}>Start tunnel</button>
                    )}
                  </div>
                  {tunnel?.error && <div className="mcp-tunnel-error">{tunnel.error}</div>}

                  <div className="settings-section-label">
                    Stdio config
                    {mcp.stdio?.config_snippet && (
                      <button className="mcp-iconbtn" onClick={() => copy(mcp.stdio.config_snippet, 'stdio')} title="Copy config">
                        {copied === 'stdio' ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    )}
                  </div>
                  <pre className="mcp-code">{mcp.stdio?.config_snippet || '—'}</pre>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      )}

      <div className="settings-footnote">API keys are stored locally on your machine.</div>
    </Modal>
  );
}
