/*
 * Navega-MX — puente con la plataforma (escritorio Electron o Android).
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Interfaz común que usa el asistente:
 *  platform, appInfo(), getActiveTab(), listTabs(), getPageContent(tabId),
 *  runInTab(tabId, code), navigate(tabId, url), openTab(url, {background}),
 *  activateTab(id), closeTab(id), waitForLoad(tabId, ms), fetch(url, opts),
 *  stream(url, opts, onChunk) -> {done, abort}, transcribe(b64, mime, opts),
 *  listen(), speak(text), getHistory(n), setHostSettings(obj), panel(action), notify(t, b)
 */

function androidHost() {
  const bridge = window.AndroidNavega;
  let seq = 0;
  const pending = new Map();
  const streams = new Map();

  window.NavegaHost = {
    _resolve(id, ok, payload) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.res(payload ? payload.v : undefined);
      else p.rej(new Error((payload && payload.v) || 'Error del sistema'));
    },
    _chunk(id, text) {
      const s = streams.get(id);
      if (s) s.onChunk(text);
    },
    _end(id, status, error) {
      const s = streams.get(id);
      if (!s) return;
      streams.delete(id);
      if (error) s.rej(new Error(error));
      else s.res({ status });
    },
    _event(name, data) {
      window.NavegaUI && window.NavegaUI.onHostEvent(name, data);
    },
  };

  function call(method, args) {
    return new Promise((res, rej) => {
      const id = 'c' + ++seq;
      pending.set(id, { res, rej });
      bridge.call(id, method, JSON.stringify(args || {}));
    });
  }

  return {
    platform: 'android',
    appInfo: () => call('appInfo'),
    getActiveTab: () => call('getActiveTab'),
    listTabs: () => call('listTabs'),
    async runInTab(tabId, code) {
      const raw = await call('runInTab', { tabId, code });
      try { return JSON.parse(raw); } catch (e) { return raw; }
    },
    async getPageContent(tabId, maxLen) {
      const src = await loadPageScript();
      return this.runInTab(tabId, wrap(src, 'window.__navega.page(' + (maxLen || 15000) + ')'));
    },
    navigate: (tabId, url) => call('navigate', { tabId, url }),
    openTab: (url, o) => call('openTab', { url, background: !!(o && o.background) }),
    activateTab: (tabId) => call('activateTab', { tabId }),
    closeTab: (tabId) => call('closeTab', { tabId }),
    waitForLoad: (tabId, ms) => call('waitForLoad', { tabId, ms: ms || 15000 }),
    goBack: (tabId) => call('goBack', { tabId }),
    fetch: (url, opts) => call('fetch', { url, opts: opts || {} }),
    stream(url, opts, onChunk) {
      const id = 's' + ++seq;
      let res, rej;
      const done = new Promise((a, b) => { res = a; rej = b; });
      streams.set(id, { onChunk, res, rej });
      bridge.call(id, 'stream', JSON.stringify({ url, opts: opts || {} }));
      return { done, abort: () => bridge.call('a' + id, 'abortStream', JSON.stringify({ id })) };
    },
    transcribe: (b64, mime, opts) => call('transcribe', { b64, mime, opts }),
    listen: () => call('listen'),
    speak: (text) => call('speak', { text }),
    stopSpeaking: () => call('stopSpeaking'),
    getHistory: (n) => call('getHistory', { n: n || 30 }),
    setHostSettings: (s) => call('setHostSettings', { settings: s }),
    panel: (action) => call('panel', { action }),
    notify: (title, body) => call('notify', { title, body }),
  };
}

function browserMockHost() {
  // Para probar la interfaz en un navegador normal (sin pestañas reales).
  return {
    platform: 'web',
    appInfo: async () => ({ version: 'dev', platform: 'web' }),
    getActiveTab: async () => ({ id: 'demo', url: location.href, title: document.title }),
    listTabs: async () => [{ id: 'demo', url: location.href, title: 'Demostración', active: true }],
    runInTab: async () => null,
    getPageContent: async () => ({ url: 'about:demo', title: 'Página de demostración', text: 'Contenido de ejemplo.' }),
    navigate: async () => {}, openTab: async () => 'demo', activateTab: async () => {},
    closeTab: async () => {}, waitForLoad: async () => {}, goBack: async () => {},
    async fetch(url, opts) {
      const r = await fetch(url, opts || {});
      return { status: r.status, text: await r.text() };
    },
    stream(url, opts, onChunk) {
      const ctl = new AbortController();
      const done = (async () => {
        const r = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
        const rd = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          onChunk(dec.decode(value, { stream: true }));
        }
        return { status: r.status };
      })();
      return { done, abort: () => ctl.abort() };
    },
    transcribe: async () => { throw new Error('No disponible en modo demostración'); },
    getHistory: async () => [], setHostSettings: async () => {}, panel: async () => {}, notify: async () => {},
  };
}

let pageScript = null;
export async function loadPageScript() {
  if (pageScript) return pageScript;
  const url = new URL('../page/agent-dom.js', import.meta.url);
  pageScript = await (await fetch(url)).text();
  return pageScript;
}

export function wrap(src, expr) {
  return (
    '(function(){try{' + src + '\n;return ' + expr +
    ';}catch(e){return {error:String(e&&e.message||e)}}})()'
  );
}

function pick() {
  try {
    if (window.parent !== window && window.parent.NavegaDesktopHost) return window.parent.NavegaDesktopHost;
  } catch (e) { /* distinto origen */ }
  if (window.AndroidNavega) return androidHost();
  return browserMockHost();
}

export const host = pick();
