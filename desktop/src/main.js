/*
 * Navega-MX — proceso principal (Electron).
 * Copyright (C) 2026 Santiago Miguel
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */
'use strict';

const {
  app, BrowserWindow, Menu, ipcMain, session, protocol, shell, dialog,
  clipboard, webContents, Notification, nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.join(__dirname, 'app');
const SHARED_DIR = app.isPackaged ? path.join(process.resourcesPath, 'shared') : path.join(__dirname, '..', '..', 'shared');
const VENDOR_DIR = path.join(__dirname, 'vendor');
const PARTITION = 'persist:navega';
const PRIVATE_PARTITION = 'navega-privado';

app.setName('Navega-MX');
// Identificarse como Chrome para máxima compatibilidad con los sitios.
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/i, '')
  .replace(/\sNavega-MX\/\S+/i, '')
  .replace(/\snavega-mx\/\S+/i, '');
app.commandLine.appendSwitch('enable-features', 'WebGPU,SharedArrayBuffer');
app.commandLine.appendSwitch('enable-unsafe-webgpu');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'navega',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, allowServiceWorkers: false },
  },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let blocker = null;
const blockedCount = new Map(); // webContentsId -> n
const streams = new Map();
const settingsHost = { adblock: true, whitelist: [] };

/* ---------------------------------------------------------------- archivos */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function resolveNavegaPath(urlStr) {
  const u = new URL(urlStr);
  let p = decodeURIComponent(u.pathname);
  // navega://inicio  -> página de nueva pestaña
  if (u.host === 'inicio') return path.join(SHARED_DIR, 'navega', 'ui', 'inicio.html');
  if (u.host !== 'app') return null;
  if (p === '/' || p === '') p = '/index.html';
  let base = APP_DIR;
  if (p.startsWith('/shared/')) { base = SHARED_DIR; p = p.slice('/shared'.length); }
  else if (p.startsWith('/vendor/')) { base = VENDOR_DIR; p = p.slice('/vendor'.length); }
  const full = path.normalize(path.join(base, p));
  if (!full.startsWith(base)) return null;
  return full;
}

function registerProtocol(ses) {
  ses.protocol.handle('navega', async (req) => {
    const file = resolveNavegaPath(req.url);
    if (!file) return new Response('No encontrado', { status: 404 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'credentialless',
        },
      });
    } catch (e) {
      return new Response('No encontrado', { status: 404 });
    }
  });
}

/* ---------------------------------------------------------------- bloqueador */
async function setupAdblock() {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    const original = blocker.onBeforeRequest;
    blocker.onBeforeRequest = (details, callback) => {
      if (!settingsHost.adblock || isWhitelisted(details)) return callback({});
      return original(details, callback);
    };
    blocker.on('request-blocked', (req) => {
      const id = req && req.tabId;
      if (typeof id === 'number' && id >= 0) {
        blockedCount.set(id, (blockedCount.get(id) || 0) + 1);
        if (win && !win.isDestroyed()) win.webContents.send('adblock:count', { id, count: blockedCount.get(id) });
      }
    });
    blocker.enableBlockingInSession(session.fromPartition(PARTITION));
    // La sesión privada solo recibe el bloqueo de red (los manejadores IPC
    // cosméticos ya están registrados por la sesión principal).
    const priv = session.fromPartition(PRIVATE_PARTITION);
    priv.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => blocker.onBeforeRequest(d, cb));
    priv.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => blocker.onHeadersReceived(d, cb));
  } catch (e) {
    console.error('[adblock] no disponible:', e.message);
  }
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
function isWhitelisted(details) {
  if (!settingsHost.whitelist.length) return false;
  let top = '';
  try {
    if (details.webContentsId != null) {
      const wc = webContents.fromId(details.webContentsId);
      if (wc) top = wc.getURL();
    }
  } catch (e) { /* sin pestaña */ }
  const h = hostOf(top || details.referrer || '');
  return !!h && settingsHost.whitelist.some((w) => h === w || h.endsWith('.' + w));
}

