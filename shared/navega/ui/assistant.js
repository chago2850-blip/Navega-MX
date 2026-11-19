/*
 * Navega-MX — Asistente de IA (chat con la página y pestañas, motor de
 * respuestas con fuentes, agente, atajos, memoria, tareas y voz).
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version. See <https://www.gnu.org/licenses/>.
 */
import { host } from '../core/host.js';
import { store, BUILTIN_SHORTCUTS, DEFAULTS } from '../core/store.js';
import { chat, listModels, systemBase, WEBLLM_MODELS } from '../core/ai.js';
import { answer, splitRelated } from '../core/answer.js';
import { runAgent } from '../core/agent.js';
import { renderMarkdown, esc } from '../core/markdown.js';
import { startListening, speak, stopSpeaking } from '../core/voice.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const icon = (id) => '<svg><use href="#i-' + id + '"/></svg>';

let settings = store.settings();
let mode = 'chat';
let includePage = true;
let extraTabs = []; // [{id,title}]
let thread = newThread();
let busy = null; // tarea activa del chat {abort|stop}
const running = new Map(); // tareas en segundo plano

document.body.classList.toggle('android', host.platform === 'android');
applyTheme();

function newThread() {
  return { id: 't' + Date.now().toString(36), title: 'Nueva conversación', created: Date.now(), messages: [] };
}
function applyTheme() {
  const t = settings.theme === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'claro' : 'oscuro') : settings.theme;
  document.documentElement.dataset.theme = t;
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

/* ================== utilidades de interfaz ================== */
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

// Tooltips en todos los botones con data-tip
(function tooltips() {
  const tip = $('#tooltip');
  let timer;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    clearTimeout(timer);
    if (!el) { tip.hidden = true; return; }
    timer = setTimeout(() => {
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const w = tip.offsetWidth, h = tip.offsetHeight;
      let x = Math.min(Math.max(6, r.left + r.width / 2 - w / 2), innerWidth - w - 6);
      let y = r.bottom + 6;
      if (y + h > innerHeight - 4) y = r.top - h - 6;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    }, 380);
  });
  document.addEventListener('mousedown', () => { clearTimeout(timer); tip.hidden = true; });
})();

// Enlaces externos: siempre se abren en una pestaña del navegador.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (a) {
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:)/.test(href)) {
      e.preventDefault();
      host.openTab(href, { background: e.ctrlKey || e.metaKey });
    }
  }
  const cc = e.target.closest('.copy-code');
  if (cc) {
    navigator.clipboard.writeText(cc.nextElementSibling.textContent);
    cc.textContent = 'Copiado';
    setTimeout(() => (cc.textContent = 'Copiar'), 1400);
  }
});

/* ================== navegación de vistas ================== */
function showView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'memory') renderMemory();
  if (name === 'shortcuts') renderShortcuts();
  if (name === 'tasks') renderTasks();
  if (name === 'settings') fillSettings();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

$('#btnClose').onclick = () => host.panel('close');
$('#btnExpand').onclick = () => {
  const wide = !document.body.classList.contains('wide');
  document.body.classList.toggle('wide', wide);
  host.panel(wide ? 'expand' : 'collapse');
};
$('#btnNew').onclick = () => { if (busy) return toast('Espera a que termine la respuesta actual'); thread = newThread(); renderThread(); };

/* ================== contexto (página / pestañas) ================== */
async function refreshContext() {
  try {
    const t = await host.getActiveTab();
    $('#ctxPageTitle').textContent = t && t.title ? t.title : 'Página actual';
    $('#ctxPage').dataset.tip = t && t.url ? 'Contexto: ' + t.url : 'Incluir la página actual';
  } catch (e) { /* sin pestaña */ }
}
$('#ctxPage').onclick = () => {
  includePage = !includePage;
  $('#ctxPage').classList.toggle('on', includePage);
};
function renderCtxTabs() {
  $('#ctxTabs').innerHTML = extraTabs.map((t, i) =>
    '<button class="ctx-chip on" data-i="' + i + '" data-tip="Quitar del contexto">' + icon('tab') +
    '<span>' + esc(t.title || t.url) + '</span><span class="rm">×</span></button>').join('');
  $$('#ctxTabs .ctx-chip').forEach((b) => (b.onclick = () => { extraTabs.splice(+b.dataset.i, 1); renderCtxTabs(); }));
}
$('#ctxAdd').onclick = () => openTabPicker();

/* ================== popup de / y @ ================== */
let popupItems = [];
let popupSel = 0;
let popupKind = '';
const popup = $('#popup');
const input = $('#input');

