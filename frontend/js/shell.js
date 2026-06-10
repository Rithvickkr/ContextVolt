// ContextVolt — App shell: theme, frameless title bar, sidebar collapse + tooltips.

// â”€â”€â”€ Theme â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.settings-theme-opt').forEach(btn => {
        const active = btn.dataset.theme === theme;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
}

function setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') return;
    _applyTheme(theme);
    localStorage.setItem('cv-theme', theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    setTheme(current === 'dark' ? 'light' : 'dark');
}

// Restore saved theme on load
(function() {
    const saved = localStorage.getItem('cv-theme') || 'dark';
    _applyTheme(saved);
})();

// ─── Custom title-bar window controls (frameless pywebview) ──────────
// Buttons call into the Python callbacks exposed via window.expose() in run.py.
// Guarded so the page still works in a plain browser (no pywebview bridge).
(function() {
    function api() { return window.pywebview && window.pywebview.api; }

    function bind() {
        const min = document.getElementById('cv-win-min');
        const max = document.getElementById('cv-win-max');
        const close = document.getElementById('cv-win-close');
        const drag = document.getElementById('cv-titlebar-drag');
        if (!min || !max || !close) return;

        const setMaxIcon = (maximized) => {
            max.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
            max.setAttribute('title', maximized ? 'Restore' : 'Maximize');
            max.classList.toggle('is-maximized', !!maximized);
        };

        min.addEventListener('click', () => { api()?.cv_minimize?.(); });
        close.addEventListener('click', () => { api()?.cv_close?.(); });
        const toggleMax = () => {
            const r = api()?.cv_toggle_maximize?.();
            if (r && typeof r.then === 'function') r.then(setMaxIcon);
        };
        max.addEventListener('click', toggleMax);
        // Double-click the drag area maximizes/restores, like a native title bar.
        if (drag) drag.addEventListener('dblclick', toggleMax);

        // Edge/corner grips → hand off to the native OS resize loop on mousedown.
        document.querySelectorAll('.cv-rz').forEach(grip => {
            grip.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                api()?.cv_start_resize?.(grip.dataset.edge);
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
// â”€â”€â”€ Sidebar Tooltips (JS-positioned) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _initSidebarTooltips() {
    const sidebar = document.getElementById('sidebar');
    const tooltip = document.getElementById('sidebar-tooltip');
    const tooltipContent = document.getElementById('sidebar-tooltip-content');
    if (!sidebar || !tooltip || !tooltipContent) return;

    let showTimeout = null;

    function showTooltip(target) {
        const text = target.getAttribute('data-tooltip');
        if (!text) return;

        tooltipContent.textContent = text;

        // Position: to the right of the button, vertically centered
        const rect = target.getBoundingClientRect();
        const tooltipGap = 10;

        tooltip.style.left = (rect.right + tooltipGap) + 'px';
        tooltip.style.top = (rect.top + rect.height / 2) + 'px';
        tooltip.style.transform = 'translateY(-50%)';

        // Show with tiny delay to prevent flicker
        showTimeout = setTimeout(() => {
            tooltip.classList.add('visible');
        }, 200);
    }

    function hideTooltip() {
        if (showTimeout) { clearTimeout(showTimeout); showTimeout = null; }
        tooltip.classList.remove('visible');
    }

    // Delegate on sidebar
    sidebar.addEventListener('mouseenter', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (!target) return;
        hideTooltip();
        showTooltip(target);
    }, true);

    sidebar.addEventListener('mouseleave', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (!target) return;
        hideTooltip();
    }, true);

    // Also hide if we click (button activates, tooltip should disappear)
    sidebar.addEventListener('click', () => hideTooltip());
}

// â”€â”€â”€ Feature 1: Collapsible Sidebar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function toggleSidebar() {
    const app = document.getElementById('app');
    if (!app) return;
    // Mark as animating so CSS can suppress scrollbar flicker during the
    // width transition (which is what makes the collapse feel laggy).
    app.classList.add('sidebar-animating');
    app.classList.toggle('sidebar-collapsed');
    const collapsed = app.classList.contains('sidebar-collapsed');
    localStorage.setItem('cv-sidebar-collapsed', collapsed ? '1' : '0');
    const sidebar = document.getElementById('sidebar');
    const clear = () => app.classList.remove('sidebar-animating');
    if (sidebar) {
        const onEnd = (e) => {
            if (e.propertyName !== 'width') return;
            sidebar.removeEventListener('transitionend', onEnd);
            clear();
        };
        sidebar.addEventListener('transitionend', onEnd);
        // Safety fallback in case transitionend doesn't fire (exceeds the 340ms CSS transition)
        setTimeout(clear, 440);
    } else {
        setTimeout(clear, 420);
    }
}

function _restoreSidebarState() {
    const saved = localStorage.getItem('cv-sidebar-collapsed');
    if (saved === '1') {
        const app = document.getElementById('app');
        if (app) app.classList.add('sidebar-collapsed');
    }
}

// Run immediately
_restoreSidebarState();



export { _initSidebarTooltips, setTheme, toggleSidebar };
