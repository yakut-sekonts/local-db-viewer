import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseReleaseVersion } from '../src/release-version.ts';

const gh = (args, capture = false) => execFileSync('gh', args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });

export async function publishRelease({ directory = process.cwd(), ref = process.env.GITHUB_REF_NAME, repository = process.env.UPDATE_REPOSITORY || process.env.GITHUB_REPOSITORY, gh: run = gh } = {}) {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const version = pkg.version;
  const tag = `v${version}`;
  const parsedVersion = parseReleaseVersion(version);
  if (!parsedVersion || ref !== tag) throw new Error('Git tag must equal package.json version: vX.Y.Z or vX.Y.Z-beta.N.');
  const beta = parsedVersion.beta !== undefined;
  if (!/^[\w-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('UPDATE_REPOSITORY is required.');
  const expected = [
    `Local-DB-Viewer-${version}-mac-arm64.dmg`,
    `Local-DB-Viewer-${version}-mac-arm64.zip`,
    `Local-DB-Viewer-${version}-windows-x64-setup.exe`,
    `Local-DB-Viewer-${version}-third-party-sources.zip`,
  ];
  const files = await readdir(join(directory, 'release-assets'));
  for (const name of expected) if (!files.includes(name) || (await stat(join(directory, 'release-assets', name))).size === 0) throw new Error(`Missing release artifact: ${name}`);
  const checksums = [];
  for (const name of expected) checksums.push(`${createHash('sha256').update(await readFile(join(directory, 'release-assets', name))).digest('hex')}  ${name}`);
  await writeFile(join(directory, 'release-assets/SHA256SUMS.txt'), checksums.join('\n') + '\n');
  const changelog = await readFile(join(directory, 'CHANGELOG.md'), 'utf8');
  const start = changelog.indexOf(`## ${version}\n`);
  if (start < 0) throw new Error('Current version is missing from CHANGELOG.md.');
  const notes = changelog.slice(start + version.length + 4).split('\n## ')[0].trim();
  await writeFile(join(directory, 'release-notes.md'), notes + '\n');
  let exists = false;
  try { run(['release', 'view', tag, '--repo', repository, '--json', 'isDraft'], true); exists = true; } catch { /* Create a new draft below. */ }
  if (exists) throw new Error('This release already exists. Use a new version; published binaries are immutable.');
  run(['release', 'create', tag, '--repo', repository, '--draft', ...(beta ? ['--prerelease'] : []), '--title', `Local DB Viewer ${version}`, '--notes-file', join(directory, 'release-notes.md')]);
  run(['release', 'upload', tag, '--repo', repository, ...expected.map(name => join(directory, 'release-assets', name)), join(directory, 'release-assets/SHA256SUMS.txt')]);
  // Publish only after both platform builds have succeeded and all assets exist.
  run(['release', 'edit', tag, '--repo', repository, '--draft=false', beta ? '--latest=false' : '--latest']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await publishRelease();
