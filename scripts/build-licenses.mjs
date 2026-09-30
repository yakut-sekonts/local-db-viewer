import { execFileSync } from 'node:child_process';
execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['scripts/build-licenses.py', ...process.argv.slice(2)], { stdio: 'inherit' });