/* ---------------------------------------------------------------- sesiones */
function setupSession(ses, isPrivate) {
  registerProtocol(ses);
  ses.setUserAgent(app.userAgentFallback);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details && (details.requestingUrl || '');
    if (origin.startsWith('navega://')) return callback(true);
    const always = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'window-management'];
    if (always.includes(permission)) return callback(true);
    const ask = { media: 'usar la cámara o el micrófono', geolocation: 'conocer tu ubicación', notifications: 'mostrarte notificaciones', 'clipboard-read': 'leer tu portapapeles', midi: 'usar dispositivos MIDI', midiSysex: 'usar dispositivos MIDI' };
    if (!ask[permission] || !win) return callback(false);
    const r = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Permitir', 'Bloquear'], defaultId: 1, cancelId: 1,
      title: 'Permiso solicitado', message: hostOf(origin) + ' quiere ' + ask[permission] + '.',
    });
    callback(r === 0);
  });
  ses.on('will-download', (event, item, wc) => {
    const dir = app.getPath('downloads');
    let name = item.getFilename();
    let target = path.join(dir, name);
    const ext = path.extname(name), base = path.basename(name, ext);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, base + ' (' + i + ')' + ext);
    item.setSavePath(target);
    const id = Date.now() + Math.random().toString(36).slice(2, 6);
    const send = (state) => win && !win.isDestroyed() && win.webContents.send('download', {
      id, name: path.basename(target), path: target, url: item.getURL(), state,
      received: item.getReceivedBytes(), total: item.getTotalBytes(), private: !!isPrivate,
    });
    send('progressing');
    item.on('updated', (e, state) => send(state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing'));
    item.once('done', (e, state) => {
      send(state);
      if (state === 'completed' && Notification.isSupported())
        new Notification({ title: 'Descarga completada', body: path.basename(target) }).show();
    });
  });
}

/* ---------------------------------------------------------------- ventana */
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 720, minHeight: 480,
    title: 'Navega-MX',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0D1230' : '#F5F6FC',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
      spellcheck: true,
    },
  });
  win.loadURL('navega://app/index.html');
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('navega://')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => { sendToUI('open-tab', { url }); return { action: 'deny' }; });
}

function sendToUI(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

/* Configura cada <webview> (pestaña) */
app.on('web-contents-created', (e, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url, disposition }) => {
      sendToUI('open-tab', { url, background: disposition === 'background-tab' });
      return { action: 'deny' };
    });
    contents.on('context-menu', (ev, params) => buildContextMenu(contents, params).popup());
  }
});

app.on('will-attach-webview', (e, webPreferences, params) => {
  delete webPreferences.preloadURL;
  webPreferences.preload = path.join(__dirname, 'webview-preload.js');
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  if (params.partition !== PARTITION && params.partition !== PRIVATE_PARTITION) params.partition = PARTITION;
  if (!/^(https?:|navega:|about:|file:|data:)/.test(params.src || 'about:blank')) params.src = 'about:blank';
});

