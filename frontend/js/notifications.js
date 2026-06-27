// ContextVolt — Topbar notification center.
import { escapeHtml } from './core.js';
// \u2500\u2500\u2500 Notification Center \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const CV_NOTIF_KEY = 'cv_notifications_v1';
let _cvNotifs = [];
let _cvNotifLoaded = false;

function _cvLoadNotifs() {
    if (_cvNotifLoaded) return;
    try { _cvNotifs = JSON.parse(localStorage.getItem(CV_NOTIF_KEY) || '[]'); } catch (_) { _cvNotifs = []; }
    if (!Array.isArray(_cvNotifs)) _cvNotifs = [];
    _cvNotifLoaded = true;
}
function _cvSaveNotifs() {
    try { localStorage.setItem(CV_NOTIF_KEY, JSON.stringify(_cvNotifs.slice(0, 50))); } catch (_) {}
}
function _cvNotifDefaultTitle(type) {
    return ({
        success: 'Done',
        error: 'Something went wrong',
        warning: 'Heads up',
        info: 'Notice',
        retry: 'Retrying',
    })[type] || 'Notification';
}
function cvNotify(type, message, opts = {}) {
    _cvLoadNotifs();
    const t = ['success','error','warning','info','retry'].includes(type) ? type : 'info';
    const n = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: t,
        title: opts.title || _cvNotifDefaultTitle(t),
        message: message || '',
        ts: Date.now(),
        read: false,
    };
    // Collapse duplicate of the most recent (same type + message) within 2s
    const head = _cvNotifs[0];
    if (head && head.type === t && head.message === n.message && (n.ts - head.ts) < 2000) return;
    _cvNotifs.unshift(n);
    _cvNotifs = _cvNotifs.slice(0, 50);
    _cvSaveNotifs();
    _cvRenderBadge();
    if (_cvPanelOpen()) _cvRenderList();
}
window.cvNotify = cvNotify;

