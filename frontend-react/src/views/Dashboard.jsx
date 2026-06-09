import { useEffect, useRef, useState } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'framer-motion';
import { Layers, FolderKanban, MessageCircleQuestion, TrendingUp, PenLine, Star, Zap } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { useToast } from '../state/ToastContext';
import { api } from '../api/client';
import '../styles/dashboard.css';

const STAT_DEFS = [
  { key: 'contexts', label: 'Contexts', icon: Layers },
  { key: 'collections', label: 'Collections', icon: FolderKanban },
  { key: 'questions_asked', label: 'Questions asked', icon: MessageCircleQuestion },
  { key: 'contexts_this_week', label: 'This week', icon: TrendingUp },
];

function CountUp({ value }) {
  const mv = useMotionValue(0);
  const rounded = useTransform(mv, (v) => Math.round(v).toLocaleString());
  useEffect(() => {
    const controls = animate(mv, value ?? 0, { duration: 0.9, ease: [0, 0, 0.2, 1] });
    return () => controls.stop();
  }, [value, mv]);
  return <motion.span>{rounded}</motion.span>;
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function Dashboard() {
  const { config, collections, showDetail, navigate } = useApp();
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        const d = await api.dashboard();
        if (alive.current) setData(d);
      } catch (e) {
        if (alive.current) showToast(e.message, 'error');
      } finally {
        if (alive.current) setLoading(false);
      }
    })();
    return () => { alive.current = false; };
  }, [showToast]);

  const stats = data?.stats || {};
  const recent = (data?.recent || []).slice(0, 8);
  const name = config?.user_name?.trim();
  const colorOf = (id) => collections.find((c) => c.id === id)?.color || 'var(--text-faint)';

  return (
    <div className="dash">
      <header className="dash-hero">
        <div className="eyebrow">Dashboard</div>
        <motion.h1
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 28 }}
        >
          {name ? `Welcome back, ${name}.` : 'Welcome back.'}
        </motion.h1>
        <p className="dash-sub">
          {loading
            ? 'Loading your vault…'
            : `${(stats.contexts ?? 0).toLocaleString()} context${stats.contexts === 1 ? '' : 's'} in your vault, ready to recall.`}
        </p>
      </header>

      <section className="dash-stats" aria-label="Stats">
        {STAT_DEFS.map(({ key, label, icon: Icon }, i) => (
          <motion.div
            key={key}
            className="card stat-card"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 26, delay: i * 0.04 }}
          >
            <div className="stat-top">
              <span className="stat-label">{label}</span>
              <Icon size={15} className="stat-ic" />
            </div>
            <div className="stat-value">
              {loading ? <span className="stat-dash">—</span> : <CountUp value={stats[key] ?? 0} />}
            </div>
          </motion.div>
        ))}
      </section>

      <section className="dash-actions" aria-label="Quick actions">
        <motion.button
          className="btn-primary"
          onClick={() => navigate('capture')}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.16 }}
        >
          <PenLine size={15} /> Capture conversation
        </motion.button>
        <motion.button
          className="btn-ghost"
          onClick={() => navigate('ask')}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <MessageCircleQuestion size={15} /> Ask your vault
        </motion.button>
      </section>

      <section className="dash-recent">
        <div className="dash-section-head">
          <h2>Recent contexts</h2>
        </div>

        {loading && (
          <div className="recent-grid">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card recent-skel">
                <div className="skel-line w-60" />
                <div className="skel-line w-90" />
                <div className="skel-line w-40" />
              </div>
            ))}
          </div>
        )}

        {!loading && recent.length === 0 && (
          <motion.div
            className="card dash-empty"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <Zap size={26} className="dash-empty-ic" />
            <h3>Your vault is empty</h3>
            <p>Capture your first AI conversation and ContextVolt will summarize, index and remember it for you.</p>
            <button className="btn-primary" onClick={() => navigate('capture')}>
              <PenLine size={15} /> Capture a conversation
            </button>
          </motion.div>
        )}

        {!loading && recent.length > 0 && (
          <div className="recent-grid">
            {recent.map((ctx, i) => {
              const snippet = ctx.summary?.snapshot || ctx.summary?.main_topic || '';
              const tags = (ctx.tags || []).slice(0, 2);
              return (
                <motion.button
                  key={ctx.id}
                  className="card recent-card"
                  onClick={() => showDetail(ctx.id)}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: 'spring', stiffness: 320, damping: 26, delay: 0.1 + i * 0.04 }}
                >
                  <div className="recent-top">
                    <span className="col-dot" style={{ background: colorOf(ctx.collection_id) }} />
                    <span className="recent-title">{ctx.title || 'Untitled'}</span>
                    {ctx.starred ? <Star size={13} className="recent-star" fill="currentColor" /> : null}
                  </div>
                  {snippet && <p className="recent-snippet">{snippet}</p>}
                  <div className="recent-meta">
                    <span className="recent-date">{fmtDate(ctx.created_at)}</span>
                    {tags.map((t) => (
                      <span key={t} className="chip">{t}</span>
                    ))}
                  </div>
                </motion.button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
