/*
 * Navega-MX — lógica del navegador de escritorio: pestañas, espacios de trabajo,
 * vista dividida, barra de direcciones con IA, marcadores, historial,
 * descargas, bloqueador y puente con el asistente.
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

(function () {
  const N = window.navegaNative;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const icon = (id) => '<svg><use href="#i-' + id + '"/></svg>';
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const HOME = 'navega://inicio';
  const PARTITION = 'persist:navega', PRIVATE = 'navega-privado';

  document.body.classList.toggle('mac', N.platform === 'darwin');

  /* ======================= almacenamiento ======================= */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const settings = () => Object.assign({ searchEngine: 'duckduckgo', adblock: true, theme: 'auto', homepage: HOME }, LS.get('navega.settings', {}));
  let history = LS.get('navega.history', []);
  let bookmarks = LS.get('navega.bookmarks', []);
  let whitelist = LS.get('navega.adblock.whitelist', []);
  let workspaces = LS.get('navega.workspaces', [{ id: 'w1', name: 'Personal', color: '#14E0C8' }]);
  let currentWs = LS.get('navega.ws', workspaces[0].id);
  if (!workspaces.some((w) => w.id === currentWs)) currentWs = workspaces[0].id;
  const downloads = [];
  const closedTabs = [];

  function applyTheme() {
    const s = settings();
    const t = s.theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'claro' : 'oscuro') : s.theme;
    document.documentElement.dataset.theme = t;
  }
  applyTheme();
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
  N.setHostSettings({ adblock: settings().adblock !== false, whitelist, theme: settings().theme });

  /* ======================= utilidades ======================= */
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), ms);
  }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  function searchUrl(q) {
    const s = settings(), e = encodeURIComponent(q);
    switch (s.searchEngine) {
      case 'google': return 'https://www.google.com/search?q=' + e;
      case 'bing': return 'https://www.bing.com/search?q=' + e;
      case 'brave': return 'https://search.brave.com/search?q=' + e;
      case 'startpage': return 'https://www.startpage.com/do/search?q=' + e;
      case 'searxng': if (s.searxUrl) return s.searxUrl.replace(/\/+$/, '') + '/search?q=' + e; // fallthrough
      default: return 'https://duckduckgo.com/?kl=mx-es&q=' + e;
    }
  }
  function looksLikeUrl(t) {
    if (/^(https?|navega|about|file):/i.test(t)) return true;
    if (/\s/.test(t)) return false;
    return /^localhost(:\d+)?(\/.*)?$/i.test(t) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(t) || /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t);
  }
  function normalizeUrl(t) {
    if (/^(https?|navega|about|file):/i.test(t)) return t;
    if (/^localhost|^(\d{1,3}\.){3}\d{1,3}/.test(t)) return 'http://' + t;
    return 'https://' + t;
  }
  const QUESTION = /^(qu[eé]|c[oó]mo|cu[aá]l(es)?|cu[aá]nt[oa]s?|por ?qu[eé]|qui[eé]n(es)?|d[oó]nde|cu[aá]ndo|explica|resume|compara|dime|ayuda|what|how|why|who|which|when|where|is|are|can|should|does)\b/i;
  function isQuestion(t) { return /\?\s*$/.test(t) || /^¿/.test(t) || (QUESTION.test(t) && t.split(/\s+/).length >= 3); }

  // tooltips
  (function () {
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
        const x = Math.min(Math.max(6, r.left + r.width / 2 - tip.offsetWidth / 2), innerWidth - tip.offsetWidth - 6);
        tip.style.left = x + 'px';
        tip.style.top = r.bottom + 7 + 'px';
      }, 420);
    });
    document.addEventListener('mousedown', () => { clearTimeout(timer); tip.hidden = true; });
  })();

  /* ======================= pestañas ======================= */
  let tabs = [];
  let activeId = null;
  let splitId = null; // pestaña mostrada a la derecha en vista dividida
  let seq = 0;
  const content = $('#content');

  function getTab(id) { return tabs.find((t) => t.id === id); }
  function activeTab() { return getTab(activeId); }
  function wsTabs() { return tabs.filter((t) => t.ws === currentWs); }

  function createTab(url, o) {
    o = o || {};
    const t = {
      id: 't' + Date.now().toString(36) + (++seq),
      url: url || settings().homepage || HOME,
      title: o.title || 'Nueva pestaña',
      favicon: '',
      private: !!o.private,
      ws: o.ws || currentWs,
      loading: false,
      audible: false,
      webview: null,
      readyP: null,
      zoom: 0,
      wcId: null,
    };
    const idx = o.after ? tabs.indexOf(getTab(o.after)) + 1 : tabs.length;
    tabs.splice(idx > 0 ? idx : tabs.length, 0, t);
    if (!o.lazy) ensureWebview(t);
    if (o.activate !== false) activate(t.id);
    else renderTabs();
    saveSession();
    return t;
  }

  function ensureWebview(t) {
    if (t.webview) return t.webview;
    const wv = document.createElement('webview');
    wv.setAttribute('partition', t.private ? PRIVATE : PARTITION);
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('webpreferences', 'contextIsolation=yes, spellcheck=yes');
    wv.dataset.tab = t.id;
    let readyResolve;
    t.readyP = new Promise((r) => (readyResolve = r));
    t.waiters = [];
    wv.addEventListener('dom-ready', () => {
      if (!t.wcId) {
        t.wcId = wv.getWebContentsId();
        readyResolve();
      }
      if (t.zoom) wv.setZoomLevel(t.zoom);
      if (/^navega:\/\/inicio/.test(wv.getURL())) {
        wv.executeJavaScript('window.navegaSetTiles && window.navegaSetTiles(' + JSON.stringify(bookmarks.slice(0, 12)) + ')').catch(() => {});
      }
    });
    wv.addEventListener('did-start-loading', () => { t.loading = true; t.favicon = t.favicon; renderTab(t); if (t.id === activeId) progress(true); });
    wv.addEventListener('did-stop-loading', () => {
      t.loading = false;
      renderTab(t);
      if (t.id === activeId) { progress(false); updateNav(); }
      t.waiters.splice(0).forEach((w) => w());
    });
    wv.addEventListener('did-navigate', (e) => onNavigate(t, e.url, true));
    wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) onNavigate(t, e.url, false); });
    wv.addEventListener('page-title-updated', (e) => {
      t.title = e.title;
      renderTab(t);
      const h = history.find((x) => x.url === t.url);
      if (h && !t.private) { h.title = e.title; saveHistory(); }
      if (t.id === activeId) document.title = e.title + ' — Navega-MX';
      saveSession();
      notifyAssistant('tabChanged');
    });
    wv.addEventListener('page-favicon-updated', (e) => { t.favicon = e.favicons && e.favicons[0] || ''; renderTab(t); const h = history.find((x) => x.url === t.url); if (h) h.favicon = t.favicon; });
    wv.addEventListener('media-started-playing', () => { t.audible = true; renderTab(t); });
    wv.addEventListener('media-paused', () => { t.audible = false; renderTab(t); });
    wv.addEventListener('enter-html-full-screen', () => document.body.classList.add('fullscreen'));
    wv.addEventListener('leave-html-full-screen', () => document.body.classList.remove('fullscreen'));
    wv.addEventListener('found-in-page', (e) => {
      const r = e.result;
      $('#findCount').textContent = r.matches ? r.activeMatchOrdinal + '/' + r.matches : 'Sin resultados';
    });
    wv.addEventListener('focus', () => { if (splitId && (t.id === splitId || t.id === activeId)) { focusPane(t.id); } });
    wv.addEventListener('ipc-message', (e) => {
      if (e.channel === 'newtab-ask') askAI(e.args[0], e.args[1] || 'buscar');
    });
    wv.addEventListener('did-fail-load', (e) => {
      if (!e.isMainFrame || e.errorCode === -3) return;
      const html = errorPage(e.validatedURL, e.errorDescription, e.errorCode);
      wv.executeJavaScript('document.open();document.write(' + JSON.stringify(html) + ');document.close();').catch(() => {});
    });
    wv.setAttribute('src', t.url);
    content.appendChild(wv);
    t.webview = wv;
    return wv;
  }

  function errorPage(url, desc, code) {
    return '<!doctype html><meta charset="utf-8"><title>No se pudo abrir</title><body style="font:15px system-ui;background:#0D1230;color:#EEF1FF;display:grid;place-items:center;height:100vh;margin:0">' +
      '<div style="max-width:520px;text-align:center"><div style="font-size:56px">⚠︎</div><h2>No se pudo abrir la página</h2><p style="color:#9AA6D6">' +
      esc(hostOf(url) || url) + ' — ' + esc(desc) + ' (' + code + ')</p><p style="color:#9AA6D6">Revisa tu conexión o la dirección. También puedes preguntarle a la IA con Alt+A.</p>' +
      '<button onclick="location.reload()" style="margin-top:10px;padding:9px 18px;border:0;border-radius:10px;background:linear-gradient(135deg,#14E0C8,#5B8CFF,#FF2E88);color:#fff;font-weight:600;cursor:pointer">Reintentar</button></div>';
  }

  function onNavigate(t, url, full) {
    // Respaldo de la página de inicio: navega://inicio/preguntar?m=…&q=…
    const ask = /^navega:\/\/inicio\/preguntar\?/.test(url) ? new URL(url) : null;
    if (ask) {
      const q = ask.searchParams.get('q') || '';
      const m = ask.searchParams.get('m') || 'buscar';
      t.url = HOME;
      if (t.webview) t.webview.executeJavaScript("history.replaceState(null, '', 'navega://inicio/')").catch(() => {});
      if (t.id === activeId) setUrlBar(HOME);
      if (q && Date.now() - (t.lastAsk || 0) > 800) { t.lastAsk = Date.now(); askAI(q, m); }
      return;
    }
    t.url = url;
    if (full && t.wcId) { N.adblockReset(t.wcId); if (t.id === activeId) updateShield(0); }
    if (!t.private && /^https?:/.test(url)) {
      history = history.filter((h) => h.url !== url);
      history.unshift({ url, title: t.title, time: Date.now(), favicon: t.favicon });
      if (history.length > 5000) history.length = 5000;
      saveHistory();
    }
    if (t.id === activeId) { setUrlBar(url); updateNav(); updateStar(); }
    saveSession();
    notifyAssistant('tabChanged');
  }

  const saveHistory = debounce(() => LS.set('navega.history', history), 800);
  const saveSession = debounce(() => {
    LS.set('navega.session', {
      tabs: tabs.filter((t) => !t.private).map((t) => ({ url: t.url, title: t.title, ws: t.ws })),
      active: activeTab() && !activeTab().private ? tabs.filter((t) => !t.private).indexOf(activeTab()) : 0,
    });
    LS.set('navega.ws', currentWs);
  }, 600);
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  function activate(id) {
    const t = getTab(id);
    if (!t) return;
    if (t.ws !== currentWs) switchWorkspace(t.ws, true);
    if (splitId === id) splitId = activeId !== id ? activeId : null;
    activeId = id;
    ensureWebview(t);
    layout();
    renderTabs();
    setUrlBar(t.url);
    updateNav();
    updateStar();
    progress(t.loading);
    document.title = (t.title || 'Navega-MX') + ' — Navega-MX';
    if (t.wcId) N.adblockCount(t.wcId).then(updateShield); else updateShield(0);
    if (/^navega:\/\/inicio/.test(t.url)) setTimeout(() => $('#url').focus(), 30);
    else if (!$('#url').matches(':focus')) setTimeout(() => t.webview && t.webview.focus(), 30);
    saveSession();
    notifyAssistant('tabChanged');
  }

  function layout() {
    const showSplit = splitId && getTab(splitId) && splitId !== activeId && getTab(splitId).ws === currentWs;
    if (!showSplit) splitId = null;
    content.classList.toggle('split', !!showSplit);
    $('#splitDivider').hidden = !showSplit;
    $('#splitBtn').classList.toggle('on', !!showSplit);
    tabs.forEach((t) => {
      if (!t.webview) return;
      const vis = t.id === activeId || t.id === splitId;
      t.webview.classList.toggle('vis', vis);
      t.webview.classList.toggle('left', vis && !!showSplit && t.id === activeId);
      t.webview.classList.toggle('right', vis && !!showSplit && t.id === splitId);
      t.webview.classList.toggle('focused', !!showSplit && t.id === activeId);
    });
  }
  function focusPane(id) {
    if (id === activeId) return;
    if (id === splitId) {
      // intercambia el foco entre los paneles
      splitId = activeId;
      activeId = id;
      const a = getTab(activeId), b = getTab(splitId);
      // mantener posiciones: el panel enfocado es el izquierdo lógicamente
      layout();
      renderTabs();
      setUrlBar(a.url);
      updateNav();
      updateStar();
      if (b) { /* nada */ }
    }
  }

  function closeTab(id) {
    const t = getTab(id);
    if (!t) return;
    if (!t.private) closedTabs.push({ url: t.url, title: t.title, ws: t.ws });
    const list = wsTabs();
    const i = list.indexOf(t);
    tabs = tabs.filter((x) => x !== t);
    if (t.webview) t.webview.remove();
    if (splitId === id) splitId = null;
    if (activeId === id) {
      const rest = wsTabs();
      if (!rest.length) { createTab(HOME); return; }
      activate((rest[i] || rest[i - 1] || rest[0]).id);
    } else { layout(); renderTabs(); }
    saveSession();
  }

  function renderTabs() {
    const box = $('#tabs');
    const list = wsTabs();
    box.innerHTML = '';
    list.forEach((t) => box.appendChild(tabEl(t)));
    const ws = workspaces.find((w) => w.id === currentWs);
    $('#wsName').textContent = ws ? ws.name : 'Personal';
    $('.ws-dot').style.background = ws ? ws.color : '';
    const a = box.querySelector('.tab.active');
    if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function tabEl(t) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeId ? ' active' : '') + (t.id === splitId ? ' split-right' : '') + (t.private ? ' private' : '');
    el.dataset.id = t.id;
    el.draggable = true;
    el.title = t.title + '\n' + t.url;
    fillTab(el, t);
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(t.id); return; }
      if (e.button === 0 && !e.target.closest('.close')) activate(t.id);
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(t, e.clientX, e.clientY); });
    el.addEventListener('dragstart', (e) => { el.classList.add('dragging'); e.dataTransfer.setData('text/navega-tab', t.id); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = getTab(e.dataTransfer.getData('text/navega-tab'));
      if (!from || from === t) return;
      tabs.splice(tabs.indexOf(from), 1);
      tabs.splice(tabs.indexOf(t), 0, from);
      renderTabs();
      saveSession();
    });
    return el;
  }
  function fillTab(el, t) {
    const fav = t.loading ? '<span class="spin"></span>'
      : t.favicon ? '<img class="fav" src="' + esc(t.favicon) + '" onerror="this.style.visibility=\'hidden\'">'
      : /^navega:/.test(t.url) ? '<img class="fav" src="navega://app/shared/navega/img/logo.svg">' : icon('globe');
    el.innerHTML = '<span class="fav-wrap">' + fav + '</span><span class="title">' + esc(t.title || t.url) + '</span>' +
      (t.audible ? '<svg class="audio"><use href="#i-volume"/></svg>' : '') +
      '<button class="close" data-tip="Cerrar pestaña (Ctrl+W)">' + icon('x') + '</button>';
    el.querySelector('.close').onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
  }
  function renderTab(t) {
    const el = $('#tabs .tab[data-id="' + t.id + '"]');
    if (el) { fillTab(el, t); el.title = t.title + '\n' + t.url; }
  }

  function tabMenu(t, x, y) {
    menu([
      { label: 'Recargar', icon: 'reload', run: () => t.webview && t.webview.reload() },
      { label: 'Duplicar', icon: 'layers', run: () => createTab(t.url, { after: t.id, private: t.private }) },
      { label: 'Abrir en vista dividida', icon: 'split', run: () => { if (t.id !== activeId) { splitId = t.id; ensureWebview(t); layout(); renderTabs(); } } },
      { label: 'Resumir con IA', icon: 'spark', run: () => { activate(t.id); aiShortcut('resumir'); } },
      '-',
      ...workspaces.filter((w) => w.id !== t.ws).map((w) => ({ label: 'Mover a «' + w.name + '»', dot: w.color, run: () => { t.ws = w.id; if (t.id === activeId) { const r = wsTabs(); r.length ? activate(r[0].id) : createTab(HOME); } renderTabs(); saveSession(); } })),
      '-',
      { label: 'Cerrar otras pestañas', run: () => wsTabs().filter((x) => x !== t).forEach((x) => closeTab(x.id)) },
      { label: 'Cerrar pestaña', icon: 'x', key: 'Ctrl+W', run: () => closeTab(t.id) },
    ], x, y);
  }

  /* ======================= barra de direcciones ======================= */
  const urlInput = $('#url');
  function setUrlBar(u) {
    if (document.activeElement === urlInput) return;
    urlInput.value = /^navega:\/\/inicio/.test(u) ? '' : u || '';
    const sec = $('#secIcon');
    sec.className = 'omni-icon';
    if (/^https:/.test(u)) { sec.innerHTML = icon('lock'); sec.classList.add('secure'); sec.dataset.tip = 'Conexión segura (HTTPS)'; }
    else if (/^http:/.test(u)) { sec.innerHTML = icon('unlock'); sec.classList.add('insecure'); sec.dataset.tip = 'Conexión no segura'; }
    else { sec.innerHTML = icon('search'); sec.dataset.tip = 'Busca o pregunta'; }
  }
  let sugItems = [], sugSel = 0;
  urlInput.addEventListener('focus', () => setTimeout(() => urlInput.select(), 0));
  urlInput.addEventListener('blur', () => setTimeout(() => { $('#suggest').hidden = true; const t = activeTab(); if (t) setUrlBar(t.url); }, 150));
  urlInput.addEventListener('input', suggest);
  urlInput.addEventListener('keydown', (e) => {
    const box = $('#suggest');
    if (!box.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      sugSel = (sugSel + (e.key === 'ArrowDown' ? 1 : -1) + sugItems.length) % sugItems.length;
      $$('.sg', box).forEach((x, i) => x.classList.toggle('sel', i === sugSel));
      return;
    }
    if (e.key === 'Escape') { box.hidden = true; const t = activeTab(); urlInput.value = t ? t.url : ''; urlInput.blur(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = urlInput.value.trim();
      if (!v) return;
      if (e.shiftKey) { box.hidden = true; askAI(v, 'buscar'); return; }
      if ((e.ctrlKey || e.metaKey) && !/\s|\./.test(v)) { go('https://www.' + v + '.com'); return; }
      if (!box.hidden && sugItems[sugSel]) { runSuggestion(sugItems[sugSel]); return; }
      submitOmni(v);
    }
  });
  function submitOmni(v) {
    $('#suggest').hidden = true;
    if (/^\?/.test(v)) return askAI(v.replace(/^\?\s*/, ''), 'buscar');
    if (/^@agente\s+/i.test(v)) return askAI(v.replace(/^@agente\s+/i, ''), 'agente');
    if (looksLikeUrl(v)) return go(normalizeUrl(v));
    if (isQuestion(v)) return askAI(v, 'buscar');
    go(searchUrl(v));
  }
  function go(url) {
    urlInput.blur();
    const t = activeTab();
    if (!t) return createTab(url);
    t.url = url;
    ensureWebview(t);
    t.readyP.then(() => t.webview.loadURL(url).catch(() => {}));
    setUrlBar(url);
  }
  function suggest() {
    const v = urlInput.value.trim();
    const box = $('#suggest');
    if (!v) { box.hidden = true; return; }
    const q = v.toLowerCase();
    const items = [];
    const url = looksLikeUrl(v);
    const ask = { kind: 'ai', text: v, label: 'Preguntar a Navega: ' + v, key: 'Shift+Enter' };
    const web = { kind: 'search', text: v, label: 'Buscar en la web: ' + v };
    if (url) items.push({ kind: 'url', text: normalizeUrl(v), label: normalizeUrl(v) });
    if (isQuestion(v)) items.push(ask, web); else items.push(web, ask);
    items.push({ kind: 'agent', text: v, label: 'Que el agente lo haga: ' + v });
    const seen = new Set();
    bookmarks.concat(history).forEach((h) => {
      if (items.length > 10 || seen.has(h.url)) return;
      if ((h.title || '').toLowerCase().includes(q) || h.url.toLowerCase().includes(q)) {
        seen.add(h.url);
        items.push({ kind: 'url', text: h.url, label: h.title || h.url, sub: h.url, star: bookmarks.includes(h) });
      }
    });
    tabs.forEach((t) => {
      if (t.id !== activeId && (t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)) && items.length < 13)
        items.push({ kind: 'tab', id: t.id, label: 'Cambiar a pestaña: ' + t.title, sub: t.url });
    });
    sugItems = items;
    sugSel = 0;
    box.innerHTML = items.map((it, i) => '<div class="sg ' + (it.kind === 'ai' || it.kind === 'agent' ? 'ai' : '') + (i === 0 ? ' sel' : '') + '" data-i="' + i + '">' +
      icon(it.kind === 'ai' ? 'spark' : it.kind === 'agent' ? 'layers' : it.kind === 'search' ? 'search' : it.kind === 'tab' ? 'split' : it.star ? 'star' : 'clock') +
      '<span class="t">' + esc(it.label) + '</span>' + (it.sub ? '<span class="u">' + esc(it.sub) + '</span>' : '') +
      (it.key ? '<kbd>' + it.key + '</kbd>' : '') + '</div>').join('');
    $$('.sg', box).forEach((el) => el.addEventListener('mousedown', (e) => { e.preventDefault(); runSuggestion(items[+el.dataset.i]); }));
    box.hidden = false;
  }
  function runSuggestion(it) {
    $('#suggest').hidden = true;
    if (it.kind === 'ai') askAI(it.text, 'buscar');
    else if (it.kind === 'agent') askAI(it.text, 'agente');
    else if (it.kind === 'search') go(searchUrl(it.text));
    else if (it.kind === 'tab') activate(it.id);
    else go(it.text);
  }
  $('#omniAsk').onclick = () => { const v = urlInput.value.trim(); if (v && v !== (activeTab() || {}).url) askAI(v, 'buscar'); else openAssistant(true); };

  /* ======================= navegación ======================= */
  function updateNav() {
    const t = activeTab();
    const wv = t && t.webview;
    const ok = wv && t.wcId;
    $('#backBtn').disabled = !(ok && wv.canGoBack());
    $('#fwdBtn').disabled = !(ok && wv.canGoForward());
    $('#reloadBtn').innerHTML = icon(t && t.loading ? 'stop' : 'reload');
    $('#reloadBtn').dataset.tip = t && t.loading ? 'Detener' : 'Recargar (Ctrl+R)';
  }
  function progress(on) {
    const p = $('#progress');
    if (on) { p.style.opacity = '1'; p.style.width = '30%'; clearInterval(progress._i); progress._i = setInterval(() => { const w = parseFloat(p.style.width); if (w < 88) p.style.width = w + (90 - w) * 0.08 + '%'; }, 300); }
    else { clearInterval(progress._i); p.style.width = '100%'; setTimeout(() => { p.style.opacity = '0'; p.style.width = '0'; }, 300); }
  }
  const withWv = (fn) => () => { const t = activeTab(); if (t && t.webview && t.wcId) fn(t.webview, t); };
  $('#backBtn').onclick = withWv((w) => w.goBack());
  $('#fwdBtn').onclick = withWv((w) => w.goForward());
  $('#reloadBtn').onclick = withWv((w, t) => (t.loading ? w.stop() : w.reload()));
  $('#homeBtn').onclick = () => go(settings().homepage || HOME);
  $('#newTabBtn').onclick = () => createTab(HOME);
  $('#tabs').addEventListener('dblclick', (e) => { if (e.target.id === 'tabs') createTab(HOME); });

  /* ======================= vista dividida ======================= */
  function toggleSplit() {
    if (splitId) { splitId = null; layout(); renderTabs(); return; }
    const others = wsTabs().filter((t) => t.id !== activeId);
    if (others.length) splitId = others[others.length - 1].id;
    else { const n = createTab(HOME, { activate: false }); splitId = n.id; }
    ensureWebview(getTab(splitId));
    layout();
    renderTabs();
    toast('Vista dividida: haz clic en un panel para enfocarlo');
  }
  $('#splitBtn').onclick = toggleSplit;

  /* ======================= espacios de trabajo ======================= */
  function switchWorkspace(id, silent) {
    if (id === currentWs) return;
    currentWs = id;
    splitId = null;
    LS.set('navega.ws', id);
    if (!silent) {
      const list = wsTabs();
      if (list.length) activate(list[list.length - 1].id);
      else createTab(HOME);
    }
    renderTabs();
    layout();
  }
  const COLORS = ['#14E0C8', '#5B8CFF', '#FF2E88', '#FF8A3D', '#8B5CF6', '#22C55E', '#EAB308'];
  $('#wsBtn').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu([
      { title: 'Espacios de trabajo' },
      ...workspaces.map((w) => ({ label: w.name + ' (' + tabs.filter((t) => t.ws === w.id).length + ')', dot: w.color, cur: w.id === currentWs, run: () => switchWorkspace(w.id) })),
      '-',
      { label: 'Nuevo espacio…', icon: 'plus', run: () => promptModal('Nuevo espacio de trabajo', 'Nombre, ej. Trabajo, Escuela, Proyecto', '', (name) => {
        const w = { id: 'w' + Date.now().toString(36), name, color: COLORS[workspaces.length % COLORS.length] };
        workspaces.push(w); LS.set('navega.workspaces', workspaces); switchWorkspace(w.id);
      }) },
      { label: 'Renombrar este espacio…', icon: 'gear', run: () => { const w = workspaces.find((x) => x.id === currentWs); promptModal('Renombrar espacio', 'Nombre', w.name, (name) => { w.name = name; LS.set('navega.workspaces', workspaces); renderTabs(); }); } },
      { label: 'Organizar pestañas con IA', icon: 'spark', run: () => askAI('Agrupa mis pestañas abiertas por tema y sugiere nombres de espacios de trabajo para cada grupo, con la lista de pestañas de cada uno.', 'chat', { allTabs: true }) },
      ...(workspaces.length > 1 ? [{ label: 'Eliminar este espacio', icon: 'trash', run: () => {
        const dead = currentWs;
        const target = workspaces.find((w) => w.id !== dead).id;
        tabs.filter((t) => t.ws === dead).forEach((t) => (t.ws = target));
        workspaces = workspaces.filter((w) => w.id !== dead);
        LS.set('navega.workspaces', workspaces);
        currentWs = '';
        switchWorkspace(target);
        toast('Las pestañas se movieron a otro espacio');
      } }] : []),
    ], r.left, r.bottom + 6);
  };

  /* ======================= menús emergentes ======================= */
  function menu(items, x, y) {
    const pop = $('#popover');
    pop.innerHTML = items.map((it, i) => {
      if (it === '-') return '<div class="sep"></div>';
      if (it.title) return '<div class="pop-title">' + esc(it.title) + '</div>';
      return '<button class="mi' + (it.cur ? ' cur' : '') + '" data-i="' + i + '">' +
        (it.dot ? '<span class="dot" style="background:' + it.dot + '"></span>' : it.icon ? icon(it.icon) : '<svg></svg>') +
        '<span>' + esc(it.label) + '</span>' + (it.key ? '<span class="k">' + it.key + '</span>' : '') + '</button>';
    }).join('');
    $$('.mi', pop).forEach((b) => (b.onclick = () => { pop.hidden = true; items[+b.dataset.i].run(); }));
    showPop(x, y);
  }
  function showPop(x, y) {
    const pop = $('#popover');
    pop.hidden = false;
    pop.style.left = Math.min(x, innerWidth - pop.offsetWidth - 8) + 'px';
    pop.style.top = Math.min(y, innerHeight - pop.offsetHeight - 8) + 'px';
  }
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#popover') && !e.target.closest('#menuBtn,#wsBtn,#shieldBtn,#dlBtn')) $('#popover').hidden = true;
  });
  window.addEventListener('blur', () => { $('#popover').hidden = true; });

  $('#menuBtn').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = activeTab();
    menu([
      { label: 'Nueva pestaña', icon: 'plus', key: 'Ctrl+T', run: () => createTab(HOME) },
      { label: 'Nueva pestaña privada', icon: 'mask', key: 'Ctrl+Shift+N', run: () => createTab(HOME, { private: true }) },
      { label: 'Buscar pestañas', icon: 'search', key: 'Ctrl+Shift+A', run: tabSearch },
      '-',
      { label: 'Historial', icon: 'clock', key: 'Ctrl+H', run: showHistory },
      { label: 'Marcadores', icon: 'star', key: 'Ctrl+Shift+B', run: showBookmarks },
      { label: 'Descargas', icon: 'download', key: 'Ctrl+J', run: showDownloads },
      '-',
      { label: 'Acercar', icon: 'plus', key: 'Ctrl++', run: () => zoom(1) },
      { label: 'Alejar', icon: 'x', key: 'Ctrl+-', run: () => zoom(-1) },
      { label: 'Buscar en la página', icon: 'search', key: 'Ctrl+F', run: openFind },
      { label: 'Imprimir…', icon: 'layers', key: 'Ctrl+P', run: () => t && t.webview && t.webview.print() },
      '-',
      { label: 'Ajustes de IA y navegador', icon: 'gear', key: 'Ctrl+,', run: () => openAssistant(true, 'settings') },
      { label: 'Usar como navegador predeterminado', icon: 'globe', run: async () => toast((await N.setDefaultBrowser()) ? 'Solicitud enviada al sistema' : 'El sistema no lo permitió; hazlo desde la configuración del sistema') },
      { label: 'Borrar datos de navegación…', icon: 'trash', run: clearData },
      { label: 'Acerca de Navega-MX', icon: 'spark', run: about },
    ], r.right - 270, r.bottom + 6);
  };

  /* ======================= bloqueador ======================= */
  function updateShield(n) {
    const t = activeTab();
    const off = settings().adblock === false || (t && whitelist.includes(hostOf(t.url)));
    $('#shieldBtn').classList.toggle('off', !!off);
    $('#shieldCount').textContent = !off && n ? (n > 99 ? '99+' : n) : '';
  }
  N.onAdblockCount((d) => { const t = activeTab(); if (t && t.wcId === d.id) updateShield(d.count); });
  $('#shieldBtn').onclick = async (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = activeTab();
    const h = t ? hostOf(t.url) : '';
    const n = t && t.wcId ? await N.adblockCount(t.wcId) : 0;
    const global = settings().adblock !== false;
    const siteOn = !whitelist.includes(h);
    const pop = $('#popover');
    pop.innerHTML = '<div class="pop-title">Bloqueador de anuncios y rastreadores</div>' +
      '<div class="pop-row"><span class="big-num">' + n + '</span><span style="color:var(--muted)">bloqueados en esta página</span></div>' +
      '<div class="pop-row">Protección global<button class="switch ' + (global ? 'on' : '') + '" id="swGlobal"></button></div>' +
      (h ? '<div class="pop-row">Bloquear en ' + esc(h) + '<button class="switch ' + (siteOn ? 'on' : '') + '" id="swSite"></button></div>' : '') +
      '<div class="pop-row" style="color:var(--muted);font-size:12px">Motor de código abierto Ghostery Adblocker (MPL-2.0) con listas EasyList y EasyPrivacy.</div>';
    showPop(r.right - 300, r.bottom + 6);
    $('#swGlobal').onclick = () => {
      const s = settings(); s.adblock = !global; LS.set('navega.settings', s);
      N.setHostSettings({ adblock: s.adblock, whitelist }); notifyAssistant('settingsChanged');
      pop.hidden = true; updateShield(0); t && t.webview && t.webview.reload();
    };
    const sw = $('#swSite');
    if (sw) sw.onclick = () => {
      whitelist = siteOn ? whitelist.concat(h) : whitelist.filter((x) => x !== h);
      LS.set('navega.adblock.whitelist', whitelist);
      N.setHostSettings({ whitelist });
      pop.hidden = true; updateShield(0); t.webview.reload();
    };
  };

  /* ======================= marcadores ======================= */
  function updateStar() {
    const t = activeTab();
    $('#starBtn').classList.toggle('on', !!(t && bookmarks.some((b) => b.url === t.url)));
  }
  function toggleBookmark() {
    const t = activeTab();
    if (!t || /^navega:/.test(t.url)) return;
    if (bookmarks.some((b) => b.url === t.url)) { bookmarks = bookmarks.filter((b) => b.url !== t.url); toast('Marcador eliminado'); }
    else { bookmarks.unshift({ url: t.url, title: t.title, favicon: t.favicon, time: Date.now() }); toast('Agregado a marcadores'); }
    LS.set('navega.bookmarks', bookmarks);
    updateStar();
  }
  $('#starBtn').onclick = toggleBookmark;

  function listModal(title, placeholder, getRows, onPick, extraHead) {
    const card = $('#modalCard');
    card.innerHTML = '<div class="modal-head"><h3>' + esc(title) + '</h3><input id="mFilter" placeholder="' + esc(placeholder) + '">' + (extraHead || '') +
      '<button class="tb-btn" id="mClose" data-tip="Cerrar (Esc)">' + icon('x') + '</button></div><div class="modal-body" id="mBody"></div>';
    $('#modal').hidden = false;
    let sel = 0, rows = [];
    const draw = () => {
      rows = getRows($('#mFilter').value.trim().toLowerCase());
      sel = Math.min(sel, Math.max(0, rows.length - 1));
      $('#mBody').innerHTML = rows.length ? rows.map((r, i) => r.group ? '<div class="group-h">' + esc(r.group) + '</div>' :
        '<div class="row-item' + (i === sel ? ' sel' : '') + '" data-i="' + i + '">' +
        (r.favicon ? '<img src="' + esc(r.favicon) + '" onerror="this.className=\'ph\';this.removeAttribute(\'src\')">' : '<span class="ph"></span>') +
        '<span class="t">' + esc(r.title) + '</span><span class="u">' + esc(r.sub || '') + '</span>' + (r.date ? '<span class="d">' + esc(r.date) + '</span>' : '') +
        (r.remove ? '<button class="tb-btn x" data-tip="Quitar">' + icon('trash') + '</button>' : '') + '</div>').join('') : '<div class="empty-msg">Nada por aquí.</div>';
      $$('.row-item', $('#mBody')).forEach((el) => el.onclick = (e) => {
        const r = rows[+el.dataset.i];
        if (e.target.closest('.x')) { r.remove(); draw(); return; }
        closeModal(); onPick(r);
      });
    };
    $('#mFilter').oninput = () => { sel = 0; draw(); };
    $('#mFilter').onkeydown = (e) => {
      const items = rows.filter((r) => !r.group);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        do { sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; } while (rows[sel] && rows[sel].group && items.length);
        draw();
        const s = $('.row-item.sel'); s && s.scrollIntoView({ block: 'nearest' });
      }
      if (e.key === 'Enter' && rows[sel] && !rows[sel].group) { closeModal(); onPick(rows[sel]); }
      if (e.key === 'Escape') closeModal();
    };
    $('#mClose').onclick = closeModal;
    draw();
    setTimeout(() => $('#mFilter').focus(), 20);
    return draw;
  }
  function closeModal() { $('#modal').hidden = true; }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });

  function showBookmarks() {
    listModal('Marcadores', 'Filtrar marcadores…', (q) => bookmarks.filter((b) => !q || (b.title + b.url).toLowerCase().includes(q))
      .map((b) => ({ title: b.title || b.url, sub: hostOf(b.url), url: b.url, favicon: b.favicon, remove: () => { bookmarks = bookmarks.filter((x) => x !== b); LS.set('navega.bookmarks', bookmarks); updateStar(); } })),
    (r) => createTab(r.url));
  }
  function showHistory() {
    const draw = listModal('Historial', 'Buscar en el historial…', (q) => {
      const rows = [];
      let day = '';
      history.filter((h) => !q || ((h.title || '') + h.url).toLowerCase().includes(q)).slice(0, 400).forEach((h) => {
        const d = new Date(h.time).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
        if (d !== day) { rows.push({ group: d }); day = d; }
        rows.push({ title: h.title || h.url, sub: hostOf(h.url), url: h.url, favicon: h.favicon,
          date: new Date(h.time).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
          remove: () => { history = history.filter((x) => x !== h); saveHistory(); } });
      });
      return rows;
    }, (r) => createTab(r.url), '<button class="btn" id="clrHist">Borrar todo</button>');
    $('#clrHist').onclick = () => { if (confirm('¿Borrar todo el historial?')) { history = []; LS.set('navega.history', history); draw(); } };
  }
  function tabSearch() {
    listModal('Buscar pestañas', 'Escribe para filtrar entre todas tus pestañas…', (q) => {
      const rows = [];
      workspaces.forEach((w) => {
        const list = tabs.filter((t) => t.ws === w.id && (!q || (t.title + t.url).toLowerCase().includes(q)));
        if (!list.length) return;
        rows.push({ group: w.name });
        list.forEach((t) => rows.push({ title: t.title, sub: hostOf(t.url), id: t.id, favicon: t.favicon, remove: () => closeTab(t.id) }));
      });
      return rows;
    }, (r) => activate(r.id));
  }
  function promptModal(title, placeholder, value, cb) {
    const card = $('#modalCard');
    card.innerHTML = '<div class="modal-head"><h3>' + esc(title) + '</h3></div><form class="modal-body" style="display:flex;gap:8px;padding:14px" id="pf">' +
      '<input class="field" id="pv" placeholder="' + esc(placeholder) + '" value="' + esc(value) + '"><button class="btn primary">Aceptar</button></form>';
    $('#modal').hidden = false;
    setTimeout(() => $('#pv').select(), 20);
    $('#pf').onsubmit = (e) => { e.preventDefault(); const v = $('#pv').value.trim(); closeModal(); if (v) cb(v); };
    $('#pv').onkeydown = (e) => { if (e.key === 'Escape') closeModal(); };
  }

  /* ======================= descargas ======================= */
  N.onDownload((d) => {
    const i = downloads.findIndex((x) => x.id === d.id);
    if (i >= 0) downloads[i] = d; else downloads.unshift(d);
    $('#dlDot').hidden = !downloads.some((x) => x.state === 'progressing');
    if (d.state === 'completed') toast('Descargado: ' + d.name);
    if (!$('#modal').hidden && $('#modalCard').dataset.kind === 'dl') showDownloads();
  });
  function showDownloads() {
    const card = $('#modalCard');
    card.dataset.kind = 'dl';
    const fmt = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
    card.innerHTML = '<div class="modal-head"><h3>Descargas</h3><button class="tb-btn" id="mClose">' + icon('x') + '</button></div><div class="modal-body">' +
      (downloads.length ? downloads.map((d, i) => '<div class="row-item" data-i="' + i + '" style="flex-wrap:wrap">' + icon(d.state === 'completed' ? 'download' : 'clock') +
        '<span class="t">' + esc(d.name) + '</span><span class="d">' + (d.state === 'completed' ? fmt(d.total || d.received) : d.state === 'progressing' ? fmt(d.received) + (d.total ? ' de ' + fmt(d.total) : '') : d.state === 'cancelled' ? 'Cancelada' : 'Interrumpida') + '</span>' +
        (d.state === 'completed' ? '<button class="btn" data-a="open">Abrir</button><button class="btn" data-a="show">Mostrar</button>' : '') +
        (d.state === 'progressing' && d.total ? '<div class="dl-bar" style="flex-basis:100%"><i style="width:' + Math.round(d.received / d.total * 100) + '%"></i></div>' : '') + '</div>').join('')
        : '<div class="empty-msg">No hay descargas en esta sesión.</div>') + '</div>';
    $('#modal').hidden = false;
    $('#mClose').onclick = () => { closeModal(); card.dataset.kind = ''; };
    $$('.row-item .btn', card).forEach((b) => (b.onclick = () => {
      const d = downloads[+b.closest('.row-item').dataset.i];
      if (b.dataset.a === 'open') N.openPath(d.path); else N.showItem(d.path);
    }));
  }
  $('#dlBtn').onclick = showDownloads;

  /* ======================= buscar en la página ======================= */
  function openFind() {
    $('#findbar').hidden = false;
    $('#findInput').focus();
    $('#findInput').select();
  }
  function find(forward) {
    const t = activeTab();
    const v = $('#findInput').value;
    if (!t || !t.webview || !v) return;
    t.webview.findInPage(v, { forward, findNext: true });
  }
  $('#findInput').addEventListener('input', () => { const t = activeTab(); const v = $('#findInput').value; if (t && t.webview) { if (v) t.webview.findInPage(v); else { t.webview.stopFindInPage('clearSelection'); $('#findCount').textContent = ''; } } });
  $('#findInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') find(!e.shiftKey); if (e.key === 'Escape') closeFind(); });
  $('#findNext').onclick = () => find(true);
  $('#findPrev').onclick = () => find(false);
  $('#findClose').onclick = closeFind;
  function closeFind() { $('#findbar').hidden = true; const t = activeTab(); if (t && t.webview) t.webview.stopFindInPage('clearSelection'); $('#findCount').textContent = ''; }

  function zoom(d) {
    const t = activeTab();
    if (!t || !t.webview) return;
    t.zoom = d === 0 ? 0 : Math.max(-5, Math.min(6, t.zoom + d * 0.5));
    t.webview.setZoomLevel(t.zoom);
    toast('Zoom: ' + Math.round(Math.pow(1.2, t.zoom) * 100) + '%', 1200);
  }

  async function clearData() {
    const card = $('#modalCard');
    card.innerHTML = '<div class="modal-head"><h3>Borrar datos de navegación</h3></div><div class="modal-body" style="padding:14px;display:flex;flex-direction:column;gap:10px">' +
      '<label><input type="checkbox" id="cH" checked> Historial</label><label><input type="checkbox" id="cC" checked> Caché</label>' +
      '<label><input type="checkbox" id="cK"> Cookies y datos de sitios (cerrará tus sesiones)</label>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="cX">Cancelar</button><button class="btn primary" id="cOk">Borrar</button></div></div>';
    $('#modal').hidden = false;
    $('#cX').onclick = closeModal;
    $('#cOk').onclick = async () => {
      if ($('#cH').checked) { history = []; LS.set('navega.history', []); }
      if ($('#cC').checked) await N.clearData('cache');
      if ($('#cK').checked) await N.clearData('storage');
      closeModal();
      toast('Datos borrados');
    };
  }

  async function about() {
    const i = await N.appInfo();
    const card = $('#modalCard');
    card.innerHTML = '<div class="modal-head"><h3>Acerca de Navega-MX</h3><button class="tb-btn" id="mClose">' + icon('x') + '</button></div>' +
      '<div class="about"><img src="navega://app/shared/navega/img/logo.svg" width="96" height="96"><div><b style="font-size:18px">Navega-MX ' + esc(i.version) + '</b><br>' +
      'Navegador web con inteligencia artificial de código abierto.<br>Motor Chromium ' + esc(i.chrome) + ' · Electron ' + esc(i.electron) + ' · ' + esc(i.platform) + ' ' + esc(i.arch) + '<br>' +
      'Licencia: <a href="#" data-ext="https://www.gnu.org/licenses/gpl-3.0.html">GNU GPL v3 o posterior</a><br>' +
      'Desarrollador: Santiago Miguel · chago2850@gmail.com · 744 354 8848<br>' +
      '<a href="#" data-ext="https://github.com/chago2850-blip/Navega-MX">Código fuente en GitHub</a></div></div>';
    $('#modal').hidden = false;
    $('#mClose').onclick = closeModal;
    $$('a[data-ext]', card).forEach((a) => (a.onclick = (e) => { e.preventDefault(); closeModal(); createTab(a.dataset.ext); }));
  }

  /* ======================= asistente ======================= */
  const side = $('#side'), resizer = $('#resizer'), frame = $('#assistant');
  side.style.width = LS.get('navega.sideWidth', 420) + 'px';
  let frameReady = new Promise((r) => frame.addEventListener('load', r, { once: true }));
  function assistantUI() { try { return frame.contentWindow.NavegaUI; } catch (e) { return null; } }
  async function notifyAssistant(name, data) {
    const ui = assistantUI();
    if (ui) ui.onHostEvent(name, data);
  }
  async function openAssistant(focus, view) {
    side.hidden = false;
    resizer.hidden = document.body.classList.contains('ai-wide');
    $('#aiBtn').classList.add('on');
    await frameReady;
    await waitUI();
    if (view) notifyAssistant('view', { name: view });
    else if (focus) notifyAssistant('focus');
  }
  function closeAssistant() {
    side.hidden = true;
    resizer.hidden = true;
    document.body.classList.remove('ai-wide');
    $('#aiBtn').classList.remove('on');
    const t = activeTab();
    if (t && t.webview) t.webview.focus();
  }
  async function waitUI() {
    for (let i = 0; i < 50 && !assistantUI(); i++) await new Promise((r) => setTimeout(r, 100));
  }
  $('#aiBtn').onclick = () => (side.hidden ? openAssistant(true) : closeAssistant());
  async function askAI(text, mode, extra) {
    await openAssistant(false);
    if (mode === 'buscar') { document.body.classList.add('ai-wide'); resizer.hidden = true; notifyAssistant('wide', { on: true }); }
    notifyAssistant('ask', Object.assign({ text, mode, newThread: mode === 'buscar' }, extra || {}));
  }
  async function aiShortcut(name) {
    await openAssistant(false);
    notifyAssistant('shortcut', { name });
  }
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizer.classList.add('drag');
    document.body.classList.add('resizing');
    const move = (ev) => { const w = Math.max(320, Math.min(innerWidth * 0.7, innerWidth - ev.clientX)); side.style.width = w + 'px'; };
    const up = () => {
      resizer.classList.remove('drag');
      document.body.classList.remove('resizing');
      LS.set('navega.sideWidth', parseInt(side.style.width, 10));
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });

  /* ---------- puente para el asistente (mismo origen navega://app) ---------- */
  let pageSrc = null;
  async function pageScript() {
    if (!pageSrc) pageSrc = await (await fetch('navega://app/shared/navega/page/agent-dom.js')).text();
    return pageSrc;
  }
  function wrap(src, expr) {
    return '(function(){try{' + src + '\n;return ' + expr + ';}catch(e){return {error:String(e&&e.message||e)}}})()';
  }
  function tabInfo(t) { return { id: t.id, url: t.url, title: t.title, active: t.id === activeId, private: t.private, workspace: t.ws }; }
  async function readyTab(id) {
    const t = getTab(id);
    if (!t) throw new Error('La pestaña ya no existe');
    ensureWebview(t);
    await Promise.race([t.readyP, new Promise((r) => setTimeout(r, 15000))]);
    return t;
  }

  window.NavegaDesktopHost = {
    platform: 'desktop',
    appInfo: () => N.appInfo(),
    async getActiveTab() { const t = activeTab(); return t ? tabInfo(t) : null; },
    async listTabs() { return tabs.map(tabInfo); },
    async runInTab(id, code) {
      const t = await readyTab(id);
      return t.webview.executeJavaScript(code, false);
    },
    async getPageContent(id, maxLen) {
      const t = getTab(id);
      if (!t) return { error: 'Pestaña no encontrada' };
      if (!t.webview || !t.wcId) return { url: t.url, title: t.title, text: '(pestaña aún no cargada)' };
      return t.webview.executeJavaScript(wrap(await pageScript(), 'window.__navega.page(' + (maxLen || 15000) + ')'), false);
    },
    async navigate(id, url) {
      const t = await readyTab(id);
      t.url = url;
      t.webview.loadURL(url).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    },
    async openTab(url, o) {
      const t = createTab(url || HOME, { activate: !(o && o.background) });
      return t.id;
    },
    async activateTab(id) { activate(id); },
    async closeTab(id) { closeTab(id); },
    async goBack(id) { const t = await readyTab(id); if (t.webview.canGoBack()) t.webview.goBack(); },
    async waitForLoad(id, ms) {
      const t = await readyTab(id);
      if (!t.loading) return;
      await new Promise((r) => { t.waiters.push(r); setTimeout(r, ms || 15000); });
    },
    fetch: (url, opts) => N.fetch(url, opts),
    stream: (url, opts, onChunk) => N.stream(url, opts, onChunk),
    transcribe: (b64, mime, o) => N.transcribe(b64, mime, o),
    async getHistory(n) { return history.slice(0, n || 30).map((h) => ({ url: h.url, title: h.title, time: h.time })); },
    async setHostSettings(s) {
      N.setHostSettings({ adblock: s.adblock !== false, whitelist, theme: s.theme });
      applyTheme();
      updateShield(0);
    },
    async panel(action) {
      if (action === 'close') closeAssistant();
      else if (action === 'open') openAssistant(false);
      else if (action === 'expand') { document.body.classList.add('ai-wide'); resizer.hidden = true; }
      else if (action === 'collapse') { document.body.classList.remove('ai-wide'); resizer.hidden = side.hidden; }
    },
    async notify(title, body) { N.notify(title, body); },
  };

  /* ======================= eventos del sistema ======================= */
  N.onOpenTab((d) => {
    const cur = activeTab();
    createTab(d.url, { activate: !d.background, private: d.private || (cur && cur.private && !d.private ? true : false), after: cur && cur.id });
  });
  N.onAI((d) => {
    if (d.kind === 'shortcut') aiShortcut(d.name);
    else askAI(d.text, d.mode);
  });
  N.onMenu((cmd) => {
    const t = activeTab();
    const list = wsTabs();
    const i = list.indexOf(t);
    switch (cmd) {
      case 'new-tab': createTab(HOME); break;
      case 'new-private': createTab(HOME, { private: true }); break;
      case 'close-tab': if (t) closeTab(t.id); break;
      case 'reopen': { const c = closedTabs.pop(); if (c) createTab(c.url, { ws: c.ws }); break; }
      case 'focus-url': urlInput.focus(); urlInput.select(); break;
      case 'reload': t && t.webview && t.webview.reload(); break;
      case 'hard-reload': t && t.webview && t.webview.reloadIgnoringCache(); break;
      case 'back': $('#backBtn').click(); break;
      case 'forward': $('#fwdBtn').click(); break;
      case 'find': openFind(); break;
      case 'print': t && t.webview && t.webview.print(); break;
      case 'zoom-in': zoom(1); break;
      case 'zoom-out': zoom(-1); break;
      case 'zoom-reset': zoom(0); break;
      case 'split': toggleSplit(); break;
      case 'tab-search': tabSearch(); break;
      case 'devtools': t && t.webview && t.webview.openDevTools(); break;
      case 'history': showHistory(); break;
      case 'downloads': showDownloads(); break;
      case 'bookmark': toggleBookmark(); break;
      case 'bookmark-all': list.forEach((x) => { if (/^https?:/.test(x.url) && !bookmarks.some((b) => b.url === x.url)) bookmarks.unshift({ url: x.url, title: x.title, favicon: x.favicon, time: Date.now() }); }); LS.set('navega.bookmarks', bookmarks); updateStar(); toast('Pestañas guardadas en marcadores'); break;
      case 'bookmarks': showBookmarks(); break;
      case 'assistant': side.hidden ? openAssistant(true) : closeAssistant(); break;
      case 'voice': openAssistant(false).then(() => notifyAssistant('voice')); break;
      case 'summarize': aiShortcut('resumir'); break;
      case 'agent': openAssistant(false).then(() => notifyAssistant('ask', { text: '', mode: 'agente' })).then(() => {}); break;
      case 'settings': openAssistant(true, 'settings'); break;
      case 'about': about(); break;
      case 'next-tab': if (list.length) activate(list[(i + 1) % list.length].id); break;
      case 'prev-tab': if (list.length) activate(list[(i - 1 + list.length) % list.length].id); break;
      default:
        if (/^tab-\d$/.test(cmd)) { const n = +cmd.slice(4); const x = n === 9 ? list[list.length - 1] : list[n - 1]; if (x) activate(x.id); }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('#popover').hidden = true; if (!$('#modal').hidden) closeModal(); if (!$('#findbar').hidden) closeFind(); }
  });
  // Los datos compartidos (marcadores, ajustes) pueden cambiar desde el asistente.
  window.addEventListener('storage', (e) => {
    if (e.key === 'navega.settings') { applyTheme(); updateShield(0); }
  });

  /* ======================= restaurar sesión ======================= */
  const sess = LS.get('navega.session', null);
  if (sess && sess.tabs && sess.tabs.length) {
    sess.tabs.forEach((s) => {
      if (!workspaces.some((w) => w.id === s.ws)) s.ws = workspaces[0].id;
      createTab(s.url, { lazy: true, activate: false, title: s.title, ws: s.ws });
    });
    const a = tabs[sess.active] && tabs[sess.active].ws === currentWs ? tabs[sess.active] : wsTabs()[0];
    if (a) activate(a.id); else createTab(HOME);
  } else {
    createTab(HOME);
  }
  renderTabs();
})();
