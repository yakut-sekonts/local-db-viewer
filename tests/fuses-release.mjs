import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertReleaseFuses, prepareInspectorCopy } from './fuses-helpers.mjs';

const executable = process.env.LOCAL_DB_VIEWER_RELEASE_EXECUTABLE;
assert.ok(executable, 'LOCAL_DB_VIEWER_RELEASE_EXECUTABLE must identify the unmodified release binary');
const artifacts = resolve('test-artifacts');
await mkdir(artifacts, { recursive: true });
const manifest = join(artifacts, 'release-fuses.json');
const current = await assertReleaseFuses(executable);
if (process.argv.includes('--prepare-inspector-copy')) {
  const copy = await prepareInspectorCopy(executable, artifacts);
  await writeFile(join(artifacts, 'inspector-executable.txt'), copy);
  await writeFile(manifest, JSON.stringify({ passed: true, ...current, verifiedUnchanged: false }, null, 2));
  console.log('PASS: strict release fuses and embedded ASAR integrity; separate inspector fixture created with identical app.asar');
} else {
  const original = JSON.parse(await readFile(manifest, 'utf8'));
  for (const field of ['fuses', 'headerHash', 'archiveHash', 'fuseFileHash']) assert.deepEqual(current[field], original[field], `Release artifact modified during testing: ${field}`);
  await writeFile(manifest, JSON.stringify({ ...original, verifiedUnchanged: true }, null, 2));
  console.log('PASS: production binary, ASAR and strict fuses unchanged after all desktop/installer tests');
}