function allShortcuts() {
  return store.shortcuts().map((s) => Object.assign({ custom: true }, s)).concat(BUILTIN_SHORTCUTS);
}
function showPopup(kind, items) {
  popupKind = kind;
  popupItems = items;
  popupSel = 0;
  if (!items.length) { popup.hidden = true; return; }
  popup.innerHTML = items.map((it, i) =>
    '<div class="opt' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '"><b>' + esc(it.label) + '</b><span>' + esc(it.desc || '') + '</span></div>').join('');
  popup.hidden = false;
  $$('.opt', popup).forEach((o) => o.addEventListener('mousedown', (e) => { e.preventDefault(); choosePopup(+o.dataset.i); }));
}
function choosePopup(i) {
  const it = popupItems[i];
  popup.hidden = true;
  if (!it) return;
  if (popupKind === 'slash') {
    input.value = '/' + it.name + ' ';
  } else if (popupKind === 'at') {
    input.value = input.value.replace(/@[^\s@]*$/, '');
    if (!extraTabs.some((t) => t.id === it.id)) extraTabs.push({ id: it.id, title: it.label, url: it.desc });
    renderCtxTabs();
  }
  input.focus();
  autoGrow();
}
async function openTabPicker(filter) {
  const tabs = await host.listTabs().catch(() => []);
  const f = (filter || '').toLowerCase();
  const items = tabs
    .filter((t) => !t.active && (!f || (t.title + ' ' + t.url).toLowerCase().includes(f)))
    .map((t) => ({ id: t.id, label: t.title || t.url, desc: t.url }));
  if (!items.length) { toast('No hay otras pestañas abiertas'); return; }
  showPopup('at', items);
}
input.addEventListener('input', () => {
  autoGrow();
  const v = input.value;
  const slash = v.match(/^\/([\w-]*)$/);
  const at = v.match(/@([^\s@]*)$/);
  if (slash) {
    const q = slash[1].toLowerCase();
    showPopup('slash', allShortcuts().filter((s) => s.name.startsWith(q)).map((s) =>
      ({ name: s.name, label: '/' + s.name, desc: s.desc || s.prompt })));
  } else if (at) {
    openTabPicker(at[1]);
  } else popup.hidden = true;
});
input.addEventListener('keydown', (e) => {
  if (!popup.hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      popupSel = (popupSel + (e.key === 'ArrowDown' ? 1 : -1) + popupItems.length) % popupItems.length;
      $$('.opt', popup).forEach((o, i) => o.classList.toggle('sel', i === popupSel));
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choosePopup(popupSel); return; }
    if (e.key === 'Escape') { popup.hidden = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(180, input.scrollHeight) + 'px';
}

/* ================== modo ================== */
function setMode(m) {
  mode = m;
  $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#bgToggle').hidden = m !== 'agente';
  input.placeholder = m === 'buscar' ? 'Pregunta a la web… (respuesta con fuentes)'
    : m === 'agente' ? 'Describe la tarea, ej. «Busca vuelos CDMX–Cancún para el 12 de diciembre y dime el más barato»'
    : 'Pregunta lo que quieras… ( / atajos · @ pestañas )';
}
$$('#modeSeg button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$$('#suggestions .chip').forEach((c) => (c.onclick = () => {
  if (c.dataset.mode) { setMode(c.dataset.mode); input.focus(); return; }
  input.value = c.dataset.prompt;
  send();
}));

