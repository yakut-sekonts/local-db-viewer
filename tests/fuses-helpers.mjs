import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FuseVersion, FuseV1Options, getCurrentFuseWire, flipFuses } from '@electron/fuses';
import * as asar from '@electron/asar';

const execute = promisify(execFile);
const policy = new Map([
  [FuseV1Options.RunAsNode, false],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
  [FuseV1Options.EnableNodeCliInspectArguments, false],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true],
  [FuseV1Options.OnlyLoadAppFromAsar, true],
]);

export function bundlePaths(executable) {
  executable = resolve(executable);
  if (process.platform === 'darwin') {
    const bundle = executable.endsWith('.app') ? executable : resolve(executable, '../../..');
    assert.ok(bundle.endsWith('.app'), 'Expected a packaged macOS application');
    return {
      bundle, executable: join(bundle, 'Contents/MacOS/Local DB Viewer'),
      resources: join(bundle, 'Contents/Resources'),
      fuseFile: join(bundle, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'),
    };
  }
  assert.equal(process.platform, 'win32', 'Packaged fuse checks require macOS or Windows');
  return { bundle: dirname(executable), executable, resources: join(dirname(executable), 'resources'), fuseFile: executable };
}

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function assertReleaseFuses(executable, { inspector = false } = {}) {
  const paths = bundlePaths(executable);
  const wire = await getCurrentFuseWire(paths.executable);
  assert.equal(wire.version, FuseVersion.V1);
  const fuses = {};
  for (const [option, required] of policy) {
    const enabled = option === FuseV1Options.EnableNodeCliInspectArguments ? inspector : required;
    assert.equal(wire[option], enabled ? 49 : 48, `Incorrect fuse: ${FuseV1Options[option]}`);
    fuses[FuseV1Options[option]] = enabled;
  }
  const archive = join(paths.resources, 'app.asar');
  asar.uncache(archive);
  const header = asar.getRawHeader(archive);
  const headerHash = createHash('sha256').update(header.headerString).digest('hex');
  let embedded;
  if (process.platform === 'darwin') {
    const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(paths.bundle, 'Contents/Info.plist')]);
    embedded = JSON.parse(stdout).ElectronAsarIntegrity?.['Resources/app.asar'];
  } else {
    const { NtExecutable, NtExecutableResource } = await import('resedit');
    const pe = NtExecutable.from(await readFile(paths.executable));
    const entries = NtExecutableResource.from(pe).entries.filter(entry => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR');
    assert.equal(entries.length, 1, 'Expected one embedded Windows ASAR integrity resource');
    const hashes = JSON.parse(Buffer.from(entries[0].bin).toString('utf8'));
    const entry = hashes.find(item => item.file.replaceAll('\\', '/').toLowerCase() === 'resources/app.asar');
    embedded = entry && { algorithm: entry.alg, hash: entry.value };
  }
  assert.equal(embedded?.algorithm, 'SHA256');
  assert.equal(embedded?.hash, headerHash, 'Embedded ASAR header hash must match the shipped archive');
  for (const file of ['package.json', 'dist-electron/main.cjs', 'dist-electron/preload.cjs', 'dist-electron/database-worker.cjs', 'dist/index.html']) {
    const entry = asar.statFile(archive, file);
    assert.ok(!entry.unpacked && !entry.link, `${file} must remain inside app.asar`);
    assert.equal(entry.integrity?.algorithm, 'SHA256', `Missing integrity for ${file}`);
    assert.equal(entry.integrity.hash, createHash('sha256').update(asar.extractFile(archive, file)).digest('hex'), `Incorrect content hash: ${file}`);
  }
  return { fuses, headerHash, archiveHash: await sha256(archive), fuseFileHash: await sha256(paths.fuseFile) };
}

export async function signTestBundle(executable) {
  if (process.platform === 'darwin') await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,requirements,flags', bundlePaths(executable).bundle], { timeout: 120000 });
}

// Never use this on a release artifact or a user's installation. Playwright's
// Electron launcher requires the main-process inspector; only isolated fixtures
// may enable it. Application ASAR and all other fuses remain unchanged.
export async function enableFixtureInspector(executable, fixtureRoot) {
  const root = await realpath(fixtureRoot);
  assert.match(basename(root), /^(?:playwright-inspector-|update-install-|LocalDBViewer-(?:install|update)-)[a-zA-Z0-9]+$/);
  const paths = bundlePaths(executable);
  const target = await realpath(paths.bundle);
  const child = relative(root, target);
  assert.ok(child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child), 'Inspector fixture must be inside its temporary root');
  const before = await assertReleaseFuses(executable);
  await flipFuses(executable, { version: FuseVersion.V1, [FuseV1Options.EnableNodeCliInspectArguments]: true });
  await signTestBundle(executable);
  const after = await assertReleaseFuses(executable, { inspector: true });
  assert.equal(after.archiveHash, before.archiveHash, 'Inspector fixture must use the same application code');
  return after;
}

export async function copyBundle(executable, directory) {
  const paths = bundlePaths(executable);
  const bundle = join(directory, basename(paths.bundle));
  await cp(paths.bundle, bundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  return process.platform === 'darwin' ? join(bundle, 'Contents/MacOS/Local DB Viewer') : join(bundle, basename(executable));
}

export async function prepareInspectorCopy(executable, artifacts) {
  await mkdir(artifacts, { recursive: true });
  const work = await mkdtemp(join(artifacts, 'playwright-inspector-'));
  const copy = await copyBundle(executable, work);
  await enableFixtureInspector(copy, work);
  return copy;
}