function _cvPanelOpen() {
    const p = document.getElementById('cv-notify-panel');
    return !!(p && !p.hasAttribute('hidden'));
}
function _cvOpenPanel() {
    const p = document.getElementById('cv-notify-panel');
    const b = document.getElementById('cv-notify-btn');
    if (!p) return;
    p.removeAttribute('hidden');
    if (b) b.setAttribute('aria-expanded', 'true');
    _cvRenderList();
    // Mark as read on open
    let dirty = false;
    _cvNotifs.forEach(n => { if (!n.read) { n.read = true; dirty = true; } });
    if (dirty) { _cvSaveNotifs(); _cvRenderBadge(); }
}
function _cvClosePanel() {
    const p = document.getElementById('cv-notify-panel');
    const b = document.getElementById('cv-notify-btn');
    if (!p) return;
    p.setAttribute('hidden', '');
    if (b) b.setAttribute('aria-expanded', 'false');
}
function _cvRenderBadge() {
    const dot = document.getElementById('cv-notify-dot');
    if (!dot) return;
    const unread = _cvNotifs.filter(n => !n.read).length;
    if (unread > 0) {
        dot.removeAttribute('hidden');
        dot.textContent = unread > 9 ? '9+' : String(unread);
    } else {
        dot.setAttribute('hidden', '');
        dot.textContent = '';
    }
}
function _cvNotifIcon(t) {
    const wrap = (inner) => `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
    if (t === 'success') return wrap('<polyline points="20 6 9 17 4 12"/>');
    if (t === 'error')   return wrap('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>');
    if (t === 'warning') return wrap('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>');
    if (t === 'retry')   return wrap('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>');
    return wrap('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>');
}
function _cvRelTime(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    if (s < 604800) return `${Math.floor(s/86400)}d ago`;
    const d = new Date(ts);
    return d.toLocaleDateString();
}
function _cvRenderList() {
    const list  = document.getElementById('cv-notify-list');
    const empty = document.getElementById('cv-notify-empty');
    const count = document.getElementById('cv-notify-count');
    if (!list) return;
    if (count) count.textContent = String(_cvNotifs.length);
    if (!_cvNotifs.length) {
        list.innerHTML = '';
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';
    list.innerHTML = _cvNotifs.map(n => `
        <div class="cv-notif-item type-${n.type}${n.read ? '' : ' unread'}" data-nid="${n.id}">
            <div class="cv-notif-icon">${_cvNotifIcon(n.type)}</div>
            <div class="cv-notif-body">
                <div class="cv-notif-title">${escapeHtml(n.title)}</div>
                <div class="cv-notif-msg">${escapeHtml(n.message)}</div>
                <div class="cv-notif-time">${_cvRelTime(n.ts)}</div>
            </div>
            <button class="cv-notif-dismiss" aria-label="Dismiss notification" data-dismiss="${n.id}" type="button">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
        </div>
    `).join('');
    list.querySelectorAll('[data-dismiss]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            _cvDismiss(btn.getAttribute('data-dismiss'));
        });
    });
    _cvBindSwipe(list);
}

// Animate a single item out, then remove it from the store.
function _cvDismiss(id) {
    const el = document.querySelector(`.cv-notif-item[data-nid="${id}"]`);
    if (!el) {
        _cvNotifs = _cvNotifs.filter(n => n.id !== id);
        _cvSaveNotifs(); _cvRenderBadge();
        return;
    }
    if (el.dataset.removing) return;
    el.dataset.removing = '1';
    // Lock height so the collapse animates smoothly.
    el.style.height = el.offsetHeight + 'px';
    // Drop any inline transform/opacity left over from a swipe so the
    // .removing class controls the exit animation.
    el.style.transform = '';
    el.style.opacity = '';
    // force reflow so the height is committed before we collapse
    void el.offsetHeight;
    el.classList.add('removing');
    el.style.height = '0px';
    const finish = () => {
        el.removeEventListener('transitionend', finish);
        _cvNotifs = _cvNotifs.filter(n => n.id !== id);
        _cvSaveNotifs();
        _cvRenderBadge();
        const list = el.parentElement;
        el.remove();
        // Show the empty state if nothing is left.
        if (list && !list.children.length) _cvRenderList();
        else { const c = document.getElementById('cv-notify-count'); if (c) c.textContent = String(_cvNotifs.length); }
    };
    el.addEventListener('transitionend', finish);
    // Safety net in case transitionend doesn't fire.
    setTimeout(finish, 360);
}

// Swipe-to-dismiss (pointer drag) — modern-app gesture.
function _cvBindSwipe(list) {
    list.querySelectorAll('.cv-notif-item').forEach(el => {
        if (el.dataset.swipeBound) return;
        el.dataset.swipeBound = '1';
        let startX = 0, dx = 0, dragging = false, pid = null;
        const THRESHOLD = 88;
        el.addEventListener('pointerdown', (e) => {
            // Don't start a swipe from the dismiss button.
            if (e.target.closest('.cv-notif-dismiss')) return;
            if (e.button !== undefined && e.button !== 0) return;
            dragging = true; startX = e.clientX; dx = 0; pid = e.pointerId;
            el.style.transition = 'none';
            try { el.setPointerCapture(pid); } catch (_) {}
        });
        el.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            dx = e.clientX - startX;
            el.style.transform = `translateX(${dx}px)`;
            el.style.opacity = String(Math.max(0.25, 1 - Math.abs(dx) / 220));
        });
        const end = () => {
            if (!dragging) return;
            dragging = false;
            try { el.releasePointerCapture(pid); } catch (_) {}
            el.style.transition = '';
            if (Math.abs(dx) >= THRESHOLD) {
                _cvDismiss(el.getAttribute('data-nid'));
            } else {
                el.style.transform = '';
                el.style.opacity = '';
            }
        };
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
    });
}
// Staggered fade-out of every item, then clear the store.
function _cvClearAll() {
    const list = document.getElementById('cv-notify-list');
    const items = list ? Array.from(list.children) : [];
    if (!items.length) {
        _cvNotifs = []; _cvSaveNotifs(); _cvRenderList(); _cvRenderBadge();
        return;
    }
    items.forEach((el, i) => {
        setTimeout(() => {
            el.style.height = el.offsetHeight + 'px';
            void el.offsetHeight;
            el.classList.add('removing');
            el.style.height = '0px';
        }, i * 45);
    });
    const total = items.length * 45 + 320;
    setTimeout(() => {
        _cvNotifs = []; _cvSaveNotifs(); _cvRenderList(); _cvRenderBadge();
    }, total);
}

function _initNotifCenter() {
    _cvLoadNotifs();
    _cvRenderBadge();
    const btn   = document.getElementById('cv-notify-btn');
    const panel = document.getElementById('cv-notify-panel');
    const wrap  = document.getElementById('cv-notify-wrap');
    if (!btn || !panel || !wrap) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_cvPanelOpen()) _cvClosePanel(); else _cvOpenPanel();
    });
    const clearBtn = document.getElementById('cv-notify-clear');
    if (clearBtn) clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _cvClearAll();
    });
    const markBtn = document.getElementById('cv-notify-mark-read');
    if (markBtn) markBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _cvNotifs.forEach(n => n.read = true);
        _cvSaveNotifs(); _cvRenderList(); _cvRenderBadge();
    });
    document.addEventListener('click', (e) => {
        if (_cvPanelOpen() && !e.target.closest('#cv-notify-wrap')) _cvClosePanel();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _cvPanelOpen()) _cvClosePanel();
    });
    // Refresh relative timestamps every 60s while open
    setInterval(() => { if (_cvPanelOpen()) _cvRenderList(); }, 60000);
}


export { _initNotifCenter, cvNotify };
