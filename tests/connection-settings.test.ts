import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateJdbc } from '../electron/jdbc-config';
import { ProfileStore } from '../electron/storage';
import { globMatches, schemaAllowed, filterSchema } from '../src/schemaSettings';
import { sshProperties } from '../electron/ssh-jdbc';
import type { Connection } from '../electron/trino';

const connection: Connection = { id: 'p', name: 'fixture', engine: 'trino', endpoint: 'https://db.invalid:8443', user: 'u', auth: 'none', tls: true, catalog: '', schema: '', jdbc: {} };
test('SSH and client key passwords stay encrypted, masked, preserved and explicitly clearable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'connection-secrets-')), path = join(directory, 'profiles.json');
  const store = new ProfileStore(path, { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() });
  try {
    const saved = await store.save({ ...connection, id: undefined, jdbc: { ssh: { enabled: false, host: 'ssh.invalid', port: 22, user: 'u', authentication: 'password', fingerprint: '', password: 'ssh-secret', passphrase: 'key-secret' }, certificates: { clientKeyPassword: 'client-secret', trustStorePassword: 'trust-secret', clientStorePassword: 'store-secret' } } });
    const visible = JSON.stringify(saved), disk = await readFile(path, 'utf8');
    for (const secret of ['ssh-secret', 'key-secret', 'client-secret', 'trust-secret', 'store-secret']) { assert.ok(!visible.includes(secret)); assert.ok(!disk.includes(secret)); }
    assert.equal(saved.jdbc?.ssh?.hasPassword, true);
    await store.save({ ...saved, name: 'edited' });
    assert.equal((await store.get(saved.id)).jdbc?.ssh?.password, 'ssh-secret');
    assert.equal((await store.get(saved.id)).jdbc?.certificates?.clientKeyPassword, 'client-secret');
    await store.save({ ...saved, jdbc: { ...saved.jdbc, ssh: { ...saved.jdbc!.ssh!, password: '' }, certificates: { ...saved.jdbc?.certificates, clientKeyPassword: '' } } });
    assert.equal((await store.get(saved.id)).jdbc?.ssh?.password, '');
    assert.equal((await store.get(saved.id)).jdbc?.certificates?.clientKeyPassword, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('schema scope handles empty selection, exclusions and relationships outside scope', () => {
  assert.equal(globMatches('iceberg.*.order?', 'iceberg.ods.orders'), true);
  assert.equal(globMatches('iceberg.*.order?', 'iceberg.ods.orders_old'), false);
  assert.equal(schemaAllowed({ mode: 'selected', selected: [] }, 'iceberg', 'ods'), false);
  const source = { catalog: 'iceberg', schema: 'ods', name: 'orders' }, target = { ...source, name: 'users' };
  const index = filterSchema({ profileId: 'p', catalog: 'iceberg', schema: 'ods', tables: [{ ...source, columns: [] }, { ...target, columns: [] }], relationships: [{ id: 'fk', name: 'users', source, target, columns: [], kind: 'foreign-key' }], warnings: [] }, { mode: 'all', selected: [], objectExclude: '*.users' });
  assert.equal(index.tables.length, 1); assert.equal(index.relationships.length, 0);
});
test('invalid nested settings and incomplete certificate selection are rejected before rendering', () => {
  for (const key of ['ssh','certificates','schemas','options']) for (const value of [null, [], true, 'bad']) assert.throws(() => validateJdbc({ [key]: value }));
  assert.throws(() => validateJdbc({ certificates: { clientMode: 'pem' } }));
  assert.throws(() => validateJdbc({ certificates: { trustSource: 'file' } }));
  assert.throws(() => validateJdbc({ options: { keepAliveSeconds: 1 } }));
  assert.throws(() => validateJdbc({ options: { beforeConnect: [{ id: 'x', name: 'x', executable: 'relative', args: [], timeoutSeconds: 10, enabled: true }] } }));
});
test('SSH transport cannot silently bypass a conflicting proxy or unsupported driver', () => {
  assert.equal(sshProperties(connection, 'jdbc:trino://db.invalid', {}, 4567).socksProxy, '127.0.0.1:4567');
  assert.throws(() => sshProperties(connection, 'jdbc:trino://db.invalid?httpProxy=elsewhere', {}, 4567), /конфликтует/);
  assert.throws(() => sshProperties({ ...connection, engine: 'mysql' }, 'jdbc:mysql://db.invalid', { socketFactory: 'custom.Factory' }, 4567));
  assert.throws(() => sshProperties({ ...connection, engine: 'jdbc', jdbc: { driverId: 'h2' } }, 'jdbc:h2:mem:test', {}, 4567), /не поддерживается/);
});
