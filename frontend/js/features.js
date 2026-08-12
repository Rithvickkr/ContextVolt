// ContextVolt — client-side feature flags.
//
// Mirrors backend/features.py. The backend is the source of truth; this module
// fetches /api/features once at boot and applies the result to the DOM.
//
// Gating is done markup-first to avoid a flash of a feature the user doesn't
// have: anything with a [data-feature] attribute is hidden by CSS from the very
// first paint. applyFeatures() then either removes the attribute (enabled) or
// removes the element from the DOM entirely (disabled). Deleting rather than
// merely hiding keeps disabled UI out of the tab order and off screen readers.
import { API, state } from './core.js';

// Default-deny until the backend answers. A failed fetch therefore hides gated
// features rather than exposing something this build can't actually serve.
let _features = {};

async function loadFeatures() {
    try {
        const res = await fetch(`${API}/api/features`);
        if (res.ok) _features = await res.json();
    } catch (_) {
        // Offline or backend not up yet — keep default-deny.
    }
    state.features = _features;
    applyFeatures();
    return _features;
}

function featureEnabled(name) {
    return _features[name] === true;
}

function applyFeatures(root = document) {
    root.querySelectorAll('[data-feature]').forEach(el => {
        if (featureEnabled(el.dataset.feature)) {
            el.removeAttribute('data-feature');
        } else {
            el.remove();
        }
    });
}

export { loadFeatures, featureEnabled, applyFeatures };
