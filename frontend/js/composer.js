// ContextVolt — Chat input + summarize pipeline.
import { $, API } from './core.js';
import { showDetail } from './detail.js';
import { showToast } from './dialogs.js';
// â”€â”€â”€ Chat Input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initChatInput() {
    const textarea = $('#chat-textarea');
    const charCount = $('#char-count');
    const summarizeBtn = $('#summarize-btn');

    textarea.addEventListener('input', () => {
        const len = textarea.value.length;
        const tokens = Math.round(len / 4);
        const tokenStr = tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${tokens}`;
        charCount.textContent = `${len.toLocaleString()} chars · ${tokenStr} tokens`;
        summarizeBtn.disabled = len < 20;
    });

    summarizeBtn.addEventListener('click', () => summarizeAndSave());
}

// ─── Pipeline UI helpers ─────────────────────────────────────────
function _pipelineShow(title) {
    const pipe = document.getElementById('cv-pipeline');
    if (!pipe) return;
    const titleEl = document.getElementById('cv-pipe-title');
    if (titleEl) titleEl.textContent = title || 'Processing conversation…';
    pipe.style.display = '';
    [1,2,3,4].forEach(n => {
        const step = document.getElementById(`cv-step-${n}`);
        if (step) step.classList.remove('done', 'active');
        const bar = document.getElementById(`cv-step-${n}-bar`);
        if (bar) bar.style.width = '0%';
    });
    const streamEl = document.getElementById('cv-stream-text');
    if (streamEl) streamEl.innerHTML = '';
    setTimeout(() => pipe.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
    pipe.addEventListener('pointermove', _pipelineSheen);
}
function _pipelineSheen(e) {
    const pipe = e.currentTarget;
    const r = pipe.getBoundingClientRect();
    pipe.style.setProperty('--px', ((e.clientX - r.left) / r.width * 100) + '%');
}
function _pipelineHide() {
    const pipe = document.getElementById('cv-pipeline');
    if (pipe) { pipe.style.display = 'none'; pipe.removeEventListener('pointermove', _pipelineSheen); }
}
function _pipelineSetStep(n, stepState, nameOverride) {
    const step = document.getElementById(`cv-step-${n}`);
    if (!step) return;
    step.classList.remove('done', 'active');
    if (stepState) step.classList.add(stepState);
    const bar = document.getElementById(`cv-step-${n}-bar`);
    if (bar) bar.style.width = stepState === 'done' ? '100%' : stepState === 'active' ? '60%' : '0%';
    if (nameOverride) { const nm = step.querySelector('.name'); if (nm) nm.textContent = nameOverride; }
}
function _pipelineAppendToken(token) {
    const el = document.getElementById('cv-stream-text');
    if (!el) return;
    el.textContent += token;
    const box = el.closest('.cv-stream');
    if (box) box.scrollTop = box.scrollHeight;
}

let _summarizing = false;
async function summarizeAndSave() {
    if (_summarizing) { console.warn('[ConVX] already in flight — bailing'); return; }
    const textarea = $('#chat-textarea');
    const btn = $('#summarize-btn');
    const text = textarea.value.trim();
    if (!text) { console.warn('[ConVX] empty text — bailing'); return; }

    _summarizing = true;
    // Show loading
    btn.querySelector('.btn-text').style.display = 'none';
    btn.querySelector('.btn-loader').style.display = 'inline-flex';
    btn.disabled = true;

    // Show pipeline on dashboard
    const _firstLine = text.split('\n').find(l => l.trim()) || 'Processing conversation…';
    _pipelineShow(_firstLine.slice(0, 80));

    try {
        // Step 1: Summarize via Ollama (streaming progress)
        const _setProgress = (msg, pct = null) => {
            const textEl = document.getElementById('summarize-progress-text');
            const fillEl = document.getElementById('summarize-progress-fill');
            if (textEl) textEl.textContent = ' ' + msg;
            if (fillEl && pct !== null) fillEl.style.width = pct + '%';
        };
        _setProgress('Summarizing…', 5);

        const summaryRes = await fetch(`${API}/api/summarize/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        });

        if (!summaryRes.ok) {
            const err = await summaryRes.json().catch(() => ({}));
            throw new Error(err.detail || 'Summarization failed');
        }

        // Read NDJSON stream for progress
        let summary = null;
        const reader = summaryRes.body.getReader();
        const decoder = new TextDecoder();
        let streamBuf = '';
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            streamBuf += decoder.decode(value, { stream: true });
            const lines = streamBuf.split('\n');
            streamBuf = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const evt = JSON.parse(line);
                    if (evt.error) throw new Error(evt.error);
                    if (evt.step) {
                        const pct = evt.total > 0 ? Math.round((evt.done / evt.total) * 85) : 0;
                        _setProgress(evt.step, pct);
                        _pipelineSetStep(1, 'active', evt.step.slice(0, 40));
                    }
                    if (evt.token) _pipelineAppendToken(evt.token);
                    if (evt.result) summary = evt.result;
                } catch (e) { if (e.message !== line) throw e; }
            }
        }

        if (!summary) throw new Error('Summarization produced no result');
        _pipelineSetStep(1, 'done', 'Summary ready');

        // Create title + tags
        const title = summary.main_topic || 'Untitled Context';
        const tags = generateTags(summary);

        // Save to database
        _pipelineSetStep(2, 'active', 'Storing to vault…');
        _setProgress('Saving…', 90);
        const createRes = await fetch(`${API}/api/contexts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title,
                summary,
                tags,
                original_chat: text,
            }),
        });

        if (!createRes.ok) {
            throw new Error('Failed to save context');
        }

        const created = await createRes.json();
        _pipelineSetStep(2, 'done', 'Saved to vault');
        _pipelineSetStep(3, 'active', 'Splitting chunks…');

        // Chunk and embed
        _setProgress('Embedding…', 97);
        try {
            const chunkRes = await fetch(`${API}/api/contexts/chunk-all?force=false`, { method: 'POST' });
            if (chunkRes.ok) {
                // Consume the NDJSON stream to completion
                const reader = chunkRes.body.getReader();
                const decoder = new TextDecoder();
                let buf = '';
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                }
            }
        } catch {
            showToast('Context saved, but chunking failed — use Rebuild Embeddings later', 'error');
        }

        _pipelineSetStep(3, 'done', 'Chunks ready');
        _pipelineSetStep(4, 'done', 'Vectors indexed');

        // Clear textarea
        textarea.value = '';
        $('#char-count').textContent = '0 characters';
        btn.disabled = true;

        showToast('Context summarized & saved', 'success');

        // Navigate to detail view
        setTimeout(() => showDetail(created.id), 500);

    } catch (err) {
        console.error('[ConVX] summarize failed', err);
        showToast(`Summarization failed: ${err.message}`, 'error');
        _pipelineHide();
    } finally {
        _summarizing = false;
        btn.querySelector('.btn-text').style.display = 'inline-flex';
        btn.querySelector('.btn-loader').style.display = 'none';
        btn.disabled = false;
        // Reset progress bar
        const fillEl = document.getElementById('summarize-progress-fill');
        if (fillEl) fillEl.style.width = '0%';
        // Hide pipeline after a beat
        setTimeout(_pipelineHide, 3000);
    }
}

function generateTags(summary) {
    const tags = new Set();
    const corpus = [
        summary.main_topic || '',
        ...(summary.key_ideas || []),
        ...(summary.conclusions || []),
        ...(summary.vitals || []),
    ].join(' ').toLowerCase();

    // Known tech keywords — still useful for canonical naming
    const knownTags = {
        'python': 'Python', 'javascript': 'JavaScript', 'typescript': 'TypeScript',
        'react': 'React', 'vue': 'Vue', 'angular': 'Angular', 'svelte': 'Svelte',
        'node': 'Node.js', 'express': 'Express', 'fastapi': 'FastAPI', 'django': 'Django', 'flask': 'Flask',
        'rust': 'Rust', 'go ': 'Go', 'golang': 'Go', 'java ': 'Java', 'kotlin': 'Kotlin', 'swift': 'Swift',
        'c++': 'C++', 'c#': 'C#', '.net': '.NET',
        'sql': 'SQL', 'sqlite': 'SQLite', 'postgres': 'PostgreSQL', 'mongodb': 'MongoDB', 'redis': 'Redis',
        'docker': 'Docker', 'kubernetes': 'Kubernetes', 'aws': 'AWS', 'gcp': 'GCP', 'azure': 'Azure',
        'git ': 'Git', 'github': 'GitHub', 'ci/cd': 'CI/CD', 'terraform': 'Terraform',
        'css': 'CSS', 'html': 'HTML', 'tailwind': 'Tailwind', 'sass': 'Sass',
        'machine learning': 'ML', 'deep learning': 'Deep Learning', 'neural': 'ML',
        'llm': 'LLM', 'gpt': 'LLM', 'transformer': 'ML', 'embedding': 'Embeddings',
        'api': 'API', 'rest': 'REST', 'graphql': 'GraphQL', 'websocket': 'WebSocket',
        'testing': 'Testing', 'debug': 'Debugging', 'performance': 'Performance',
        'security': 'Security', 'auth': 'Auth', 'oauth': 'Auth', 'jwt': 'Auth',
        'linux': 'Linux', 'windows': 'Windows', 'bash': 'Shell', 'powershell': 'Shell',
    };
    for (const [keyword, tag] of Object.entries(knownTags)) {
        if (corpus.includes(keyword)) tags.add(tag);
    }

    // Extract key nouns from the topic itself as tags (2+ word chunks)
    const topic = (summary.main_topic || '').trim();
    if (topic && tags.size < 3) {
        // Use capitalized words from the topic that look like proper nouns or tech terms
        const topicWords = topic.split(/\s+/).filter(w => w.length > 2);
        for (const w of topicWords) {
            if (/^[A-Z]/.test(w) && !['The', 'And', 'For', 'With', 'How', 'What', 'Why', 'When', 'Using', 'From', 'Into', 'About'].includes(w)) {
                tags.add(w);
            }
            if (tags.size >= 5) break;
        }
    }

    return [...tags].slice(0, 5);
}


export { initChatInput, summarizeAndSave };
