import { useState } from 'react';
import { LayoutDashboard, Library, MessageCircleQuestion, PenLine, Settings, Sun, Moon, FolderPlus, RefreshCw, DatabaseBackup, Activity } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { useTheme, VIBES } from '../state/ThemeContext';
import { useToast } from '../state/ToastContext';
import { api, COLLECTION_COLORS } from '../api/client';
import Modal from './Modal';

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, key: 'N' },
  { id: 'capture', label: 'Capture', icon: PenLine, key: 'C' },
  { id: 'library', label: 'Library', icon: Library, key: 'L' },
  { id: 'ask', label: 'Ask Vault', icon: MessageCircleQuestion, key: 'A' },
];

export default function Sidebar({ onOpenSettings, onOpenSystem }) {
  const { view, navigate, collections, refreshCollections, activeCollection, setActiveCollection, backendUp } = useApp();
  const { theme, toggleTheme, vibe, setVibe } = useTheme();
  const { showToast } = useToast();
  const [newColOpen, setNewColOpen] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [newColColor, setNewColColor] = useState(COLLECTION_COLORS[0][0]);
  const [rebuilding, setRebuilding] = useState(false);

  const createCollection = async () => {
    const name = newColName.trim();
    if (!name) return;
    try {
      await api.createCollection(name, newColColor);
      await refreshCollections();
      setNewColOpen(false);
      setNewColName('');
      showToast(`Collection “${name}” created`);
    } catch (e) {
      showToast(e.message, 'error');
    }
  };

  const rebuildEmbeddings = async () => {
    if (rebuilding) return;
    setRebuilding(true);
    showToast('Rebuilding embeddings…');
    try {
      let last = null;
      await api.chunkAll(true, (ev) => { last = ev; });
      showToast(`Embeddings rebuilt — ${last?.updated ?? 0} updated, ${last?.skipped ?? 0} skipped`);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setRebuilding(false);
    }
  };

  const backup = () => {
    window.open('/api/backup/download', '_blank');
    showToast('Backup download started');
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src="/static/CVsvg.svg" width="22" height="22" alt="" />
        <div className="brand-text">
          <span className="brand-name">ContextVolt</span>
          <span className="brand-sub">v2 · local</span>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Main">
        <div className="nav-section-label">Workspace</div>
        {NAV.map(({ id, label, icon: Icon, key }) => (
          <button
            key={id}
            className={`nav-item ${view === id ? 'active' : ''}`}
            onClick={() => navigate(id)}
          >
            <Icon size={16} className="nav-ic" />
            <span>{label}</span>
            <kbd className="nav-kbd">{key}</kbd>
          </button>
        ))}

        <div className="nav-section-label">
          Collections
          <button className="nav-mini-btn" onClick={() => setNewColOpen(true)} aria-label="New collection">
            <FolderPlus size={13} />
          </button>
        </div>
        <button
          className={`nav-item nav-col ${activeCollection === null ? 'active' : ''}`}
          onClick={() => { setActiveCollection(null); navigate('library'); }}
        >
          <span className="col-dot" style={{ background: 'var(--text-muted)' }} />
          <span>All contexts</span>
        </button>
        {collections.slice(0, 6).map((c) => (
          <button
            key={c.id}
            className={`nav-item nav-col ${activeCollection === c.id ? 'active' : ''}`}
            onClick={() => { setActiveCollection(c.id); navigate('library'); }}
          >
            <span className="col-dot" style={{ background: c.color }} />
            <span className="col-name">{c.name}</span>
            <span className="col-count">{c.count}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className="vibe-toggle" role="tablist" aria-label="Vibe">
          {VIBES.map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={vibe === v}
              className={vibe === v ? 'on' : ''}
              onClick={() => setVibe(v)}
            >
              {v}
            </button>
          ))}
        </div>

        <div className="sidebar-actions">
          <button className="side-iconbtn" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button className="side-iconbtn" onClick={onOpenSettings} aria-label="Settings" title="Settings & Models">
            <Settings size={15} />
          </button>
          <button className="side-iconbtn" onClick={rebuildEmbeddings} disabled={rebuilding} aria-label="Rebuild embeddings" title="Rebuild embeddings">
            <RefreshCw size={15} className={rebuilding ? 'spin' : ''} />
          </button>
          <button className="side-iconbtn" onClick={backup} aria-label="Backup vault" title="Backup vault">
            <DatabaseBackup size={15} />
          </button>
          <button className="side-iconbtn" onClick={onOpenSystem} aria-label="System status" title="System status">
            <Activity size={15} />
          </button>
        </div>

        <div className={`status-line ${backendUp ? 'ok' : 'down'}`}>
          <span className="status-dot" />
          {backendUp ? 'Online' : 'Backend offline'}
        </div>
      </div>

      <Modal open={newColOpen} onClose={() => setNewColOpen(false)} title="New Collection">
        <input
          autoFocus
          placeholder="Collection name"
          value={newColName}
          onChange={(e) => setNewColName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && createCollection()}
          style={{ width: '100%', padding: '10px 12px', fontSize: 14 }}
        />
        <div className="color-picker">
          {COLLECTION_COLORS.map(([hex, name]) => (
            <button
              key={hex}
              className={`color-swatch ${newColColor === hex ? 'on' : ''}`}
              style={{ background: hex }}
              onClick={() => setNewColColor(hex)}
              aria-label={name}
              title={name}
            />
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={() => setNewColOpen(false)}>Cancel</button>
          <button className="btn-primary" onClick={createCollection} disabled={!newColName.trim()}>Create</button>
        </div>
      </Modal>
    </aside>
  );
}
