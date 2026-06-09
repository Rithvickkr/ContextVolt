import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { LayoutGrid, ListChecks, Loader, PenLine, Rows3, Search, Trash2, X } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../state/AppContext';
import { useToast } from '../state/ToastContext';
import Modal from '../components/Modal';
import ContextCard from '../components/ContextCard';
import '../styles/library.css';

const PER_PAGE = 24;
const SORTS = [
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['alpha', 'A → Z'],
];

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};

export default function Library() {
  const { collections, refreshCollections, activeCollection, showDetail, navigate } = useApp();
  const { showToast } = useToast();

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [searchMode, setSearchMode] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSortState] = useState(() => localStorage.getItem('cv-sort-order') || 'newest');
  const [layout, setLayoutState] = useState(() => localStorage.getItem('cv-lib-view') || 'grid');

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [refreshTick, setRefreshTick] = useState(0);
  const fetchKey = `${query}|${sort}|${activeCollection ?? 'all'}|${refreshTick}`;
  const [loadedKey, setLoadedKey] = useState(null);
  const loading = loadedKey !== fetchKey;

  const pageRef = useRef(1);
  const searchRef = useRef(null);
  const pendingDeletes = useRef(new Map()); // id → timeout

  const fetchPage = useCallback((page) => api.contexts({
    page,
    per_page: PER_PAGE,
    sort,
    q: query || undefined,
    collection_id: activeCollection,
  }), [sort, query, activeCollection]);

  // ── Data loading (page 1, re-runs when filters change) ────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchPage(1);
        if (cancelled) return;
        pageRef.current = 1;
        setItems(res.contexts || []);
        setTotal(res.total ?? 0);
        setHasMore(!!res.has_more);
        setSearchMode(res.search_mode || null);
      } catch (e) {
        if (!cancelled) showToast(e.message, 'error');
      } finally {
        if (!cancelled) setLoadedKey(fetchKey);
      }
    })();
    return () => { cancelled = true; };
  }, [fetchKey, fetchPage, showToast]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = pageRef.current + 1;
      const res = await fetchPage(page);
      pageRef.current = page;
      setItems((prev) => [...prev, ...(res.contexts || [])]);
      setHasMore(!!res.has_more);
      if (res.total != null) setTotal(res.total);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  // Debounce search input → query (300ms)
  useEffect(() => {
    const t = setTimeout(() => setQuery(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // '/' focuses search when not typing elsewhere
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ── Preferences ───────────────────────────────────────────
  const setSort = (v) => { setSortState(v); localStorage.setItem('cv-sort-order', v); };
  const setLayout = (v) => { setLayoutState(v); localStorage.setItem('cv-lib-view', v); };

  // ── Star (optimistic) ─────────────────────────────────────
  const toggleStar = async (ctx) => {
    setItems((prev) => prev.map((c) => (c.id === ctx.id ? { ...c, starred: !c.starred } : c)));
    try {
      await api.toggleStar(ctx.id);
    } catch (e) {
      setItems((prev) => prev.map((c) => (c.id === ctx.id ? { ...c, starred: ctx.starred } : c)));
      showToast(e.message, 'error');
    }
  };

  // ── Single delete: remove from UI, DELETE after 5s unless undone ──
  const deleteOne = (ctx) => {
    if (pendingDeletes.current.has(ctx.id)) return;
    const idx = items.findIndex((c) => c.id === ctx.id);
    setItems((prev) => prev.filter((c) => c.id !== ctx.id));
    setTotal((t) => Math.max(0, t - 1));

    const timer = setTimeout(async () => {
      pendingDeletes.current.delete(ctx.id);
      try {
        await api.deleteContext(ctx.id);
        refreshCollections();
      } catch (e) {
        showToast(e.message, 'error');
      }
    }, 5000);
    pendingDeletes.current.set(ctx.id, timer);

    showToast('Deleted', 'success', {
      actionLabel: 'Undo',
      action: () => {
        const t = pendingDeletes.current.get(ctx.id);
        if (t) { clearTimeout(t); pendingDeletes.current.delete(ctx.id); }
        setItems((prev) => {
          if (prev.some((c) => c.id === ctx.id)) return prev;
          const next = prev.slice();
          next.splice(Math.min(Math.max(idx, 0), next.length), 0, ctx);
          return next;
        });
        setTotal((t2) => t2 + 1);
      },
    });
  };

  // ── Bulk select / delete ──────────────────────────────────
  const toggleSelectMode = () => {
    setSelectMode((m) => !m);
    setSelectedIds(new Set());
  };

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const bulkDelete = async () => {
    setBulkBusy(true);
    try {
      const ids = [...selectedIds];
      await api.bulkDelete(ids);
      showToast(`Deleted ${ids.length} context${ids.length === 1 ? '' : 's'}`);
      setBulkConfirm(false);
      setSelectMode(false);
      setSelectedIds(new Set());
      refreshCollections();
      setRefreshTick((t) => t + 1);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  // ── Render ────────────────────────────────────────────────
  const activeCol = collections.find((c) => c.id === activeCollection);
  const searching = !!query;

  return (
    <div className="library-view">
      <header className="lib-header">
        <div className="eyebrow">Library{activeCol ? ` · ${activeCol.name}` : ''}</div>
        <h1>Everything you&rsquo;ve saved.</h1>
        <p className="lib-sub">
          {loading ? 'Loading…' : `${total} context${total === 1 ? '' : 's'}${searching ? ' found' : ''}`}
        </p>
      </header>

      <div className="lib-toolbar">
        <div className="lib-search">
          <Search size={14} className="lib-search-ic" />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search your vault…  ( / )"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search contexts"
          />
          {searching && searchMode && (
            <span className={`lib-mode-badge ${searchMode}`}>{searchMode}</span>
          )}
        </div>

        <div className="lib-controls">
          <select
            className="lib-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            aria-label="Sort order"
          >
            {SORTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>

          <div className="lib-seg" role="group" aria-label="Layout">
            <button
              className={layout === 'grid' ? 'on' : ''}
              onClick={() => setLayout('grid')}
              aria-label="Grid view"
              title="Grid view"
            >
              <LayoutGrid size={14} />
            </button>
            <button
              className={layout === 'rows' ? 'on' : ''}
              onClick={() => setLayout('rows')}
              aria-label="Rows view"
              title="Rows view"
            >
              <Rows3 size={14} />
            </button>
          </div>

          <button
            className={`lib-select-toggle ${selectMode ? 'on' : ''}`}
            onClick={toggleSelectMode}
            aria-pressed={selectMode}
            title="Bulk select"
          >
            <ListChecks size={14} />
            Select
          </button>
        </div>
      </div>

      {loading ? (
        <div className="view-loading"><div className="spinner" /></div>
      ) : items.length === 0 ? (
        searching ? (
          <div className="lib-empty">
            <Search size={26} />
            <h3>No matches for &ldquo;{query}&rdquo;</h3>
            <p>Try different keywords — semantic search digs into the content, not just titles.</p>
          </div>
        ) : (
          <div className="lib-empty">
            <PenLine size={26} />
            <h3>Nothing saved yet</h3>
            <p>Capture your first AI conversation and it will land here.</p>
            <button className="btn-primary" onClick={() => navigate('capture')}>
              <PenLine size={14} /> Capture a context
            </button>
          </div>
        )
      ) : (
        <>
          <motion.div
            key={fetchKey}
            className={`lib-list ${layout}`}
            variants={containerVariants}
            initial="hidden"
            animate="show"
          >
            {items.map((ctx) => (
              <ContextCard
                key={ctx.id}
                ctx={ctx}
                collections={collections}
                onOpen={showDetail}
                onStar={toggleStar}
                onDelete={deleteOne}
                selected={selectedIds.has(ctx.id)}
                selectMode={selectMode}
                onToggleSelect={toggleSelect}
                searchQuery={query}
              />
            ))}
          </motion.div>

          {hasMore && (
            <div className="lib-more">
              <button
                className="btn-ghost"
                disabled={loadingMore}
                onClick={loadMore}
              >
                {loadingMore ? <Loader size={14} className="lib-spin" /> : null}
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      <AnimatePresence>
        {selectMode && selectedIds.size > 0 && (
          <motion.div
            className="lib-bulkbar"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <span className="lib-bulk-count">
              {selectedIds.size} selected
            </span>
            <button className="btn-danger" onClick={() => setBulkConfirm(true)}>
              <Trash2 size={14} /> Delete
            </button>
            <button
              className="lib-bulk-close"
              onClick={toggleSelectMode}
              aria-label="Exit select mode"
            >
              <X size={15} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <Modal open={bulkConfirm} onClose={() => setBulkConfirm(false)} title="Delete contexts?">
        <p className="lib-confirm-text">
          This permanently deletes <strong>{selectedIds.size}</strong> context{selectedIds.size === 1 ? '' : 's'} and
          their embeddings. This can&rsquo;t be undone.
        </p>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={() => setBulkConfirm(false)}>Cancel</button>
          <button className="btn-danger" onClick={bulkDelete} disabled={bulkBusy}>
            {bulkBusy ? 'Deleting…' : `Delete ${selectedIds.size}`}
          </button>
        </div>
      </Modal>
    </div>
  );
}
