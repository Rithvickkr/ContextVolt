// Background service worker

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "save_chat") {

        const payload = {
            source: request.payload.source,
            text: request.payload.text,
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
            console.error("Context Vault Error:", err);
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
});
