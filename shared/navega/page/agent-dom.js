/*
 * Navega-MX — script de página para el agente y la lectura de contenido.
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Se inyecta en la página activa. Define window.__navega con funciones
 * síncronas que devuelven valores serializables en JSON.
 */
(function () {
  if (window.__navega && window.__navega.version === 3) return;

  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], ' +
    '[role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], ' +
    '[role="switch"], [role="combobox"], [role="searchbox"], [role="textbox"], ' +
    '[contenteditable="true"], [contenteditable=""], [onclick], [tabindex]:not([tabindex="-1"])';

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) return false;
    return true;
  }
  function inViewport(el, margin) {
    const r = el.getBoundingClientRect();
    const m = margin || 0;
    return r.bottom > -m && r.top < innerHeight + m && r.right > 0 && r.left < innerWidth;
  }
  function clean(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return n && s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function labelOf(el) {
    const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (aria) return aria;
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return l.innerText;
    }
    const pl = el.closest('label');
    if (pl) return pl.innerText;
    if (el.tagName === 'IMG') return el.alt || '';
    const img = el.querySelector && el.querySelector('img[alt]');
    return (el.innerText || el.value || '') || (img ? img.alt : '');
  }

  function readable(maxLen) {
    maxLen = maxLen || 15000;
    const root =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.body;
    if (!root) return '';
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll('script,style,noscript,svg,canvas,iframe,template,nav,footer,aside,form,[aria-hidden="true"]')
      .forEach((n) => n.remove());
    let text = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n');
    text = text.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').trim();
    if (text.length < 400 && root !== document.body) {
      text = (document.body.innerText || '').trim();
    }
    return text.length > maxLen ? text.slice(0, maxLen) + '\n…[contenido recortado]' : text;
  }

  let nextId = 1;
  function snapshot(opts) {
    opts = opts || {};
    const items = [];
    const seen = new Set();
    document.querySelectorAll('[data-navega-id]').forEach((e) => e.removeAttribute('data-navega-id'));
    nextId = 1;
    const all = Array.from(document.querySelectorAll(INTERACTIVE));
    for (const el of all) {
      if (items.length >= (opts.max || 160)) break;
      if (seen.has(el) || !visible(el) || !inViewport(el, 600)) continue;
      if (el.disabled) continue;
      seen.add(el);
      const id = nextId++;
      el.setAttribute('data-navega-id', String(id));
      const tag = el.tagName.toLowerCase();
      let desc = tag;
      const role = el.getAttribute('role');
      if (role) desc += '[' + role + ']';
      if (tag === 'input') desc += ' type=' + (el.type || 'text');
      let line = '[' + id + '] ' + desc;
      const label = clean(labelOf(el), 80);
      if (label) line += ' "' + label + '"';
      if (el.placeholder) line += ' placeholder="' + clean(el.placeholder, 50) + '"';
      if ((tag === 'input' || tag === 'textarea') && el.type !== 'password' && el.value)
        line += ' valor="' + clean(el.value, 50) + '"';
      if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) line += el.checked ? ' [marcado]' : ' [sin marcar]';
      if (tag === 'select') {
        const opt = Array.from(el.options).slice(0, 12).map((o) => clean(o.text, 25));
        line += ' opciones=[' + opt.join(' | ') + ']';
      }
      if (tag === 'a') {
        const href = el.getAttribute('href') || '';
        if (href && !href.startsWith('javascript')) line += ' -> ' + clean(href, 70);
      }
      if (!inViewport(el, 0)) line += ' (fuera de vista)';
      items.push(line);
    }
    const sh = document.documentElement.scrollHeight;
    return {
      url: location.href,
      title: document.title,
      scroll: { y: Math.round(scrollY), alto: sh, vista: innerHeight },
      elementos: items.join('\n'),
      texto: readable(opts.textLen || 3500),
    };
  }

  function byId(id) {
    return document.querySelector('[data-navega-id="' + String(id) + '"]');
  }

  let glowEl = null;
  function glow(el) {
    try {
      if (!glowEl) {
        glowEl = document.createElement('div');
        glowEl.style.cssText =
          'position:fixed;z-index:2147483647;pointer-events:none;border-radius:10px;' +
          'box-shadow:0 0 0 3px #FF2E88,0 0 22px 6px rgba(91,140,255,.7);transition:all .25s ease;';
        document.documentElement.appendChild(glowEl);
      }
      const r = el.getBoundingClientRect();
      Object.assign(glowEl.style, {
        left: r.left - 4 + 'px', top: r.top - 4 + 'px',
        width: r.width + 8 + 'px', height: r.height + 8 + 'px', opacity: '1',
      });
      clearTimeout(glow._t);
      glow._t = setTimeout(() => glowEl && (glowEl.style.opacity = '0'), 1600);
    } catch (e) {}
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function key(el, k) {
    const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38 };
    const init = { key: k, code: k, keyCode: codes[k] || 0, which: codes[k] || 0, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function act(a) {
    try {
      const t = a.type;
      if (t === 'scroll') {
        const dir = a.direction === 'up' ? -1 : 1;
        scrollBy({ top: dir * innerHeight * 0.8, behavior: 'instant' });
        return { ok: true, info: 'Desplazado ' + (dir > 0 ? 'abajo' : 'arriba') };
      }
      if (t === 'key' && !a.id) {
        const target = document.activeElement || document.body;
        key(target, a.key || 'Enter');
        if ((a.key || 'Enter') === 'Enter' && target.form) target.form.requestSubmit ? target.form.requestSubmit() : target.form.submit();
        return { ok: true, info: 'Tecla ' + (a.key || 'Enter') };
      }
      const el = byId(a.id);
      if (!el) return { ok: false, info: 'No encontré el elemento [' + a.id + ']. Vuelve a observar la página.' };
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      glow(el);
      if (t === 'click') {
        el.focus && el.focus();
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((n) =>
          el.dispatchEvent(new MouseEvent(n, { bubbles: true, cancelable: true, view: window })));
        el.click();
        return { ok: true, info: 'Clic en [' + a.id + '] ' + clean(labelOf(el), 60) };
      }
      if (t === 'type') {
        el.focus();
        if (el.isContentEditable) {
          el.textContent = a.text || '';
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } else {
          setNativeValue(el, a.text || '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (a.enter) {
          key(el, 'Enter');
          const form = el.form;
          if (form) setTimeout(() => (form.requestSubmit ? form.requestSubmit() : form.submit()), 60);
        }
        return { ok: true, info: 'Escribí en [' + a.id + ']' + (a.enter ? ' y presioné Enter' : '') };
      }
      if (t === 'select') {
        const want = String(a.value || '').toLowerCase();
        const opt = Array.from(el.options || []).find(
          (o) => o.value.toLowerCase() === want || o.text.toLowerCase().includes(want));
        if (!opt) return { ok: false, info: 'Opción no encontrada: ' + a.value };
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, info: 'Seleccioné "' + opt.text + '"' };
      }
      if (t === 'key') {
        el.focus();
        key(el, a.key || 'Enter');
        return { ok: true, info: 'Tecla ' + (a.key || 'Enter') + ' en [' + a.id + ']' };
      }
      return { ok: false, info: 'Acción desconocida: ' + t };
    } catch (e) {
      return { ok: false, info: 'Error: ' + e.message };
    }
  }

  function describeTarget(id) {
    const el = byId(id);
    if (!el) return null;
    return {
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      text: clean(labelOf(el), 120),
      form: !!el.form,
    };
  }

  function selection() {
    return String(getSelection ? getSelection() : '').trim();
  }

  window.__navega = {
    version: 3,
    snapshot,
    act,
    readable,
    describeTarget,
    selection,
    page: function (maxLen) {
      return { url: location.href, title: document.title, text: readable(maxLen), seleccion: selection() };
    },
  };
})();