function buildContextMenu(wc, p) {
  const t = [];
  const id = wc.id;
  if (p.linkURL) {
    t.push({ label: 'Abrir enlace en pestaña nueva', click: () => sendToUI('open-tab', { url: p.linkURL, background: true }) });
    t.push({ label: 'Abrir enlace en pestaña privada', click: () => sendToUI('open-tab', { url: p.linkURL, private: true }) });
    t.push({ label: 'Copiar dirección del enlace', click: () => clipboard.writeText(p.linkURL) });
    t.push({ type: 'separator' });
  }
  if (p.hasImageContents && p.srcURL) {
    t.push({ label: 'Abrir imagen en pestaña nueva', click: () => sendToUI('open-tab', { url: p.srcURL }) });
    t.push({ label: 'Guardar imagen…', click: () => wc.downloadURL(p.srcURL) });
    t.push({ label: 'Copiar imagen', click: () => wc.copyImageAt(p.x, p.y) });
    t.push({ type: 'separator' });
  }
  if (p.selectionText) {
    const sel = p.selectionText.trim();
    t.push({ label: 'Preguntar a Navega sobre «' + (sel.length > 24 ? sel.slice(0, 24) + '…' : sel) + '»', click: () => sendToUI('ai', { kind: 'ask', mode: 'chat', text: 'Explícame esto: «' + sel + '»' }) });
    t.push({ label: 'Traducir selección', click: () => sendToUI('ai', { kind: 'ask', mode: 'chat', text: 'Traduce al español: «' + sel + '»' }) });
    t.push({ label: 'Buscar en la web con IA', click: () => sendToUI('ai', { kind: 'ask', mode: 'buscar', text: sel }) });
    t.push({ type: 'separator' });
    t.push({ label: 'Copiar', role: 'copy' });
  }
  if (p.isEditable) {
    t.push({ label: 'Deshacer', role: 'undo' }, { label: 'Cortar', role: 'cut' }, { label: 'Copiar', role: 'copy' },
      { label: 'Pegar', role: 'paste' }, { label: 'Seleccionar todo', role: 'selectAll' });
    if (p.misspelledWord) {
      t.unshift({ type: 'separator' });
      p.dictionarySuggestions.slice(0, 4).reverse().forEach((s) => t.unshift({ label: s, click: () => wc.replaceMisspelling(s) }));
    }
    t.push({ type: 'separator' });
  }
  if (!p.linkURL && !p.selectionText && !p.isEditable) {
    t.push({ label: 'Atrás', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
    t.push({ label: 'Adelante', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
    t.push({ label: 'Recargar', click: () => wc.reload() });
    t.push({ type: 'separator' });
    t.push({ label: 'Resumir esta página', click: () => sendToUI('ai', { kind: 'shortcut', name: 'resumir', wcId: id }) });
    t.push({ label: 'Puntos clave', click: () => sendToUI('ai', { kind: 'shortcut', name: 'puntos', wcId: id }) });
    t.push({ label: 'Traducir página', click: () => sendToUI('ai', { kind: 'shortcut', name: 'traducir', wcId: id }) });
    t.push({ type: 'separator' });
    t.push({ label: 'Guardar página como…', click: () => savePage(wc) });
    t.push({ label: 'Imprimir…', click: () => wc.print() });
  }
  t.push({ type: 'separator' });
  t.push({ label: 'Inspeccionar', click: () => wc.inspectElement(p.x, p.y) });
  return Menu.buildFromTemplate(t);
}

async function savePage(wc) {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), (wc.getTitle() || 'pagina').replace(/[\\/:*?"<>|]+/g, '_') + '.html'),
    filters: [{ name: 'Página web completa', extensions: ['html'] }],
  });
  if (!r.canceled && r.filePath) wc.savePage(r.filePath, 'HTMLComplete').catch(() => {});
}

/* ---------------------------------------------------------------- menú */
function buildMenu() {
  const m = (cmd) => () => sendToUI('menu', cmd);
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: 'Navega-MX', submenu: [
      { label: 'Acerca de Navega-MX', click: m('about') }, { type: 'separator' },
      { label: 'Ajustes…', accelerator: 'Cmd+,', click: m('settings') }, { type: 'separator' },
      { role: 'hide', label: 'Ocultar Navega-MX' }, { role: 'hideOthers', label: 'Ocultar otros' }, { type: 'separator' },
      { role: 'quit', label: 'Salir de Navega-MX' }] }] : []),
    { label: 'Archivo', submenu: [
      { label: 'Nueva pestaña', accelerator: 'CmdOrCtrl+T', click: m('new-tab') },
      { label: 'Nueva pestaña privada', accelerator: 'CmdOrCtrl+Shift+N', click: m('new-private') },
      { label: 'Reabrir pestaña cerrada', accelerator: 'CmdOrCtrl+Shift+T', click: m('reopen') },
      { label: 'Cerrar pestaña', accelerator: 'CmdOrCtrl+W', click: m('close-tab') },
      { type: 'separator' },
      { label: 'Imprimir…', accelerator: 'CmdOrCtrl+P', click: m('print') },
      ...(isMac ? [] : [{ type: 'separator' }, { label: 'Ajustes', accelerator: 'Ctrl+,', click: m('settings') }, { role: 'quit', label: 'Salir' }]),
    ] },
    { label: 'Editar', submenu: [
      { role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' }, { type: 'separator' },
      { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' },
      { role: 'selectAll', label: 'Seleccionar todo' }, { type: 'separator' },
      { label: 'Buscar en la página', accelerator: 'CmdOrCtrl+F', click: m('find') },
    ] },
    { label: 'Ver', submenu: [
      { label: 'Ir a la barra de direcciones', accelerator: 'CmdOrCtrl+L', click: m('focus-url') },
      { label: 'Recargar', accelerator: 'CmdOrCtrl+R', click: m('reload') },
      { label: 'Recargar', accelerator: 'F5', click: m('reload'), visible: false },
      { label: 'Recargar sin caché', accelerator: 'CmdOrCtrl+Shift+R', click: m('hard-reload') },
      { type: 'separator' },
      { label: 'Acercar', accelerator: 'CmdOrCtrl+Plus', click: m('zoom-in') },
      { label: 'Acercar', accelerator: 'CmdOrCtrl+=', click: m('zoom-in'), visible: false },
      { label: 'Alejar', accelerator: 'CmdOrCtrl+-', click: m('zoom-out') },
      { label: 'Tamaño real', accelerator: 'CmdOrCtrl+0', click: m('zoom-reset') },
      { type: 'separator' },
      { label: 'Vista dividida', accelerator: 'CmdOrCtrl+Shift+S', click: m('split') },
      { label: 'Buscar pestañas', accelerator: 'CmdOrCtrl+Shift+A', click: m('tab-search') },
      { label: 'Pantalla completa', role: 'togglefullscreen' },
      { label: 'Herramientas de desarrollo', accelerator: 'F12', click: m('devtools') },
    ] },
    { label: 'Historial', submenu: [
      { label: 'Atrás', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: m('back') },
      { label: 'Adelante', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: m('forward') },
      { label: 'Ver historial', accelerator: isMac ? 'Cmd+Y' : 'Ctrl+H', click: m('history') },
      { label: 'Descargas', accelerator: isMac ? 'Cmd+Shift+J' : 'Ctrl+J', click: m('downloads') },
    ] },
    { label: 'Marcadores', submenu: [
      { label: 'Agregar a marcadores', accelerator: 'CmdOrCtrl+D', click: m('bookmark') },
      { label: 'Marcar todas las pestañas', accelerator: 'CmdOrCtrl+Shift+D', click: m('bookmark-all') },
      { label: 'Ver marcadores', accelerator: 'CmdOrCtrl+Shift+B', click: m('bookmarks') },
    ] },
    { label: 'IA', submenu: [
      { label: 'Asistente', accelerator: 'Alt+A', click: m('assistant') },
      { label: 'Modo de voz', accelerator: 'Alt+Shift+V', click: m('voice') },
      { label: 'Resumir página', accelerator: 'Alt+S', click: m('summarize') },
      { label: 'Agente: hacer una tarea…', accelerator: 'Alt+G', click: m('agent') },
    ] },
    { label: 'Pestañas', submenu: [
      { label: 'Siguiente pestaña', accelerator: 'Ctrl+Tab', click: m('next-tab') },
      { label: 'Pestaña anterior', accelerator: 'Ctrl+Shift+Tab', click: m('prev-tab') },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ label: 'Pestaña ' + n, accelerator: 'CmdOrCtrl+' + n, click: m('tab-' + n), visible: false })),
    ] },
    { label: 'Ayuda', submenu: [
      { label: 'Acerca de Navega-MX', click: m('about') },
      { label: 'Código fuente (GPL-3.0)', click: () => shell.openExternal('https://github.com/chago2850-blip/Navega-MX') },
      { label: 'Instalar Ollama (IA local)', click: () => shell.openExternal('https://ollama.com/download') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------------------------------------------------------- IPC */
function cleanHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) if (v != null) out[k] = String(v);
  return out;
}

ipcMain.handle('net:fetch', async (e, url, opts) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL no permitida');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), (opts && opts.timeout) || 30000);
  try {
    const r = await fetch(url, {
      method: (opts && opts.method) || 'GET',
      headers: Object.assign({ 'User-Agent': app.userAgentFallback }, cleanHeaders(opts && opts.headers)),
      body: opts && opts.body ? opts.body : undefined,
      signal: ctl.signal,
      redirect: 'follow',
    });
    const ct = r.headers.get('content-type') || '';
    let text;
    if (/text|json|xml|html|javascript/i.test(ct) || !ct) {
      const buf = Buffer.from(await r.arrayBuffer());
      text = buf.slice(0, 3 * 1024 * 1024).toString('utf8');
    } else text = '';
    return { status: r.status, text, contentType: ct, url: r.url };
  } finally {
    clearTimeout(t);
  }
});