/* ================== render de conversación ================== */
const box = $('#messages');
function scrollDown(force) {
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  if (near || force) box.scrollTop = box.scrollHeight;
}
function renderThread() {
  box.querySelectorAll('.msg').forEach((m) => m.remove());
  $('#empty').hidden = thread.messages.length > 0;
  thread.messages.forEach((m) => {
    if (m.role === 'user') addUser(m.content, m.note);
    else if (m.kind === 'agent') {
      const card = agentCard(m.goal);
      m.steps.forEach((s) => card.addStep(s));
      card.finish(m.content, m.status || 'ok');
    } else {
      const v = aiMessage(m.kind);
      v.setSources(m.sources);
      v.setText(m.content, true);
      v.setRelated(m.related);
    }
  });
  scrollDown(true);
}
function addUser(text, note) {
  $('#empty').hidden = true;
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = '<div class="bubble">' + esc(text) + (note ? '<div class="ctxnote">' + esc(note) + '</div>' : '') + '</div>';
  box.appendChild(el);
  scrollDown(true);
}
function aiMessage(kind) {
  const el = document.createElement('div');
  el.className = 'msg ai';
  el.innerHTML =
    '<div class="head"><span class="dot">' + icon(kind === 'answer' ? 'globe' : 'spark') + '</span>' +
    (kind === 'answer' ? 'Respuesta con fuentes' : 'Navega') + '</div>' +
    '<div class="status-line" hidden><span class="spinner"></span><span class="st"></span></div>' +
    '<div class="sources" hidden></div><div class="md"></div><div class="related" hidden></div>' +
    '<div class="actions" hidden>' +
    '<button class="icon" data-a="copy" data-tip="Copiar respuesta">' + icon('copy') + '</button>' +
    '<button class="icon" data-a="speak" data-tip="Leer en voz alta">' + icon('speaker') + '</button>' +
    '<button class="icon" data-a="pin" data-tip="Guardar en memoria">' + icon('pin') + '</button>' +
    '</div>';
  box.appendChild(el);
  let text = '';
  let sources = [];
  const md = $('.md', el);
  const api = {
    el,
    status(s) {
      const sl = $('.status-line', el);
      sl.hidden = !s;
      $('.st', el).textContent = s || '';
      scrollDown();
    },
    setSources(list) {
      sources = list || [];
      const sw = $('.sources', el);
      sw.hidden = !sources.length;
      sw.innerHTML = sources.map((s, i) => {
        let d = '';
        try { d = new URL(s.url).hostname.replace(/^www\./, ''); } catch (e) {}
        return '<button class="source" data-url="' + esc(s.url) + '" data-tip="' + esc(s.url) + '"><div class="n">' + (i + 1) +
          '</div><div class="t">' + esc(s.title) + '</div><div class="d">' + esc(d) + '</div></button>';
      }).join('');
      $$('.source', sw).forEach((b) => (b.onclick = () => host.openTab(b.dataset.url)));
    },
    setText(t, final) {
      text = t;
      md.innerHTML = renderMarkdown(t, sources);
      md.classList.toggle('cursor', !final);
      if (final) $('.actions', el).hidden = false;
      scrollDown();
    },
    setRelated(list) {
      const r = $('.related', el);
      r.hidden = !(list && list.length);
      r.innerHTML = (list || []).map((q) => '<button>' + icon('plus') + '<span>' + esc(q) + '</span></button>').join('');
      $$('button', r).forEach((b) => (b.onclick = () => { setMode('buscar'); input.value = b.textContent; send(); }));
    },
    error(msg) {
      md.classList.remove('cursor');
      md.insertAdjacentHTML('beforeend', '<div class="err">' + esc(msg) + '</div>');
      api.status('');
      scrollDown();
    },
  };
  $$('.actions .icon', el).forEach((b) => (b.onclick = () => {
    if (b.dataset.a === 'copy') { navigator.clipboard.writeText(text); toast('Copiado'); }
    if (b.dataset.a === 'speak') speak(text);
    if (b.dataset.a === 'pin') {
      if (settings.memoryMode === 'off') return toast('La memoria está desactivada (pestaña Memoria)');
      store.addMemory(text.length > 400 ? text.slice(0, 400) + '…' : text);
      toast('Guardado en tu memoria local');
    }
  }));
  return api;
}

function agentCard(goal, onStop) {
  const el = document.createElement('div');
  el.className = 'msg ai';
  el.innerHTML =
    '<div class="agent"><div class="agent-head"><span class="dot" style="width:26px;height:26px;border-radius:8px;background:var(--grad);display:grid;place-items:center;color:#fff">' + icon('robot') + '</span>' +
    '<div class="grow"><b>Agente</b><div class="goal">' + esc(goal) + '</div></div>' +
    '<span class="pill run">trabajando</span>' +
    '<button class="btn small danger" data-tip="Detener al agente">' + icon('stop') + '</button></div>' +
    '<ul class="agent-steps"></ul><div class="agent-ask"></div><div class="agent-body"><div class="md"></div></div></div>';
  box.appendChild(el);
  const ul = $('.agent-steps', el);
  const stopBtn = $('.agent-head .btn', el);
  stopBtn.onclick = () => onStop && onStop();
  if (!onStop) stopBtn.hidden = true;
  const ICON = { action: 'check', thought: 'spark', warn: 'alert', error: 'alert', done: 'check', info: 'tab', stop: 'stop', think: 'clock' };
  let thinking = null;
  return {
    el,
    addStep(s) {
      if (s.kind === 'think') {
        if (!thinking) {
          thinking = document.createElement('li');
          thinking.className = 'think';
          ul.appendChild(thinking);
        }
        thinking.innerHTML = '<span class="spinner"></span><span>Paso ' + ((s.data && s.data.n) || '') + ': observando ' + esc((s.data && s.data.title) || 'la página') + '…</span>';
        ul.appendChild(thinking);
      } else {
        if (thinking) { thinking.remove(); thinking = null; }
        if (s.kind === 'done' || !s.text) return;
        const li = document.createElement('li');
        li.className = s.kind;
        li.innerHTML = icon(ICON[s.kind] || 'check') + '<span>' + esc(s.text) + '</span>';
        ul.appendChild(li);
      }
      ul.scrollTop = ul.scrollHeight;
      scrollDown();
    },
    finish(text, status) {
      if (thinking) { thinking.remove(); thinking = null; }
      const pill = $('.pill', el);
      pill.className = 'pill ' + (status === 'ok' ? 'ok' : 'bad');
      pill.textContent = status === 'ok' ? 'completado' : status === 'stop' ? 'detenido' : 'error';
      stopBtn.hidden = true;
      $('.agent-body .md', el).innerHTML = renderMarkdown(text || '');
      scrollDown();
    },
    confirm(question) {
      return new Promise((resolve) => {
        const a = $('.agent-ask', el);
        a.innerHTML = '<div class="ask"><p>' + esc(question) + '</p><div class="row"><button class="btn primary">Permitir</button><button class="btn">No permitir</button></div></div>';
        const [yes, no] = $$('button', a);
        yes.onclick = () => { a.innerHTML = ''; resolve(true); };
        no.onclick = () => { a.innerHTML = ''; resolve(false); };
        host.panel('open');
        scrollDown(true);
      });
    },
    ask(question) {
      return new Promise((resolve) => {
        const a = $('.agent-ask', el);
        a.innerHTML = '<div class="ask"><p>' + esc(question) + '</p><form class="row"><input class="grow" style="background:var(--bg2);border:1px solid var(--border);border-radius:9px;padding:8px" autofocus><button class="btn primary">Responder</button></form></div>';
        const f = $('form', a);
        f.onsubmit = (e) => { e.preventDefault(); const v = $('input', f).value; a.innerHTML = ''; resolve(v); };
        host.panel('open');
        scrollDown(true);
      });
    },
  };
}

