import { useMemo } from 'react';

/**
 * Minimal markdown renderer matching the legacy _askSimpleMarkdown:
 * code blocks, inline code, bold, italic, lists, tables, paragraphs.
 * Citations like [1] become clickable sups when `sources` is provided
 * (sources: [{n, context_id, title}]) — onCite(context_id) is called.
 */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text, sources) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  if (sources?.length) {
    html = html.replace(/\[(\d+)\]/g, (m, n) => {
      const src = sources.find((s) => String(s.n) === n);
      if (!src) return m;
      return `<sup class="md-cite"><a data-ctx="${src.context_id}" title="${escapeHtml(src.title || '')}">${n}</a></sup>`;
    });
  }
  return html;
}

function markdownToHtml(text, sources) {
  const blocks = [];
  // Pull out fenced code blocks first so their content is untouched.
  const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);
  for (let i = 0; i < parts.length; i += 3) {
    blocks.push({ type: 'text', content: parts[i] });
    if (i + 2 < parts.length) {
      blocks.push({ type: 'code', lang: parts[i + 1], content: parts[i + 2] });
    }
  }

  return blocks.map((block) => {
    if (block.type === 'code') {
      return `<pre class="md-code"><code>${escapeHtml(block.content)}</code></pre>`;
    }
    const lines = block.content.split('\n');
    const out = [];
    let list = null; // 'ul' | 'ol'
    let para = [];

    const flushPara = () => {
      if (para.length) {
        out.push(`<p>${renderInline(para.join('<br>'), sources)}</p>`);
        para = [];
      }
    };
    const flushList = () => {
      if (list) { out.push(`</${list}>`); list = null; }
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      const ul = line.match(/^\s*[-*]\s+(.*)/);
      const ol = line.match(/^\s*\d+\.\s+(.*)/);
      if (ul || ol) {
        flushPara();
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { flushList(); out.push(`<${want}>`); list = want; }
        out.push(`<li>${renderInline((ul || ol)[1], sources)}</li>`);
      } else if (!line.trim()) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
    return out.join('');
  }).join('');
}

export default function MarkdownLite({ text, sources, onCite, className }) {
  const html = useMemo(() => markdownToHtml(text || '', sources), [text, sources]);

  const handleClick = (e) => {
    const a = e.target.closest('a[data-ctx]');
    if (a && onCite) {
      e.preventDefault();
      onCite(Number(a.dataset.ctx));
    }
  };

  return (
    <div
      className={`md-lite ${className || ''}`}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