ipcMain.on('net:stream', async (e, id, url, opts) => {
  const sender = e.sender;
  const ctl = new AbortController();
  streams.set(id, ctl);
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('URL no permitida');
    const r = await fetch(url, {
      method: (opts && opts.method) || 'POST',
      headers: cleanHeaders(opts && opts.headers),
      body: opts && opts.body,
      signal: ctl.signal,
    });
    if (!r.ok && r.status >= 400) {
      const txt = await r.text().catch(() => '');
      let msg = 'HTTP ' + r.status;
      try { const j = JSON.parse(txt); msg += ': ' + ((j.error && (j.error.message || j.error)) || txt.slice(0, 200)); } catch (er) { if (txt) msg += ': ' + txt.slice(0, 200); }
      throw new Error(msg);
    }
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      if (sender.isDestroyed()) break;
      sender.send('net:chunk', id, dec.decode(chunk, { stream: true }));
    }
    if (!sender.isDestroyed()) sender.send('net:end', id, r.status, null);
  } catch (err) {
    if (!sender.isDestroyed()) sender.send('net:end', id, 0, ctl.signal.aborted ? null : (err.cause && err.cause.code ? err.cause.code + ' ' : '') + err.message);
  } finally {
    streams.delete(id);
  }
});
ipcMain.on('net:abort', (e, id) => { const c = streams.get(id); if (c) c.abort(); });