/* ================== envío ================== */
function setBusy(b) {
  busy = b;
  const s = $('#btnSend');
  s.innerHTML = icon(b ? 'stop' : 'send');
  s.dataset.tip = b ? 'Detener' : 'Enviar (Enter)';
}
$('#btnSend').onclick = () => {
  if (busy) { busy.abort ? busy.abort() : busy.stop(); setBusy(null); return; }
  send();
};

function memoryFacts() {
  return settings.memoryMode === 'off' ? [] : store.memory().slice(0, 40);
}

async function gatherContext(opts) {
  const parts = [];
  const notes = [];
  let page = null;
  try {
    if (includePage || opts.needPage) {
      const t = await host.getActiveTab();
      if (t && t.id && !/^navega:|appassets/.test(t.url || '')) {
        page = await host.getPageContent(t.id, 14000);
        if (page && !page.error) {
          parts.push('PÁGINA ACTUAL: ' + page.title + '\nURL: ' + page.url +
            (page.seleccion ? '\nTEXTO SELECCIONADO POR EL USUARIO:\n' + page.seleccion : '') +
            '\nCONTENIDO:\n' + page.text);
          notes.push('página actual');
        }
      }
    }
    let tabs = extraTabs.slice();
    if (opts.allTabs) {
      const all = await host.listTabs();
      tabs = all.filter((t) => !t.active && /^https?:/.test(t.url)).slice(0, 8);
    }
    for (const t of tabs) {
      const c = await host.getPageContent(t.id, opts.allTabs ? 4500 : 7000).catch(() => null);
      if (c && !c.error) parts.push('PESTAÑA «' + c.title + '»\nURL: ' + c.url + '\nCONTENIDO:\n' + c.text);
    }
    if (tabs.length) notes.push(tabs.length + ' pestaña(s) más');
    if (settings.memoryMode === 'local+historial') {
      const h = await host.getHistory(25).catch(() => []);
      if (h && h.length) parts.push('HISTORIAL RECIENTE DEL USUARIO (títulos):\n' + h.map((x) => '- ' + x.title + ' (' + x.url + ')').join('\n'));
    }
  } catch (e) { /* contexto parcial */ }
  return { text: parts.join('\n\n-----\n\n'), note: notes.length ? 'Con contexto: ' + notes.join(', ') : '', page };
}

function expandShortcut(raw, page) {
  const m = raw.match(/^\/([\w-]+)\s*([\s\S]*)$/);
  if (!m) return null;
  const sc = allShortcuts().find((s) => s.name === m[1].toLowerCase());
  if (!sc) return null;
  const rest = m[2].trim();
  let p = sc.prompt;
  const pageStr = page ? page.title + ' (' + page.url + ')' : '';
  const hadText = /\{texto\}/.test(p);
  p = p.replace(/\{texto\}/g, rest).replace(/\{pagina\}/g, pageStr).replace(/\{url\}/g, page ? page.url : '')
    .replace(/\{seleccion\}/g, page && page.seleccion ? page.seleccion : '');
  if (!hadText && rest) p += '\n\nIndicaciones adicionales: ' + rest;
  return { sc, prompt: p.trim(), rest };
}

async function send(textArg, modeArg, allTabsArg) {
  if (busy) return;
  let text = (textArg != null ? textArg : input.value).trim();
  if (!text) return;
  input.value = '';
  autoGrow();
  popup.hidden = true;
  stopSpeaking();
  let m = modeArg || mode;
  let allTabs = !!allTabsArg;

  if (text.startsWith('/')) {
    let page = null;
    try { const t = await host.getActiveTab(); if (t) page = await host.getPageContent(t.id, 600); } catch (e) {}
    const ex = expandShortcut(text, page);
    if (ex) {
      if (ex.sc.mode === 'recordar') {
        if (settings.memoryMode === 'off') return toast('Activa la memoria en la pestaña Memoria');
        store.addMemory(ex.rest);
        toast('Guardado en tu memoria local');
        return;
      }
      m = ex.sc.mode;
      allTabs = !!ex.sc.allTabs;
      addUser(text);
      text = ex.prompt;
      return dispatch(text, m, allTabs, true);
    }
  }
  addUser(text);
  return dispatch(text, m, allTabs, false);
}

