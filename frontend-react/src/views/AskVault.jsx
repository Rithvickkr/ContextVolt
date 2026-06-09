import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  History, MessageCircleQuestion, Pin, Plus, Send, Square, Trash2, X, Zap,
} from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../state/AppContext';
import { useToast } from '../state/ToastContext';
import MarkdownLite from '../components/MarkdownLite';
import '../styles/ask.css';

const SUGGESTIONS = [
  'What did I learn about embeddings?',
  'Summarize my recent research',
  'Find conversations about deployment',
];

const MAX_TA_HEIGHT = 148; // ~6 rows

function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function AskVault() {
  const { showDetail, activeCollection, collections } = useApp();
  const { showToast } = useToast();

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState(null);

  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const taRef = useRef(null);

  const scopeName = activeCollection != null
    ? (collections.find((c) => c.id === activeCollection)?.name || 'collection')
    : null;

  // ── Sessions ─────────────────────────────────────────────────
  const loadSessions = useCallback(async () => {
    try {
      const r = await api.askSessions();
      const list = Array.isArray(r) ? r : r?.sessions || [];
      list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
      setSessions(list);
    } catch { /* sessions endpoint may not be up yet */ }
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Smooth auto-scroll as messages grow / stream.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: streaming ? 'auto' : 'smooth' });
  }, [messages, thinking, streaming]);

  const resizeTextarea = () => {
    const t = taRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, MAX_TA_HEIGHT)}px`;
  };

  // ── Send / stream ────────────────────────────────────────────
  const send = async (rawText) => {
    const question = (rawText ?? input).trim();
    if (!question || streaming) return;

    const history = messages
      .filter((m) => !m.error && m.content)
      .map(({ role, content }) => ({ role, content }));

    setInput('');
    requestAnimationFrame(resizeTextarea);
    setMessages((ms) => [
      ...ms,
      { role: 'user', content: question },
      { role: 'assistant', content: '', streaming: true },
    ]);
    setStreaming(true);
    setThinking(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const patchLast = (fn) => setMessages((ms) => {
      if (!ms.length) return ms;
      const next = [...ms];
      next[next.length - 1] = fn({ ...next[next.length - 1] });
      return next;
    });

    let finalized = false;
    try {
      await api.ask(
        { question, history, session_id: sessionId, collection_id: activeCollection },
        (ev) => {
          if (ev.token) {
            setThinking(false);
            patchLast((m) => { m.content += ev.token; return m; });
          } else if (ev.done) {
            finalized = true;
            if (ev.session_id) setSessionId(ev.session_id);
            patchLast((m) => {
              m.streaming = false;
              m.sources = Array.isArray(ev.sources) ? ev.sources : [];
              return m;
            });
          } else if (ev.error) {
            finalized = true;
            patchLast((m) => { m.streaming = false; m.error = ev.error; return m; });
            showToast(ev.error, 'error');
          }
        },
        ctrl.signal,
      );
      if (!finalized) patchLast((m) => { m.streaming = false; return m; });
      loadSessions();
    } catch (e) {
      if (e.name === 'AbortError') {
        patchLast((m) => { m.streaming = false; m.stopped = true; return m; });
      } else {
        patchLast((m) => { m.streaming = false; m.error = e.message; return m; });
        showToast(e.message || 'Ask failed', 'error');
      }
    } finally {
      setStreaming(false);
      setThinking(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const newChat = () => {
    if (streaming) stop();
    setMessages([]);
    setSessionId(null);
    setInput('');
    taRef.current?.focus();
  };

  const loadSession = async (id) => {
    if (streaming) return;
    setLoadingSessionId(id);
    try {
      const s = await api.askSession(id);
      setSessionId(s.id ?? id);
      setMessages((s.messages || []).map((m) => ({
        role: m.role,
        content: m.content,
        sources: m.citations || m.sources || [],
      })));
    } catch (e) {
      showToast(e.message || 'Could not load session', 'error');
    } finally {
      setLoadingSessionId(null);
    }
  };

  const togglePin = async (s) => {
    try {
      await api.updateSession(s.id, { pinned: !s.pinned });
      loadSessions();
    } catch (e) {
      showToast(e.message || 'Could not update session', 'error');
    }
  };

  const removeSession = async (s) => {
    try {
      await api.deleteSession(s.id);
      if (s.id === sessionId) newChat();
      loadSessions();
      showToast('Session deleted');
    } catch (e) {
      showToast(e.message || 'Could not delete session', 'error');
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const fillSuggestion = (s) => {
    setInput(s);
    requestAnimationFrame(() => { resizeTextarea(); taRef.current?.focus(); });
  };

  const lastIdx = messages.length - 1;

  return (
    <div className="ask-view">
      <div className="ask-main">
        <div className="ask-header">
          <div className="eyebrow">Ask Vault</div>
          {scopeName && (
            <span className="chip on ask-scope" title="Questions are scoped to the active collection">
              <Zap size={11} /> Scoped to {scopeName}
            </span>
          )}
          <div className="ask-header-actions">
            <button className="btn-ghost ask-hbtn" onClick={newChat} title="New chat">
              <Plus size={14} /> New chat
            </button>
            <button
              className={`btn-ghost ask-hbtn ${panelOpen ? 'on' : ''}`}
              onClick={() => setPanelOpen((v) => !v)}
              title="Chat history"
              aria-expanded={panelOpen}
            >
              <History size={14} /> History
            </button>
          </div>
        </div>

        <div className="ask-scroll" ref={scrollRef}>
          {messages.length === 0 ? (
            <motion.div
              className="ask-empty"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0, 0, 0.2, 1] }}
            >
              <div className="ask-empty-icon">
                <MessageCircleQuestion size={26} />
              </div>
              <h1>Ask your vault.</h1>
              <p>
                Answers streamed from your saved conversations — every claim traceable
                back to a context in your library.
              </p>
              <div className="ask-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="ask-pill" onClick={() => fillSuggestion(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </motion.div>
          ) : (
            <div className="ask-msgs">
              {messages.map((m, i) => (
                <motion.div
                  key={i}
                  className={`ask-msg ${m.role === 'user' ? 'from-user' : 'from-assistant'}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
                >
                  {m.role === 'user' ? (
                    <div className="ask-bubble user-bubble">{m.content}</div>
                  ) : (
                    <div className={`ask-bubble assistant-bubble ${m.error ? 'is-error' : ''}`}>
                      {m.streaming && !m.content ? (
                        <span className="thinking-dots" aria-label="Thinking">
                          <span /><span /><span />
                        </span>
                      ) : (
                        <>
                          <MarkdownLite
                            text={m.content}
                            sources={m.sources}
                            onCite={(ctxId) => showDetail(ctxId)}
                            className={m.streaming && i === lastIdx ? 'is-streaming' : ''}
                          />
                          {m.error && <div className="ask-error-note">{m.error}</div>}
                          {m.stopped && <div className="ask-stopped-note">Generation stopped.</div>}
                        </>
                      )}
                      {!m.streaming && m.sources?.length > 0 && (
                        <div className="ask-sources">
                          {m.sources.map((s) => (
                            <button
                              key={`${s.n}-${s.context_id}`}
                              className="ask-src-chip"
                              onClick={() => showDetail(s.context_id)}
                              title={s.snippet || s.title}
                            >
                              <span className="src-n">{s.n}</span>
                              <span className="src-title">{s.title || 'Untitled context'}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </motion.div>
              ))}
            </div>
          )}
        </div>

        <div className="ask-inputbar">
          <textarea
            ref={taRef}
            rows={1}
            className="ask-input"
            placeholder={streaming ? 'Streaming answer…' : 'Ask anything about your vault…'}
            value={input}
            disabled={streaming}
            onChange={(e) => { setInput(e.target.value); resizeTextarea(); }}
            onKeyDown={onKeyDown}
          />
          {streaming ? (
            <button className="ask-send stop" onClick={stop} aria-label="Stop generating" title="Stop">
              <Square size={15} />
            </button>
          ) : (
            <button
              className="ask-send"
              onClick={() => send()}
              disabled={!input.trim()}
              aria-label="Send"
              title="Send (Enter)"
            >
              <Send size={15} />
            </button>
          )}
        </div>
      </div>

      <AnimatePresence>
        {panelOpen && (
          <motion.aside
            className="ask-sessions card"
            initial={{ opacity: 0, x: 28, width: 0 }}
            animate={{ opacity: 1, x: 0, width: 240 }}
            exit={{ opacity: 0, x: 28, width: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            aria-label="Chat sessions"
          >
            <div className="ask-sessions-head">
              <span>Sessions</span>
              <button className="ask-sessions-close" onClick={() => setPanelOpen(false)} aria-label="Close sessions">
                <X size={13} />
              </button>
            </div>
            <div className="ask-sessions-list">
              {sessions.length === 0 && (
                <div className="ask-sessions-empty">No saved chats yet.</div>
              )}
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`ask-session ${s.id === sessionId ? 'active' : ''} ${loadingSessionId === s.id ? 'loading' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => loadSession(s.id)}
                  onKeyDown={(e) => e.key === 'Enter' && loadSession(s.id)}
                >
                  <div className="ask-session-main">
                    <span className="ask-session-title">{s.title || 'Untitled chat'}</span>
                    <span className="ask-session-meta">
                      {s.message_count ?? 0} msgs · {timeAgo(s.updated_at)}
                    </span>
                  </div>
                  <div className="ask-session-actions">
                    <button
                      className={`ask-session-btn ${s.pinned ? 'pinned' : ''}`}
                      onClick={(e) => { e.stopPropagation(); togglePin(s); }}
                      aria-label={s.pinned ? 'Unpin' : 'Pin'}
                      title={s.pinned ? 'Unpin' : 'Pin'}
                    >
                      <Pin size={12} />
                    </button>
                    <button
                      className="ask-session-btn danger"
                      onClick={(e) => { e.stopPropagation(); removeSession(s); }}
                      aria-label="Delete session"
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}
