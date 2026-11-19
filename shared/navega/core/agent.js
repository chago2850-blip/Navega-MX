/*
 * Navega-MX — agente que "toma el control" del navegador para completar tareas.
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { host, loadPageScript, wrap } from './host.js';
import { chat, parseJSON, systemBase } from './ai.js';

const SENSITIVE = /(pagar|pago|comprar|compra|checkout|confirmar pedido|realizar pedido|place order|buy|pay|purchase|eliminar|borrar|delete|remove|enviar|send|publicar|post|transferir|transfer|suscrib|subscribe|firmar|sign)/i;

const TOOLS = `Acciones disponibles (responde con UNA por turno):
- {"type":"navigate","url":"https://..."}     abre una URL en la pestaña del agente
- {"type":"click","id":N}                       hace clic en el elemento [N]
- {"type":"type","id":N,"text":"...","enter":true|false}  escribe en un campo
- {"type":"select","id":N,"value":"..."}        elige una opción de un <select>
- {"type":"key","key":"Enter|Escape|Tab|ArrowDown","id":N?}  pulsa una tecla
- {"type":"scroll","direction":"down|up"}        desplaza la página
- {"type":"back"}                               regresa a la página anterior
- {"type":"read"}                               lee más texto de la página actual
- {"type":"search","query":"..."}               busca en la web
- {"type":"wait","seconds":2}                   espera a que cargue algo
- {"type":"ask_user","question":"..."}          pide un dato al usuario (contraseñas, decisiones)
- {"type":"finish","answer":"..."}               termina y entrega el resultado final al usuario`;

function searchUrl(q, s) {
  const e = encodeURIComponent(q);
  switch (s.searchEngine) {
    case 'google': return 'https://www.google.com/search?q=' + e;
    case 'bing': return 'https://www.bing.com/search?q=' + e;
    case 'brave': return 'https://search.brave.com/search?q=' + e;
    case 'startpage': return 'https://www.startpage.com/do/search?q=' + e;
    case 'searxng': if (s.searxUrl) return s.searxUrl.replace(/\/+$/, '') + '/search?q=' + e; // fallthrough
    default: return 'https://duckduckgo.com/?kl=mx-es&q=' + e;
  }
}

/**
 * @param {object} o
 *  goal, settings, memory, tabId (opcional), background (bool),
 *  onStep({kind, text, data}), confirm(text) -> Promise<bool>, askUser(q) -> Promise<string>
 * @returns {{done: Promise<string>, stop: Function, tabId: Promise<string>}}
 */