async function dispatch(text, m, allTabs, fromShortcut) {
  if (!thread.messages.length) thread.title = text.slice(0, 60);
  thread.messages.push({ role: 'user', content: fromShortcut ? text : text });
  if (m === 'buscar') return doAnswer(text);
  if (m === 'agente') return doAgent(text, $('#bgCheck').checked);
  return doChat(text, allTabs);
}

async function doChat(text, allTabs) {
  const v = aiMessage('chat');
  v.status('Leyendo el contexto…');
  setBusy({ abort() {} });
  const ctx = await gatherContext({ allTabs, needPage: allTabs ? false : undefined });
  if (ctx.note) {
    const bubbles = $$('.msg.user .bubble', box);
    const last = bubbles[bubbles.length - 1];
    if (last) last.insertAdjacentHTML('beforeend', '<div class="ctxnote">' + esc(ctx.note) + '</div>');
  }
  const prior = thread.messages.slice(0, -1).slice(-8).map((x) => ({ role: x.role === 'user' ? 'user' : 'assistant', content: String(x.content).slice(0, 4000) }));
  const messages = [{ role: 'system', content: systemBase(settings, memoryFacts()) }]
    .concat(prior)
    .concat([{ role: 'user', content: (ctx.text ? 'CONTEXTO DEL NAVEGADOR:\n' + ctx.text + '\n\n=====\n\n' : '') + 'PREGUNTA: ' + text }]);
  v.status('Pensando…');
  const job = chat({ settings, messages, onStatus: (s) => v.status(s), onToken: (_, full) => { v.status(''); v.setText(full, false); } });
  setBusy(job);
  try {
    const full = await job.done;
    v.setText(full || '(sin respuesta)', true);
    thread.messages.push({ role: 'assistant', kind: 'chat', content: full });
    if (settings.tts) speak(full);
    persist();
  } catch (e) {
    v.error(e.message);
  } finally {
    v.status('');
    setBusy(null);
  }
}

async function doAnswer(query) {
  const v = aiMessage('answer');
  let ctxText = '';
  if (includePage) {
    const c = await gatherContext({});
    if (c.page && /(esta|esto|página|articulo|artículo)/i.test(query)) ctxText = 'El usuario está viendo: ' + c.page.title + ' — ' + c.page.url + '\n' + (c.page.text || '').slice(0, 2500);
  }
  let srcs = [];
  const job = answer({
    query, settings, memory: memoryFacts(), extraContext: ctxText,
    onStatus: (s) => v.status(s),
    onSources: (s) => { srcs = s; v.setSources(s); },
    onToken: (_, full) => { v.status(''); v.setText(splitRelated(full).body, false); },
  });
  setBusy(job);
  try {
    const r = await job.done;
    const { body, related } = splitRelated(r.text);
    v.setText(body || '(sin respuesta)', true);
    v.setRelated(related);
    thread.messages.push({ role: 'assistant', kind: 'answer', content: body, sources: srcs, related });
    if (settings.tts) speak(body);
    persist();
  } catch (e) {
    v.error(e.message);
  } finally {
    v.status('');
    setBusy(null);
  }
}

async function doAgent(goal, background) {
  let job;
  const card = agentCard(goal, () => job && job.stop());
  const steps = [];
  const active = await host.getActiveTab().catch(() => null);
  const useCurrent = !background && active && /^https?:/.test(active.url || '');
  job = runAgent({
    goal, settings, memory: memoryFacts(),
    tabId: useCurrent ? active.id : null,
    background,
    onStep: (s) => { if (s.kind !== 'think') steps.push({ kind: s.kind, text: s.text }); card.addStep(s); updateRunning(); },
    confirm: (q) => card.confirm(q),
    askUser: (q) => card.ask(q),
  });
  const task = { id: 'a' + Date.now(), goal, job, steps, status: 'run', card, started: Date.now() };
  running.set(task.id, task);
  updateRunning();
  if (!background) setBusy({ stop: () => job.stop() });
  else toast('El agente trabaja en segundo plano. Míralo en «Tareas».');
  let status = 'ok', result = '';
  try {
    result = await job.done;
    if (result === 'Tarea detenida.') status = 'stop';
  } catch (e) {
    status = 'error';
    result = 'No pude completar la tarea: ' + e.message;
  }
  card.finish(result, status);
  task.status = status;
  task.result = result;
  updateRunning();
  if (!background) setBusy(null);
  else host.notify('Navega-MX · tarea terminada', goal.slice(0, 80));
  thread.messages.push({ role: 'assistant', kind: 'agent', goal, steps, content: result, status });
  if (settings.tts && status === 'ok') speak(result);
  persist();
  return result;
}

function persist() {
  if (settings.memoryMode === 'off') return;
  thread.updated = Date.now();
  store.saveThread(thread);
}

