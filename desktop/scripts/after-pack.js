/*
 * Navega-MX — firma ad-hoc en macOS para que la app abra en Apple Silicon
 * sin certificado de desarrollador.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  try {
    execSync('codesign --force --deep --sign - "' + app + '"', { stdio: 'inherit' });
    console.log('  • firma ad-hoc aplicada a', app);
  } catch (e) {
    console.warn('  • no se pudo firmar ad-hoc:', e.message);
  }
};
