// Options page — optional manual override for the backend port.
//
// Normally the extension auto-detects the port (the app picks the first free
// one in 8000–8009 and the extension probes that range). Set a value here only
// to pin a specific port; leave it blank to let auto-detect do its thing.
// Stored under "backendPort" in chrome.storage.local — background.js reads it.

const portInput = document.getElementById("port");
const statusEl = document.getElementById("status");

function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = kind || "";
}

// Confirm a ContextVolt backend is actually answering on a port.
async function isContextVolt(port) {
    try {
        const res = await fetch(`http://localhost:${port}/api/health`);
        if (!res.ok) return false;
        const j = await res.json();
        return !!j && j.app === "contextvolt";
    } catch {
        return false;
    }
}

// Show the current override (blank = auto-detect).
chrome.storage.local.get("backendPort").then(({ backendPort }) => {
    if (backendPort) portInput.value = backendPort;
});

document.getElementById("save").addEventListener("click", async () => {
    const raw = portInput.value.trim();

    // Blank = clear the override and fall back to auto-detection.
    if (raw === "") {
        await chrome.storage.local.remove("backendPort");
        setStatus("Cleared — the extension will auto-detect the port.", "ok");
        return;
    }

    const port = parseInt(raw, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        setStatus("Enter a valid port (1–65535), or leave blank to auto-detect.", "err");
        return;
    }

    await chrome.storage.local.set({ backendPort: port });
    setStatus("Saved. Testing…", "");

    if (await isContextVolt(port)) {
        setStatus(`Connected to ContextVolt on port ${port}.`, "ok");
    } else {
        setStatus(`Saved, but no ContextVolt backend responded on port ${port}.`, "err");
    }
});
