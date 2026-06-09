import { lazy, Suspense, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Sidebar from './components/Sidebar';
import SetupWizard from './components/SetupWizard';
import { useApp } from './state/AppContext';
import './styles/app.css';

const Dashboard = lazy(() => import('./views/Dashboard'));
const Capture = lazy(() => import('./views/Capture'));
const Library = lazy(() => import('./views/Library'));
const Detail = lazy(() => import('./views/Detail'));
const AskVault = lazy(() => import('./views/AskVault'));
const SettingsModal = lazy(() => import('./components/SettingsModal'));
const SystemModal = lazy(() => import('./components/SystemModal'));

const VIEWS = {
  dashboard: Dashboard,
  capture: Capture,
  library: Library,
  detail: Detail,
  ask: AskVault,
};

export default function App() {
  const { view, navigate, detailId } = useApp();
  const [setupDone, setSetupDone] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'n') navigate('dashboard');
      else if (k === 'c') navigate('capture');
      else if (k === 'l') navigate('library');
      else if (k === 'a') navigate('ask');
      else if (e.key === 'Backspace' && view === 'detail') navigate('library');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate, view]);

  const ViewComponent = VIEWS[view] || Dashboard;

  return (
    <div className="app-shell">
      {!setupDone && <SetupWizard onReady={() => setSetupDone(true)} />}

      <Sidebar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSystem={() => setSystemOpen(true)}
      />

      <main className="main-content">
        <Suspense fallback={<div className="view-loading"><div className="spinner" /></div>}>
          <AnimatePresence mode="wait">
            <motion.div
              key={view + (view === 'detail' ? `-${detailId}` : '')}
              className="view-wrap"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: [0, 0, 0.2, 1] }}
            >
              <ViewComponent id={view === 'detail' ? detailId : undefined} />
            </motion.div>
          </AnimatePresence>
        </Suspense>
      </main>

      <Suspense fallback={null}>
        {settingsOpen && <SettingsModal open onClose={() => setSettingsOpen(false)} />}
        {systemOpen && <SystemModal open onClose={() => setSystemOpen(false)} />}
      </Suspense>
    </div>
  );
}
