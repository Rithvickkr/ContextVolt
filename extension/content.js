// Content script for ChatGPT and Claude

// ─── Marked snippets state ────────────────────────────────────────
// key: first 100 chars of text (dedup key), value: full message text
const _markedSnippets = new Map();

// ─── Get message elements for star button injection ───────────────
function getMessageElements() {
    const domain = window.location.hostname;
    const elements = [];

    if (domain.includes("chatgpt.com")) {
        document.querySelectorAll('[data-message-author-role]').forEach(msg => {
            const role = msg.getAttribute('data-message-author-role');
            if (role !== 'user' && role !== 'assistant') return;
            const prose = msg.querySelector('.markdown, .whitespace-pre-wrap, .text-message') || msg;
            elements.push({ text: prose, container: msg });
        });
    } else if (domain.includes("claude.ai")) {
        document.querySelectorAll('[data-testid="user-message"]').forEach(el =>
            elements.push({ text: el, container: el }));
        Array.from(document.querySelectorAll('div.font-claude-response'))
            .filter(el => !el.classList.contains('font-claude-response-body') && el.tagName === 'DIV' && el.closest('.group'))
            .forEach(el => elements.push({ text: el, container: el.closest('.group') || el }));
    } else if (domain.includes("gemini.google.com")) {
        // user-query / model-response are Gemini's custom elements; extract inner text element when available
        document.querySelectorAll('user-query, model-response').forEach(el => {
            const textEl = el.querySelector(
                '.user-query-text-with-attachments, .user-query-text, ' +
                'message-content, .model-response-text, .response-content, ' +
                '[class*="response-text"], [class*="markdown"]'
            ) || el;
            elements.push({ text: textEl, container: el });
        });
    } else if (domain.includes("grok.com") || domain.includes("x.com") || domain.includes("x.ai")) {
        // Grok's DOM has changed across versions — try known selectors in order
        let msgs = document.querySelectorAll('[data-message-author-role]');
        if (msgs.length === 0)
            msgs = document.querySelectorAll('[class*="MessageBubble"], [class*="message-bubble"], .message-bubble');
        if (msgs.length === 0)
            msgs = document.querySelectorAll('[class*="UserMessage"], [class*="BotMessage"], [class*="AssistantMessage"]');
        if (msgs.length === 0)
            msgs = document.querySelectorAll('[data-testid*="message"], [data-testid*="Message"]');
        msgs.forEach(el => elements.push({ text: el, container: el.parentElement || el }));
    } else if (domain.includes("deepseek.com")) {
        // Try stable selectors first, then fall back to class-fragment matching
        let msgs = document.querySelectorAll('.ds-message-row');
        if (msgs.length === 0)
            msgs = document.querySelectorAll('[class*="user-message"], [class*="UserMessage"]');
        if (msgs.length === 0)
            msgs = document.querySelectorAll('[class*="assistant"], [class*="AssistantMessage"]');
        if (msgs.length === 0)
            msgs = document.querySelectorAll('[class*="chat-message"], .chat-message-content');
        msgs.forEach(el => elements.push({ text: el, container: el }));
    } else if (domain.includes("perplexity.ai")) {
        // Prefer data-testid attributes; fall back to .prose only inside a message wrapper
        let msgs = document.querySelectorAll('[data-testid*="user-message"], [data-testid*="answer"]');
        if (msgs.length === 0)
            msgs = document.querySelectorAll('.message-block, [class*="ConversationTurn"], [class*="MessageBlock"]');
        if (msgs.length > 0) {
            msgs.forEach(el => elements.push({ text: el, container: el }));
        } else {
            // Last-resort: .prose blocks that sit inside a recognisable message wrapper
            document.querySelectorAll('.prose').forEach(el => {
                const wrap = el.closest('[class*="message"], [class*="Message"], [class*="answer"], [class*="Answer"]');
                if (wrap) elements.push({ text: el, container: wrap });
            });
        }
    } else if (domain.includes("copilot.microsoft.com") || domain.includes("copilot.cloud.microsoft")) {
        // New Copilot dropped cib-message; try modern selectors first
        let msgs = document.querySelectorAll('[data-testid*="message"], [class*="UserMessage"], [class*="BotMessage"]');
        if (msgs.length === 0)
            msgs = document.querySelectorAll('.user-message, .bot-message, .ai-message');
        if (msgs.length === 0)
            msgs = document.querySelectorAll('cib-message, .cib-message');
        msgs.forEach(el => elements.push({ text: el, container: el }));
    }

    return elements;
}