export function runAgent(o) {
  const s = o.settings;
  let stopped = false;
  let current = null;
  let resolveTab;
  const tabIdP = new Promise((r) => (resolveTab = r));
  const step = (kind, text, data) => o.onStep && o.onStep({ kind, text, data, time: Date.now() });

  const done = (async () => {
    const src = await loadPageScript();
    let tabId = o.tabId;
    if (!tabId || o.background) {
      const start = /^https?:\/\//.test(o.startUrl || '') ? o.startUrl : 'about:blank';
      tabId = await host.openTab(start, { background: !!o.background });
      step('info', o.background ? 'Trabajando en una pestaña en segundo plano.' : 'Abrí una pestaña nueva para la tarea.');
    }
    resolveTab(tabId);

    const history = [];
    const maxSteps = Math.max(3, Number(s.agentMaxSteps) || 25);
    let extraText = '';

    for (let n = 1; n <= maxSteps; n++) {
      if (stopped) { step('stop', 'Tarea detenida por el usuario.'); return 'Tarea detenida.'; }
      await host.waitForLoad(tabId, 12000).catch(() => {});
      let obs = await host.runInTab(tabId, wrap(src, 'window.__navega.snapshot({textLen: 3000})')).catch((e) => ({ error: e.message }));
      if (!obs || obs.error) obs = { url: '(sin página)', title: '', elementos: '', texto: obs && obs.error ? 'Error al leer la página: ' + obs.error : '' };

      const observation =
        'Página actual: ' + obs.title + '\nURL: ' + obs.url +
        (obs.scroll ? '\nDesplazamiento: ' + obs.scroll.y + '/' + obs.scroll.alto + ' px' : '') +
        '\n\nElementos interactivos visibles:\n' + (obs.elementos || '(ninguno)') +
        '\n\nTexto visible (extracto):\n' + (obs.texto || '') +
        (extraText ? '\n\nTexto adicional leído:\n' + extraText : '');
      extraText = '';

      const messages = [
        { role: 'system', content: systemBase(s, o.memory) +
          '\n\nAhora actúas como AGENTE DE NAVEGACIÓN autónomo. Controlas una pestaña del navegador para cumplir la tarea del usuario. ' +
          'En cada turno observas la página y eliges UNA acción. Usa los números [N] de la lista de elementos. ' +
          'Si la página está en blanco, usa "navigate" o "search". Sé eficiente: no repitas acciones que fallaron. ' +
          'Nunca inventes datos personales, contraseñas ni datos de pago: usa "ask_user". ' +
          'Cuando tengas la información o la tarea esté hecha, usa "finish" con una respuesta completa en Markdown.\n\n' + TOOLS +
          '\n\nResponde SOLO con JSON: {"thought":"razonamiento breve en español","action":{...}}' },
        { role: 'user', content: 'TAREA: ' + o.goal +
          (history.length ? '\n\nPasos anteriores:\n' + history.slice(-10).map((h, i) => (i + 1) + '. ' + h).join('\n') : '') +
          '\n\nOBSERVACIÓN (paso ' + n + ' de ' + maxSteps + '):\n' + observation },
      ];

      step('think', 'Analizando la página…', { url: obs.url, title: obs.title, n });
      current = chat({ settings: s, messages, json: true });
      let raw;
      try { raw = await current.done; } catch (e) { step('error', e.message); throw e; }
      current = null;
      if (stopped) continue;
      const parsed = parseJSON(raw);
      const action = parsed && (parsed.action || parsed.accion || (parsed.type ? parsed : null));
      if (!action || !action.type) {
        history.push('Respuesta inválida del modelo; debía ser JSON con "action".');
        step('error', 'El modelo no devolvió una acción válida; reintentando.');
        continue;
      }
      const thought = (parsed.thought || parsed.pensamiento || '').toString();
      step('thought', thought, { action });

      let result = { ok: true, info: '' };
      try {
        switch (action.type) {
          case 'finish': {
            const ans = String(action.answer || action.respuesta || thought || 'Listo.');
            step('done', ans);
            return ans;
          }
          case 'navigate': {
            let url = String(action.url || '');
            if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
            await host.navigate(tabId, url);
            result.info = 'Abrí ' + url;
            break;
          }
          case 'search':
            await host.navigate(tabId, searchUrl(String(action.query || ''), s));
            result.info = 'Busqué "' + action.query + '"';
            break;
          case 'back':
            await host.goBack(tabId);
            result.info = 'Regresé';
            break;
          case 'wait':
            await new Promise((r) => setTimeout(r, Math.min(10, Number(action.seconds) || 2) * 1000));
            result.info = 'Esperé';
            break;
          case 'read': {
            const p = await host.runInTab(tabId, wrap(src, 'window.__navega.readable(9000)'));
            extraText = typeof p === 'string' ? p : '';
            result.info = 'Leí el contenido de la página';
            break;
          }
          case 'ask_user': {
            const ansU = o.askUser ? await o.askUser(String(action.question || '¿Cómo continúo?')) : '';
            result.info = 'El usuario respondió: ' + (ansU || '(sin respuesta)');
            break;
          }
          case 'click': case 'type': case 'select': case 'key': case 'scroll': {
            if (s.agentConfirm && (action.type === 'click' || action.type === 'type' || action.type === 'key') && action.id) {
              const target = await host.runInTab(tabId, wrap(src, 'window.__navega.describeTarget(' + Number(action.id) + ')'));
              const isPwd = target && target.type === 'password';
              const risky = target && (SENSITIVE.test(target.text || '') || (action.type === 'key' && target.form));
              if (isPwd || risky) {
                const ok = o.confirm ? await o.confirm(
                  isPwd ? 'El agente quiere escribir en un campo de contraseña. ¿Lo permites?'
                        : 'El agente quiere ' + (action.type === 'click' ? 'hacer clic en' : 'usar') + ' «' + (target.text || 'elemento') + '». Esta acción podría ser importante (pago, envío o borrado). ¿Continuar?') : false;
                if (!ok) { result = { ok: false, info: 'El usuario NO autorizó esta acción. Busca otra forma o termina.' }; break; }
              }
            }
            result = await host.runInTab(tabId, wrap(src, 'window.__navega.act(' + JSON.stringify(action) + ')')) || { ok: false, info: 'Sin respuesta de la página' };
            await new Promise((r) => setTimeout(r, 700));
            break;
          }
          default:
            result = { ok: false, info: 'Acción desconocida: ' + action.type };
        }
      } catch (e) {
        result = { ok: false, info: 'Error: ' + e.message };
      }
      const label = describe(action);
      history.push(label + ' → ' + (result.ok === false ? 'FALLÓ: ' : '') + (result.info || 'ok'));
      step(result.ok === false ? 'warn' : 'action', label + (result.info ? ' — ' + result.info : ''), { action, result });
    }
    const msg = 'Alcancé el límite de ' + maxSteps + ' pasos sin terminar. Puedes darme más detalles o aumentar el límite en Ajustes.';
    step('error', msg);
    return msg;
  })();

  return {
    done,
    tabId: tabIdP,
    stop() { stopped = true; if (current) current.abort(); },
  };
}

function describe(a) {
  switch (a.type) {
    case 'navigate': return 'Ir a ' + a.url;
    case 'search': return 'Buscar «' + a.query + '»';
    case 'click': return 'Clic en [' + a.id + ']';
    case 'type': return 'Escribir «' + String(a.text || '').slice(0, 40) + '» en [' + a.id + ']';
    case 'select': return 'Elegir «' + a.value + '» en [' + a.id + ']';
    case 'key': return 'Tecla ' + a.key;
    case 'scroll': return 'Desplazar ' + (a.direction === 'up' ? 'arriba' : 'abajo');
    case 'back': return 'Atrás';
    case 'read': return 'Leer página';
    case 'wait': return 'Esperar';
    case 'ask_user': return 'Preguntar al usuario';
    default: return a.type;
  }
}

export { searchUrl };
