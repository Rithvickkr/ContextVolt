import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Server, Box, Brain, Check } from 'lucide-react';
import { api } from '../api/client';
import '../styles/setup.css';

const POLL_MS = 1500;
const SKIP_AFTER_MS = 15000;

function StatusDot({ state }) {
  if (state === 'ok') return <span className="setup-dot ok"><Check size={10} strokeWidth={3.5} /></span>;
  if (state === 'checking') return <span className="setup-spinner" aria-label="Checking" />;
  return <span className="setup-dot pending" />;
}

export default function SetupWizard({ onReady }) {
  const [backend, setBackend] = useState('checking');
  const [ollama, setOllama] = useState('pending');
  const [model, setModel] = useState('pending');
  const [modelName, setModelName] = useState(null);
  const [showSkip, setShowSkip] = useState(false);
  const [success, setSuccess] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const doneRef = useRef(false);
  const inFlight = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setLeaving(true); // exit animation → onExitComplete calls onReady
  };

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (cancelled || doneRef.current || inFlight.current) return;
      inFlight.current = true;
      try {
        let backendOk = false;
        try {
          await api.health();
          backendOk = true;
        } catch { /* backend not reachable yet — keep checking */ }
        if (cancelled) return;

        if (!backendOk) {
          setBackend('checking');
          setOllama('pending');
          setModel('pending');
          return;
        }
        setBackend('ok');

        let st = null;
        try {
          st = await api.setupStatus();
        } catch { /* endpoint not ready — keep checking */ }
        if (cancelled) return;

        if (!st) {
          setOllama('checking');
          setModel('pending');
          return;
        }
        if (st.model_name) setModelName(st.model_name);
        setOllama(st.ollama_running ? 'ok' : 'checking');
        setModel(st.model_ready ? 'ok' : st.ollama_running ? 'checking' : 'pending');

        if (st.ollama_running && st.model_ready) {
          setSuccess(true);
          setTimeout(finish, 850);
        }
      } finally {
        inFlight.current = false;
      }
    };

    poll();
    const interval = setInterval(poll, POLL_MS);
    const skipTimer = setTimeout(() => { if (!doneRef.current) setShowSkip(true); }, SKIP_AFTER_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(skipTimer);
    };
  }, []);

  const cards = [
    { icon: Server, label: 'Backend Server', sub: backend === 'ok' ? 'Connected' : 'Waiting for connection…', state: backend },
    { icon: Box, label: 'Ollama Service', sub: ollama === 'ok' ? 'Running' : ollama === 'checking' ? 'Starting up…' : 'Waiting for backend', state: ollama },
    { icon: Brain, label: modelName ? `Model · ${modelName}` : 'Model', sub: model === 'ok' ? 'Ready' : model === 'checking' ? 'Loading model…' : 'Waiting for Ollama', state: model },
  ];

  return (
    <AnimatePresence onExitComplete={onReady}>
      {!leaving && (
        <motion.div
          className="setup-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, scale: 1.02 }}
          transition={{ duration: 0.35, ease: [0, 0, 0.2, 1] }}
        >
          <motion.div
            className="setup-panel"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 280, damping: 26, delay: 0.08 }}
          >
            <div className="setup-brand">
              <img src="/static/CVsvg.svg" width="40" height="40" alt="" className="setup-logo" />
              <span className="setup-name">ContextVolt</span>
            </div>

            <h1 className="setup-heading">
              {success ? 'Workspace ready.' : 'Getting your workspace ready'}
            </h1>
            <p className="setup-sub">
              {success
                ? 'Everything is up and running — let’s go.'
                : 'Checking your local stack. This usually takes a few seconds.'}
            </p>

            <div className="setup-cards">
              {cards.map(({ icon: Icon, label, sub, state }, i) => (
                <motion.div
                  key={i}
                  className={`setup-card ${state}`}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: 'spring', stiffness: 320, damping: 26, delay: 0.16 + i * 0.04 }}
                >
                  <Icon size={17} className="setup-card-ic" />
                  <div className="setup-card-text">
                    <span className="setup-card-label">{label}</span>
                    <span className="setup-card-sub">{sub}</span>
                  </div>
                  <StatusDot state={state} />
                </motion.div>
              ))}
            </div>

            <div className="setup-foot">
              <AnimatePresence mode="wait">
                {success ? (
                  <motion.div
                    key="ok"
                    className="setup-ready"
                    initial={{ opacity: 0, scale: 0.92 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                  >
                    <Check size={14} strokeWidth={3} /> All systems go
                  </motion.div>
                ) : showSkip ? (
                  <motion.button
                    key="skip"
                    className="btn-ghost"
                    onClick={finish}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    Continue anyway
                  </motion.button>
                ) : (
                  <motion.span
                    key="wait"
                    className="setup-waiting"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                  >
                    Hang tight…
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
