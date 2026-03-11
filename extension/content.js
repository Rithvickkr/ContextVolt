// Content script for ChatGPT and Claude

// Utility to extract text based on domain
function extractChatContent() {
    const domain = window.location.hostname;
    let chatLog = "";

    if (domain.includes("chatgpt.com")) {
        const messages = document.querySelectorAll('[data-message-author-role]');
        if (messages.length === 0) return null;

        messages.forEach(msg => {
            const role = msg.getAttribute('data-message-author-role');
            if (role !== 'user' && role !== 'assistant') return;
            const prose = msg.querySelector('.markdown, .whitespace-pre-wrap, .text-message');
            if (!prose) return;
            const text = prose.innerText.trim();
            if (!text) return;
            chatLog += (role === 'user' ? 'USER' : 'ASSISTANT') + ':\n' + text + '\n\n';
        });

    } else if (domain.includes("claude.ai")) {
        const humanTurns = document.querySelectorAll('[data-testid="human-turn"]');
        const aiTurns = document.querySelectorAll('[data-testid="ai-turn"]');

        if (humanTurns.length > 0 || aiTurns.length > 0) {
            const allTurns = [];
            humanTurns.forEach(el => allTurns.push({ el, role: 'USER' }));
            aiTurns.forEach(el => allTurns.push({ el, role: 'ASSISTANT' }));

            allTurns.sort((a, b) => {
                const pos = a.el.compareDocumentPosition(b.el);
                return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
            });

            allTurns.forEach(({ el, role }) => {
                const text = el.innerText.trim();
                if (!text) return;
                chatLog += role + ':\n' + text + '\n\n';
            });
        } else {
            const messages = document.querySelectorAll('.prose, [class*="Message"]');
            if (messages.length === 0) return null;
            messages.forEach((msg, i) => {
                const text = msg.innerText.trim();
                if (!text) return;
                const role = i % 2 === 0 ? 'USER' : 'ASSISTANT';
                chatLog += role + ':\n' + text + '\n\n';
            });
            if (!chatLog) {
                return null;
            }
        }
    }

    return chatLog.trim() || null;
}

// ─── Paste text into ChatGPT or Claude input box ─────────────────
function pasteIntoInput(text) {
    const domain = window.location.hostname;

    if (domain.includes("chatgpt.com")) {
        const input = document.querySelector('#prompt-textarea, textarea[data-id="root"], div[contenteditable="true"]');
        if (input) {
            if (input.tagName === 'TEXTAREA') {
                input.value = text;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                input.innerText = text;
                input.dispatchEvent(new InputEvent('input', { bubbles: true }));
            }
            input.focus();
            return true;
        }
    } else if (domain.includes("claude.ai")) {
        const input = document.querySelector('[contenteditable="true"].ProseMirror, div[contenteditable="true"]');
        if (input) {
            input.innerHTML = `<p>${text.replace(/\n/g, '<br>')}</p>`;
            input.dispatchEvent(new InputEvent('input', { bubbles: true }));
            input.focus();
            return true;
        }
    }
    return false;
}

// ─── Inject floating buttons ─────────────────────────────────────
function injectButton() {
    if (document.getElementById("cv-btn-container")) return;

    // Container for both buttons
    const container = document.createElement("div");
    container.id = "cv-btn-container";

    // Export button (Send to Vault)
    const exportBtn = document.createElement("button");
    exportBtn.id = "cv-export-button";
    exportBtn.innerHTML = `<span class="cv-icon">✦</span> Send to Vault`;

    exportBtn.addEventListener("click", () => {
        exportBtn.innerHTML = `<span class="cv-spinner"></span> Extracting…`;
        exportBtn.classList.add("cv-sending");
        exportBtn.disabled = true;

        setTimeout(() => {
            const chatText = extractChatContent();

            if (!chatText || chatText.length < 20) {
                exportBtn.innerHTML = `No chat found!`;
                exportBtn.classList.remove("cv-sending");
                setTimeout(() => { exportBtn.innerHTML = `<span class="cv-icon">✦</span> Send to Vault`; exportBtn.disabled = false; }, 2000);
                return;
            }

            exportBtn.innerHTML = `<span class="cv-spinner"></span> Contextualizing…`;
            const stateTimer = setTimeout(() => {
                exportBtn.innerHTML = `<span class="cv-spinner"></span> Summarizing…`;
            }, 2500);

            const source = window.location.hostname.includes("chatgpt.com") ? "ChatGPT" : "Claude";

            chrome.runtime.sendMessage({
                action: "save_chat",
                payload: { text: chatText, source: source }
            }, (response) => {
                clearTimeout(stateTimer);
                exportBtn.classList.remove("cv-sending");

                if (chrome.runtime.lastError) {
                    exportBtn.innerHTML = `❌ Extension error`;
                    exportBtn.classList.add("cv-error");
                } else if (response && response.success) {
                    exportBtn.innerHTML = `✅ Saved!`;
                    exportBtn.classList.add("cv-success");
                } else {
                    exportBtn.innerHTML = `❌ Failed!`;
                    exportBtn.classList.add("cv-error");
                }

                setTimeout(() => {
                    exportBtn.innerHTML = `<span class="cv-icon">✦</span> Send to Vault`;
                    exportBtn.classList.remove("cv-success", "cv-error");
                    exportBtn.disabled = false;
                }, 3000);
            });
        }, 300);
    });

    // Import button (Pull from Vault)
    const importBtn = document.createElement("button");
    importBtn.id = "cv-import-button";
    importBtn.innerHTML = `<span class="cv-icon">📥</span> From Vault`;

    importBtn.addEventListener("click", () => {
        toggleImportPanel();
    });

    container.appendChild(importBtn);
    container.appendChild(exportBtn);
    document.body.appendChild(container);
}

