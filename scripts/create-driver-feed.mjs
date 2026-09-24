// Creates metadata only. Hosting and distribution rights remain with the publisher.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['driver', 'class', 'version', 'revision', 'base-url', 'output'].map(name => [name, { type: 'string' }])) });
const definitions = JSON.parse(await readFile(new URL('../drivers/definitions.json', import.meta.url), 'utf8'));
const definition = definitions.find(driver => driver.id === values.driver);
const driverClass = values.class || definition?.className;
const revision = Number(values.revision);
if (!definition || !driverClass || driverClass.length > 512 || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(driverClass) || !values.version?.trim() || values.version.length > 100 || /[\x00-\x1f\x7f]/.test(values.version) || !Number.isSafeInteger(revision) || revision < 1 || !values['base-url'] || !values.output || !positionals.length || positionals.length > 250) {
  throw new Error('Usage: node scripts/create-driver-feed.mjs --driver custom --class com.vendor.jdbc.Driver --version 1.0.0 --revision 1 --base-url https://host/jdbc/1.0.0/ --output driver.json driver.jar dependency.jar');
}
const base = new URL(values['base-url']);
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) throw new Error('--base-url requires HTTPS, a trailing slash and no credentials, query or fragment.');
const files = [], urls = new Set(), hashes = new Set(); let total = 0;
for (const path of positionals) {
  const info = await stat(path);
  if (!path.toLowerCase().endsWith('.jar') || !info.isFile() || info.size <= 0 || info.size > 512 * 1024 ** 2) throw new Error('Expected non-empty JAR files up to 512 MiB.');
  total += info.size; if (total > 1024 ** 3) throw new Error('Bundle exceeds 1 GiB.');
  const file = await open(path, 'r');
  try { const header = Buffer.alloc(4); await file.read(header, 0, 4, 0); if (!header.equals(Buffer.from([80, 75, 3, 4]))) throw new Error('File is not a JAR/ZIP archive.'); }
  finally { await file.close(); }
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
  const sha256 = hash.digest('hex'), url = new URL(encodeURIComponent(basename(path)), base).href;
  if (urls.has(url) || hashes.has(sha256) || url.length > 2048) throw new Error('Duplicate JAR, filename collision or URL too long.');
  urls.add(url); hashes.add(sha256); files.push({ url, size: info.size, sha256 });
}
const manifest = { format: 1, driverId: definition.id, driverClass, revision, version: values.version.trim(), files };
await writeFile(values.output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(`Created ${values.output}: ${files.length} JAR files, ${total} bytes. No files were uploaded.`);
