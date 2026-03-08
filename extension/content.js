// Content script for ChatGPT and Claude

// Utility to extract text based on domain
function extractChatContent() {
    const domain = window.location.hostname;
    let chatLog = "";

    if (domain.includes("chatgpt.com")) {
        // ChatGPT: each message has data-message-author-role on a container,
        // but the actual prose lives in a nested .markdown or .whitespace-pre-wrap div.
        const messages = document.querySelectorAll('[data-message-author-role]');
        if (messages.length === 0) return null;

        messages.forEach(msg => {
            const role = msg.getAttribute('data-message-author-role');
            if (role !== 'user' && role !== 'assistant') return;

            // Get only the message body, not action buttons or metadata
            const prose = msg.querySelector('.markdown, .whitespace-pre-wrap, .text-message');
            if (!prose) return;
            const text = prose.innerText.trim();
            if (!text) return;

            chatLog += (role === 'user' ? 'USER' : 'ASSISTANT') + ':\n' + text + '\n\n';
        });

    } else if (domain.includes("claude.ai")) {
        // Claude: messages use data-testid="human-turn" and data-testid="ai-turn"
        const humanTurns = document.querySelectorAll('[data-testid="human-turn"]');
        const aiTurns = document.querySelectorAll('[data-testid="ai-turn"]');

        if (humanTurns.length > 0 || aiTurns.length > 0) {
            // Collect all turns with their DOM order for proper sequencing
            const allTurns = [];
            humanTurns.forEach(el => allTurns.push({ el, role: 'USER' }));
            aiTurns.forEach(el => allTurns.push({ el, role: 'ASSISTANT' }));

            // Sort by document position
            allTurns.sort((a, b) => {
                const pos = a.el.compareDocumentPosition(b.el);
                return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
            });

            allTurns.forEach(({ el, role }) => {
                // Get the prose content, skip buttons/controls
                const prose = el.querySelector('.font-claude, .font-user, [class*="prose"], .grid-cols-1, .break-words');
                const text = (prose || el).innerText.trim();
                if (text) chatLog += role + ':\n' + text + '\n\n';
            });
        } else {
            // Fallback: try font-user / font-claude classes
            const fontEls = document.querySelectorAll('.font-user-message, .font-claude-message, .font-user, .font-claude');
            if (fontEls.length > 0) {
                fontEls.forEach(el => {
                    const isUser = el.className.includes('user');
                    const text = el.innerText.trim();
                    if (text) chatLog += (isUser ? 'USER' : 'ASSISTANT') + ':\n' + text + '\n\n';
                });
            } else {
                return null;
            }
        }
    }

    return chatLog.trim() || null;
}

// Inject floating button
function injectButton() {
    if (document.getElementById("cv-export-button")) return;

    const btn = document.createElement("button");
    btn.id = "cv-export-button";
    btn.innerHTML = `<span class="cv-icon">✦</span> Send to Vault`;
    
    btn.addEventListener("click", () => {
        btn.innerHTML = `<span class="cv-spinner"></span> Extracting…`;
        btn.classList.add("cv-sending");
        btn.disabled = true;

        // Small delay so the user sees the extracting state
        setTimeout(() => {
            const chatText = extractChatContent();

            if (!chatText || chatText.length < 20) {
                btn.innerHTML = `No chat found!`;
                btn.classList.remove("cv-sending");
                setTimeout(() => { btn.innerHTML = `<span class="cv-icon">✦</span> Send to Vault`; btn.disabled = false; }, 2000);
                return;
            }

            btn.innerHTML = `<span class="cv-spinner"></span> Contextualizing…`;

            // Progress through states while waiting for the backend
            const stateTimer = setTimeout(() => {
                btn.innerHTML = `<span class="cv-spinner"></span> Summarizing…`;
            }, 2500);

            const source = window.location.hostname.includes("chatgpt.com") ? "ChatGPT" : "Claude";

            chrome.runtime.sendMessage({
                action: "save_chat",
                payload: {
                    text: chatText,
                    source: source
                }
            }, (response) => {
                clearTimeout(stateTimer);
                btn.classList.remove("cv-sending");

                if (chrome.runtime.lastError) {
                    btn.innerHTML = `❌ Extension error`;
                    btn.classList.add("cv-error");
                } else if (response && response.success) {
                    btn.innerHTML = `✅ Saved!`;
                    btn.classList.add("cv-success");
                } else {
                    btn.innerHTML = `❌ Failed!`;
                    btn.classList.add("cv-error");
                }

                setTimeout(() => {
                    btn.innerHTML = `<span class="cv-icon">✦</span> Send to Vault`;
                    btn.classList.remove("cv-success", "cv-error");
                    btn.disabled = false;
                }, 3000);
            });
        }, 300);
    });

    document.body.appendChild(btn);
}

// Run injection periodically since SPAs re-render the DOM
setInterval(injectButton, 2000);
