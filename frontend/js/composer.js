// ContextVolt — Chat input + summarize pipeline.
import { $, API } from './core.js';
import { showToast } from './dialogs.js';
import { navigateTo } from './nav.js';
import { _kickGlobalPoll } from './polling.js';
// â”€â”€â”€ Chat Input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initChatInput() {
    const textarea = $('#chat-textarea');
    const summarizeBtn = $('#summarize-btn');
    if (!textarea || !summarizeBtn) return;

    const refresh = () => {
        _updateCaptureStats();
        summarizeBtn.disabled = textarea.value.trim().length < 20;
        const drop = document.getElementById('cap-drophint');
        if (drop) drop.hidden = textarea.value.length > 0;
        _autoDetectSource(textarea.value);
    };

    textarea.addEventListener('input', refresh);

    // Paste from clipboard (toolbar button + empty-state CTA)
    const doPaste = async () => {
        try {
            const txt = await navigator.clipboard.readText();
            if (txt) { textarea.value = txt; refresh(); }
            textarea.focus();
        } catch {
            showToast('Clipboard blocked — paste with Ctrl+V instead', 'error');
            textarea.focus();
        }
    };
    document.getElementById('cap-paste-btn')?.addEventListener('click', doPaste);
    document.getElementById('cap-paste-cta')?.addEventListener('click', doPaste);

    // Clear
    document.getElementById('cap-clear-btn')?.addEventListener('click', () => {
        textarea.value = ''; refresh(); textarea.focus();
    });

    // Drag & drop a .txt / .md / .json export
    const zone = document.getElementById('cap-dropzone');
    if (zone) {
        ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, (e) => {
            e.preventDefault(); zone.classList.add('dragover');
        }));
        zone.addEventListener('dragleave', (e) => { if (e.target === zone) zone.classList.remove('dragover'); });
        zone.addEventListener('drop', async (e) => {
            e.preventDefault(); zone.classList.remove('dragover');
            const file = e.dataTransfer?.files?.[0];
            if (!file) return;
            try { textarea.value = await file.text(); refresh(); }
            catch { showToast('Could not read that file', 'error'); }
        });
    }

    // Source select — once the user picks, stop auto-detect from overriding it
    // Custom dropdowns (source + collection) — replace native <select>s.
    _initCapDropdown('cap-source-dd', (val) => {
        const v = document.getElementById('cap-source');
        if (v) v.dataset.manual = val ? '1' : '';
    });
    _initCapDropdown('cap-collection-dd');

    _initTagInput();
    _loadCollections();

    summarizeBtn.addEventListener('click', () => summarizeAndSave());
    refresh();
}

