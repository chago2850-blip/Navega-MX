/*
 * Navega-MX — motor de respuestas: busca en la web, lee las fuentes y
 * sintetiza una respuesta con citas numeradas.
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { host } from './host.js';
import { chat, systemBase } from './ai.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

function decodeDDG(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const real = u.searchParams.get('uddg');
    return real ? decodeURIComponent(real) : u.href;
  } catch (e) { return href; }
}

export async function webSearch(query, s, n) {
  n = n || 6;
  if (s.searchEngine === 'searxng' && s.searxUrl) {
    const url = s.searxUrl.replace(/\/+$/, '') + '/search?format=json&q=' + encodeURIComponent(query);
    const r = await host.fetch(url, { method: 'GET', headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const j = JSON.parse(r.text);
    return (j.results || []).slice(0, n).map((x) => ({ title: x.title, url: x.url, snippet: x.content || '' }));
  }
  const r = await host.fetch('https://html.duckduckgo.com/html/?kl=mx-es&q=' + encodeURIComponent(query), {
    method: 'GET', headers: { 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.6' },
  });
  const doc = new DOMParser().parseFromString(r.text, 'text/html');
  const out = [];
  doc.querySelectorAll('.result').forEach((el) => {
    if (out.length >= n) return;
    if (el.classList.contains('result--ad')) return;
    const a = el.querySelector('a.result__a');
    if (!a) return;
    const url = decodeDDG(a.getAttribute('href'));
    if (!/^https?:/.test(url) || /duckduckgo\.com\/y\.js/.test(url)) return;
    const sn = el.querySelector('.result__snippet');
    out.push({ title: a.textContent.trim(), url, snippet: sn ? sn.textContent.trim() : '' });
  });
  return out;
}

export function pageText(html, maxLen) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,svg,nav,footer,header,aside,form,iframe').forEach((n) => n.remove());
  const root = doc.querySelector('article') || doc.querySelector('main') || doc.body;
  let t = (root ? root.textContent : '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  maxLen = maxLen || 3000;
  return t.length > maxLen ? t.slice(0, maxLen) + '…' : t;
}

async function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('tiempo agotado')), ms); })])
    .finally(() => clearTimeout(t));
}

/**
 * @param {object} o {query, settings, memory, onStatus, onSources, onToken, extraContext}
 */
export function answer(o) {
  const s = o.settings;
  let inner = null;
  let aborted = false;
  const done = (async () => {
    o.onStatus && o.onStatus('Buscando en la web…');
    let results = [];
    try {
      results = await webSearch(o.query, s, Math.max(3, Number(s.answerSources) || 5) + 2);
    } catch (e) {
      o.onStatus && o.onStatus('No pude buscar en la web (' + e.message + '). Responderé con lo que sé.');
    }
    if (aborted) return { text: '', sources: [] };
    results = results.slice(0, Math.max(3, Number(s.answerSources) || 5));
    o.onSources && o.onSources(results);
    o.onStatus && o.onStatus('Leyendo ' + results.length + ' fuentes…');
    const texts = await Promise.all(results.map(async (r) => {
      try {
        const res = await withTimeout(host.fetch(r.url, { method: 'GET', headers: { 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9' } }), 9000);
        return pageText(res.text, 2800);
      } catch (e) { return ''; }
    }));
    if (aborted) return { text: '', sources: results };
    const ctx = results.map((r, i) =>
      '[' + (i + 1) + '] ' + r.title + '\nURL: ' + r.url + '\nExtracto: ' + r.snippet + '\nContenido: ' + (texts[i] || '(no disponible)')
    ).join('\n\n');

    const messages = [
      { role: 'system', content: systemBase(s, o.memory) +
        '\n\nEres un motor de respuestas. Responde la pregunta usando las fuentes numeradas. ' +
        'Cita cada afirmación con el número de la fuente entre corchetes, por ejemplo [1] o [2][3]. ' +
        'Empieza con una respuesta directa de 1-2 oraciones y luego desarrolla con encabezados o viñetas si conviene. ' +
        'Si las fuentes no bastan, dilo. Al final escribe una línea que empiece con "RELACIONADAS:" seguida de 3 preguntas de seguimiento separadas por " | ".' },
      { role: 'user', content: (o.extraContext ? 'Contexto adicional:\n' + o.extraContext + '\n\n' : '') +
        'Fuentes:\n' + (ctx || '(sin resultados)') + '\n\nPregunta: ' + o.query },
    ];
    o.onStatus && o.onStatus('Redactando la respuesta…');
    inner = chat({ settings: s, messages, onToken: o.onToken, onStatus: o.onStatus });
    const text = await inner.done;
    return { text, sources: results };
  })();
  return { done, abort() { aborted = true; inner && inner.abort(); } };
}

export function splitRelated(text) {
  const m = String(text || '').match(/\n?\s*\**RELACIONADAS:?\**\s*(.*)$/is);
  if (!m) return { body: text, related: [] };
  const related = m[1].split(/\s*\|\s*|\n+/).map((x) => x.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean).slice(0, 4);
  return { body: text.slice(0, m.index).trim(), related };
}
