/**
 * ContextVolt API client.
 * Same-origin fetches — in dev, Vite proxies /api to localhost:8000.
 */

const API = '';

async function request(path, options = {}) {
  const res = await fetch(API + path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    let detail;
    try { detail = (await res.json()).detail; } catch { /* non-JSON error body */ }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res;
}

export const get = (path) => request(path);
export const post = (path, body) => request(path, { method: 'POST', body });
export const put = (path, body) => request(path, { method: 'PUT', body });
export const patch = (path, body) => request(path, { method: 'PATCH', body });
export const del = (path) => request(path, { method: 'DELETE' });

/**
 * Consume an NDJSON streaming endpoint.
 * Calls onEvent(parsedLine) for each complete JSON line.
 * Returns when the stream ends. Pass an AbortSignal to cancel.
 */
export async function streamNDJSON(path, body, onEvent, signal) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail;
    try { detail = (await res.json()).detail; } catch { /* non-JSON error body */ }
    throw new Error(detail || `Stream failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let data;
      try { data = JSON.parse(line); } catch { continue; }
      onEvent(data);
    }
  }
  if (buf.trim()) {
    try { onEvent(JSON.parse(buf)); } catch { /* trailing partial line */ }
  }
}

// ─── Typed endpoint helpers ──────────────────────────────────────────

export const api = {
  // Setup
  setupStatus: () => get('/api/setup/status'),
  setupConfig: () => get('/api/setup/config'),
  selectModel: (model) => post('/api/setup/select-model', { model }),
  selectEmbedModel: (model) => post('/api/setup/select-embed-model', { model }),
  selectProvider: (provider, model) => post('/api/setup/select-provider', { provider, model }),
  saveProfile: (name, about) => post('/api/setup/save-profile', { name, about }),
  validateKey: (provider, api_key) => post('/api/setup/validate-key', { provider, api_key }),
  deleteCloudKey: (provider) => del(`/api/setup/cloud-key/${provider}`),
  deleteModel: (modelId) => del(`/api/setup/delete-model/${encodeURIComponent(modelId)}`),
  pullModelStream: (body, onEvent, signal) => streamNDJSON('/api/setup/pull-model-stream', body, onEvent, signal),

  // Dashboard
  dashboard: () => get('/api/dashboard'),

  // Contexts
  contexts: (params = {}) => {
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ''))
    );
    return get(`/api/contexts?${q}`);
  },
  context: (id) => get(`/api/contexts/${id}`),
  createContext: (body) => post('/api/contexts', body),
  updateContext: (id, body) => put(`/api/contexts/${id}`, body),
  deleteContext: (id) => del(`/api/contexts/${id}`),
  toggleStar: (id) => post(`/api/contexts/${id}/star`),
  setCollection: (id, collection_id) => post(`/api/contexts/${id}/collection`, { collection_id }),
  resummarize: (id) => post(`/api/contexts/${id}/resummarize`),
  chunks: (id, query) => get(`/api/contexts/${id}/chunks${query ? `?query=${encodeURIComponent(query)}` : ''}`),
  generatePrompt: (id, size, query) => post(`/api/contexts/${id}/prompt`, { size, query }),
  bulkDelete: (ids) => post('/api/contexts/bulk-delete', { ids }),
  summarizingContexts: () => get('/api/contexts/summarizing'),
  chunkAll: (force, onEvent, signal) =>
    streamNDJSON(`/api/contexts/chunk-all?force=${force ? 'true' : 'false'}`, {}, onEvent, signal),

  // Summarize
  summarizeStream: (text, onEvent, signal) => streamNDJSON('/api/summarize/stream', { text }, onEvent, signal),

  // Search
  search: (query) => post('/api/retrieve/search', { query }),

  // Collections
  collections: () => get('/api/collections'),
  createCollection: (name, color) => post('/api/collections', { name, color }),
  renameCollection: (id, name) => put(`/api/collections/${id}`, { name }),
  deleteCollection: (id) => del(`/api/collections/${id}`),

  // Ask Vault
  ask: (body, onEvent, signal) => streamNDJSON('/api/vault/ask', body, onEvent, signal),
  askSessions: () => get('/api/vault/sessions'),
  askSession: (id) => get(`/api/vault/sessions/${id}`),
  updateSession: (id, body) => patch(`/api/vault/sessions/${id}`, body),
  deleteSession: (id) => del(`/api/vault/sessions/${id}`),

  // System
  health: () => get('/api/health'),
  restart: () => post('/api/restart'),
  systemStatus: () => get('/api/system/status'),
  logs: (lines = 100) => get(`/api/debug/logs?lines=${lines}`),

  // MCP
  mcpInfo: () => get('/api/mcp_server/info'),
  mcpRegenToken: () => post('/api/mcp_server/regenerate_token'),
  mcpAuthRequired: (required) => post('/api/mcp_server/auth_required', { required }),
  mcpTunnel: () => get('/api/mcp_server/tunnel'),
  mcpTunnelStart: () => post('/api/mcp_server/tunnel/start'),
  mcpTunnelStop: () => post('/api/mcp_server/tunnel/stop'),

  // Update
  updateCheck: () => get('/api/update/check'),
};

// ─── Constants shared across views ───────────────────────────────────

export const COLLECTION_COLORS = [
  ['#6366f1', 'Indigo'], ['#ec4899', 'Pink'], ['#f59e0b', 'Amber'], ['#10b981', 'Emerald'],
  ['#3b82f6', 'Blue'], ['#8b5cf6', 'Violet'], ['#ef4444', 'Red'], ['#06b6d4', 'Cyan'],
];

export const AI_BRANDS = {
  ChatGPT:    { color: '#10a37f', bg: 'rgba(16,163,127,0.14)' },
  Claude:     { color: '#d97757', bg: 'rgba(217,119,87,0.14)' },
  Gemini:     { color: '#4285f4', bg: 'rgba(66,133,244,0.14)' },
  Grok:       { color: '#a8a8a8', bg: 'rgba(168,168,168,0.14)' },
  DeepSeek:   { color: '#4d6bfe', bg: 'rgba(77,107,254,0.14)' },
  Perplexity: { color: '#20b8cd', bg: 'rgba(32,184,205,0.14)' },
  Copilot:    { color: '#d83b01', bg: 'rgba(216,59,1,0.14)' },
};
