/*
 * Navega-MX — preload de la ventana principal.
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const chunkHandlers = new Map();
ipcRenderer.on('net:chunk', (e, id, text) => { const h = chunkHandlers.get(id); if (h) h.onChunk(text); });
ipcRenderer.on('net:end', (e, id, status, error) => {
  const h = chunkHandlers.get(id);
  if (!h) return;
  chunkHandlers.delete(id);
  if (error) h.reject(new Error(error));
  else h.resolve({ status });
});
let seq = 0;

function on(channel, cb) {
  const fn = (e, ...args) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

contextBridge.exposeInMainWorld('navegaNative', {
  platform: process.platform,
  fetch: (url, opts) => ipcRenderer.invoke('net:fetch', url, opts || {}),
  stream(url, opts, onChunk) {
    const id = 'st' + Date.now() + '_' + ++seq;
    let resolve, reject;
    const done = new Promise((a, b) => { resolve = a; reject = b; });
    chunkHandlers.set(id, { onChunk, resolve, reject });
    ipcRenderer.send('net:stream', id, url, opts || {});
    return { done, abort: () => ipcRenderer.send('net:abort', id) };
  },
  transcribe: (b64, mime, o) => ipcRenderer.invoke('stt:transcribe', b64, mime, o || {}),
  setHostSettings: (s) => ipcRenderer.invoke('host:settings', s),
  adblockCount: (wcId) => ipcRenderer.invoke('adblock:count', wcId),
  adblockReset: (wcId) => ipcRenderer.send('adblock:reset', wcId),
  appInfo: () => ipcRenderer.invoke('app:info'),
  clearData: (what) => ipcRenderer.invoke('wc:clear-data', what),
  setDefaultBrowser: () => ipcRenderer.invoke('app:set-default'),
  openPath: (p) => ipcRenderer.send('shell:open-path', p),
  showItem: (p) => ipcRenderer.send('shell:show-item', p),
  openExternal: (u) => ipcRenderer.send('shell:external', u),
  notify: (t, b) => ipcRenderer.send('notify', t, b),
  onMenu: (cb) => on('menu', cb),
  onOpenTab: (cb) => on('open-tab', cb),
  onAI: (cb) => on('ai', cb),
  onDownload: (cb) => on('download', cb),
  onAdblockCount: (cb) => on('adblock:count', cb),
});
