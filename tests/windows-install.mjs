import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// The installer modifies shortcuts and uninstall registration in the disposable
// runner account. Never run this fixture against a developer's installed copy.
if (process.platform !== 'win32' || process.env.CI !== 'true') throw new Error('Run this installer test on a disposable Windows CI runner.');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const installer = resolve(`release/Local-DB-Viewer-${pkg.version}-windows-x64-setup.exe`);
const work = await mkdtemp(join(homedir(), 'LocalDBViewer-install-'));
const installation = join(work, 'Local DB Viewer');
const executable = join(installation, 'Local DB Viewer.exe');
async function run(file, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${file} exited with ${code}`)));
  });
}
try {
  // NSIS requires /D last and without quotes, including when the path has spaces.
  await run(installer, ['/S', `/D=${installation}`], { windowsVerbatimArguments: true });
  await access(executable);
  const bytes = await readFile(executable);
  const header = bytes.readUInt32LE(0x3c);
  if (bytes.readUInt16LE(header + 4) !== 0x8664 || !bytes.toString('latin1').includes('level="asInvoker"')) throw new Error('Expected an x64 application with an asInvoker manifest.');
  console.log('PASS: NSIS installed under the current user; x64/asInvoker application found');
  await run(process.execPath, ['tests/desktop.mjs'], { env: { ...process.env, LOCAL_DB_VIEWER_EXECUTABLE: executable } });
  await mkdir('test-artifacts', { recursive: true });
  await writeFile('test-artifacts/windows-install-results.json', JSON.stringify({ passed: true, version: pkg.version, perUserPath: true, architecture: 'x64', requestedExecutionLevel: 'asInvoker', testedAt: new Date().toISOString() }, null, 2));
} finally {
  const uninstaller = (await readdir(installation).catch(() => [])).find(name => /^uninstall.*\.exe$/i.test(name));
  if (uninstaller) await run(join(installation, uninstaller), ['/S']);
}