ipcMain.handle('stt:transcribe', async (e, b64, mime, o) => {
  const base = String((o && o.url) || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Configura la URL del servidor de transcripción');
  const fd = new FormData();
  const ext = /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : /mp4|m4a/.test(mime) ? 'm4a' : 'webm';
  fd.append('file', new Blob([Buffer.from(b64, 'base64')], { type: mime || 'audio/webm' }), 'voz.' + ext);
  fd.append('model', (o && o.model) || 'whisper-1');
  if (o && o.language) fd.append('language', o.language);
  const r = await fetch(base + '/audio/transcriptions', { method: 'POST', body: fd });
  const txt = await r.text();
  if (!r.ok) throw new Error('Transcripción falló (' + r.status + '): ' + txt.slice(0, 200));
  try { return JSON.parse(txt).text || ''; } catch (er) { return txt; }
});

ipcMain.handle('host:settings', (e, s) => {
  if (s && typeof s.adblock === 'boolean') settingsHost.adblock = s.adblock;
  if (s && Array.isArray(s.whitelist)) settingsHost.whitelist = s.whitelist.map(String);
  if (s && s.theme) nativeTheme.themeSource = s.theme === 'claro' ? 'light' : s.theme === 'oscuro' ? 'dark' : 'system';
  return true;
});
ipcMain.handle('adblock:count', (e, wcId) => blockedCount.get(wcId) || 0);
ipcMain.on('adblock:reset', (e, wcId) => blockedCount.delete(wcId));
ipcMain.handle('app:info', () => ({
  version: app.getVersion(), platform: process.platform, arch: process.arch,
  electron: process.versions.electron, chrome: process.versions.chrome, adblock: !!blocker,
}));
ipcMain.on('shell:open-path', (e, p) => { if (p) shell.openPath(p); });
ipcMain.on('shell:show-item', (e, p) => { if (p) shell.showItemInFolder(p); });
ipcMain.on('shell:external', (e, url) => { if (/^(https?:|mailto:)/.test(url)) shell.openExternal(url); });
ipcMain.on('notify', (e, title, body) => {
  if (Notification.isSupported()) new Notification({ title: String(title), body: String(body || '') }).show();
});
ipcMain.handle('wc:clear-data', async (e, what) => {
  const ses = session.fromPartition(PARTITION);
  if (what === 'cache') await ses.clearCache();
  else await ses.clearStorageData();
  return true;
});
ipcMain.handle('app:set-default', () => {
  const ok = app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https');
  return ok;
});

/* ---------------------------------------------------------------- arranque */
function urlFromArgv(argv) {
  return (argv || []).find((a) => /^https?:\/\//i.test(a));
}

app.on('second-instance', (e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const u = urlFromArgv(argv);
  if (u) sendToUI('open-tab', { url: u });
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (win) sendToUI('open-tab', { url });
  else app.once('browser-window-created', () => setTimeout(() => sendToUI('open-tab', { url }), 1500));
});

app.whenReady().then(async () => {
  registerProtocol(session.defaultSession);
  setupSession(session.fromPartition(PARTITION), false);
  setupSession(session.fromPartition(PRIVATE_PARTITION), true);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true));
  buildMenu();
  createWindow();
  setupAdblock();
  const u = urlFromArgv(process.argv);
  if (u) win.webContents.once('did-finish-load', () => setTimeout(() => sendToUI('open-tab', { url: u }), 600));
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => {
  session.fromPartition(PRIVATE_PARTITION).clearStorageData().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------------------------------------------------------- prueba de humo (CI) */
if (process.env.NAVEGA_SMOKE) {
  app.on('web-contents-created', (e, c) => {
    c.on('console-message', (ev, level, message) => {
      const msg = (ev && ev.message) || message;
      const lvl = ev && ev.level != null ? ev.level : level;
      if (lvl === 'error' || lvl === 3 || /error/i.test(String(msg))) console.log('[consola ' + c.getType() + ']', msg);
    });
    c.on('render-process-gone', (ev, d) => console.log('[proceso caído]', d && d.reason));
  });
  app.whenReady().then(() => setTimeout(async () => {
    let ok = true;
    try {
      const r = await win.webContents.executeJavaScript(`(async () => {
        const out = { titulo: document.title, pestanas: document.querySelectorAll('#tabs .tab').length };
        out.webviews = Array.from(document.querySelectorAll('webview')).map((w) => w.getURL());
        document.getElementById('aiBtn').click();
        await new Promise((r) => setTimeout(r, 2500));
        const f = document.getElementById('assistant').contentWindow;
        out.asistente = !!(f && f.NavegaUI);
        const t = await NavegaDesktopHost.getActiveTab();
        out.activa = t && t.url;
        const c = await NavegaDesktopHost.getPageContent(t.id, 400);
        out.contenido = c && (c.title + ' :: ' + String(c.text || c.error).slice(0, 120));
        const snap = await NavegaDesktopHost.runInTab(t.id, await (await fetch('navega://app/shared/navega/page/agent-dom.js')).text() + ';window.__navega.snapshot({max:5}).elementos');
        out.agente = String(snap).split('\\n').slice(0, 5);
        return out;
      })()`);
      console.log('[humo] ' + JSON.stringify(r, null, 1));
      ok = r.pestanas >= 1 && r.asistente && !!r.contenido && !/error/i.test(r.contenido);
      console.log('[humo] bloqueador cargado: ' + !!blocker);
      await new Promise((res) => setTimeout(res, 1500));
      const img = await win.webContents.capturePage();
      const jpg = img.resize({ width: 900 }).toJPEG(55).toString('base64');
      console.log('[captura-inicio]' + jpg + '[captura-fin]');
    } catch (e) {
      ok = false;
      console.log('[humo] error: ' + e.stack);
    }
    console.log('[humo] resultado: ' + (ok ? 'OK' : 'FALLO'));
    app.exit(ok ? 0 : 1);
  }, 12000));
}
