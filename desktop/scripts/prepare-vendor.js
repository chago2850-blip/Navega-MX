/*
 * Navega-MX — copia la librería WebLLM (Apache-2.0) para la IA integrada.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '..', 'src', 'vendor');
fs.mkdirSync(out, { recursive: true });
try {
  const src = require.resolve('@mlc-ai/web-llm/lib/index.js');
  fs.copyFileSync(src, path.join(out, 'web-llm.js'));
  const lic = path.join(path.dirname(src), '..', 'LICENSE');
  if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(out, 'web-llm.LICENSE.txt'));
  console.log('WebLLM copiado a src/vendor');
} catch (e) {
  console.warn('WebLLM no disponible (la IA integrada quedará desactivada):', e.message);
}