/* ================== voz ================== */
let rec = null;
$('#btnMic').onclick = toggleVoice;
async function toggleVoice() {
  const b = $('#btnMic');
  try {
    if (host.platform === 'android') {
      b.classList.add('rec');
      const r = await startListening(settings);
      const txt = await r.result;
      b.classList.remove('rec');
      if (txt) { input.value = txt; send(); }
      return;
    }
    if (rec) {
      b.classList.remove('rec');
      const r = rec;
      rec = null;
      toast('Transcribiendo…');
      const txt = await r.stop();
      if (txt) { input.value = txt; send(); }
      return;
    }
    rec = await startListening(settings);
    b.classList.add('rec');
    toast('Escuchando… pulsa de nuevo para terminar', 3500);
  } catch (e) {
    rec = null;
    b.classList.remove('rec');
    toast(e.message, 6000);
  }
}

/* ================== conversaciones ================== */
function threadItems(container, onOpen) {
  const list = store.threads();
  container.innerHTML = list.length ? '' : '<p class="hint">Aún no hay conversaciones guardadas.</p>';
  list.forEach((t) => {
    const it = document.createElement('div');
    it.className = 'item click';
    it.innerHTML = '<div class="main"><b>' + esc(t.title) + '</b><small>' + new Date(t.updated || t.created).toLocaleString('es-MX') +
      ' · ' + t.messages.length + ' mensajes</small></div><button class="icon" data-tip="Borrar">' + icon('trash') + '</button>';
    it.onclick = (e) => {
      if (e.target.closest('.icon')) { store.deleteThread(t.id); threadItems(container, onOpen); return; }
      onOpen(t);
    };
    container.appendChild(it);
  });
}
$('#btnThreads').onclick = () => {
  const d = $('#threadsDrawer');
  d.hidden = !d.hidden;
  if (!d.hidden) threadItems($('#drawerList'), (t) => { thread = t; renderThread(); d.hidden = true; showView('chat'); });
};
$('#closeDrawer').onclick = () => ($('#threadsDrawer').hidden = true);

/* ================== memoria ================== */
function renderMemory() {
  $$('input[name=memMode]').forEach((r) => (r.checked = r.value === settings.memoryMode));
  const list = store.memory();
  const ml = $('#memList');
  ml.innerHTML = list.length ? '' : '<p class="hint">No hay datos guardados. Usa «/recordar …» o el botón de fijar en una respuesta.</p>';
  list.forEach((m) => {
    const it = document.createElement('div');
    it.className = 'item';
    it.innerHTML = '<div class="main"><b style="white-space:normal">' + esc(m.text) + '</b><small>' + new Date(m.date).toLocaleDateString('es-MX') +
      '</small></div><button class="icon" data-tip="Olvidar">' + icon('trash') + '</button>';
    $('.icon', it).onclick = () => { store.removeMemory(m.id); renderMemory(); };
    ml.appendChild(it);
  });
  threadItems($('#threadList'), (t) => { thread = t; renderThread(); showView('chat'); });
}
$$('input[name=memMode]').forEach((r) => (r.onchange = () => {
  settings.memoryMode = r.value;
  store.saveSettings(settings);
  toast(r.value === 'off' ? 'Memoria desactivada' : 'Memoria local activada');
}));
$('#memForm').onsubmit = (e) => {
  e.preventDefault();
  const v = e.target.fact.value.trim();
  if (!v) return;
  store.addMemory(v);
  e.target.reset();
  renderMemory();
};
$('#btnClearMemory').onclick = () => { if (confirm('¿Borrar todo lo que Navega recuerda?')) { store.clearMemory(); renderMemory(); } };
$('#btnClearThreads').onclick = () => { if (confirm('¿Borrar todas las conversaciones?')) { store.clearThreads(); renderMemory(); } };
$('#btnExport').onclick = () => {
  const blob = new Blob([store.exportAll()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'navega-mx-datos.json';
  a.click();
};
$('#btnImport').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { store.importAll(await f.text()); settings = store.settings(); toast('Datos importados'); renderMemory(); } catch (er) { toast('Archivo no válido'); }
};

/* ================== atajos ================== */
function renderShortcuts() {
  const custom = store.shortcuts();
  const cl = $('#customShortcuts');
  cl.innerHTML = custom.length ? '' : '<p class="hint">Crea tu primer atajo abajo.</p>';
  custom.forEach((s, i) => {
    const it = document.createElement('div');
    it.className = 'item';
    it.innerHTML = '<div class="main"><b>/' + esc(s.name) + '</b><small>' + esc(s.desc || s.prompt) + '</small></div>' +
      '<button class="icon" data-a="run" data-tip="Usar ahora">' + icon('play') + '</button>' +
      '<button class="icon" data-a="edit" data-tip="Editar">' + icon('edit') + '</button>' +
      '<button class="icon" data-a="del" data-tip="Eliminar">' + icon('trash') + '</button>';
    $$('.icon', it).forEach((b) => (b.onclick = () => {
      if (b.dataset.a === 'del') { custom.splice(i, 1); store.saveShortcuts(custom); renderShortcuts(); }
      if (b.dataset.a === 'run') { showView('chat'); input.value = '/' + s.name + ' '; input.focus(); }
      if (b.dataset.a === 'edit') {
        const f = $('#scForm');
        f.name.value = s.name; f.desc.value = s.desc || ''; f.prompt.value = s.prompt; f.mode.value = s.mode || 'chat';
        f.allTabs.checked = !!s.allTabs; f.editing.value = String(i);
        f.name.focus();
      }
    }));
    cl.appendChild(it);
  });
  $('#builtinShortcuts').innerHTML = BUILTIN_SHORTCUTS.map((s) =>
    '<div class="item"><div class="main"><b>/' + esc(s.name) + '</b><small>' + esc(s.desc) + '</small></div></div>').join('');
}
$('#scForm').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  const list = store.shortcuts();
  const sc = { name: f.name.value.trim().toLowerCase(), desc: f.desc.value.trim(), prompt: f.prompt.value.trim(), mode: f.mode.value, allTabs: f.allTabs.checked };
  if (f.editing.value !== '') list[+f.editing.value] = sc;
  else {
    if (allShortcuts().some((x) => x.name === sc.name)) return toast('Ya existe un atajo con ese nombre');
    list.push(sc);
  }
  store.saveShortcuts(list);
  f.reset();
  f.editing.value = '';
  renderShortcuts();
  toast('Atajo guardado: /' + sc.name);
};

