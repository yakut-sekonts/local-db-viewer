import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
if (!/^\d+\.\d+\.\d+$/.test(version) || process.env.GITHUB_REF_NAME !== tag) throw new Error('Git tag must equal package.json version, for example v0.2.0.');
const repository = process.env.UPDATE_REPOSITORY || process.env.GITHUB_REPOSITORY;
if (!/^[\w-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('UPDATE_REPOSITORY is required.');
const expected = [
  `Local-DB-Viewer-${version}-mac-arm64.dmg`,
  `Local-DB-Viewer-${version}-mac-arm64.zip`,
  `Local-DB-Viewer-${version}-windows-x64-setup.exe`,
];
const files = await readdir('release-assets');
for (const name of expected) if (!files.includes(name) || (await stat(join('release-assets', name))).size === 0) throw new Error(`Missing release artifact: ${name}`);
const checksums = [];
for (const name of expected) checksums.push(`${createHash('sha256').update(await readFile(join('release-assets', name))).digest('hex')}  ${name}`);
await writeFile('release-assets/SHA256SUMS.txt', checksums.join('\n') + '\n');
const changelog = await readFile('CHANGELOG.md', 'utf8');
const start = changelog.indexOf(`## ${version}\n`);
if (start < 0) throw new Error('Current version is missing from CHANGELOG.md.');
const notes = changelog.slice(start + version.length + 4).split('\n## ')[0].trim();
await writeFile('release-notes.md', notes + '\n');
const gh = (args, capture = false) => execFileSync('gh', args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
let exists = false;
try { gh(['release', 'view', tag, '--repo', repository, '--json', 'isDraft'], true); exists = true; } catch { /* Create a new draft below. */ }
if (exists) throw new Error('This release already exists. Use a new version; published binaries are immutable.');
gh(['release', 'create', tag, '--repo', repository, '--draft', '--title', `Local DB Viewer ${version}`, '--notes-file', 'release-notes.md']);
gh(['release', 'upload', tag, '--repo', repository, ...expected.map(name => join('release-assets', name)), 'release-assets/SHA256SUMS.txt']);
// Publish only after both platform builds have succeeded and all assets exist.
gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']);
