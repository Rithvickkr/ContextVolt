// ContextVolt — Modal dialogs, toasts, focus trap, shortcuts modal.
import { $, escapeHtml } from './core.js';
import { closeEditModal } from './detail.js';
import { cvNotify } from './notifications.js';
import { closeSettingsModal } from './settings.js';
import { closeSystemModal } from './system.js';
// â”€â”€â”€ Toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showConfirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'cv-confirm-overlay';
        overlay.innerHTML = `
            <div class="cv-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="cv-confirm-title">
                <div class="cv-confirm-title" id="cv-confirm-title">${escapeHtml(title)}</div>
                ${message ? `<div class="cv-confirm-message">${escapeHtml(message)}</div>` : ''}
                <div class="cv-confirm-actions">
                    <button class="cv-confirm-cancel">Cancel</button>
                    <button class="cv-confirm-ok${danger ? ' danger' : ''}">${escapeHtml(confirmLabel)}</button>
                </div>
            </div>`;

        const dismiss = (result) => {
            overlay.classList.add('cv-confirm-out');
            setTimeout(() => { overlay.remove(); resolve(result); }, 150);
        };

        const confirmCancel = overlay.querySelector('.cv-confirm-cancel');
        const confirmOk = overlay.querySelector('.cv-confirm-ok');
        if (confirmCancel) confirmCancel.addEventListener('click', () => dismiss(false));
        if (confirmOk) confirmOk.addEventListener('click', () => dismiss(true));
        overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(false); });
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') dismiss(false); });

        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('cv-confirm-in'));
        overlay.querySelector('.cv-confirm-cancel').focus();
    });
}

function showPrompt({ title, message, defaultValue = '', placeholder = '', confirmLabel = 'Save', maxLength = 200 }) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'cv-confirm-overlay';
        overlay.innerHTML = `
            <div class="cv-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="cv-prompt-title">
                <div class="cv-confirm-title" id="cv-prompt-title">${escapeHtml(title)}</div>
                ${message ? `<div class="cv-confirm-message">${escapeHtml(message)}</div>` : ''}
                <input type="text" class="cv-confirm-input"
                       value="${escapeHtml(defaultValue)}"
                       placeholder="${escapeHtml(placeholder)}"
                       maxlength="${maxLength}" autocomplete="off" spellcheck="false" />
                <div class="cv-confirm-actions">
                    <button class="cv-confirm-cancel">Cancel</button>
                    <button class="cv-confirm-ok">${escapeHtml(confirmLabel)}</button>
                </div>
            </div>`;

        const dismiss = (result) => {
            overlay.classList.add('cv-confirm-out');
            setTimeout(() => { overlay.remove(); resolve(result); }, 150);
        };

        const input = overlay.querySelector('.cv-confirm-input');
        const cancelBtn = overlay.querySelector('.cv-confirm-cancel');
        const okBtn = overlay.querySelector('.cv-confirm-ok');

        const submit = () => {
            const v = (input.value || '').trim();
            dismiss(v || null);
        };

        cancelBtn.addEventListener('click', () => dismiss(null));
        okBtn.addEventListener('click', submit);
        overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(null); });
        overlay.addEventListener('keydown', e => {
            if (e.key === 'Escape') dismiss(null);
            if (e.key === 'Enter' && document.activeElement === input) submit();
        });

        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('cv-confirm-in'));
        // Focus input + select existing text so the user can immediately type a replacement.
        setTimeout(() => { input.focus(); input.select(); }, 0);
    });
}

function showToast(message, type = 'success') {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
        // Fallback: create the stack on the fly if it was somehow removed
        stack = document.createElement('div');
        stack.className = 'toast-stack';
        stack.id = 'toast-stack';
        stack.setAttribute('role', 'status');
        stack.setAttribute('aria-live', 'polite');
        document.body.appendChild(stack);
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '\u2705' : '\u274C'}</span><span class="toast-message">${escapeHtml(message)}</span>`;
    stack.appendChild(toast);

    // Auto-remove after 3s
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);

    // Cap at 5 visible toasts
    while (stack.children.length > 5) {
        stack.firstChild.remove();
    }

    // Mirror into the Notification Center with a smarter title
    try {
        const m = String(message || '').toLowerCase();
        let title;
        if (m.includes('summariz')) title = type === 'error' ? 'Summarization failed' : 'Summarization complete';
        else if (m.includes('embed')) title = type === 'error' ? 'Embedding failed' : 'Context saved';
        else if (m.includes('retry') || m.includes('retrying') || m.includes('re-summariz')) title = 'Retrying';
        else if (m.includes('deleted') || m.includes('delete')) title = type === 'error' ? 'Delete failed' : 'Deleted';
        else if (m.includes('copied') || m.includes('copy')) title = type === 'error' ? 'Copy failed' : 'Copied';
        else if (m.includes('failed') || m.includes('error')) title = 'Error';
        cvNotify(type, message, title ? { title } : {});
    } catch (_) {}
}

// â”€â”€â”€ P2-10: Undo Toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _showUndoToast(message, onUndo) {
    const stack = $('#toast-stack');
    const toast = document.createElement('div');
    toast.className = 'toast undo';
    toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></span>
        <span class="toast-message">${escapeHtml(message)}</span>
        <button class="toast-undo-btn">Undo</button>
        <div class="toast-countdown"></div>
    `;
    stack.appendChild(toast);

    const undoBtn = toast.querySelector('.toast-undo-btn');
    if (undoBtn) undoBtn.addEventListener('click', () => {
        if (onUndo) onUndo();
        toast.remove();
    });

    // Auto-remove after 5.3s (a bit after the countdown animation)
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        setTimeout(() => toast.remove(), 300);
    }, 5300);

    while (stack.children.length > 5) {
        stack.firstChild.remove();
    }
}