// Lightweight custom dropdown: button toggles a themed menu; selecting sets the
// hidden <input> value + label and fires onChange. Click-outside / Esc dismiss.
function _initCapDropdown(rootId, onChange) {
    const root = document.getElementById(rootId);
    if (!root || root._cvBound) return;
    root._cvBound = true;
    const btn = root.querySelector('.cv-cap3-dd-btn');
    const menu = root.querySelector('.cv-cap3-dd-menu');
    const label = root.querySelector('.cv-cap3-dd-label');
    const valueEl = root.querySelector('input[type="hidden"]');
    if (!btn || !menu || !valueEl) return;

    const onOutside = (e) => { if (!root.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { close(); btn.focus(); } };
    function close() {
        if (menu.hidden) return;
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
    }
    function open() {
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        document.addEventListener('mousedown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
    }
    btn.addEventListener('click', () => (menu.hidden ? open() : close()));
    menu.addEventListener('click', (e) => {
        const opt = e.target.closest('.cv-cap3-dd-opt');
        if (!opt) return;
        const val = opt.dataset.val || '';
        valueEl.value = val;
        if (label) {
            label.textContent = opt.textContent.trim();
            label.classList.toggle('cv-cap3-dd-label-muted', val === '');
        }
        menu.querySelectorAll('.cv-cap3-dd-opt').forEach(o => o.setAttribute('aria-selected', String(o === opt)));
        close();
        onChange?.(val);
    });
}

// ─── Capture studio: live helpers ────────────────────────────────
function _updateCaptureStats() {
    const ta = document.getElementById('chat-textarea');
    if (!ta) return;
    const len = ta.value.length;
    const tokens = Math.round(len / 4);
    const chunks = len ? Math.max(1, Math.round(len / 2200)) : 0;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('cap-chars', len.toLocaleString());
    set('cap-tokens', tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens));
    set('cap-chunks', String(chunks));
    const hint = document.getElementById('cap-chunk-hint');
    if (hint) hint.textContent = chunks ? `· ~${chunks}` : '';
    const cc = document.getElementById('char-count');
    if (cc) cc.textContent = len ? `${len.toLocaleString()} characters ready` : 'Nothing saved until you summarize';

    // v3 surface: live meter fill, morphing status, "filled" state (green dot + glow)
    const fill = document.getElementById('cap-meter-fill');
    if (fill) fill.style.width = `${Math.min(100, Math.round(tokens / 16000 * 100))}%`;
    const surf = document.getElementById('cap-dropzone');
    if (surf) surf.classList.toggle('cv-cap3-filled', len > 0);
    const status = document.getElementById('cap-status-text');
    if (status) {
        if (!len) status.textContent = 'Empty — paste to begin';
        else {
            const s = _detectSource(ta.value);
            status.innerHTML = s ? `<b>${s}</b> conversation · ready` : 'Conversation · ready';
        }
    }
}

function _detectSource(text) {
    const t = (text || '').slice(0, 4000).toLowerCase();
    if (/chatgpt|chat\.openai\.com|openai|gpt-4|gpt-5|you said:|chatgpt said:/.test(t)) return 'ChatGPT';
    if (/claude|claude\.ai|anthropic/.test(t)) return 'Claude';
    if (/gemini|gemini\.google|\bbard\b/.test(t)) return 'Gemini';
    if (/\bgrok\b|x\.ai/.test(t)) return 'Grok';
    if (/deepseek/.test(t)) return 'DeepSeek';
    return '';
}

function _autoDetectSource(text) {
    const valueEl = document.getElementById('cap-source');
    if (!valueEl) return;
    const detected = _detectSource(text);
    if (valueEl.dataset.manual) return; // user picked — don't override
    valueEl.value = detected || '';
    const label = document.getElementById('cap-source-label');
    if (label) {
        label.textContent = detected || 'Auto-detect';
        label.classList.toggle('cv-cap3-dd-label-muted', !detected);
    }
    document.getElementById('cap-source-menu')
        ?.querySelectorAll('.cv-cap3-dd-opt')
        .forEach(o => o.setAttribute('aria-selected', String((o.dataset.val || '') === (detected || ''))));
}

function _initTagInput() {
    const input = document.getElementById('cap-tag-input');
    const wrap = document.getElementById('cap-tags');
    if (!input || !wrap) return;
    const addTag = (raw) => {
        const val = (raw || '').replace(/,+$/, '').trim();
        if (!val) return;
        if (_collectTags().some(t => t.toLowerCase() === val.toLowerCase())) { input.value = ''; return; }
        const chip = document.createElement('span');
        chip.className = 'cv-cap2-tag';
        const label = document.createTextNode(val + ' ');
        const x = document.createElement('button');
        x.type = 'button'; x.setAttribute('aria-label', 'Remove tag'); x.textContent = '×';
        x.addEventListener('click', () => chip.remove());
        chip.append(label, x);
        wrap.insertBefore(chip, input);
        input.value = '';
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(input.value); }
        else if (e.key === 'Backspace' && !input.value) {
            const chips = wrap.querySelectorAll('.cv-cap2-tag');
            if (chips.length) chips[chips.length - 1].remove();
        }
    });
    input.addEventListener('blur', () => addTag(input.value));
}

function _collectTags() {
    return [...document.querySelectorAll('#cap-tags .cv-cap2-tag')]
        .map(c => (c.firstChild?.textContent || '').trim())
        .filter(Boolean);
}

async function _loadCollections() {
    const menu = document.getElementById('cap-collection-menu');
    if (!menu || menu.dataset.loaded) return;
    try {
        const res = await fetch(`${API}/api/collections`);
        if (!res.ok) return;
        const data = await res.json();
        const cols = Array.isArray(data) ? data : (data.collections || []);
        for (const c of cols) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'cv-cap3-dd-opt'; b.setAttribute('role', 'option');
            b.setAttribute('aria-selected', 'false'); b.dataset.val = String(c.id);
            b.textContent = c.name || `Collection ${c.id}`;
            menu.appendChild(b);
        }
        menu.dataset.loaded = '1';
    } catch { /* offline / no collections — leave "No collection" */ }
}

