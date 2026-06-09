import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * App-level navigation + shared data (collections, setup status).
 * Views: 'dashboard' | 'capture' | 'library' | 'detail' | 'ask'
 * Detail view carries a contextId param.
 */
const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [view, setView] = useState('dashboard');
  const [detailId, setDetailId] = useState(null);
  const [collections, setCollections] = useState([]);
  const [activeCollection, setActiveCollection] = useState(null);
  const [config, setConfig] = useState(null);
  const [backendUp, setBackendUp] = useState(true);

  const navigate = useCallback((v, params = {}) => {
    setView(v);
    if (v === 'detail') setDetailId(params.id ?? null);
  }, []);

  const showDetail = useCallback((id) => {
    setDetailId(id);
    setView('detail');
  }, []);

  const refreshCollections = useCallback(async () => {
    try {
      const cols = await api.collections();
      setCollections(Array.isArray(cols) ? cols : cols.collections || []);
    } catch { /* backend may not be ready yet */ }
  }, []);

  const refreshConfig = useCallback(async () => {
    try { setConfig(await api.setupConfig()); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refreshCollections();
    refreshConfig();
    const ping = setInterval(async () => {
      try { await api.health(); setBackendUp(true); } catch { setBackendUp(false); }
    }, 15000);
    return () => clearInterval(ping);
  }, [refreshCollections, refreshConfig]);

  return (
    <AppContext.Provider value={{
      view, navigate, detailId, showDetail,
      collections, refreshCollections,
      activeCollection, setActiveCollection,
      config, refreshConfig,
      backendUp,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  return useContext(AppContext);
}
