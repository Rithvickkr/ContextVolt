// Background service worker

// The backend auto-selects the first free port in this range (see
// backend/paths.py PORT_CANDIDATES — keep the two in sync). We don't assume a
// fixed port: we discover the live one by probing /api/health and confirming
// the "contextvolt" signature, then cache it. A manual override saved from the
// options page is tried first.
const PORT_CANDIDATES = [8000, 8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009];
const PROBE_TIMEOUT_MS = 700;
const NOT_FOUND_MSG =
    `Cannot reach ContextVolt — is the app running? (checked ports ${PORT_CANDIDATES[0]}–${PORT_CANDIDATES[PORT_CANDIDATES.length - 1]})`;

let _cachedPort = null; // fast path for this service-worker lifetime

async function _storedPort() {
    const { backendPort } = await chrome.storage.local.get("backendPort");
    const p = parseInt(backendPort, 10);
    return Number.isInteger(p) ? p : null;
}

// True only if a ContextVolt backend answers on this port.
async function _isContextVolt(port) {
    try {
        const res = await fetch(`http://localhost:${port}/api/health`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) return false;
        const j = await res.json();
        return !!j && j.app === "contextvolt";
    } catch {
        return false;
    }
}

// Probe the stored port first, then the rest of the range. Cache + persist the
// winner. Returns the port, or null if nothing answers.
async function discoverPort() {
    const stored = await _storedPort();
    const order = stored
        ? [stored, ...PORT_CANDIDATES.filter((p) => p !== stored)]
        : PORT_CANDIDATES;
    for (const port of order) {
        if (await _isContextVolt(port)) {
            _cachedPort = port;
            await chrome.storage.local.set({ backendPort: port });
            return port;
        }
    }
    return null;
}

async function backendOrigin() {
    if (_cachedPort) return `http://localhost:${_cachedPort}`;
    const stored = await _storedPort();
    if (stored) {
        _cachedPort = stored;
        return `http://localhost:${stored}`;
    }
    const port = await discoverPort();
    if (port === null) throw new Error(NOT_FOUND_MSG);
    return `http://localhost:${port}`;
}

// Fetch against the backend. On a network error (e.g. the app moved to another
// port since we cached it), drop the cache, rediscover once, and retry.
async function apiFetch(path, options = {}, _retried = false) {
    const base = await backendOrigin();
    try {
        return await fetch(base + path, options);
    } catch (err) {
        if (_retried) throw err;
        _cachedPort = null;
        const port = await discoverPort();
        if (port === null) throw new Error(NOT_FOUND_MSG);
        return apiFetch(path, options, true);
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "save_chat") {

        const payload = {
            source: request.payload.source,
            text: request.payload.text,
            // The conversation's name from the host AI, when it has one. The
            // backend treats a supplied title as authoritative and skips
            // generating one; "" means "no usable title, decide it yourself".
            title: request.payload.title || null,
            important_snippets: request.payload.important_snippets || [],
            conversation_url: request.payload.conversation_url || "",
            imported_context_id: request.payload.imported_context_id ?? null,
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000); // 2-min timeout

        (async () => {
            try {
                const response = await apiFetch("/api/capture", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
                clearTimeout(timeout);
                if (response.ok) {
                    const data = await response.json();
                    sendResponse({ success: true, id: data.id });
                } else {
                    const body = await response.text();
                    throw new Error(body || ("Server error " + response.status));
                }
            } catch (err) {
                clearTimeout(timeout);
                console.error("ContextVolt Error:", err);
                let msg = err.message || String(err);
                if (err.name === "AbortError") {
                    msg = "Request timed out — is the backend running?";
                }
                sendResponse({ success: false, error: msg });
            }
        })();

        // Keep message channel open for async response
        return true;
    }

    // ── Import from Vault: fetch lightweight context list ──
    if (request.action === "fetch_contexts") {
        const q = request.query || "";

        (async () => {
            try {
                const path = q
                    ? `/api/contexts/list?q=${encodeURIComponent(q)}`
                    : `/api/contexts/list`;
                const res = await apiFetch(path);
                if (!res.ok) throw new Error("Server error " + res.status);
                const data = await res.json();
                sendResponse({ success: true, contexts: data });
            } catch (err) {
                console.error("ContextVolt — fetch contexts error:", err);
                sendResponse({ success: false, error: err.message || String(err) });
            }
        })();

        return true;
    }

    // ── Import from Vault: fetch generated prompt for a context ──
    if (request.action === "fetch_prompt") {
        const size = request.size || "standard";
        const query = request.query || "";

        (async () => {
            try {
                const res = await apiFetch(`/api/contexts/${request.contextId}/prompt`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ query: query || null, size }),
                });
                if (!res.ok) throw new Error("Server error " + res.status);
                const data = await res.json();
                // `prompt` is the whole thing (inline delivery). The three
                // split fields are the same content redistributed for
                // attachment delivery — forward them or the content script
                // silently falls back to inline for every context.
                sendResponse({
                    success: true,
                    prompt: data.prompt,
                    mode: data.mode,
                    prompt_inline: data.prompt_inline || null,
                    prompt_attachment: data.prompt_attachment || null,
                    attachment_filename: data.attachment_filename || null,
                });
            } catch (err) {
                console.error("ContextVolt — fetch prompt error:", err);
                sendResponse({ success: false, error: err.message || String(err) });
            }
        })();

        return true;
    }

});
