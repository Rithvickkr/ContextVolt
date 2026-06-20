// ContextVolt — Setup wizard.
import { loadCollections } from './collections.js';
import { $, API, state } from './core.js';
import { loadDashboard } from './dashboard.js';
import { maybeStartOnboarding } from './onboarding.js';
import { _startGlobalSummarizingPoll } from './polling.js';
import { _PROVIDER_META, _prefetchSettingsConfig, _primeSettingsConfig, _settingsConfig } from './settings.js';
import { updateStatusIndicator } from './system.js';
// â”€â”€â”€ Setup Wizard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let setupInterval = null;
let setupAttempts = 0;

// Keep the wizard on screen for at least this long so the user can actually
// see each check turn green. Without it, a warm stack (Ollama already running +
// model present, or a cloud provider active) passes on the first immediate
// check and the wizard vanishes before it's even perceptible.
const MIN_WIZARD_MS = 1400;
let _wizardShownAt = 0;
let _transitioning = false;

// Called from main.js init — the interval handle must be assigned here, in
// the module that owns the binding.
function startSetupPolling() {
    _wizardShownAt = Date.now();
    setupInterval = setInterval(checkSetup, 2000);
}

function _setStepState(el, stepState, statusText) {
    el.classList.remove('pending', 'ok', 'warn');
    el.classList.add(stepState);
    el.querySelector('.step-status').textContent = statusText;
}


async function checkSetup() {
    setupAttempts++;
    const stepBackend = $('#step-backend');
    const stepOllama = $('#step-ollama');
    const stepModel = $('#step-model');
    const skipBtn = $('#skip-setup-btn');

    try {
        const res = await fetch(`${API}/api/setup/status`);
        const data = await res.json();

        // Backend
        _setStepState(stepBackend, 'ok', 'Connected');
        stepBackend.classList.add('ready');

        // Ollama
        if (data.ollama_running) {
            _setStepState(stepOllama, 'ok', 'Running');
            stepOllama.classList.add('ready');
        } else {
            _setStepState(stepOllama, 'pending', 'Waiting for Ollama...');
            stepOllama.classList.remove('ready');
        }

        // Model
        if (data.model_ready) {
            _setStepState(stepModel, 'ok', `${data.model_name} ready`);
            stepModel.classList.add('ready');
        } else if (data.ollama_running) {
            _setStepState(stepModel, 'pending', 'Downloading model...');
            fetch(`${API}/api/setup/pull-model`, { method: 'POST' }).catch(() => {});
        } else {
            _setStepState(stepModel, 'pending', 'Waiting...');
        }

         // Check if a cloud provider is active -- bypass Ollama requirement
        try {
            const cfgRes = await fetch(`${API}/api/setup/config`);
            const cfg = await cfgRes.json();
            _primeSettingsConfig(cfg);  // prime cache early
            if (cfg.is_cloud_active) {
                const provLabel = (_PROVIDER_META[cfg.active_provider] || {}).label || cfg.active_provider;
                _setStepState(stepOllama, 'ok', `Using ${provLabel}`);
                stepOllama.classList.add('ready');
                _setStepState(stepModel, 'ok', cfg.active_model || 'Cloud model ready');
                stepModel.classList.add('ready');
                updateStatusIndicator(true, provLabel);
                state.setupComplete = true;
                transitionToApp();
                return;
            }
        } catch (_) { /* ignore */ }

       // Update status indicator
        state.ollamaReady = data.ollama_running && data.model_ready;
        updateStatusIndicator(data.ollama_running && data.model_ready);

        // LLM ready â†’ go to app
        if (data.ollama_running && data.model_ready) {
            state.setupComplete = true;
            transitionToApp();
            return;
        }

        // Show skip button after 15 seconds
        if (setupAttempts > 7) {
            skipBtn.style.display = 'block';
        }

    } catch (err) {
        // Backend not yet reachable
        _setStepState(stepBackend, 'pending', 'Connecting...');

        if (setupAttempts > 15) {
            _setStepState(stepBackend, 'warn', 'Cannot reach backend');
            stepBackend.classList.add('error');
            skipBtn.style.display = 'block';
        }
    }
}

function transitionToApp() {
    if (_transitioning) return;
    _transitioning = true;
    if (setupInterval) { clearInterval(setupInterval); setupInterval = null; }

    // Hold the wizard until the minimum display time has elapsed, so a warm
    // stack doesn't make it flash by before the checks are readable.
    const elapsed = Date.now() - _wizardShownAt;
    const remaining = MIN_WIZARD_MS - elapsed;
    if (remaining > 0) {
        setTimeout(_doTransition, remaining);
    } else {
        _doTransition();
    }
}

function _doTransition() {
    const wizard = $('#setup-wizard');
    wizard.style.transition = 'opacity 0.5s ease';
    wizard.style.opacity = '0';
    setTimeout(() => {
        wizard.style.display = 'none';
        $('#app').style.display = 'flex';
        $('#app').style.animation = 'fadeIn 0.5s ease';
        loadCollections();
        _prefetchSettingsConfig();
        loadDashboard();
        try { maybeStartOnboarding(); } catch (e) { console.warn('onboarding init failed', e); }
        _startGlobalSummarizingPoll();
    }, 500);
}


export { checkSetup, startSetupPolling, setupInterval, transitionToApp };
