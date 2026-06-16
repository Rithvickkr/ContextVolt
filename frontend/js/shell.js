// ContextVolt — App shell: theme, frameless title bar, sidebar collapse + tooltips.

// â”€â”€â”€ Theme â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Resolve the user's *choice* to a concrete palette. 'system' follows the OS.
function _resolveTheme(choice) {
    if (choice === 'system') {
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    return choice === 'light' ? 'light' : 'dark';
}

// `choice` is the user's selection: 'light' | 'dark' | 'system'.
function _applyTheme(choice) {
    const resolved = _resolveTheme(choice);
    document.documentElement.setAttribute('data-theme', resolved);
    // Settings segmented control highlights the *choice* (so "System" stays lit).
    document.querySelectorAll('.settings-theme-opt').forEach(btn => {
        const active = btn.dataset.theme === choice;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    // Topbar Light/Dark pill reflects the *resolved* theme (no System option there).
    document.querySelectorAll('#modeToggle button').forEach(btn => {
        const active = btn.dataset.mode === resolved;
        btn.classList.toggle('on', active);
        btn.setAttribute('aria-selected', String(active));
    });
    // Slide the active "thumb" under the newly-selected option.
    _positionThumb(document.getElementById('modeToggle'));
    _positionThumb(document.querySelector('.settings-theme-segmented'));
}

// Re-resolve live when the OS palette flips and the user picked "System".
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if ((localStorage.getItem('cv-theme') || 'dark') === 'system') _applyTheme('system');
});

// ─── Segmented-control sliding thumb (color-mode + settings theme) ───
// A real element overlays the active button; its position is measured in JS
// so it lines up exactly, and it carries a view-transition-name so it morphs
// smoothly as part of the liquid theme transition.
function _ensureThumb(container) {
    if (!container || container.querySelector('.cv-seg-thumb')) return;
    const thumb = document.createElement('span');
    thumb.className = 'cv-seg-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    container.insertBefore(thumb, container.firstChild);
}

function _positionThumb(container) {
    if (!container) return;
    _ensureThumb(container);
    const active = container.querySelector('button.on, button.active');
    const thumb = container.querySelector('.cv-seg-thumb');
    if (!active || !thumb || !active.offsetWidth) return;
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.height = `${active.offsetHeight}px`;
    thumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    container.classList.add('cv-seg-ready');
}

(function _initSegThumbs() {
    const containers = [
        document.getElementById('modeToggle'),
        document.querySelector('.settings-theme-segmented'),
    ].filter(Boolean);
    const reposition = () => containers.forEach(_positionThumb);
    containers.forEach(c => {
        _positionThumb(c);
        // Reposition when the control gains/changes size (e.g. its view becomes
        // visible, or the window resizes the topbar).
        if (window.ResizeObserver) {
            new ResizeObserver(() => _positionThumb(c)).observe(c);
        }
    });
    window.addEventListener('resize', reposition);

    // The topbar toggle (#modeToggle) lives inside #app, which starts hidden, so
    // its first measure is 0px and the thumb never becomes "ready" → it snaps.
    // Re-measure once the app is revealed (and on the next frame) so the toggle
    // slides as smoothly as the settings segmented control.
    window.addEventListener('load', () => requestAnimationFrame(reposition));
    const app = document.getElementById('app');
    if (app && window.MutationObserver) {
        new MutationObserver(() => {
            if (app.style.display !== 'none') {
                requestAnimationFrame(reposition);
                requestAnimationFrame(() => requestAnimationFrame(reposition));
            }
        }).observe(app, { attributes: true, attributeFilter: ['style'] });
    }
})();

// Remember where the user last clicked so the theme animation can bloom from there.
let _themeOrigin = { x: null, y: null };
document.addEventListener('pointerdown', (e) => {
    _themeOrigin = { x: e.clientX, y: e.clientY };
}, true);

// Flip to `true` to bring back the iOS liquid-glass theme reveal.
// (Temporarily off — the sliding selector thumb still animates.)
const LIQUID_THEME_TRANSITION = false;

function setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') return;

    const commit = () => {
        _applyTheme(theme);
        localStorage.setItem('cv-theme', theme);
    };

    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Disabled, no-op switch, no View Transitions support, or reduced-motion → just apply.
    if (!LIQUID_THEME_TRANSITION || current === _resolveTheme(theme) || reduce || !document.startViewTransition) {
        commit();
        return;
    }

    // iOS "liquid glass" reveal: the incoming theme blooms out of the toggle
    // as an expanding, frosted circle. Origin = last click, fall back to top-right.
    const root = document.documentElement;
    const x = _themeOrigin.x != null ? _themeOrigin.x : window.innerWidth - 48;
    const y = _themeOrigin.y != null ? _themeOrigin.y : 44;
    const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    root.style.setProperty('--cv-theme-x', `${x}px`);
    root.style.setProperty('--cv-theme-y', `${y}px`);
    root.style.setProperty('--cv-theme-r', `${r}px`);
    root.classList.add('cv-theme-anim');

    const t = document.startViewTransition(commit);
    t.finished.finally(() => root.classList.remove('cv-theme-anim'));
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

        // mac detail: traffic lights go gray while the window is unfocused.
        window.addEventListener('blur',  () => document.body.classList.add('cv-win-blurred'));
        window.addEventListener('focus', () => document.body.classList.remove('cv-win-blurred'));

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
    // A manual toggle is an explicit choice — drop the auto-collapse flag so
    // widening the window later doesn't override what the user just did.
    delete app.dataset.autoCollapsed;
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

// ─── Responsive: auto-collapse the sidebar on narrow windows ───────────
// Below this width the 248px sidebar costs too much of a frameless window.
// We reuse the existing .sidebar-collapsed styles, but tag the collapse as
// automatic (dataset.autoCollapsed) so widening the window restores the
// user's manual preference instead of clobbering it.
const _narrowSidebarMQ = window.matchMedia('(max-width: 1024px)');

function _syncResponsiveSidebar() {
    const app = document.getElementById('app');
    if (!app) return;
    if (_narrowSidebarMQ.matches) {
        // Collapse if not already (manual or auto). Tag only auto-collapses.
        if (!app.classList.contains('sidebar-collapsed')) {
            app.classList.add('sidebar-collapsed');
            app.dataset.autoCollapsed = '1';
        }
    } else if (app.dataset.autoCollapsed === '1') {
        // Leaving narrow mode: undo only the automatic collapse, then honour
        // whatever the user last chose manually.
        delete app.dataset.autoCollapsed;
        if (localStorage.getItem('cv-sidebar-collapsed') !== '1') {
            app.classList.remove('sidebar-collapsed');
        }
    }
}

_narrowSidebarMQ.addEventListener('change', _syncResponsiveSidebar);

// Run immediately
_restoreSidebarState();
_syncResponsiveSidebar();



export { _initSidebarTooltips, setTheme, toggleSidebar };
