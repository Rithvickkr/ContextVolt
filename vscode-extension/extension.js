const vscode = require("vscode");
const http = require("http");

const API_BASE = "http://localhost:8000";

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const provider = new ContextVaultSidebarProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "ContextVolt.sidebarView",
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ContextVolt.refreshContexts", () => {
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ContextVolt.openDashboard", () => {
      vscode.env.openExternal(vscode.Uri.parse("http://localhost:8000"));
    })
  );
}

function deactivate() {}

// ─── HTTP helper ─────────────────────────────────────────────────
function httpGet(path) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${path}`;
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Invalid JSON from backend"));
          }
        });
      })
      .on("error", (err) => reject(err));
  });
}

function httpPost(path) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(`${API_BASE}${path}`);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Invalid JSON from backend"));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.end();
  });
}

// ─── Sidebar Webview Provider ────────────────────────────────────
class ContextVaultSidebarProvider {
  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._getHtml();

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "fetchContexts": {
          try {
            const q = message.query || "";
            const path = q
              ? `/api/contexts/list?q=${encodeURIComponent(q)}`
              : "/api/contexts/list";
            const contexts = await httpGet(path);
            webviewView.webview.postMessage({
              command: "contextsLoaded",
              contexts,
            });
          } catch (err) {
            webviewView.webview.postMessage({
              command: "error",
              message: "Cannot reach backend. Is it running?",
            });
          }
          break;
        }

        case "insertPrompt": {
          try {
            const data = await httpPost(
              `/api/contexts/${message.contextId}/prompt`
            );
            const editor = vscode.window.activeTextEditor;
            if (editor) {
              editor.edit((editBuilder) => {
                editBuilder.insert(editor.selection.active, data.prompt);
              });
              vscode.window.showInformationMessage(
                `Context "${data.title}" inserted!`
              );
            } else {
              // No editor open — copy to clipboard
              await vscode.env.clipboard.writeText(data.prompt);
              vscode.window.showInformationMessage(
                "No editor open — prompt copied to clipboard!"
              );
            }
            webviewView.webview.postMessage({ command: "insertSuccess" });
          } catch (err) {
            vscode.window.showErrorMessage("Failed to generate prompt");
            webviewView.webview.postMessage({
              command: "error",
              message: "Failed to generate prompt",
            });
          }
          break;
        }

        case "openDashboard": {
          vscode.env.openExternal(vscode.Uri.parse("http://localhost:8000"));
          break;
        }
      }
    });
  }

  refresh() {
    if (this._view) {
      this._view.webview.postMessage({ command: "refresh" });
    }
  }

  _getHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 0;
  }

  .header {
    padding: 12px 14px 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .header-title {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-foreground);
    opacity: 0.7;
  }
  .header-actions {
    display: flex;
    gap: 4px;
  }
  .icon-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 14px;
    opacity: 0.6;
  }
  .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

  .search-box {
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .search-box input {
    width: 100%;
    padding: 6px 10px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    outline: none;
  }
  .search-box input:focus {
    border-color: var(--vscode-focusBorder);
  }
  .search-box input::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  .ctx-list {
    overflow-y: auto;
    max-height: calc(100vh - 100px);
  }

  .ctx-item {
    padding: 10px 14px;
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-panel-border);
    transition: background 0.1s;
  }
  .ctx-item:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .ctx-item:active {
    background: var(--vscode-list-activeSelectionBackground);
  }
  .ctx-item.loading {
    opacity: 0.5;
    pointer-events: none;
    text-align: center;
    color: var(--vscode-descriptionForeground);
  }

  .ctx-title {
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 4px;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ctx-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .ctx-date {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .ctx-tag {
    display: inline-block;
    padding: 1px 6px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px;
    font-size: 10px;
    font-weight: 500;
  }

  .status-msg {
    padding: 24px 14px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }
  .status-msg.error { color: var(--vscode-errorForeground); }

  .open-dashboard {
    display: block;
    width: calc(100% - 24px);
    margin: 12px auto;
    padding: 7px 12px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    text-align: center;
  }
  .open-dashboard:hover {
    background: var(--vscode-button-hoverBackground);
  }
</style>
</head>
<body>
  <div class="header">
    <span class="header-title">ContextVolt</span>
    <div class="header-actions">
      <button class="icon-btn" id="refresh-btn" title="Refresh">⟳</button>
    </div>
  </div>
  <div class="search-box">
    <input type="text" id="search" placeholder="Search contexts…" />
  </div>
  <div class="ctx-list" id="ctx-list">
    <div class="status-msg">Loading…</div>
  </div>
  <button class="open-dashboard" id="open-dashboard">Open Dashboard ↗</button>

  <script>
    const vscode = acquireVsCodeApi();
    const listEl = document.getElementById('ctx-list');
    const searchInput = document.getElementById('search');

    // Initial load
    vscode.postMessage({ command: 'fetchContexts', query: '' });

    // Search
    let debounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        vscode.postMessage({ command: 'fetchContexts', query: searchInput.value.trim() });
      }, 300);
    });

    // Refresh button
    document.getElementById('refresh-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'fetchContexts', query: searchInput.value.trim() });
    });

    // Open dashboard
    document.getElementById('open-dashboard').addEventListener('click', () => {
      vscode.postMessage({ command: 'openDashboard' });
    });

    // Handle messages from extension
    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.command === 'contextsLoaded') {
        renderContexts(msg.contexts);
      } else if (msg.command === 'error') {
        listEl.innerHTML = '<div class="status-msg error">' + escapeHtml(msg.message) + '</div>';
      } else if (msg.command === 'refresh') {
        vscode.postMessage({ command: 'fetchContexts', query: searchInput.value.trim() });
      } else if (msg.command === 'insertSuccess') {
        // Briefly flash the list green
        setTimeout(() => {
          vscode.postMessage({ command: 'fetchContexts', query: searchInput.value.trim() });
        }, 500);
      }
    });

    function renderContexts(contexts) {
      if (!contexts || contexts.length === 0) {
        listEl.innerHTML = '<div class="status-msg">No contexts found</div>';
        return;
      }

      listEl.innerHTML = contexts.map(ctx => {
        const date = new Date(ctx.created_at).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric'
        });
        const tags = (ctx.tags || []).map(t =>
          '<span class="ctx-tag">' + escapeHtml(t) + '</span>'
        ).join('');

        return '<div class="ctx-item" data-id="' + ctx.id + '">'
          + '<div class="ctx-title">' + escapeHtml(ctx.title) + '</div>'
          + '<div class="ctx-meta"><span class="ctx-date">' + date + '</span>' + tags + '</div>'
          + '</div>';
      }).join('');

      // Click handlers
      listEl.querySelectorAll('.ctx-item').forEach(item => {
        item.addEventListener('click', () => {
          const id = item.getAttribute('data-id');
          item.classList.add('loading');
          item.innerHTML = '⏳ Inserting…';
          vscode.postMessage({ command: 'insertPrompt', contextId: id });
        });
      });
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
  }
}

module.exports = { activate, deactivate };