function _resetCaptureForm() {
    const ta = document.getElementById('chat-textarea'); if (ta) ta.value = '';
    const title = document.getElementById('cap-title'); if (title) title.value = '';
    document.querySelectorAll('#cap-tags .cv-cap2-tag').forEach(c => c.remove());
    // Reset source dropdown
    const src = document.getElementById('cap-source'); if (src) { src.value = ''; src.dataset.manual = ''; }
    const srcLbl = document.getElementById('cap-source-label');
    if (srcLbl) { srcLbl.textContent = 'Auto-detect'; srcLbl.classList.add('cv-cap3-dd-label-muted'); }
    document.getElementById('cap-source-menu')?.querySelectorAll('.cv-cap3-dd-opt')
        .forEach(o => o.setAttribute('aria-selected', String((o.dataset.val || '') === '')));
    // Reset collection dropdown
    const col = document.getElementById('cap-collection'); if (col) col.value = '';
    const colLbl = document.getElementById('cap-collection-label');
    if (colLbl) { colLbl.textContent = 'No collection'; colLbl.classList.add('cv-cap3-dd-label-muted'); }
    document.getElementById('cap-collection-menu')?.querySelectorAll('.cv-cap3-dd-opt')
        .forEach(o => o.setAttribute('aria-selected', String((o.dataset.val || '') === '')));
    const drop = document.getElementById('cap-drophint'); if (drop) drop.hidden = false;
    _updateCaptureStats();
    const btn = document.getElementById('summarize-btn'); if (btn) btn.disabled = true;
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

// In-app Quick Capture now mirrors the browser extension: the conversation is
// saved as a "summarizing" context and the LLM work happens in a background
// worker. The new card shows up in the Library with a "Summarizing" badge that
// clears when it's done — no blocking dashboard pipeline.
async function summarizeAndSave() {
    if (_summarizing) return;
    const textarea = $('#chat-textarea');
    const btn = $('#summarize-btn');
    const text = textarea.value.trim();
    if (text.length < 20) return;

    _summarizing = true;
    _setSubmitState(btn, 'busy');

    const source = (document.getElementById('cap-source')?.value || _detectSource(text) || 'Manual').trim();
    const title = (document.getElementById('cap-title')?.value || '').trim();
    const tags = _collectTags();
    const colRaw = document.getElementById('cap-collection')?.value;
    const collection_id = colRaw ? Number(colRaw) : null;

    try {
        const res = await fetch(`${API}/api/capture`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, source, method: 'Quick Capture', title: title || null, tags, collection_id }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Capture failed');
        }
        await res.json();

        _setSubmitState(btn, 'done');
        _resetCaptureForm();
        showToast('Saved — summarizing in the background', 'success');
        try { _kickGlobalPoll(); } catch {}

        // Land in the Library so the new "Summarizing" card is visible (like an extension capture).
        setTimeout(() => { navigateTo('library'); _setSubmitState(btn, 'idle'); }, 650);
    } catch (err) {
        console.error('[ConVX] capture failed', err);
        showToast(`Capture failed: ${err.message}`, 'error');
        _setSubmitState(btn, 'idle');
    } finally {
        _summarizing = false;
    }
}

// Submit button states: idle · busy (spinner) · done (✓ Saved)
function _setSubmitState(btn, state) {
    if (!btn) return;
    const txt = btn.querySelector('.btn-text');
    const loader = btn.querySelector('.btn-loader');
    btn.classList.remove('is-busy', 'is-done');
    if (state === 'busy') {
        btn.classList.add('is-busy');
        btn.disabled = true;
        if (txt) txt.style.display = 'none';
        if (loader) loader.style.display = 'inline-flex';
    } else if (state === 'done') {
        btn.classList.add('is-done');
        btn.disabled = true;
        if (loader) loader.style.display = 'none';
        if (txt) { txt.style.display = 'inline-flex'; txt.textContent = '✓ Saved'; }
    } else {
        btn.disabled = (document.getElementById('chat-textarea')?.value.trim().length || 0) < 20;
        if (loader) loader.style.display = 'none';
        if (txt) { txt.style.display = 'inline-flex'; txt.textContent = 'Summarize & Save'; }
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