// --- Action Toast (long-lived, with a single action button) ---
function _showActionToast(message, actionLabel, onAction) {
    const stack = $('#toast-stack');
    const toast = document.createElement('div');
    toast.className = 'toast undo';   // reuse the undo-toast styling (icon + button)
    toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true">i</span>
        <span class="toast-message">${escapeHtml(message)}</span>
        <button class="toast-undo-btn">${escapeHtml(actionLabel)}</button>
    `;
    stack.appendChild(toast);

    const actionBtn = toast.querySelector('.toast-undo-btn');
    if (actionBtn) actionBtn.addEventListener('click', () => {
        try { if (onAction) onAction(); } finally { toast.remove(); }
    });

    // Stays for 12s â€” long enough to read and act, but auto-dismisses.
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        setTimeout(() => toast.remove(), 300);
    }, 12000);

    while (stack.children.length > 5) {
        stack.firstChild.remove();
    }
}

// â”€â”€â”€ Accessibility: Focus Trap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _focusTrapEl   = null;   // currently trapped container
let _focusTrapPrev = null;   // element that had focus before modal opened
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapFocus(container, triggerEl) {
    _focusTrapEl   = container;
    _focusTrapPrev = triggerEl || document.activeElement;

    const focusable = () => Array.from(container.querySelectorAll(FOCUSABLE));

    // Move focus to first focusable inside
    const first = focusable()[0];
    if (first) first.focus();

    container._trapHandler = (e) => {
        if (e.key !== 'Tab') return;
        const items = focusable();
        if (!items.length) { e.preventDefault(); return; }
        const firstEl = items[0];
        const lastEl  = items[items.length - 1];
        if (e.shiftKey) {
            if (document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
        } else {
            if (document.activeElement === lastEl)  { e.preventDefault(); firstEl.focus(); }
        }
    };
    container.addEventListener('keydown', container._trapHandler);
}

function releaseFocus(container) {
    if (container && container._trapHandler) {
        container.removeEventListener('keydown', container._trapHandler);
        container._trapHandler = null;
    }
    if (_focusTrapPrev && typeof _focusTrapPrev.focus === 'function') {
        _focusTrapPrev.focus();
    }
    _focusTrapEl   = null;
    _focusTrapPrev = null;
}

// Global Escape key — closes whichever modal is open
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const editModal      = $('#edit-modal');
    const settingsModal  = $('#settings-modal');
    const shortcutsModal = $('#shortcuts-modal');
    const systemModal    = $('#system-modal');
    if (shortcutsModal && shortcutsModal.style.display !== 'none') { closeShortcutsModal(); return; }
    if (systemModal    && systemModal.style.display    !== 'none') { closeSystemModal();    return; }
    if (editModal      && editModal.style.display      !== 'none') closeEditModal();
    if (settingsModal  && settingsModal.style.display   !== 'none') closeSettingsModal();
});

// â”€â”€â”€ P2-9: Keyboard Shortcuts Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openShortcutsModal() {
    const modal = $('#shortcuts-modal');
    modal.style.display = 'flex';
    trapFocus(modal.querySelector('.shortcuts-modal'), $('#btn-shortcuts'));
}

function closeShortcutsModal() {
    const overlay = $('#shortcuts-modal');
    const inner = overlay.querySelector('.shortcuts-modal');
    releaseFocus(inner);
    inner.style.animation = 'shellOut 0.18s var(--ease) forwards';
    overlay.style.animation = 'fadeOut 0.18s var(--ease) forwards';
    setTimeout(() => {
        overlay.style.display = 'none';
        inner.style.animation = '';
        overlay.style.animation = '';
    }, 180);
}


export { _showActionToast, _showUndoToast, closeShortcutsModal, openShortcutsModal, releaseFocus, showConfirm, showPrompt, showToast, trapFocus };