// ─── Inject per-message star buttons ─────────────────────────────
function injectStarButtons() {
    getMessageElements().forEach(({ text: textEl, container }) => {
        if (container.querySelector('.cv-star-btn')) return; // already injected

        const existingPos = window.getComputedStyle(container).position;
        if (existingPos === 'static') container.style.position = 'relative';

        const btn = document.createElement('button');
        btn.className = 'cv-star-btn';
        btn.title = 'Mark as important for ContextVolt';
        btn.textContent = '☆';
        btn.setAttribute('data-cv-starred', 'false');

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const fullText = textEl.innerText.trim();
            if (!fullText) return;
            const key = fullText.substring(0, 100);
            const isStarred = btn.getAttribute('data-cv-starred') === 'true';
            if (isStarred) {
                _markedSnippets.delete(key);
                btn.setAttribute('data-cv-starred', 'false');
                btn.textContent = '☆';
                btn.classList.remove('cv-star-active');
            } else {
                _markedSnippets.set(key, fullText);
                btn.setAttribute('data-cv-starred', 'true');
                btn.textContent = '★';
                btn.classList.add('cv-star-active');
            }
        });

        container.appendChild(btn);
    });
}

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
            const text = prose ? prose.innerText.trim() : msg.innerText.trim();
            if (!text) return;
            chatLog += (role === 'user' ? 'USER' : 'ASSISTANT') + ':\n' + text + '\n\n';
        });

    } else if (domain.includes("claude.ai")) {
        // Claude uses data-testid="user-message" for user, and .font-claude-response divs for assistant
        const userMsgs = document.querySelectorAll('[data-testid="user-message"]');
        const aiMsgs = document.querySelectorAll('div.font-claude-response');

        // Filter assistant messages to top-level response containers only (not inner paragraphs)
        const topLevelAiMsgs = Array.from(aiMsgs).filter(el =>
            !el.classList.contains('font-claude-response-body') && el.tagName === 'DIV' &&
            el.closest('.group')
        );

        if (userMsgs.length > 0 || topLevelAiMsgs.length > 0) {
            const allTurns = [];
            userMsgs.forEach(el => allTurns.push({ el, role: 'USER' }));
            topLevelAiMsgs.forEach(el => allTurns.push({ el, role: 'ASSISTANT' }));

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
            // Fallback: try old selectors or generic approach
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
            }
            if (!chatLog) return null;
        }
    } else if (domain.includes("gemini.google.com")) {
        // Gemini: user-query for user messages, model-response for assistant messages
        const userQueries = document.querySelectorAll('user-query');
        const modelResponses = document.querySelectorAll('model-response');
        if (userQueries.length === 0 && modelResponses.length === 0) return null;

        const allTurns = [];
        userQueries.forEach(el => allTurns.push({ el, role: 'USER' }));
        modelResponses.forEach(el => allTurns.push({ el, role: 'ASSISTANT' }));

        allTurns.sort((a, b) => {
            const pos = a.el.compareDocumentPosition(b.el);
            return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });

        allTurns.forEach(({ el, role }) => {
            let text = el.innerText.trim();
            if (!text) return;
            // Strip "You said" / "Gemini said" prefixes added by the UI
            text = text.replace(/^You said\s*\n+/i, '').replace(/^Gemini said\s*\n+/i, '');
            chatLog += role + ':\n' + text + '\n\n';
        });
    } else if (domain.includes("grok.com") || domain.includes("x.com") || domain.includes("x.ai")) {
        // Grok: .message-bubble for all messages
        // User bubbles have parent with class 'items-end', assistant with 'items-start'
        const messages = document.querySelectorAll('.message-bubble');
        if (messages.length === 0) return null;
        messages.forEach((msg) => {
            const text = msg.innerText.trim();
            if (!text) return;

            // Detect role from parent container alignment
            const parent = msg.closest('[class*="items-end"], [class*="items-start"]');
            const isUser = parent && parent.className.includes('items-end');

            chatLog += (isUser ? 'USER' : 'ASSISTANT') + ':\n' + text + '\n\n';
        });
    } else if (domain.includes("deepseek.com")) {
        // DeepSeek
        // DeepSeek wraps messages in .ds-message-row or similar.
        const allTurns = document.querySelectorAll('.ds-message-row, .chat-message-content, .d887a0b3'); // d887a0b3 is a common class for user/bot rows
        if (allTurns.length === 0) return null;
        
        allTurns.forEach((msg) => {
            const contentEl = msg.querySelector('.ds-markdown') || msg;
            const text = contentEl.innerText.trim();
            if (!text) return;

            // User messages usually have different classes than assistant
            const isUser = msg.classList.contains('ds-user-message') || 
                           msg.querySelector('.ds-user-avatar') != null ||
                           msg.innerHTML.includes('User');
                           
            chatLog += (isUser ? 'USER' : 'ASSISTANT') + ':\n' + text + '\n\n';
        });
    } else if (domain.includes("perplexity.ai")) {
        // Perplexity
        const userQueries = document.querySelectorAll('[dir="auto"]');
        const aiAnswers = document.querySelectorAll('.prose'); // Markdown rendering
        
        const allTurns = [];
        userQueries.forEach(el => {
            if (el.closest('.prose') === null && el.innerText.trim()) { // Avoid picking up inner text
                allTurns.push({ el, role: 'USER' });
            }
        });
        aiAnswers.forEach(el => {
            if (el.innerText.trim()) {
                allTurns.push({ el, role: 'ASSISTANT' });
            }
        });

        allTurns.sort((a, b) => {
            const pos = a.el.compareDocumentPosition(b.el);
            return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });

        if (allTurns.length === 0) return null;
        allTurns.forEach(({ el, role }) => {
            chatLog += role + ':\n' + el.innerText.trim() + '\n\n';
        });
    } else if (domain.includes("copilot.microsoft.com")) {
        // Copilot
        // Copilot uses Shadow DOM heavily. We try to grab surface elements if available, 
        // or Fallback to cib-message.
        const messages = document.querySelectorAll('cib-message, .cib-message');
        if (messages.length === 0) return null;
        
        messages.forEach((msg) => {
             const text = msg.innerText.trim();
             if (!text) return;
             
             // Copilot messages usually have a type attribute like type="text" or source="user"
             const isUser = msg.getAttribute('type') === 'text' || 
                            msg.getAttribute('source') === 'user' ||
                            msg.classList.contains('user-message');
                            
             chatLog += (isUser ? 'USER' : 'ASSISTANT') + ':\n' + text + '\n\n';
        });
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
    } else if (domain.includes("gemini.google.com")) {
        const input = document.querySelector('rich-textarea div[contenteditable="true"]');
        if (input) {
            input.innerHTML = `<p>${text.replace(/\n/g, '<br>')}</p>`;
            input.dispatchEvent(new InputEvent('input', { bubbles: true }));
            input.focus();
            return true;
        }
    } else if (domain.includes("grok.com") || domain.includes("x.com") || domain.includes("x.ai")) {
        const input = document.querySelector('textarea, [contenteditable="true"]');
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
    } else if (domain.includes("deepseek.com")) {
        const input = document.querySelector('textarea, #chat-input');
        if (input) {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
            return true;
        }
    } else if (domain.includes("perplexity.ai")) {
        const input = document.querySelector('textarea, [contenteditable="true"]');
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
    } else if (domain.includes("copilot.microsoft.com")) {
        const input = document.querySelector('textarea, #searchbox');
        if (input) {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
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

            let source = "Unknown";
            const h = window.location.hostname;
            if (h.includes("chatgpt.com")) source = "ChatGPT";
            else if (h.includes("claude.ai")) source = "Claude";
            else if (h.includes("gemini.google.com")) source = "Gemini";
            else if (h.includes("grok.com") || h.includes("x.com") || h.includes("x.ai")) source = "Grok";
            else if (h.includes("deepseek.com")) source = "DeepSeek";
            else if (h.includes("perplexity.ai")) source = "Perplexity";
            else if (h.includes("copilot.microsoft.com")) source = "Copilot";

            chrome.runtime.sendMessage({
                action: "save_chat",
                payload: {
                    text: chatText,
                    source: source,
                    important_snippets: Array.from(_markedSnippets.values()),
                }
            }, (response) => {
                clearTimeout(stateTimer);
                exportBtn.classList.remove("cv-sending");

                if (chrome.runtime.lastError) {
                    const msg = chrome.runtime.lastError.message || "Extension error";
                    exportBtn.title = msg;
                    exportBtn.innerHTML = `❌ ${msg.length > 30 ? msg.substring(0, 30) + "…" : msg}`;
                    exportBtn.classList.add("cv-error");
                } else if (response && response.success) {
                    exportBtn.innerHTML = `✅ Saved!`;
                    exportBtn.classList.add("cv-success");
                } else {
                    const errMsg = (response && response.error) || "Unknown error";
                    exportBtn.title = errMsg;
                    exportBtn.innerHTML = `❌ ${errMsg.length > 30 ? errMsg.substring(0, 30) + "…" : errMsg}`;
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
setInterval(() => {
    injectButton();
    injectStarButtons();
}, 2000);
