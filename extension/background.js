// Background service worker

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "save_chat") {

        const payload = {
            source: request.payload.source,
            text: request.payload.text,
            important_snippets: request.payload.important_snippets || [],
            conversation_url: request.payload.conversation_url || "",
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000); // 2-min timeout

        fetch("http://localhost:8000/api/capture", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
        })
        .then(response => {
            clearTimeout(timeout);
            if (response.ok) {
                return response.json();
            }
            return response.text().then(body => {
                throw new Error(body || ("Server error " + response.status));
            });
        })
        .then(data => {
            sendResponse({ success: true, id: data.id });
        })
        .catch(err => {
            clearTimeout(timeout);
            console.error("ContextVolt Error:", err);
            let msg = err.message || String(err);
            if (err.name === "AbortError") {
                msg = "Request timed out — is the backend running?";
            } else if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
                msg = "Cannot reach backend at localhost:8000";
            }
            sendResponse({ success: false, error: msg });
        });

        // Keep message channel open for async response
        return true;
    }

    // ── Import from Vault: fetch lightweight context list ──
    if (request.action === "fetch_contexts") {
        const q = request.query || "";
        const url = q
            ? `http://localhost:8000/api/contexts/list?q=${encodeURIComponent(q)}`
            : "http://localhost:8000/api/contexts/list";

        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error("Server error " + res.status);
                return res.json();
            })
            .then(data => sendResponse({ success: true, contexts: data }))
            .catch(err => {
                console.error("ContextVolt — fetch contexts error:", err);
                let msg = err.message || String(err);
                if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
                    msg = "Cannot reach backend at localhost:8000";
                }
                sendResponse({ success: false, error: msg });
            });

        return true;
    }

    // ── Import from Vault: fetch generated prompt for a context ──
    if (request.action === "fetch_prompt") {
        const size = request.size || "standard";
        const query = request.query || "";

        fetch(`http://localhost:8000/api/contexts/${request.contextId}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: query || null, size }),
        })
            .then(res => {
                if (!res.ok) throw new Error("Server error " + res.status);
                return res.json();
            })
            .then(data => sendResponse({ success: true, prompt: data.prompt, mode: data.mode }))
            .catch(err => {
                console.error("ContextVolt — fetch prompt error:", err);
                sendResponse({ success: false, error: err.message || String(err) });
            });

        return true;
    }

});

