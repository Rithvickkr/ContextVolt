# ContextVolt — Vanilla JS → React Migration Map

Reference for porting `frontend/js/app.js` (7.5K LOC) to React. All endpoints verified against the running backend.

## API ENDPOINTS

### Setup & Configuration
- **GET** `/api/setup/status` → `{ollama_running, model_ready, model_name}`
- **GET** `/api/setup/config` → `{user_name, user_about, model, embed_model, available_models[], available_embed_models[], cloud_providers[], gpu, recommendation, is_cloud_active, active_provider, active_model}`
- **POST** `/api/setup/pull-model-stream` — NDJSON stream: `{status, completed, total, error}`
- **POST** `/api/setup/select-model` — `{model}`
- **POST** `/api/setup/select-embed-model` — `{model}`
- **POST** `/api/setup/select-provider` — `{provider, model}`
- **POST** `/api/setup/save-profile` — `{name, about}`
- **POST** `/api/setup/validate-key` — `{provider, api_key}` → `{valid, error}`
- **DELETE** `/api/setup/cloud-key/{provider}`
- **DELETE** `/api/setup/delete-model/{modelId}`

### Dashboard
- **GET** `/api/dashboard` → `{stats: {contexts, collections, questions_asked, contexts_this_week}, recent: [context]}`

### Contexts
- **GET** `/api/contexts?page&per_page&sort(newest|oldest|alpha)&q&collection_id` → `{contexts[], has_more, total, search_mode(semantic|keyword)}`
- **GET** `/api/contexts/{id}` → full context
- **POST** `/api/contexts` — `{title, summary, tags[], original_chat}`
- **PUT** `/api/contexts/{id}` — `{title, tags[], summary, important_notes[]}`
- **DELETE** `/api/contexts/{id}`
- **POST** `/api/contexts/{id}/star`
- **POST** `/api/contexts/{id}/collection` — `{collection_id}` (null = remove)
- **POST** `/api/contexts/{id}/resummarize`
- **GET** `/api/contexts/{id}/chunks?query=` → `{chunks[], total}`
- **POST** `/api/contexts/{id}/prompt` — `{query?, size(compact|standard|full)}` → `{prompt}`
- **GET** `/api/contexts/{id}/export/download` — binary markdown
- **POST** `/api/contexts/bulk-delete` — `{ids[]}`
- **POST** `/api/contexts/chunk-all?force=` — NDJSON: `{done, total, updated, skipped, status}`
- **GET** `/api/contexts/summarizing` → `{contexts: [{id, status}]}`

### Summarize
- **POST** `/api/summarize/stream` — `{text}` — NDJSON: `{step, done, total, token, result: {main_topic, key_ideas[], conclusions[], unresolved_questions[], vitals[]}, error}`

### Search
- **POST** `/api/retrieve/search` — `{query}` → `{results: [{context_id, title, created_at, tags[], best_score, chunks: [{text, score, has_code, is_starred}]}], total_chunks, search_mode, low_confidence}`

### Collections
- **GET** `/api/collections` → `[{id, name, color, count}]`
- **POST** `/api/collections` — `{name, color}`
- **PUT** `/api/collections/{id}` — `{name}`
- **DELETE** `/api/collections/{id}`

### Ask Vault (RAG)
- **POST** `/api/vault/ask` — `{question, history: [{role, content}], session_id|null, collection_id|null}` — NDJSON: `{token}` … `{done: true, session_id, sources: [{n, context_id, title, score, snippet, source, neighbor}]}` or `{error}`
- **GET** `/api/vault/sessions` → `{sessions: [{id, title, pinned, message_count, updated_at}]}`
- **GET** `/api/vault/sessions/{id}` → `{id, title, messages: [{role, content, citations[]}]}`
- **PATCH** `/api/vault/sessions/{id}` — `{pinned?, title?}`
- **DELETE** `/api/vault/sessions/{id}`

### System
- **GET** `/api/health` → `{started_at}`
- **POST** `/api/restart`
- **GET** `/api/system/status` → `{backend: {uptime_s}, ollama: {running, url}, model: {name, ready}, embed: {name}, database: {contexts, chunks, collections, size_mb}, installed_models[]}`
- **GET** `/api/debug/logs?lines=100` → `{exists, lines[]}`
- **GET** `/api/backup/download` — binary DB

### MCP Server
- **GET** `/api/mcp_server/info` → `{http: {url, token, auth_required}, stdio: {config_snippet}}`
- **POST** `/api/mcp_server/regenerate_token` → `{token}`
- **POST** `/api/mcp_server/auth_required` — `{required}`
- **GET** `/api/mcp_server/tunnel` → `{status, mcp_url, error}`
- **POST** `/api/mcp_server/tunnel/start` / `/stop`

### Update
- **GET** `/api/update/check` → `{update_available, current_version, latest_version, release_notes, html_url, download_url, error}`

## CONTEXT OBJECT SHAPE
```js
{
  id, title, original_chat,
  summary: {main_topic, key_ideas[], conclusions[], unresolved_questions[], vitals[], snapshot},
  tags: [], created_at, collection_id, starred,
  status: 'done'|'summarizing'|'failed',
  important_notes: []
}
```

## NDJSON PARSING PATTERN
```js
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
while (true) {
  const {value, done} = await reader.read();
  if (done) break;
  buf += decoder.decode(value, {stream: true});
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const data = JSON.parse(line);
  }
}
```

## LOCALSTORAGE KEYS
- `cv-theme`: 'light'|'dark' (default dark)
- `cv-vibe`: 'volt'|'space'|'noir' (default volt)
- `cv-sort-order`: 'newest'|'oldest'|'alpha'
- `cv-lib-view`: 'grid'|'rows'
- `cv-sidebar-collapsed`: '0'|'1'

## THEME SYSTEM
- `data-theme` + `data-vibe` attributes on `<html>`
- Collection colors: `#6366f1 Indigo, #ec4899 Pink, #f59e0b Amber, #10b981 Emerald, #3b82f6 Blue, #8b5cf6 Violet, #ef4444 Red, #06b6d4 Cyan`
- AI brand colors: ChatGPT `#10a37f`, Claude `#d97757`, Gemini `#4285f4`, Grok `#a8a8a8`, DeepSeek `#4d6bfe`, Perplexity `#20b8cd`, Copilot `#d83b01`
- Known sources: ChatGPT, Claude, Gemini, Grok, DeepSeek, Perplexity, Copilot

## KEYBOARD SHORTCUTS
- `?` shortcuts modal · `/` focus search (library) or ask input (ask view) · `N` dashboard · `L` library · `Ctrl+K` focus search · `Ctrl+Enter` summarize & save · `Esc` close modal · `Backspace` detail → library

## PYWEBVIEW BRIDGE (guarded — works in browser without it)
`window.pywebview.api.cv_minimize() / cv_close() / cv_toggle_maximize() → Promise<bool> / cv_start_resize(edge)`

## CITATIONS
Ask responses contain `[1]`, `[2]` linking to `sources[].n` → render as clickable sup that opens context detail.
