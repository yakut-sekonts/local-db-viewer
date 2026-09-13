import { build } from 'esbuild';

await build({
  entryPoints: ['electron/main.ts', 'electron/preload.ts', 'electron/database-worker.ts'],
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron', 'pg', 'mysql2', 'tedious', 'undici', 'ssh2'],
  format: 'cjs',
  sourcemap: true,
});
