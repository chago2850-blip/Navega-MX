/*
 * Navega-MX — preload de las pestañas.
 * Solo expone una API mínima a las páginas internas navega:// (nueva pestaña).
 * Los sitios web normales no reciben ninguna API.
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'navega:') {
  contextBridge.exposeInMainWorld('navegaNewtab', {
    ask: (text, mode) => ipcRenderer.sendToHost('newtab-ask', String(text || ''), String(mode || 'buscar')),
  });
}
