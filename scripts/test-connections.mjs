import { build } from 'esbuild';
import { spawn } from 'node:child_process';
await build({ entryPoints: ['tests/connection-runtime.ts'], outfile: 'dist-tests/connection-runtime.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
const child = spawn(process.execPath, ['dist-tests/connection-runtime.cjs'], { stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
