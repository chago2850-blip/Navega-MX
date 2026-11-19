/*
 * Navega-MX — almacenamiento local (ajustes, memoria, atajos, conversaciones, tareas).
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Todo se guarda solo en este equipo. Nada se envía a terceros.
 */

export const DEFAULTS = {
  provider: 'ollama', // ollama | openai | webllm
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: '',
  openaiUrl: 'http://localhost:8080/v1',
  openaiKey: '',
  openaiModel: '',
  webllmModel: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  temperature: 0.4,
  language: 'español',
  searchEngine: 'duckduckgo', // duckduckgo | searxng | google | bing | brave | startpage
  searxUrl: '',
  answerSources: 5,
  adblock: true,
  memoryMode: 'local', // off | local | local+historial
  agentConfirm: true,
  agentMaxSteps: 25,
  sttUrl: '', // servidor compatible con OpenAI /v1 para transcripción (whisper.cpp, Speaches…)
  sttModel: 'whisper-1',
  tts: false,
  theme: 'auto', // auto | claro | oscuro
  homepage: 'navega://inicio',
};

const K = {
  settings: 'navega.settings',
  memory: 'navega.memory',
  shortcuts: 'navega.shortcuts',
  threads: 'navega.threads',
  scheduled: 'navega.scheduled',
};

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch (e) {
    return fallback;
  }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* almacenamiento lleno o bloqueado */ }
}

export const store = {
  settings() { return Object.assign({}, DEFAULTS, read(K.settings, {})); },
  saveSettings(s) { write(K.settings, s); },

  memory() { return read(K.memory, []); },
  addMemory(text) {
    const m = this.memory();
    const t = String(text || '').trim();
    if (!t || m.some((x) => x.text.toLowerCase() === t.toLowerCase())) return m;
    m.unshift({ id: Date.now().toString(36), text: t, date: new Date().toISOString() });
    write(K.memory, m.slice(0, 300));
    return m;
  },
  removeMemory(id) { write(K.memory, this.memory().filter((x) => x.id !== id)); },
  clearMemory() { write(K.memory, []); },

  shortcuts() { return read(K.shortcuts, []); },
  saveShortcuts(list) { write(K.shortcuts, list); },

  threads() { return read(K.threads, []); },
  saveThread(thread) {
    const list = this.threads().filter((t) => t.id !== thread.id);
    list.unshift(thread);
    write(K.threads, list.slice(0, 60));
  },
  deleteThread(id) { write(K.threads, this.threads().filter((t) => t.id !== id)); },
  clearThreads() { write(K.threads, []); },

  scheduled() { return read(K.scheduled, []); },
  saveScheduled(list) { write(K.scheduled, list); },

  exportAll() {
    return JSON.stringify({
      app: 'Navega-MX', fecha: new Date().toISOString(),
      settings: Object.assign({}, this.settings(), { openaiKey: '' }),
      memory: this.memory(), shortcuts: this.shortcuts(), scheduled: this.scheduled(),
    }, null, 2);
  },
  importAll(json) {
    const d = JSON.parse(json);
    if (d.settings) write(K.settings, Object.assign(this.settings(), d.settings));
    if (Array.isArray(d.memory)) write(K.memory, d.memory);
    if (Array.isArray(d.shortcuts)) write(K.shortcuts, d.shortcuts);
    if (Array.isArray(d.scheduled)) write(K.scheduled, d.scheduled);
  },
};

export const BUILTIN_SHORTCUTS = [
  { name: 'resumir', desc: 'Resume la página actual', mode: 'chat', prompt: 'Resume esta página en un párrafo breve y luego 5 viñetas con lo más importante.' },
  { name: 'puntos', desc: 'Puntos clave de la página', mode: 'chat', prompt: 'Extrae los puntos clave de esta página como una lista numerada, con datos concretos.' },
  { name: 'traducir', desc: 'Traduce la página o el texto seleccionado', mode: 'chat', prompt: 'Traduce al español el texto seleccionado (o, si no hay selección, el contenido principal de la página). Conserva el formato.' },
  { name: 'explicar', desc: 'Explica en palabras sencillas', mode: 'chat', prompt: 'Explica el contenido de esta página como si yo no supiera nada del tema, con ejemplos.' },
  { name: 'comparar', desc: 'Compara todas las pestañas abiertas', mode: 'chat', allTabs: true, prompt: 'Compara la información de todas mis pestañas abiertas en una tabla y dime cuál conviene más y por qué.' },
  { name: 'pestanas', desc: 'Sintetiza todas las pestañas', mode: 'chat', allTabs: true, prompt: 'Haz una síntesis de lo que dicen todas mis pestañas abiertas, señalando coincidencias y contradicciones.' },
  { name: 'correo', desc: 'Redacta una respuesta al correo abierto', mode: 'chat', prompt: 'Redacta una respuesta cordial y profesional al correo que estoy viendo. Dame solo el texto listo para copiar.' },
  { name: 'datos', desc: 'Extrae datos en tabla', mode: 'chat', prompt: 'Extrae los datos estructurados de esta página (nombres, precios, fechas, cifras) en una tabla Markdown.' },
  { name: 'verificar', desc: 'Verifica afirmaciones con la web', mode: 'buscar', prompt: 'Verifica con fuentes de la web las principales afirmaciones de esta página: {pagina}' },
  { name: 'buscar', desc: 'Busca en la web con respuesta y fuentes', mode: 'buscar', prompt: '{texto}' },
  { name: 'agente', desc: 'El agente toma el control del navegador', mode: 'agente', prompt: '{texto}' },
  { name: 'recordar', desc: 'Guarda un dato en tu memoria local', mode: 'recordar', prompt: '{texto}' },
];
