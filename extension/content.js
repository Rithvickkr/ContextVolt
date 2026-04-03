// Content script for ChatGPT and Claude

// ─── Network Interceptor Listener ─────────────────────────────────
// The interceptor.js (MAIN world) captures API responses and fires
// CustomEvents. We accumulate them here in the ISOLATED world.
let _interceptedMessages = [];   // { role: 'user'|'assistant', content: string }[]
let _interceptorActive = false;  // set to true once we receive the first event

window.addEventListener('__cv_captured__', (e) => {
    _interceptorActive = true;
    const incoming = e.detail?.newMessages;
    if (!incoming || !Array.isArray(incoming)) return;

    for (const msg of incoming) {
        if (!msg.content || !msg.content.trim()) continue;

        // Deduplicate: skip if we already have an identical message
        const isDup = _interceptedMessages.some(
            m => m.role === msg.role && m.content === msg.content.trim()
        );
        if (!isDup) {
            _interceptedMessages.push({
                role: msg.role,
                content: msg.content.trim(),
            });
        }
    }
});

// Request the full transcript from the interceptor (for page-load catch-up)
function requestInterceptorTranscript() {
    return new Promise((resolve) => {
        const handler = (e) => {
            window.removeEventListener('__cv_transcript__', handler);
            resolve(e.detail?.messages || []);
        };
        window.addEventListener('__cv_transcript__', handler);
        window.dispatchEvent(new CustomEvent('__cv_get_transcript__'));
        // Timeout after 200ms if interceptor didn't respond (not installed)
        setTimeout(() => {
            window.removeEventListener('__cv_transcript__', handler);
            resolve([]);
        }, 200);
    });
}

// Reset intercepted messages when URL changes (SPA navigation)
let _lastContentUrl = location.href;
setInterval(() => {
    if (location.href !== _lastContentUrl) {
        _lastContentUrl = location.href;
        _interceptedMessages = [];
    }
}, 1000);

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

// ─── Extract chat content (Network Intercept → DOM fallback) ─────
// Priority: 1) Network-intercepted API data (clean JSON)
//           2) DOM scraping (existing selectors, as fallback)
function extractChatContent() {
    // ── Priority 1: Use intercepted network data ──────────────────
    if (_interceptedMessages.length >= 2) {
        console.debug('[ConVX] Using intercepted network data (%d messages)', _interceptedMessages.length);
        let chatLog = '';
        for (const msg of _interceptedMessages) {
            const label = msg.role === 'user' ? 'USER' : 'ASSISTANT';
            chatLog += label + ':\n' + msg.content + '\n\n';
        }
        const result = chatLog.trim();
        if (result.length >= 20) return result;
    }

    // ── Priority 2: DOM scraping (existing selectors) ────────────
    console.debug('[ConVX] Falling back to DOM scraping');
    return _extractChatFromDOM();
}

// The original DOM scraping logic, moved into its own function
function _extractChatFromDOM() {
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
function _injectIntoElement(input, text) {
    input.focus();
    if (input.tagName === 'TEXTAREA') {
        // Use React's internal value setter so synthetic events fire correctly.
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        )?.set;
        if (nativeSetter) nativeSetter.call(input, text);
        else input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        // For contenteditable (React, Angular, ProseMirror):
        // execCommand('selectAll') on an EMPTY contenteditable doesn't always set a
        // real selection — the subsequent insertText then only inserts up to the first
        // special character. Use Selection API to guarantee a range even on empty inputs.
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.removeAllRanges();
        sel.addRange(range);
        // With a real selection in place, insertText replaces it reliably.
        document.execCommand('insertText', false, text);
    }
    return true;
}

