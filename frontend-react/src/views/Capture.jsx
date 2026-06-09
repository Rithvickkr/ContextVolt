import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Sparkles } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { useToast } from '../state/ToastContext';
import { api } from '../api/client';
import '../styles/capture.css';

const STEPS = ['Summarize', 'Save', 'Chunk', 'Embed'];
const MIN_CHARS = 20;

function matchStep(label) {
  const t = String(label).toLowerCase();
  if (t.includes('embed')) return 3;
  if (t.includes('chunk')) return 2;
  if (t.includes('sav')) return 1;
  return 0;
}

export default function Capture() {
  const { showDetail, refreshCollections } = useApp();
  const { showToast } = useToast();

  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [stepLabel, setStepLabel] = useState('');
  const [frac, setFrac] = useState(0);
  const [live, setLive] = useState('');

  const abortRef = useRef(null);
  const alive = useRef(true);
  const liveRef = useRef(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // Keep live token area scrolled to bottom
  useEffect(() => {
    if (liveRef.current) liveRef.current.scrollTop = liveRef.current.scrollHeight;
  }, [live]);

  const chars = text.length;
  const tokens = Math.ceil(chars / 4);
  const canSave = !busy && text.trim().length >= MIN_CHARS;

  const fail = (msg) => {
    if (!alive.current) return;
    showToast(msg || 'Something went wrong', 'error');
    setBusy(false);
    setStepIdx(0);
    setStepLabel('');
    setFrac(0);
    setLive('');
  };

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setStepIdx(0);
    setStepLabel('Summarizing…');
    setFrac(0);
    setLive('');

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let result = null;
    let streamErr = null;

    try {
      await api.summarizeStream(text, (ev) => {
        if (ev.error) {
          streamErr = ev.error;
          ctrl.abort();
          return;
        }
        if (ev.token) setLive((s) => (s + ev.token).slice(-1600));
        if (ev.step) {
          setStepLabel(String(ev.step));
          setStepIdx(matchStep(ev.step));
          setFrac(0);
        }
        if (ev.done != null && ev.total) setFrac(Math.min(1, ev.done / ev.total));
        if (ev.result) result = ev.result;
      }, ctrl.signal);
    } catch (e) {
      if (!alive.current) return; // unmounted mid-stream
      if (!streamErr && e.name !== 'AbortError') { fail(e.message); return; }
    }
    if (!alive.current) return;
    if (streamErr) { fail(streamErr); return; }
    if (!result) { fail('Summarization produced no result'); return; }

    // Save → Chunk → Embed happen inside the create call on the backend.
    setStepIdx(1);
    setStepLabel('Saving context…');
    setFrac(0.4);
    try {
      const created = await api.createContext({
        title: title.trim() || result.main_topic || 'Untitled context',
        summary: result,
        tags: [],
        original_chat: text,
      });
      if (!alive.current) return;
      setStepIdx(3);
      setStepLabel('Done');
      setFrac(1);
      refreshCollections();
      showToast('Context saved');
      showDetail(created.id);
    } catch (e) {
      fail(e.message);
    }
  };

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  };

  const overall = busy ? Math.min(100, ((stepIdx + Math.min(frac, 1)) / STEPS.length) * 100) : 0;

  return (
    <div className="capture">
      <header className="capture-head">
        <div className="eyebrow">Capture</div>
        <motion.h1
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 28 }}
        >
          Save a conversation.
        </motion.h1>
        <p className="capture-sub">Paste a chat from any AI assistant — it gets summarized, chunked and embedded into your vault.</p>
      </header>

      <motion.div
        className="capture-form"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 26, delay: 0.04 }}
      >
        <input
          className="capture-title"
          placeholder="Title (optional — auto-generated if empty)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
        />

        <div className="capture-textwrap">
          <textarea
            className="capture-text"
            placeholder="Paste any AI conversation…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
            spellCheck={false}
          />
          <div className="capture-counter">
            <span>{chars.toLocaleString()} chars</span>
            <span className="counter-sep">·</span>
            <span>≈{tokens.toLocaleString()} tokens</span>
          </div>
        </div>

        <div className="capture-bar">
          <span className="capture-hint">
            {canSave ? <kbd>Ctrl</kbd> : null}
            {canSave ? <span className="hint-plus">+</span> : null}
            {canSave ? <kbd>Enter</kbd> : null}
            {canSave ? ' to save' : `Paste at least ${MIN_CHARS} characters to save`}
          </span>
          <button className="btn-primary" onClick={save} disabled={!canSave}>
            {busy ? <span className="spinner" /> : <Sparkles size={15} />}
            {busy ? 'Working…' : 'Summarize & Save'}
          </button>
        </div>
      </motion.div>

      <AnimatePresence>
        {busy && (
          <motion.div
            className="card pipeline"
            initial={{ opacity: 0, y: 16, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -8, height: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          >
            <div className="pipeline-inner">
              <div className="pipeline-steps">
                {STEPS.map((s, i) => {
                  const state = i < stepIdx ? 'done' : i === stepIdx ? 'active' : 'todo';
                  return (
                    <div key={s} className={`pipe-step ${state}`}>
                      <span className="pipe-dot">
                        {state === 'done' ? <Check size={11} strokeWidth={3} /> : i + 1}
                      </span>
                      <span className="pipe-name">{s}</span>
                      {i < STEPS.length - 1 && <span className="pipe-line" />}
                    </div>
                  );
                })}
              </div>

              <div className="pipeline-track">
                <motion.div
                  className="pipeline-fill"
                  animate={{ width: `${overall}%` }}
                  transition={{ type: 'spring', stiffness: 120, damping: 24 }}
                />
              </div>
              <div className="pipeline-label">{stepLabel || 'Working…'}</div>

              {live && (
                <div className="pipeline-live" ref={liveRef}>
                  <span className="live-text">{live}</span>
                  <span className="live-caret" />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
