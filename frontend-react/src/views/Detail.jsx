import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft, ChevronDown, Copy, Download, FileDown, Pencil,
  RefreshCw, Sparkles, Star, Trash2,
} from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../state/AppContext';
import { useToast } from '../state/ToastContext';
import Modal from '../components/Modal';
import '../styles/detail.css';

const PROMPT_SIZES = ['compact', 'standard', 'full'];

function fullDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function buildMarkdown(ctx) {
  const s = ctx.summary || {};
  const lines = [`# ${ctx.title}`, '', `*Saved ${new Date(ctx.created_at).toLocaleString()}*`];
  if (ctx.tags?.length) lines.push('', `Tags: ${ctx.tags.join(', ')}`);
  if (s.snapshot) lines.push('', '## Snapshot', '', s.snapshot);
  if (s.key_ideas?.length) lines.push('', '## Key Ideas', '', ...s.key_ideas.map((k) => `- ${k}`));
  if (s.conclusions?.length) lines.push('', '## Conclusions', '', ...s.conclusions.map((c) => `- ${c}`));
  if (s.unresolved_questions?.length) {
    lines.push('', '## Unresolved Questions', '', ...s.unresolved_questions.map((q) => `- ${q}`));
  }
  if (s.vitals?.length) lines.push('', '## Vitals', '', ...s.vitals.map((v) => `- \`${v}\``));
  if (ctx.important_notes?.length) {
    lines.push('', '## Important Notes', '', ...ctx.important_notes.map((n) => `- ${n}`));
  }
  return lines.join('\n');
}