function pasteIntoInput(text) {
    const domain = window.location.hostname;
    let input = null;

    if (domain.includes("chatgpt.com")) {
        input = document.querySelector('#prompt-textarea, textarea[data-id="root"], div[contenteditable="true"]');
    } else if (domain.includes("claude.ai")) {
        input = document.querySelector('[contenteditable="true"].ProseMirror, div[contenteditable="true"]');
    } else if (domain.includes("gemini.google.com")) {
        input = document.querySelector('rich-textarea div[contenteditable="true"]');
    } else if (domain.includes("grok.com") || domain.includes("x.com") || domain.includes("x.ai")) {
        input = document.querySelector('textarea, [contenteditable="true"]');
    } else if (domain.includes("deepseek.com")) {
        input = document.querySelector('textarea, #chat-input');
    } else if (domain.includes("perplexity.ai")) {
        input = document.querySelector('textarea, [contenteditable="true"]');
    } else if (domain.includes("copilot.microsoft.com")) {
        input = document.querySelector('textarea, #searchbox');
    }

    if (!input) return false;
    return _injectIntoElement(input, text);
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
            <div class="cv-panel-logo">
                <span class="cv-panel-logo-mark">✦</span>
                <span class="cv-panel-title">Vault</span>
            </div>
            <button class="cv-panel-close" id="cv-panel-close">✕</button>
        </div>
        <div class="cv-panel-controls">
            <div class="cv-panel-search">
                <svg class="cv-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="text" id="cv-search-input" placeholder="Search…" />
            </div>
            <div class="cv-size-selector">
                <button class="cv-size-btn" data-size="compact" title="Compact context">S</button>
                <button class="cv-size-btn cv-size-active" data-size="standard" title="Standard context">M</button>
                <button class="cv-size-btn" data-size="full" title="Full context">L</button>
            </div>
        </div>
        <div class="cv-query-section">
            <input type="text" id="cv-query-input" placeholder="Focus query — e.g. 'the auth bug'" />
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

    // Size selector
    panel.querySelectorAll(".cv-size-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            panel.querySelectorAll(".cv-size-btn").forEach(b => b.classList.remove("cv-size-active"));
            btn.classList.add("cv-size-active");
        });
    });

    // Query input — highlight border when active
    document.getElementById("cv-query-input").addEventListener("input", (e) => {
        const querySection = document.querySelector(".cv-query-section");
        if (querySection) {
            querySection.classList.toggle("cv-query-active", !!e.target.value.trim());
        }
    });

    // Search
    let searchTimer = null;
    document.getElementById("cv-search-input").addEventListener("input", (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => loadContexts(e.target.value), 300);
    });

    loadContexts();
}

function showBriefToast(message) {
    const existing = document.getElementById("cv-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.id = "cv-toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("cv-toast-visible"));
    setTimeout(() => {
        toast.classList.remove("cv-toast-visible");
        setTimeout(() => toast.remove(), 300);
    }, 2200);
}

