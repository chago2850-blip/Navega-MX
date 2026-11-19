/*
 * Navega-MX — renderizador Markdown pequeño y seguro (escapa todo el HTML).
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeUrl(u) {
  u = String(u || '').trim();
  return /^(https?:|mailto:)/i.test(u) ? u : '#';
}

function inline(text, sources) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) =>
    '<a href="' + esc(safeUrl(u.replace(/&amp;/g, '&'))) + '" data-ext="1">' + t + '</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) =>
    p + '<a href="' + u + '" data-ext="1">' + (u.length > 50 ? u.slice(0, 47) + '…' : u) + '</a>');
  if (sources && sources.length) {
    s = s.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, (m, nums) =>
      nums.split(',').map((n) => {
        const i = parseInt(n, 10);
        const src = sources[i - 1];
        if (!src) return '';
        return '<a class="cite" href="' + esc(safeUrl(src.url)) + '" data-ext="1" title="' + esc(src.title) + '">' + i + '</a>';
      }).join(''));
  }
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[+i] + '</code>');
  return s;
}

export function renderMarkdown(md, sources) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```\s*([\w-]*)/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre><button class="copy-code" title="Copiar código">Copiar</button><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { out.push('<h' + (h[1].length + 1) + '>' + inline(h[2], sources) + '</h' + (h[1].length + 1) + '>'); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push('<div class="table-wrap"><table><thead><tr>' + head.map((c) => '<th>' + inline(c, sources) + '</th>').join('') +
        '</tr></thead><tbody>' + body.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c, sources) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>');
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push('<' + tag + '>' + items.map((t) => '<li>' + inline(t, sources) + '</li>').join('') + '</' + tag + '>');
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push('<blockquote>' + inline(buf.join(' '), sources) + '</blockquote>');
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s+|\s*\|)/.test(lines[i])) buf.push(lines[i++]);
    out.push('<p>' + inline(buf.join('\n'), sources).replace(/\n/g, '<br>') + '</p>');
  }
  return out.join('');
}

export { esc };
