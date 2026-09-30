import { execFileSync } from 'node:child_process';
// Electron 44 downloads its distribution lazily. Obtain the pinned distribution
// (including LICENSE/Chromium notices) before constructing legal resources.
if (process.argv.length === 2) execFileSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit' });
execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['scripts/build-licenses.py', ...process.argv.slice(2)], { stdio: 'inherit' });