function showContextPreview(item, ctx) {
    // Remove any existing tooltip
    const existing = document.getElementById("cv-preview-tooltip");
    if (existing) existing.remove();

    const title = ctx.title || "Untitled";
    const source = ctx.source || "";
    const date = ctx.created_at
        ? new Date(ctx.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
        : "";

    const tip = document.createElement("div");
    tip.id = "cv-preview-tooltip";
    tip.innerHTML = `
        <div class="cv-preview-title">${escapeHtml(title)}</div>
        <div class="cv-preview-meta">
            ${source ? `<span class="cv-preview-source">${escapeHtml(source)}</span>` : ""}
            ${date ? `<span class="cv-preview-date">${date}</span>` : ""}
        </div>
        <div class="cv-preview-hint">Click to import into this conversation</div>
    `;
    document.body.appendChild(tip);

    // Position: left of the item, vertically centered
    const rect = item.getBoundingClientRect();
    const tipWidth = 280;
    const margin = 10;
    let left = rect.left - tipWidth - margin;
    if (left < 8) left = rect.right + margin; // flip right if no space
    let top = rect.top + (rect.height / 2) - 60;
    top = Math.max(8, Math.min(top, window.innerHeight - 160));

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;

    requestAnimationFrame(() => tip.classList.add("cv-preview-visible"));
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
            const source = ctx.source || "";
            const date = ctx.created_at ? new Date(ctx.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

            item.innerHTML = `
                <div class="cv-context-title">${escapeHtml(title)}</div>
                <div class="cv-context-meta">
                    ${source ? `<span class="cv-context-source">${escapeHtml(source)}</span>` : ""}
                    ${date ? `<span class="cv-context-date">${date}</span>` : ""}
                </div>
            `;

            // ── Hover preview (1 second hover, not hold) ─────────────
            let hoverTimer = null;

            item.addEventListener("mouseenter", () => {
                hoverTimer = setTimeout(() => {
                    hoverTimer = null;
                    showContextPreview(item, ctx);
                }, 1000);
            });

            item.addEventListener("mouseleave", () => {
                if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
                // Dismiss tooltip when leaving the item
                const tip = document.getElementById("cv-preview-tooltip");
                if (tip) {
                    tip.classList.remove("cv-preview-visible");
                    setTimeout(() => tip.remove(), 180);
                }
            });

            item.addEventListener("click", () => {
                // Dismiss any open preview
                const tip = document.getElementById("cv-preview-tooltip");
                if (tip) tip.remove();

                item.classList.add("cv-loading");
                const queryInput = document.getElementById("cv-query-input");
                const query = queryInput ? queryInput.value.trim() : "";
                const modeLabel = query ? "Retrieving…" : "Generating…";
                item.querySelector(".cv-context-title").innerHTML = `<span class="cv-spinner"></span> ${modeLabel}`;

                const activeSize = document.querySelector(".cv-size-btn.cv-size-active");
                const size = activeSize ? activeSize.dataset.size : "standard";

                chrome.runtime.sendMessage({ action: "fetch_prompt", contextId: ctx.id, size, query }, (res) => {
                    item.classList.remove("cv-loading");

                    if (res && res.success && res.prompt) {
                        const mode = res.mode === "hybrid" ? "⚡ Hybrid" : res.mode === "retrieval" ? "🎯 Retrieved" : "📄 Static";

                        // Close panel FIRST so focus returns to the page input,
                        // then inject after a short delay for the panel animation to settle.
                        const panel = document.getElementById("cv-import-panel");
                        if (panel) { panel.classList.remove("cv-panel-open"); panelOpen = false; }

                        setTimeout(() => {
                            const pasted = pasteIntoInput(res.prompt);
                            if (!pasted) {
                                // Fallback: copy to clipboard and briefly reopen panel to show status
                                navigator.clipboard.writeText(res.prompt).catch(() => {});
                                showBriefToast(`📋 ${mode} — copied to clipboard`);
                            } else {
                                showBriefToast(`✅ ${mode} — pasted`);
                            }
                        }, 120);
                    } else {
                        item.querySelector(".cv-context-title").textContent = "❌ Failed";
                        setTimeout(() => {
                            item.querySelector(".cv-context-title").textContent = title;
                        }, 2000);
                    }
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

// ─── @convx keyword detection ────────────────────────────────────
// When user types "@convx <query>" in the chat input, intercept it,
// retrieve cross-conversation context, and replace @convx with the prompt.

const CONVX_TRIGGER = /@convx\s+(.+)/i;
let _convxProcessing = false;
let _convxLastQuery = "";       // Prevent re-searching the same query
let _convxPendingPrompt = null; // Stored prompt waiting for user confirmation
let _convxOriginalText = "";    // Original input text at time of search

function getChatInput() {
    const domain = window.location.hostname;
    if (domain.includes("chatgpt.com"))
        return document.querySelector('#prompt-textarea, textarea[data-id="root"], div[contenteditable="true"]');
    if (domain.includes("claude.ai"))
        return document.querySelector('[contenteditable="true"].ProseMirror, div[contenteditable="true"]');
    if (domain.includes("gemini.google.com"))
        return document.querySelector('rich-textarea div[contenteditable="true"]');
    if (domain.includes("grok.com") || domain.includes("x.com") || domain.includes("x.ai"))
        return document.querySelector('textarea, [contenteditable="true"]');
    if (domain.includes("deepseek.com"))
        return document.querySelector('textarea, #chat-input');
    if (domain.includes("perplexity.ai"))
        return document.querySelector('textarea, [contenteditable="true"]');
    if (domain.includes("copilot.microsoft.com"))
        return document.querySelector('textarea, #searchbox');
    return null;
}

function getInputText(el) {
    if (!el) return "";
    return el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value : el.innerText;
}

function setInputText(el, text) {
    if (!el) return;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
        // contenteditable
        const domain = window.location.hostname;
        if (domain.includes("claude.ai") || domain.includes("gemini.google.com")) {
            el.innerHTML = `<p>${text.replace(/\n/g, "<br>")}</p>`;
        } else {
            el.innerText = text;
        }
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    el.focus();
}

function checkConvxTrigger() {
    if (_convxProcessing) return;
    const input = getChatInput();
    if (!input) return;

    const text = getInputText(input);
    const match = text.match(CONVX_TRIGGER);

    // If @convx was removed from input, reset state
    if (!match) {
        if (_convxLastQuery) {
            _convxLastQuery = "";
            _convxPendingPrompt = null;
            _convxOriginalText = "";
            hideConvxBadge();
        }
        return;
    }

    const query = match[1].trim();
    if (!query || query.length < 3) return;

    // Don't re-search the same query
    if (query === _convxLastQuery) return;

    _convxProcessing = true;
    _convxLastQuery = query;
    _convxOriginalText = text;

    showConvxBadge("Searching...");

    chrome.runtime.sendMessage({ action: "cross_retrieve", query, size: "standard" }, (res) => {
        _convxProcessing = false;
        if (res && res.success && res.prompt && res.chunks_found > 0) {
            _convxPendingPrompt = res.prompt;
            // Show badge with Inject / Dismiss buttons — user decides
            showConvxInjectBadge(res.chunks_found, query);
        } else {
            _convxPendingPrompt = null;
            showConvxBadge("No matching context found");
            setTimeout(hideConvxBadge, 3000);
        }
    });
}

function showConvxInjectBadge(chunksFound, query) {
    let badge = document.getElementById("cv-convx-badge");
    if (!badge) {
        badge = document.createElement("div");
        badge.id = "cv-convx-badge";
        document.body.appendChild(badge);
    }
    badge.className = "cv-badge cv-badge-visible cv-badge-action";

    const shortQuery = query.length > 30 ? query.substring(0, 30) + "…" : query;
    badge.innerHTML = `
        <span class="cv-badge-text">⚡ Found ${chunksFound} chunks for "${escapeHtml(shortQuery)}"</span>
        <button class="cv-badge-btn cv-badge-inject" id="cv-convx-inject">Inject</button>
        <button class="cv-badge-btn cv-badge-dismiss" id="cv-convx-dismiss">✕</button>
    `;

    document.getElementById("cv-convx-inject").addEventListener("click", () => {
        if (_convxPendingPrompt) {
            const input = getChatInput();
            if (input) {
                // Remove @convx ... from the original text, prepend context
                const userMessage = _convxOriginalText.replace(CONVX_TRIGGER, "").trim();
                const combined = _convxPendingPrompt + "\n\n" + userMessage;
                setInputText(input, combined);
            }
        }
        _convxPendingPrompt = null;
        _convxLastQuery = "";
        _convxOriginalText = "";
        hideConvxBadge();
    });

    document.getElementById("cv-convx-dismiss").addEventListener("click", () => {
        _convxPendingPrompt = null;
        _convxLastQuery = "";
        _convxOriginalText = "";
        hideConvxBadge();
    });
}

// Poll for @convx trigger (check every 800ms)
setInterval(checkConvxTrigger, 800);


// ─── Auto-inject on first message ────────────────────────────────
// Detects when user is starting a new conversation and automatically
// searches for relevant context across all saved conversations.

let _autoInjectDone = false;
let _lastUrl = window.location.href;
let _autoInjectDismissed = false;
let _pendingAutoPrompt = null;

function isNewConversation() {
    const domain = window.location.hostname;
    const path = window.location.pathname;

    // ChatGPT: / or /? means new chat; /c/xxx means existing
    if (domain.includes("chatgpt.com")) return path === "/" || path === "";
    // Claude: /new means new chat; /chat/xxx means existing
    if (domain.includes("claude.ai")) return path === "/new" || path === "/" || path === "";
    // Gemini: /app means new; /app/xxx means existing
    if (domain.includes("gemini.google.com")) return path === "/app" || path === "/";
    // Grok, DeepSeek, Perplexity: heuristic — check if no messages on page
    if (domain.includes("grok.com") || domain.includes("deepseek.com") || domain.includes("perplexity.ai")) {
        const msgs = document.querySelectorAll("[data-message-author-role], .message-bubble, .ds-message-row, .prose");
        return msgs.length === 0;
    }
    return false;
}

function checkAutoInject() {
    // Reset when URL changes (user navigated to a new chat)
    if (window.location.href !== _lastUrl) {
        _lastUrl = window.location.href;
        _autoInjectDone = false;
        _autoInjectDismissed = false;
        _pendingAutoPrompt = null;
        hideConvxBadge();
    }

    if (_autoInjectDone || _autoInjectDismissed) return;
    if (!isNewConversation()) return;

    const input = getChatInput();
    if (!input) return;

    const text = getInputText(input).trim();
    // Need at least 15 chars of meaningful input to trigger
    if (text.length < 15) return;

    // Don't trigger if it's an @convx message (that has its own handler)
    if (CONVX_TRIGGER.test(text)) return;

    _autoInjectDone = true; // Only try once per conversation

    showConvxBadge("Searching vault...");

    chrome.runtime.sendMessage({ action: "cross_retrieve", query: text, size: "standard" }, (res) => {
        if (res && res.success && res.prompt && res.chunks_found > 0) {
            _pendingAutoPrompt = res.prompt;
            showAutoInjectBadge(res.chunks_found);
        } else {
            hideConvxBadge();
        }
    });
}

// Check every 2 seconds for auto-inject opportunity
setInterval(checkAutoInject, 2000);


// ─── Badge UI for @convx and auto-inject ─────────────────────────

function showConvxBadge(message) {
    let badge = document.getElementById("cv-convx-badge");
    if (!badge) {
        badge = document.createElement("div");
        badge.id = "cv-convx-badge";
        document.body.appendChild(badge);
    }
    badge.textContent = "⚡ ConVX: " + message;
    badge.className = "cv-badge cv-badge-visible";
}

function hideConvxBadge() {
    const badge = document.getElementById("cv-convx-badge");
    if (badge) badge.className = "cv-badge";
}

function showAutoInjectBadge(chunksFound) {
    let badge = document.getElementById("cv-convx-badge");
    if (!badge) {
        badge = document.createElement("div");
        badge.id = "cv-convx-badge";
        document.body.appendChild(badge);
    }
    badge.className = "cv-badge cv-badge-visible cv-badge-action";
    badge.innerHTML = `
        <span class="cv-badge-text">⚡ ConVX found ${chunksFound} relevant chunks</span>
        <button class="cv-badge-btn cv-badge-inject" id="cv-auto-inject-yes">Inject</button>
        <button class="cv-badge-btn cv-badge-dismiss" id="cv-auto-inject-no">✕</button>
    `;

    document.getElementById("cv-auto-inject-yes").addEventListener("click", () => {
        if (_pendingAutoPrompt) {
            const input = getChatInput();
            if (input) {
                const currentText = getInputText(input).trim();
                const combined = _pendingAutoPrompt + "\n\n" + currentText;
                setInputText(input, combined);
            }
            _pendingAutoPrompt = null;
        }
        hideConvxBadge();
    });

    document.getElementById("cv-auto-inject-no").addEventListener("click", () => {
        _autoInjectDismissed = true;
        _pendingAutoPrompt = null;
        hideConvxBadge();
    });
}


// Run injection periodically since SPAs re-render the DOM
setInterval(() => {
    injectButton();
    injectStarButtons();
}, 2000);