// ─── Import Panel ────────────────────────────────────────────────
let panelOpen = false;

function toggleImportPanel() {
    const existing = document.getElementById("cv-import-panel");
    if (existing) {
        existing.classList.toggle("cv-panel-open");
        panelOpen = !panelOpen;
        if (panelOpen) loadContexts();
        return;
    }

    // Create the panel
    const panel = document.createElement("div");
    panel.id = "cv-import-panel";
    panel.innerHTML = `
        <div class="cv-panel-header">
            <span class="cv-panel-title">📚 Your Vault</span>
            <button class="cv-panel-close" id="cv-panel-close">✕</button>
        </div>
        <div class="cv-panel-search">
            <input type="text" id="cv-search-input" placeholder="Search contexts..." />
        </div>
        <div class="cv-panel-list" id="cv-panel-list">
            <div class="cv-panel-loading"><span class="cv-spinner"></span> Loading…</div>
        </div>
    `;

    document.body.appendChild(panel);

    // Animate in
    requestAnimationFrame(() => panel.classList.add("cv-panel-open"));
    panelOpen = true;

    // Close button
    document.getElementById("cv-panel-close").addEventListener("click", () => {
        panel.classList.remove("cv-panel-open");
        panelOpen = false;
    });

    // Search
    let searchTimer = null;
    document.getElementById("cv-search-input").addEventListener("input", (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => loadContexts(e.target.value), 300);
    });

    loadContexts();
}

function loadContexts(query = "") {
    const listEl = document.getElementById("cv-panel-list");
    if (!listEl) return;

    listEl.innerHTML = `<div class="cv-panel-loading"><span class="cv-spinner"></span> Loading…</div>`;

    chrome.runtime.sendMessage({ action: "fetch_contexts", query }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
            const errMsg = response?.error || "Cannot reach ContextVolt backend";
            listEl.innerHTML = `<div class="cv-panel-empty">
                <div class="cv-panel-empty-icon">⚡</div>
                <div>${errMsg}</div>
                <div class="cv-panel-hint">Make sure ContextVolt is running</div>
            </div>`;
            return;
        }

        const contexts = response.contexts;
        if (!contexts || contexts.length === 0) {
            listEl.innerHTML = `<div class="cv-panel-empty">
                <div class="cv-panel-empty-icon">📭</div>
                <div>No saved contexts yet</div>
                <div class="cv-panel-hint">Use "Send to Vault" to save a conversation first</div>
            </div>`;
            return;
        }

        listEl.innerHTML = "";
        contexts.forEach(ctx => {
            const item = document.createElement("div");
            item.className = "cv-context-item";
            const title = ctx.title || "Untitled";
            const summary = (ctx.summary || "No summary").substring(0, 100);
            const source = ctx.source || "";
            const date = ctx.created_at ? new Date(ctx.created_at).toLocaleDateString() : "";

            item.innerHTML = `
                <div class="cv-context-title">${escapeHtml(title)}</div>
                <div class="cv-context-meta">
                    ${source ? `<span class="cv-context-source">${escapeHtml(source)}</span>` : ""}
                    ${date ? `<span class="cv-context-date">${date}</span>` : ""}
                </div>
                <div class="cv-context-summary">${escapeHtml(summary)}…</div>
            `;

            item.addEventListener("click", () => {
                item.classList.add("cv-loading");
                item.querySelector(".cv-context-title").innerHTML = `<span class="cv-spinner"></span> Generating prompt…`;

                chrome.runtime.sendMessage({ action: "fetch_prompt", contextId: ctx.id }, (res) => {
                    item.classList.remove("cv-loading");

                    if (res && res.success && res.prompt) {
                        const pasted = pasteIntoInput(res.prompt);
                        if (pasted) {
                            item.querySelector(".cv-context-title").textContent = "✅ Pasted into input!";
                            // Close panel after a moment
                            setTimeout(() => {
                                const panel = document.getElementById("cv-import-panel");
                                if (panel) { panel.classList.remove("cv-panel-open"); panelOpen = false; }
                            }, 1200);
                        } else {
                            // Fallback: copy to clipboard
                            navigator.clipboard.writeText(res.prompt).then(() => {
                                item.querySelector(".cv-context-title").textContent = "📋 Copied to clipboard!";
                            }).catch(() => {
                                item.querySelector(".cv-context-title").textContent = "❌ Could not paste";
                            });
                        }
                    } else {
                        item.querySelector(".cv-context-title").textContent = "❌ Failed to generate prompt";
                    }

                    // Reset after delay
                    setTimeout(() => {
                        item.querySelector(".cv-context-title").textContent = title;
                    }, 2500);
                });
            });

            listEl.appendChild(item);
        });
    });
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

// Run injection periodically since SPAs re-render the DOM
setInterval(injectButton, 2000);
