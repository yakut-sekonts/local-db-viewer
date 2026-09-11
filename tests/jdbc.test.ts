import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jdbcConfig, validateJdbc } from '../electron/jdbc-config';
import { ProfileStore } from '../electron/storage';
import type { ProfileDraft } from '../src/shared';
import { transactionAction } from '../electron/sql';

test('transaction tracking handles comments, savepoints and chained transactions', () => {
  assert.equal(transactionAction('-- ignored\n/* outer /* nested */ */ BEGIN'), 'begin');
  assert.equal(transactionAction('START /* options */ TRANSACTION READ ONLY'), 'begin');
  assert.equal(transactionAction('BEGIN IMMEDIATE'), 'begin');
  assert.equal(transactionAction('SAVEPOINT kept'), 'begin');
  assert.equal(transactionAction('ROLLBACK WORK TO SAVEPOINT kept'), '');
  assert.equal(transactionAction('COMMIT /* keep session */ AND CHAIN'), 'commit-chain');
  assert.equal(transactionAction('ROLLBACK AND NO CHAIN'), 'rollback');
  assert.equal(transactionAction("SELECT 'COMMIT'"), '');
});

const draft: ProfileDraft = { name: 'JDBC test', engine: 'trino', endpoint: 'https://example.test:8443', user: 'tester', auth: 'none', tls: true, catalog: 'iceberg', schema: 'analytics' };
test('Trino SSL and literal JDBC parameters reach the driver without a whitelist', () => {
  const config = jdbcConfig({ ...draft, jdbc: { properties: { SSL: 'true', sessionProperties: 'query_max_run_time:15m', customDriverProperty: 'literal_value' } } });
  assert.equal(config.url, 'jdbc:trino://example.test:8443/iceberg/analytics');
  assert.equal(config.properties.SSL, 'true');
  assert.equal(config.properties.SSLVerification, 'FULL');
  assert.equal(config.properties.sessionProperties, 'query_max_run_time:15m');
  assert.equal(config.properties.customDriverProperty, 'literal_value');
  const override = jdbcConfig({ ...draft, jdbc: { url: 'jdbc:trino://example.test:8443/iceberg/analytics?SSL=true', properties: { SSL: 'false' } } });
  assert.equal(override.properties.SSL, undefined);
  assert.throws(() => validateJdbc({ url: 'jdbc:trino://example.test:8443?accessToken=secret' }));
  assert.throws(() => validateJdbc({ classpath: ['relative.jar'] }));
  assert.equal(jdbcConfig({ ...draft, engine: 'clickhouse', sslVerification: 'CA', jdbc: {} }).properties.ssl_mode, 'VERIFY_CA');
});
test('JDBC secrets and environment are encrypted, masked and preserved across settings edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-db-viewer-jdbc-'));
  const store = new ProfileStore(join(directory, 'profiles.json'), {
    encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString(),
  });
  try {
    const saved = await store.save({ ...draft, jdbc: { properties: { SSL: 'true', accessToken: 'private-access-token' }, environment: { CUSTOM_SECRET: 'private-env' } } });
    assert.equal(saved.jdbc?.properties?.SSL, 'true');
    assert.equal(saved.jdbc?.properties?.accessToken, undefined);
    assert.deepEqual(saved.jdbcSecrets, ['accessToken']);
    assert.deepEqual(saved.jdbc?.environment, {});
    const contents = await readFile(join(directory, 'profiles.json'), 'utf8');
    assert.equal(contents.includes('private-access-token'), false);
    assert.equal(contents.includes('private-env'), false);
    await store.save({ ...saved, name: 'Renamed connection' });
    assert.equal((await store.get(saved.id)).jdbc?.properties?.accessToken, 'private-access-token');
    assert.equal((await store.get(saved.id)).jdbc?.environment?.CUSTOM_SECRET, 'private-env');
    await store.save({ ...saved, jdbc: { ...saved.jdbc, properties: { accessToken: '' }, environment: { CUSTOM_SECRET: '' } } });
    assert.equal(jdbcConfig(await store.get(saved.id)).properties.accessToken, undefined);
    assert.equal((await store.get(saved.id)).jdbc?.environment?.CUSTOM_SECRET, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
