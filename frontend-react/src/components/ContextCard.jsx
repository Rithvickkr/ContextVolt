import { motion } from 'framer-motion';
import { Check, Star, Trash2 } from 'lucide-react';
import { AI_BRANDS } from '../api/client';
import '../styles/context-card.css';

/** Relative "time ago" for card metadata. */
function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Wrap query matches in <mark>. */
function Highlight({ text, query }) {
  const str = String(text ?? '');
  const q = (query || '').trim();
  if (!q) return str;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = str.split(new RegExp(`(${esc})`, 'ig'));
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p));
}

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 420, damping: 34 } },
};

/**
 * One context in the library list.
 * Props: {ctx, collections, onOpen, onStar, onDelete?, selected, selectMode, onToggleSelect, searchQuery}
 */
export default function ContextCard({
  ctx, collections = [], onOpen, onStar, onDelete,
  selected = false, selectMode = false, onToggleSelect, searchQuery = '',
}) {
  const collection = collections.find((c) => c.id === ctx.collection_id);
  const sourceName = (ctx.tags || []).find((t) =>
    Object.keys(AI_BRANDS).some((b) => b.toLowerCase() === String(t).toLowerCase())
  );
  const brand = sourceName
    ? AI_BRANDS[Object.keys(AI_BRANDS).find((b) => b.toLowerCase() === String(sourceName).toLowerCase())]
    : null;
  const snippet = ctx.summary?.snapshot || ctx.summary?.main_topic || '';
  const tags = (ctx.tags || []).slice(0, 3);
  const extraTags = Math.max(0, (ctx.tags || []).length - 3);

  const handleClick = () => {
    if (selectMode) onToggleSelect?.(ctx.id);
    else onOpen?.(ctx.id);
  };

  return (
    <motion.article
      className={`ctx-card ${selected ? 'selected' : ''} ${selectMode ? 'select-mode' : ''}`}
      variants={itemVariants}
      whileHover={{ y: -2 }}
      transition={{ type: 'spring', stiffness: 420, damping: 28 }}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } }}
      aria-label={ctx.title}
    >
      {selectMode && (
        <span className={`ctx-checkbox ${selected ? 'on' : ''}`} aria-hidden="true">
          {selected && <Check size={11} strokeWidth={3.5} />}
        </span>
      )}

      <div className="ctx-card-top">
        <span
          className="ctx-dot"
          style={{ background: collection?.color || 'var(--text-faint)' }}
          title={collection ? collection.name : 'No collection'}
        />
        <h3 className="ctx-title"><Highlight text={ctx.title} query={searchQuery} /></h3>
        <div className="ctx-actions" onClick={(e) => e.stopPropagation()}>
          {onDelete && !selectMode && (
            <button
              className="ctx-iconbtn ctx-del"
              onClick={() => onDelete(ctx)}
              aria-label="Delete context"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            className={`ctx-iconbtn ctx-star ${ctx.starred ? 'on' : ''}`}
            onClick={() => onStar?.(ctx)}
            aria-label={ctx.starred ? 'Unstar' : 'Star'}
            aria-pressed={!!ctx.starred}
            title={ctx.starred ? 'Unstar' : 'Star'}
          >
            <Star size={14} fill={ctx.starred ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>

      {snippet && (
        <p className="ctx-snippet"><Highlight text={snippet} query={searchQuery} /></p>
      )}

      <div className="ctx-foot">
        <span className="ctx-date">{relTime(ctx.created_at)}</span>
        {ctx.status === 'summarizing' && <span className="ctx-status summarizing">Summarizing…</span>}
        {ctx.status === 'failed' && <span className="ctx-status failed">Failed</span>}
        {brand && (
          <span className="ctx-source" style={{ color: brand.color, background: brand.bg }}>
            {Object.keys(AI_BRANDS).find((b) => b.toLowerCase() === String(sourceName).toLowerCase())}
          </span>
        )}
        <span className="ctx-tags">
          {tags.map((t) => <span key={t} className="ctx-tag">{t}</span>)}
          {extraTags > 0 && <span className="ctx-tag more">+{extraTags}</span>}
        </span>
      </div>
    </motion.article>
  );
}