/* ================== tareas ================== */
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
$('#schedDays').innerHTML = DAYS.map((d, i) => '<label><input type="checkbox" name="d' + i + '" checked> ' + d + '</label>').join('');
function updateRunning() {
  const n = Array.from(running.values()).filter((t) => t.status === 'run').length;
  $('#taskBadge').hidden = !n;
  $('#taskBadge').textContent = n;
  if ($('#view-tasks').classList.contains('active')) renderTasks();
}
function renderTasks() {
  const rl = $('#runningList');
  const list = Array.from(running.values()).sort((a, b) => b.started - a.started);
  rl.innerHTML = list.length ? '' : '<p class="hint">No hay tareas del agente en esta sesión.</p>';
  list.forEach((t) => {
    const it = document.createElement('div');
    it.className = 'item click';
    const last = t.steps[t.steps.length - 1];
    it.innerHTML = '<div class="main"><b>' + esc(t.goal) + '</b><small>' + esc(t.status === 'run' ? (last ? last.text : 'Iniciando…') : (t.result || '').replace(/[*_#`>|]/g, '').slice(0, 120)) + '</small></div>' +
      '<span class="pill ' + (t.status === 'run' ? 'run' : t.status === 'ok' ? 'ok' : 'bad') + '">' + (t.status === 'run' ? 'en curso' : t.status === 'ok' ? 'listo' : t.status === 'stop' ? 'detenida' : 'error') + '</span>' +
      (t.status === 'run' ? '<button class="icon" data-tip="Detener">' + icon('stop') + '</button>' : '');
    it.onclick = (e) => {
      if (e.target.closest('.icon')) { t.job.stop(); return; }
      t.job.tabId.then((id) => id && host.activateTab(id));
      showView('chat');
      t.card.el.scrollIntoView({ behavior: 'smooth' });
    };
    rl.appendChild(it);
  });
  const sl = $('#schedList');
  const sched = store.scheduled();
  sl.innerHTML = sched.length ? '' : '<p class="hint">Sin tareas programadas.</p>';
  sched.forEach((t, i) => {
    const it = document.createElement('div');
    it.className = 'item';
    it.innerHTML = '<div class="main"><b>' + esc(t.prompt) + '</b><small>' + t.time + ' · ' + t.days.map((d) => DAYS[d]).join(', ') +
      ' · ' + (t.mode === 'agente' ? 'Agente' : 'Buscar') + (t.lastRun ? ' · última: ' + t.lastRun : '') + '</small></div>' +
      '<button class="icon" data-a="run" data-tip="Ejecutar ahora">' + icon('play') + '</button>' +
      '<button class="icon" data-a="del" data-tip="Eliminar">' + icon('trash') + '</button>';
    $$('.icon', it).forEach((b) => (b.onclick = () => {
      if (b.dataset.a === 'del') { sched.splice(i, 1); store.saveScheduled(sched); renderTasks(); }
      else runScheduled(t);
    }));
    sl.appendChild(it);
  });
}
$('#schedForm').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  const days = DAYS.map((_, i) => (f['d' + i].checked ? i : -1)).filter((x) => x >= 0);
  if (!days.length) return toast('Elige al menos un día');
  const list = store.scheduled();
  list.push({ id: 's' + Date.now().toString(36), prompt: f.prompt.value.trim(), time: f.time.value, mode: f.mode.value, days, lastRun: '' });
  store.saveScheduled(list);
  f.prompt.value = '';
  renderTasks();
  toast('Tarea programada');
};
async function runScheduled(t) {
  if (busy) { toast('Hay una respuesta en curso; la tarea se ejecutará en un momento'); setTimeout(() => runScheduled(t), 20000); return; }
  const prev = thread;
  thread = newThread();
  thread.title = 'Tarea programada: ' + t.prompt.slice(0, 40);
  renderThread();
  addUser(t.prompt, 'Tarea programada · ' + t.time);
  thread.messages.push({ role: 'user', content: t.prompt });
  if (t.mode === 'agente') await doAgent(t.prompt, true);
  else { await doAnswer(t.prompt); host.notify('Navega-MX · tarea programada lista', t.prompt.slice(0, 80)); }
  if (!prev.messages.length) return;
}
setInterval(() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hm = now.getHours() * 60 + now.getMinutes();
  const list = store.scheduled();
  let changed = false;
  list.forEach((t) => {
    const [h, m] = t.time.split(':').map(Number);
    const due = h * 60 + m;
    if (t.days.includes(now.getDay()) && t.lastRun !== today && hm >= due && hm - due < 15) {
      t.lastRun = today;
      changed = true;
      runScheduled(t);
    }
  });
  if (changed) store.saveScheduled(list);
}, 30000);

/* ================== ajustes ================== */
const sf = $('#settingsForm');
$('#webllmSelect').innerHTML = WEBLLM_MODELS.map((m) => '<option value="' + m.id + '">' + esc(m.label) + '</option>').join('');
function fillSettings() {
  settings = store.settings();
  for (const [k, v] of Object.entries(settings)) {
    const el = sf.elements[k];
    if (!el || el instanceof RadioNodeList) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  $('#tempOut').textContent = settings.temperature;
  provVisibility();
  host.appInfo().then((i) => ($('#version').textContent = 'v' + i.version)).catch(() => {});
}
function provVisibility() {
  const p = sf.elements.provider.value;
  $$('[data-prov]').forEach((d) => (d.hidden = d.dataset.prov !== p));
}
sf.elements.provider.onchange = provVisibility;
sf.elements.temperature.oninput = () => ($('#tempOut').textContent = sf.elements.temperature.value);
function readForm() {
  const s = Object.assign({}, settings);
  for (const k of Object.keys(DEFAULTS)) {
    const el = sf.elements[k];
    if (!el || el instanceof RadioNodeList) continue;
    if (el.type === 'checkbox') s[k] = el.checked;
    else if (el.type === 'number' || el.type === 'range') s[k] = Number(el.value);
    else s[k] = el.value.trim();
  }
  return s;
}
sf.onsubmit = (e) => {
  e.preventDefault();
  settings = readForm();
  store.saveSettings(settings);
  applyTheme();
  host.setHostSettings(settings).catch(() => {});
  const st = $('#saveStatus');
  st.textContent = 'Guardado';
  st.className = 'status ok';
  setTimeout(() => (st.textContent = ''), 2000);
};
$('#btnTest').onclick = async () => {
  const st = $('#testStatus');
  st.className = 'status';
  st.textContent = 'Probando…';
  const s = readForm();
  try {
    const models = await listModels(s);
    $('#modelList').innerHTML = models.map((m) => '<option value="' + esc(m) + '">').join('');
    st.className = 'status ok';
    st.textContent = models.length ? 'Conectado · ' + models.length + ' modelo(s): ' + models.slice(0, 4).join(', ') + (models.length > 4 ? '…' : '')
      : 'Conectado, pero no hay modelos instalados';
  } catch (e) {
    st.className = 'status bad';
    st.textContent = 'Sin conexión: ' + e.message;
  }
};

/* ================== eventos del navegador ================== */
window.NavegaUI = {
  onHostEvent(name, data) {
    data = data || {};
    if (name === 'tabChanged') refreshContext();
    if (name === 'view') showView(data.name || 'chat');
    if (name === 'focus') { showView('chat'); refreshContext(); setTimeout(() => input.focus(), 50); }
    if (name === 'wide') document.body.classList.toggle('wide', !!data.on);
    if (name === 'voice') { showView('chat'); toggleVoice(); }
    if (name === 'settingsChanged') { settings = store.settings(); applyTheme(); }
    if (name === 'ask') {
      showView('chat');
      if (busy) { toast('Espera a que termine la respuesta actual'); return; }
      if (data.newThread && thread.messages.length) { thread = newThread(); renderThread(); }
      const m = data.mode || 'buscar';
      setMode(m === 'agente' ? 'agente' : m === 'chat' ? 'chat' : 'buscar');
      refreshContext();
      send(data.text, m, data.allTabs);
    }
    if (name === 'shortcut') {
      showView('chat');
      refreshContext();
      if (data.selection) { includePage = true; $('#ctxPage').classList.add('on'); }
      send('/' + data.name + (data.text ? ' ' + data.text : ''));
    }
  },
};

/* ================== inicio ================== */
setMode('chat');
renderThread();
refreshContext();
host.setHostSettings(settings).catch(() => {});
if (location.hash === '#ajustes') showView('settings');
