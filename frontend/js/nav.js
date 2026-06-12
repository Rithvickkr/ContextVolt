// ContextVolt — View navigation.
import { $, $$, state } from './core.js';
import { loadDashboard } from './dashboard.js';
import { loadContexts } from './library.js';
import { startWorkerPolling } from './polling.js';
// â”€â”€â”€ Navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function navigateTo(view) {
    state.view = view;
    document.body.dataset.view = view; // lets CSS adapt per view (e.g. lights backdrop)

    // Hide all views, show target with fade-in
    $$('.view').forEach(v => {
        if (v.id === `view-${view}`) {
            v.style.display = 'block';
            // Trigger fade-in: start invisible, paint, then transition to visible
            v.style.opacity = '0';
            v.style.transform = 'translateY(6px)';
            v.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
            requestAnimationFrame(() => {
                v.style.opacity = '1';
                v.style.transform = 'translateY(0)';
            });
        } else {
            v.style.display = 'none';
            v.style.opacity = '';
            v.style.transform = '';
            v.style.transition = '';
        }
    });

    // Update nav
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    const navKey = view === 'detail' ? 'library' : (view === 'capture' ? 'input' : view);
    const navBtn = $(`[data-view="${navKey}"]`);
    if (navBtn) navBtn.classList.add('active');

    // Load data for the target view
    if (view === 'library') {
        loadContexts();
    } else if (view === 'input') {
        loadDashboard(); // always refresh — stats, pins and recents change while you're away
    } else if (view === 'ask') {
        // Drop the cursor straight into the composer so users can type at once.
        setTimeout(() => {
            const ai = document.getElementById('ask-input');
            if (ai && state.view === 'ask' && !ai.disabled) ai.focus();
        }, 80);
    }

    // Start polling when entering library/detail; let it self-stop when done
    // (don't stop on other views — in-flight summarizations still need to fire toasts)
    if (view === 'library' || view === 'detail') {
        startWorkerPolling();
    }
}


export { navigateTo };
