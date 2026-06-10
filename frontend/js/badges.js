// ContextVolt — Source/AI-brand badge constants and helpers.
import { escapeHtml } from './core.js';

// â”€â”€â”€ P2-2: Source badge constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _KNOWN_SOURCES = ['ChatGPT', 'Claude', 'Gemini', 'Grok', 'DeepSeek', 'Perplexity', 'Copilot'];

// Brand colors per AI model — used on library cards so users can recognize source at a glance.
const _AI_BRAND = {
    'ChatGPT':    { label: 'ChatGPT',    color: '#10a37f', bg: 'rgba(16,163,127,0.14)',  border: 'rgba(16,163,127,0.38)' },
    'Claude':     { label: 'Claude',     color: '#d97757', bg: 'rgba(217,119,87,0.14)',  border: 'rgba(217,119,87,0.38)' },
    'Gemini':     { label: 'Gemini',     color: '#4285f4', bg: 'rgba(66,133,244,0.14)',  border: 'rgba(66,133,244,0.38)' },
    'Grok':       { label: 'Grok',       color: '#e5e5e7', bg: 'rgba(229,229,231,0.10)', border: 'rgba(229,229,231,0.32)' },
    'DeepSeek':   { label: 'DeepSeek',   color: '#4d6bfe', bg: 'rgba(77,107,254,0.14)',  border: 'rgba(77,107,254,0.38)' },
    'Perplexity': { label: 'Perplexity', color: '#20c5c5', bg: 'rgba(32,197,197,0.14)',  border: 'rgba(32,197,197,0.38)' },
    'Copilot':    { label: 'Copilot',    color: '#5ea0ef', bg: 'rgba(94,160,239,0.14)',  border: 'rgba(94,160,239,0.38)' },
};

// Capture-method tags that should appear as the card's source chip (bottom) — not as a tag chip.
const _CAPTURE_TAGS = new Set([
    'extension', 'Extension', 'EXTENSION',
    'paste', 'Paste', 'PASTE',
    'import', 'Import', 'IMPORT',
    'api', 'API',
    'upload', 'Upload',
]);

function _getAIBrand(tags) {
    if (!tags || !tags.length) return null;
    const hit = tags.find(t => _AI_BRAND[t]);
    return hit ? { key: hit, ..._AI_BRAND[hit] } : null;
}

function _getCaptureTag(tags) {
    if (!tags || !tags.length) return '';
    const hit = tags.find(t => _CAPTURE_TAGS.has(t));
    return hit || '';
}

function _getSourceBadge(tags) {
    if (!tags || !tags.length) return '';
    const source = tags.find(t => _KNOWN_SOURCES.includes(t));
    if (!source) return '';
    const cls = 'source-' + source.toLowerCase();
    return `<span class="source-badge ${cls}">${escapeHtml(source)}</span>`;
}


export { _AI_BRAND, _CAPTURE_TAGS, _KNOWN_SOURCES, _getAIBrand, _getCaptureTag };