/** Collapsible summary section. */
function Section({ title, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card det-section">
      <button className="det-section-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="det-section-title">{title}</span>
        {count != null && <span className="det-section-count">{count}</span>}
        <ChevronDown size={15} className={`det-chev ${open ? 'open' : ''}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div className="det-section-body">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Detail({ id }) {
  const { collections, refreshCollections, navigate } = useApp();
  const { showToast } = useToast();

  const [ctx, setCtx] = useState(null);
  const [loading, setLoading] = useState(true);

  const [promptSize, setPromptSize] = useState('standard');
  const [promptQuery, setPromptQuery] = useState('');
  const [promptText, setPromptText] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);

  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef(null);

  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // ── Load ──────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const data = await api.context(id);
      setCtx(data);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [id, showToast]);

  // App.jsx keys the view wrapper by detailId, so this component
  // remounts per context — initial state covers the per-id reset.
  useEffect(() => { load(); }, [load]);

  // Poll while the summary is still cooking
  useEffect(() => {
    if (ctx?.status !== 'summarizing') return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [ctx?.status, load]);

  // Close export menu on outside click
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e) => {
      if (exportRef.current && !exportRef.current.contains(e.target)) setExportOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [exportOpen]);

  // ── Actions ───────────────────────────────────────────────
  const copy = async (text, msg = 'Copied to clipboard') => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(msg);
    } catch {
      showToast('Copy failed — clipboard unavailable', 'error');
    }
  };

  const toggleStar = async () => {
    const prev = ctx.starred;
    setCtx((c) => ({ ...c, starred: !c.starred }));
    try {
      await api.toggleStar(id);
    } catch (e) {
      setCtx((c) => ({ ...c, starred: prev }));
      showToast(e.message, 'error');
    }
  };

  const changeCollection = async (raw) => {
    const col = collections.find((c) => String(c.id) === raw);
    const newId = raw === '' ? null : (col ? col.id : raw);
    const prev = ctx.collection_id;
    setCtx((c) => ({ ...c, collection_id: newId }));
    try {
      await api.setCollection(id, newId);
      refreshCollections();
      showToast(newId === null ? 'Removed from collection' : `Moved to ${col?.name ?? 'collection'}`);
    } catch (e) {
      setCtx((c) => ({ ...c, collection_id: prev }));
      showToast(e.message, 'error');
    }
  };

  const retrySummary = async () => {
    try {
      await api.resummarize(id);
      setCtx((c) => ({ ...c, status: 'summarizing' }));
      showToast('Re-summarizing…');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };

  const generatePrompt = async () => {
    setPromptBusy(true);
    try {
      const res = await api.generatePrompt(id, promptSize, promptQuery.trim() || undefined);
      setPromptText(res.prompt || '');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setPromptBusy(false);
    }
  };

  const openEdit = () => {
    setEditTitle(ctx.title || '');
    setEditTags((ctx.tags || []).join(', '));
    setEditNotes((ctx.important_notes || []).join('\n'));
    setEditOpen(true);
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      await api.updateContext(id, {
        title: editTitle.trim() || ctx.title,
        tags: editTags.split(',').map((t) => t.trim()).filter(Boolean),
        summary: ctx.summary,
        important_notes: editNotes.split('\n').map((n) => n.trim()).filter(Boolean),
      });
      setEditOpen(false);
      showToast('Context updated');
      load();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteContext(id);
      showToast('Context deleted');
      refreshCollections();
      navigate('library');
    } catch (e) {
      showToast(e.message, 'error');
      setDeleting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="detail-view">
        <div className="det-skeleton">
          <div className="det-skel det-skel-back" />
          <div className="det-skel det-skel-title" />
          <div className="det-skel det-skel-meta" />
          <div className="det-skel det-skel-block" />
          <div className="det-skel det-skel-block" />
        </div>
      </div>
    );
  }

  if (!ctx) {
    return (
      <div className="detail-view">
        <button className="det-back" onClick={() => navigate('library')}>
          <ArrowLeft size={14} /> Library
        </button>
        <div className="det-missing">Context not found.</div>
      </div>
    );
  }

  const s = ctx.summary || {};

  return (
    <div className="detail-view">
      <button className="det-back" onClick={() => navigate('library')}>
        <ArrowLeft size={14} /> Library
      </button>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      >
        {/* ── Hero ── */}
        <header className="det-hero">
          <div className="det-hero-top">
            <h1 className="det-title">{ctx.title}</h1>
            <button
              className={`det-starbtn ${ctx.starred ? 'on' : ''}`}
              onClick={toggleStar}
              aria-pressed={!!ctx.starred}
              aria-label={ctx.starred ? 'Unstar' : 'Star'}
              title={ctx.starred ? 'Unstar' : 'Star'}
            >
              <Star size={17} fill={ctx.starred ? 'currentColor' : 'none'} />
            </button>
          </div>

          <div className="det-meta">
            <span className="det-date">{fullDate(ctx.created_at)}</span>
            {(ctx.tags || []).map((t) => <span key={t} className="chip">{t}</span>)}
          </div>

          <div className="det-actions">
            <select
              className="det-col-select"
              value={ctx.collection_id != null ? String(ctx.collection_id) : ''}
              onChange={(e) => changeCollection(e.target.value)}
              aria-label="Collection"
            >
              <option value="">No collection</option>
              {collections.map((c) => (
                <option key={c.id} value={String(c.id)}>{c.name}</option>
              ))}
            </select>

            <button className="btn-ghost" onClick={openEdit}><Pencil size={14} /> Edit</button>

            <div className="det-export-wrap" ref={exportRef}>
              <button
                className="btn-ghost"
                onClick={() => setExportOpen((o) => !o)}
                aria-expanded={exportOpen}
                aria-haspopup="menu"
              >
                <Download size={14} /> Export
              </button>
              <AnimatePresence>
                {exportOpen && (
                  <motion.div
                    className="det-export-menu"
                    role="menu"
                    initial={{ opacity: 0, y: -6, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.97 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 32 }}
                  >
                    <button
                      role="menuitem"
                      onClick={() => {
                        window.open(`/api/contexts/${id}/export/download`);
                        setExportOpen(false);
                        showToast('Export started');
                      }}
                    >
                      <FileDown size={14} /> Download .md
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => { copy(buildMarkdown(ctx), 'Markdown copied'); setExportOpen(false); }}
                    >
                      <Copy size={14} /> Copy as Markdown
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <button className="btn-danger" onClick={() => setDeleteOpen(true)}>
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </header>

        {/* ── Status banners ── */}
        {ctx.status === 'summarizing' && (
          <div className="det-banner summarizing">
            <div className="spinner" />
            <span>Summarizing this conversation — sections will appear as soon as it&rsquo;s done.</span>
          </div>
        )}
        {ctx.status === 'failed' && (
          <div className="det-banner failed">
            <span>Summarization failed. The original conversation is safe — you can retry.</span>
            <button className="btn-ghost det-retry" onClick={retrySummary}>
              <RefreshCw size={13} /> Retry
            </button>
          </div>
        )}

        {/* ── Summary sections ── */}
        <div className="det-sections">
          {s.snapshot && (
            <Section title="Snapshot" defaultOpen>
              <p className="det-snapshot">{s.snapshot}</p>
            </Section>
          )}
          {s.key_ideas?.length > 0 && (
            <Section title="Key Ideas" count={s.key_ideas.length} defaultOpen>
              <ul className="det-list">
                {s.key_ideas.map((k, i) => <li key={i}>{k}</li>)}
              </ul>
            </Section>
          )}
          {s.conclusions?.length > 0 && (
            <Section title="Conclusions" count={s.conclusions.length}>
              <ul className="det-list">
                {s.conclusions.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </Section>
          )}
          {s.unresolved_questions?.length > 0 && (
            <Section title="Unresolved Questions" count={s.unresolved_questions.length}>
              <ul className="det-list questions">
                {s.unresolved_questions.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
            </Section>
          )}
          {s.vitals?.length > 0 && (
            <Section title="Vitals" count={s.vitals.length}>
              <div className="det-vitals">
                {s.vitals.map((v, i) => <code key={i} className="det-vital">{v}</code>)}
              </div>
            </Section>
          )}
          {ctx.important_notes?.length > 0 && (
            <Section title="Important Notes" count={ctx.important_notes.length}>
              <ul className="det-list">
                {ctx.important_notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </Section>
          )}
          {ctx.original_chat && (
            <Section title="Original Conversation">
              <pre className="det-chat">{ctx.original_chat}</pre>
            </Section>
          )}
        </div>

        {/* ── Continuation prompt generator ── */}
        <div className="card det-promptgen">
          <div className="det-promptgen-head">
            <div className="eyebrow">Continue elsewhere</div>
            <h2>Continuation Prompt</h2>
            <p>Generate a context-rich prompt to pick this conversation back up in any AI.</p>
          </div>

          <div className="det-promptgen-controls">
            <div className="det-seg" role="group" aria-label="Prompt size">
              {PROMPT_SIZES.map((sz) => (
                <button
                  key={sz}
                  className={promptSize === sz ? 'on' : ''}
                  onClick={() => setPromptSize(sz)}
                >
                  {sz}
                </button>
              ))}
            </div>
            <input
              className="det-prompt-query"
              placeholder="Optional focus — e.g. “the caching strategy”"
              value={promptQuery}
              onChange={(e) => setPromptQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !promptBusy && generatePrompt()}
            />
            <button className="btn-primary" onClick={generatePrompt} disabled={promptBusy}>
              {promptBusy ? <div className="spinner det-btn-spinner" /> : <Sparkles size={14} />}
              {promptBusy ? 'Generating…' : 'Generate'}
            </button>
          </div>

          <AnimatePresence>
            {promptText && (
              <motion.div
                className="det-prompt-result"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
              >
                <div className="det-prompt-block">
                  <button
                    className="det-copy"
                    onClick={() => copy(promptText, 'Prompt copied')}
                    title="Copy prompt"
                  >
                    <Copy size={13} /> Copy
                  </button>
                  <pre>{promptText}</pre>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      {/* ── Edit modal ── */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit Context">
        <label className="det-field">
          <span>Title</span>
          <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} autoFocus />
        </label>
        <label className="det-field">
          <span>Tags <em>(comma-separated)</em></span>
          <input
            value={editTags}
            onChange={(e) => setEditTags(e.target.value)}
            placeholder="react, performance, ChatGPT"
          />
        </label>
        <label className="det-field">
          <span>Important notes <em>(one per line)</em></span>
          <textarea
            rows={4}
            value={editNotes}
            onChange={(e) => setEditNotes(e.target.value)}
            placeholder="Anything worth pinning to this context…"
          />
        </label>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={() => setEditOpen(false)}>Cancel</button>
          <button className="btn-primary" onClick={saveEdit} disabled={saving || !editTitle.trim()}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </Modal>

      {/* ── Delete modal ── */}
      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete context?">
        <p className="det-confirm-text">
          <strong>&ldquo;{ctx.title}&rdquo;</strong> and its embeddings will be permanently deleted.
          This can&rsquo;t be undone.
        </p>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={() => setDeleteOpen(false)}>Cancel</button>
          <button className="btn-danger" onClick={confirmDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
