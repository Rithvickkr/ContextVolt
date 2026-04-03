/**
 * ConVX — Network Interceptor (MAIN world)
 *
 * Runs in the page's own JS context (before any site code).
 * Monkey-patches window.fetch and XMLHttpRequest to capture
 * API responses from AI chat platforms.
 *
 * Captured messages are dispatched as CustomEvents that the
 * content script (ISOLATED world) listens for.
 */

(function () {
    'use strict';

    // Guard against double-injection
    if (window.__cv_interceptor__) return;
    window.__cv_interceptor__ = true;

    const _originalFetch = window.fetch;
    const _originalXHROpen = XMLHttpRequest.prototype.open;
    const _originalXHRSend = XMLHttpRequest.prototype.send;

    // ─── Accumulated conversation state ──────────────────────────
    // We accumulate messages over time (each API call adds to this).
    // The content script reads the full array when the user clicks
    // "Send to Vault".
    const _capturedMessages = [];

    // ─── API endpoint matching ───────────────────────────────────
    const CONVERSATION_PATTERNS = [
        // ChatGPT
        /backend-api\/conversation/,
        /chatgpt\.com.*\/api/,
        // Claude
        /api\/organizations\/.*\/chat_conversations/,
        /api\/organizations\/.*\/completion/,
        /api\.claude\.ai/,
        // Gemini
        /generativelanguage\.googleapis\.com/,
        /batchexecute/,  // Gemini uses batchexecute for some calls
        // Grok
        /api\/rpc\/.*\/grok/i,
        /grok.*\/api/,
        // DeepSeek
        /chat\.deepseek\.com\/api/,
        /deepseek.*\/chat/,
        // Perplexity
        /api\.perplexity\.ai/,
        /perplexity.*\/api/,
        // Copilot
        /sydney.*\/chat/i,
        /copilot.*\/api/,
        // Generic OpenAI-compatible endpoints
        /\/v1\/chat\/completions/,
        /\/v1\/messages/,
        /\/api\/chat/,
    ];

    function isConversationURL(url) {
        if (!url || typeof url !== 'string') return false;
        return CONVERSATION_PATTERNS.some(p => p.test(url));
    }

    // ─── SSE stream parsing ──────────────────────────────────────
    async function readSSEStream(response) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const messages = [];
        let currentRole = 'assistant';
        let currentContent = '';

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop() || '';  // keep incomplete last line

                for (const line of lines) {
                    // SSE format: "data: {...}" or "data: [DONE]"
                    if (!line.startsWith('data:')) continue;
                    const raw = line.slice(5).trim();
                    if (raw === '[DONE]' || raw === '') continue;

                    try {
                        const parsed = JSON.parse(raw);
                        const delta = extractDelta(parsed);
                        if (delta) {
                            currentContent += delta;
                        }

                        // Some APIs send full messages rather than deltas
                        const fullMsg = extractFullMessage(parsed);
                        if (fullMsg) {
                            messages.push(fullMsg);
                        }
                    } catch (_) { /* malformed JSON chunk, skip */ }
                }
            }
        } catch (err) {
            // Stream interrupted — use whatever we got
            console.debug('[ConVX] Stream read error (partial capture):', err.message);
        }

        // If we accumulated streaming content, push it as a complete message
        if (currentContent.trim()) {
            messages.push({ role: currentRole, content: currentContent.trim() });
        }

        return messages;
    }

    // ─── Extract delta content from streaming chunks ─────────────
    function extractDelta(parsed) {
        // OpenAI / ChatGPT streaming
        if (parsed.choices?.[0]?.delta?.content) {
            return parsed.choices[0].delta.content;
        }
        // Anthropic / Claude streaming
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            return parsed.delta.text;
        }
        // Generic delta
        if (parsed.delta?.content) {
            return parsed.delta.content;
        }
        // Gemini streaming
        if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
            return parsed.candidates[0].content.parts[0].text;
        }
        return null;
    }

    // ─── Extract full messages from non-streaming JSON ───────────
    function extractFullMessage(data) {
        // OpenAI / ChatGPT completed message
        if (data.choices?.[0]?.message) {
            const msg = data.choices[0].message;
            if (msg.content) return { role: msg.role || 'assistant', content: msg.content };
        }
        // ChatGPT conversation response format
        if (data.message?.content?.parts) {
            const text = data.message.content.parts.join('');
            const role = data.message.author?.role || 'assistant';
            if (text.trim()) return { role: role, content: text.trim() };
        }
        return null;
    }

    // ─── Extract all messages from a complete JSON response ──────
    function extractMessagesFromJSON(data) {
        const messages = [];

        // OpenAI shape: { choices: [{ message: { role, content } }] }
        if (data.choices && Array.isArray(data.choices)) {
            for (const choice of data.choices) {
                const msg = choice.message || choice.delta;
                if (msg?.content) {
                    messages.push({ role: msg.role || 'assistant', content: msg.content });
                }
            }
        }

        // Anthropic shape: { role, content: [{ type: "text", text }] }
        if (data.content && Array.isArray(data.content)) {
            for (const block of data.content) {
                if (block.type === 'text' && block.text) {
                    messages.push({ role: data.role || 'assistant', content: block.text });
                }
            }
        } else if (data.completion) {
            // Anthropic legacy
            messages.push({ role: 'assistant', content: data.completion });
        }

        // Gemini shape: { candidates: [{ content: { parts: [{ text }] } }] }
        if (data.candidates && Array.isArray(data.candidates)) {
            for (const candidate of data.candidates) {
                const parts = candidate.content?.parts || [];
                const text = parts.map(p => p.text || '').join('');
                if (text.trim()) {
                    messages.push({ role: candidate.content?.role || 'model', content: text.trim() });
                }
            }
        }

        // ChatGPT conversation tree format
        if (data.mapping && typeof data.mapping === 'object') {
            const nodes = Object.values(data.mapping)
                .filter(n => n.message?.content?.parts)
                .sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));

            for (const node of nodes) {
                const msg = node.message;
                const role = msg.author?.role;
                if (role !== 'user' && role !== 'assistant') continue;
                const text = msg.content.parts
                    .filter(p => typeof p === 'string')
                    .join('')
                    .trim();
                if (text) {
                    messages.push({ role, content: text });
                }
            }
        }

        // DeepSeek / generic: { messages: [{ role, content }] }
        if (data.messages && Array.isArray(data.messages)) {
            for (const msg of data.messages) {
                if (msg.role && msg.content) {
                    messages.push({ role: msg.role, content: msg.content });
                }
            }
        }

        return messages;
    }

    // ─── Extract user message from request body ──────────────────
    function extractUserMessageFromBody(body) {
        if (!body) return null;
        try {
            let data;
            if (typeof body === 'string') {
                data = JSON.parse(body);
            } else if (body instanceof FormData) {
                return null;
            } else if (body instanceof Blob || body instanceof ArrayBuffer) {
                return null;
            } else {
                data = body;
            }

            // OpenAI format: { messages: [{ role: "user", content: "..." }] }
            if (data.messages && Array.isArray(data.messages)) {
                const userMsgs = data.messages.filter(m => m.role === 'user');
                const last = userMsgs[userMsgs.length - 1];
                if (last?.content) {
                    const content = typeof last.content === 'string'
                        ? last.content
                        : Array.isArray(last.content)
                            ? last.content.filter(c => c.type === 'text').map(c => c.text).join('')
                            : '';
                    if (content.trim()) return { role: 'user', content: content.trim() };
                }
            }

            // ChatGPT: { action: "next", messages: [{ content: { parts: [...] } }] }
            if (data.action && data.messages) {
                for (const msg of data.messages) {
                    if (msg.author?.role === 'user' || msg.role === 'user') {
                        const text = msg.content?.parts?.join('') || msg.content || '';
                        if (typeof text === 'string' && text.trim()) {
                            return { role: 'user', content: text.trim() };
                        }
                    }
                }
            }

            // Anthropic format: { prompt }  or just a text field
            if (data.prompt && typeof data.prompt === 'string') {
                return { role: 'user', content: data.prompt };
            }
        } catch (_) { /* not JSON, ignore */ }
        return null;
    }

    // ─── Dispatch to content script ──────────────────────────────
    function dispatch(newMessages) {
        if (!newMessages || newMessages.length === 0) return;

        // Normalize roles to USER / ASSISTANT
        for (const msg of newMessages) {
            if (/^(user|human)$/i.test(msg.role)) msg.role = 'user';
            else msg.role = 'assistant';
        }

        // Add to accumulated buffer
        _capturedMessages.push(...newMessages);

        // Dispatch event for content script
        window.dispatchEvent(new CustomEvent('__cv_captured__', {
            detail: {
                newMessages,
                totalMessages: _capturedMessages.length,
                timestamp: Date.now(),
            }
        }));
    }

    // ─── Make full transcript available on demand ────────────────
    // Content script calls this via a query event
    window.addEventListener('__cv_get_transcript__', () => {
        window.dispatchEvent(new CustomEvent('__cv_transcript__', {
            detail: {
                messages: [..._capturedMessages],
                timestamp: Date.now(),
            }
        }));
    });

    // Reset captured messages when URL changes (new conversation)
    let _lastHref = location.href;
    const _navObserver = new MutationObserver(() => {
        if (location.href !== _lastHref) {
            _lastHref = location.href;
            _capturedMessages.length = 0;
        }
    });
    _navObserver.observe(document.documentElement, { childList: true, subtree: true });

    // ─── Fetch interceptor ───────────────────────────────────────
    window.fetch = async function (...args) {
        const [input, init] = args;
        const url = typeof input === 'string' ? input
            : input instanceof Request ? input.url
            : String(input);

        if (!isConversationURL(url)) {
            return _originalFetch.apply(this, args);
        }

        // Capture user message from request body
        const requestBody = init?.body || (input instanceof Request ? await input.clone().text().catch(() => null) : null);
        const userMsg = extractUserMessageFromBody(requestBody);
        if (userMsg) dispatch([userMsg]);

        // Execute the real fetch
        const response = await _originalFetch.apply(this, args);

        // Clone before the page consumes it
        const clone = response.clone();
        const contentType = response.headers.get('content-type') || '';

        // Process response asynchronously (don't block the page)
        (async () => {
            try {
                if (contentType.includes('text/event-stream') ||
                    contentType.includes('text/plain') ||
                    response.headers.get('transfer-encoding') === 'chunked') {
                    // SSE streaming response
                    const msgs = await readSSEStream(clone);
                    dispatch(msgs);
                } else if (contentType.includes('application/json')) {
                    const data = await clone.json();
                    const msgs = extractMessagesFromJSON(data);
                    dispatch(msgs);
                } else {
                    // Try to parse as JSON anyway (some endpoints don't set content-type correctly)
                    try {
                        const text = await clone.text();
                        if (text.startsWith('{') || text.startsWith('[')) {
                            const data = JSON.parse(text);
                            const msgs = extractMessagesFromJSON(data);
                            dispatch(msgs);
                        }
                    } catch (_) {}
                }
            } catch (err) {
                console.debug('[ConVX] Response capture error:', err.message);
            }
        })();

        return response;
    };

    // ─── XHR interceptor ─────────────────────────────────────────
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__cv_url = typeof url === 'string' ? url : String(url);
        this.__cv_method = method;
        return _originalXHROpen.call(this, method, url, ...rest);
    };

    const _originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        // Track content type
        if (name.toLowerCase() === 'content-type') {
            this.__cv_contentType = value;
        }
        return _originalXHRSetHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function (body) {
        if (isConversationURL(this.__cv_url)) {
            // Capture user message from request body
            if (typeof body === 'string') {
                const userMsg = extractUserMessageFromBody(body);
                if (userMsg) dispatch([userMsg]);
            }

            // Listen for response
            this.addEventListener('load', function () {
                try {
                    if (this.responseType === '' || this.responseType === 'text') {
                        const text = this.responseText;
                        try {
                            const data = JSON.parse(text);
                            const msgs = extractMessagesFromJSON(data);
                            dispatch(msgs);
                        } catch (_) {
                            // Might be SSE-style text — parse line by line
                            const msgs = [];
                            let content = '';
                            for (const line of text.split('\n')) {
                                if (!line.startsWith('data:')) continue;
                                const raw = line.slice(5).trim();
                                if (raw === '[DONE]' || !raw) continue;
                                try {
                                    const delta = extractDelta(JSON.parse(raw));
                                    if (delta) content += delta;
                                } catch (_) {}
                            }
                            if (content.trim()) {
                                msgs.push({ role: 'assistant', content: content.trim() });
                            }
                            dispatch(msgs);
                        }
                    } else if (this.responseType === 'json' && this.response) {
                        const msgs = extractMessagesFromJSON(this.response);
                        dispatch(msgs);
                    }
                } catch (err) {
                    console.debug('[ConVX] XHR capture error:', err.message);
                }
            });
        }

        return _originalXHRSend.call(this, body);
    };

    console.debug('[ConVX] Network interceptor installed');
})();
