import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity, Boxes, Cpu, Database, FileText, Power, RefreshCw, Server, Sparkles,
} from 'lucide-react';
import Modal from './Modal';
import { api } from '../api/client';
import { useToast } from '../state/ToastContext';
import '../styles/system.css';

const paneMotion = {
  initial: { opacity: 0, x: 10 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -10 },
  transition: { duration: 0.16, ease: [0, 0, 0.2, 1] },
};

function fmtUptime(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return '—';
  let s = Math.max(0, Math.floor(Number(seconds)));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export default function SystemModal({ open, onClose }) {
  const { showToast } = useToast();

  const [tab, setTab] = useState('health');
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(false);
  const [logs, setLogs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const logsRef = useRef(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.systemStatus());
      setStatusError(false);
    } catch {
      setStatus(null);
      setStatusError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      setLogs(await api.logs(200));
    } catch {
      setLogs({ exists: false, lines: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (tab === 'health') loadStatus();
    else loadLogs();
  }, [open, tab, loadStatus, loadLogs]);

  // Auto-scroll log viewer to the bottom whenever logs load.
  useEffect(() => {
    const el = logsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const restart = async () => {
    if (!confirmRestart) { setConfirmRestart(true); return; }
    setConfirmRestart(false);
    try {
      await api.restart();
      showToast('Restarting…');
    } catch (e) {
      // The backend often drops the connection mid-restart — treat that as success.
      if (/failed to fetch|network/i.test(e.message || '')) showToast('Restarting…');
      else showToast(e.message || 'Restart failed', 'error');
    }
  };

  const lineClass = (line) => {
    if (/ERROR/.test(line)) return 'log-line log-err';
    if (/WARNING/.test(line)) return 'log-line log-warn';
    return 'log-line';
  };

  const db = status?.database;

  return (
    <Modal open={open} onClose={onClose} title="System" wide>
      <div className="sys-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'health'}
          className={`sys-tab ${tab === 'health' ? 'on' : ''}`}
          onClick={() => { if (tab !== 'health') { setLoading(true); setTab('health'); } }}
        >
          <Activity size={14} /> Health
        </button>
        <button
          role="tab"
          aria-selected={tab === 'logs'}
          className={`sys-tab ${tab === 'logs' ? 'on' : ''}`}
          onClick={() => { if (tab !== 'logs') { setLoading(true); setTab('logs'); } }}
        >
          <FileText size={14} /> Logs
        </button>
        <div className="sys-tabs-spacer" />
        <button
          className="btn-ghost sys-refresh"
          onClick={() => { setLoading(true); (tab === 'health' ? loadStatus() : loadLogs()); }}
          disabled={loading}
        >
          <RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>

      <AnimatePresence mode="wait">
        {tab === 'health' && (
          <motion.div key="health" className="sys-pane" {...paneMotion}>
            {statusError && !loading && (
              <div className="sys-empty">System status unavailable — is the backend running?</div>
            )}
            {loading && !status && <div className="sys-loading"><div className="spinner" /></div>}
            {status && (
              <>
                <div className="sys-grid">
                  <div className="sys-card">
                    <div className="sys-card-head"><Server size={14} /> Backend</div>
                    <div className="sys-card-value">Up {fmtUptime(status.backend?.uptime_s)}</div>
                  </div>
                  <div className="sys-card">
                    <div className="sys-card-head"><Boxes size={14} /> Ollama</div>
                    <div className={`sys-card-value ${status.ollama?.running ? 'ok' : 'bad'}`}>
                      {status.ollama?.running ? 'Running' : 'Not running'}
                    </div>
                    {status.ollama?.url && <div className="sys-card-sub">{status.ollama.url}</div>}
                  </div>
                  <div className="sys-card">
                    <div className="sys-card-head"><Cpu size={14} /> Model</div>
                    <div className={`sys-card-value ${status.model?.ready ? 'ok' : ''}`}>
                      {status.model?.name || '—'}
                    </div>
                    <div className="sys-card-sub">{status.model?.ready ? 'Ready' : 'Not ready'}</div>
                  </div>
                  <div className="sys-card">
                    <div className="sys-card-head"><Sparkles size={14} /> Embedding</div>
                    <div className="sys-card-value">{status.embed?.name || '—'}</div>
                  </div>
                  <div className="sys-card sys-card-wide">
                    <div className="sys-card-head"><Database size={14} /> Database</div>
                    <div className="sys-db-stats">
                      <span><strong>{db?.contexts ?? '—'}</strong> contexts</span>
                      <span><strong>{db?.chunks ?? '—'}</strong> chunks</span>
                      <span><strong>{db?.collections ?? '—'}</strong> collections</span>
                      <span><strong>{db?.size_mb != null ? `${db.size_mb} MB` : '—'}</strong></span>
                    </div>
                  </div>
                </div>

                {Array.isArray(status.installed_models) && status.installed_models.length > 0 && (
                  <>
                    <div className="sys-section-label">Installed models</div>
                    <div className="sys-models">
                      {status.installed_models.map((m, i) => {
                        const name = typeof m === 'string' ? m : (m?.name || m?.id || m?.model || JSON.stringify(m));
                        return <span key={`${name}-${i}`} className="chip">{name}</span>;
                      })}
                    </div>
                  </>
                )}

                <div className="sys-footer">
                  <button
                    className="btn-danger"
                    onClick={restart}
                    onBlur={() => setConfirmRestart(false)}
                  >
                    <Power size={14} />
                    {confirmRestart ? 'Click again to confirm restart' : 'Restart Backend'}
                  </button>
                </div>
              </>
            )}
          </motion.div>
        )}

        {tab === 'logs' && (
          <motion.div key="logs" className="sys-pane" {...paneMotion}>
            {logs && !logs.exists ? (
              <div className="sys-empty">No log file found.</div>
            ) : (
              <div className="logs-view" ref={logsRef}>
                {(logs?.lines || []).map((line, i) => (
                  <div key={i} className={lineClass(line)}>{line}</div>
                ))}
                {logs && logs.exists && (logs.lines || []).length === 0 && (
                  <div className="log-line">Log file is empty.</div>
                )}
                {!logs && loading && <div className="sys-loading"><div className="spinner" /></div>}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  );
}
