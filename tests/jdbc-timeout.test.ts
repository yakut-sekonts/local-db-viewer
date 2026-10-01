import test from 'node:test';
import assert from 'node:assert/strict';
import { jdbcConfig } from '../electron/jdbc-config';
import type { ProfileDraft } from '../src/shared';

const base: ProfileDraft = { engine: 'jdbc', name: 'Timeout', endpoint: 'jdbc:fixture:test', user: '', auth: 'none', tls: false, catalog: '', schema: '' };
test('JDBC connection timeout defaults use driver-specific units, including Universal JDBC', () => {
  for (const [driverClass, defaults] of [
    ['org.postgresql.Driver', { connectTimeout: '7', loginTimeout: '7' }],
    ['com.mysql.cj.jdbc.Driver', { connectTimeout: '7000' }],
    ['org.mariadb.jdbc.Driver', { connectTimeout: '7000' }],
    ['com.microsoft.sqlserver.jdbc.SQLServerDriver', { loginTimeout: '7' }],
    ['com.clickhouse.jdbc.ClickHouseDriver', { connection_timeout: '7000' }],
    ['io.trino.jdbc.TrinoDriver', {}], ['org.sqlite.JDBC', {}], ['vendor.CustomDriver', {}],
  ] as const) {
    const result = jdbcConfig({ ...base, jdbc: { driverClass, options: { connectTimeoutSeconds: 7 } } });
    assert.deepEqual({ ...result.properties }, defaults);
    assert.equal(result.options.connectTimeoutSeconds, 7);
  }
});
test('zero survives, absent timeout defaults to 30 seconds and bounds are validated', () => {
  const jdbc = { driverClass: 'com.mysql.cj.jdbc.Driver' };
  assert.equal(jdbcConfig({ ...base, jdbc }).properties.connectTimeout, '30000');
  assert.equal(jdbcConfig({ ...base, jdbc: { ...jdbc, options: { connectTimeoutSeconds: 0 } } }).properties.connectTimeout, '0');
  assert.equal(jdbcConfig({ ...base, jdbc: { ...jdbc, options: { connectTimeoutSeconds: 86400 } } }).properties.connectTimeout, '86400000');
  for (const value of [-1, NaN, Infinity, 0.1, 86401]) assert.throws(() => jdbcConfig({ ...base, jdbc: { ...jdbc, options: { connectTimeoutSeconds: value } } }));
});
test('Advanced and URL values override driver defaults without changing the IDE deadline', () => {
  const jdbc = { driverClass: 'com.mysql.cj.jdbc.Driver', options: { connectTimeoutSeconds: 2 }, properties: { connectTimeout: '9000', socketTimeout: '17000' } };
  const explicit = jdbcConfig({ ...base, jdbc });
  assert.equal(explicit.properties.connectTimeout, '9000');
  assert.equal(explicit.properties.socketTimeout, '17000');
  assert.equal(explicit.options.connectTimeoutSeconds, 2);
  for (const profile of [
    { ...base, endpoint: 'jdbc:mysql://host/db?connectTimeout=8000', jdbc },
    { ...base, jdbc: { ...jdbc, url: 'jdbc:mysql://host/db?connectTimeout=8000' } },
  ]) assert.equal(jdbcConfig(profile).properties.connectTimeout, undefined);
  const sqlserver = jdbcConfig({ ...base, jdbc: { driverClass: 'com.microsoft.sqlserver.jdbc.SQLServerDriver', properties: { LOGINTIMEOUT: '60' } } });
  assert.equal(sqlserver.properties.loginTimeout, undefined);
  assert.equal(sqlserver.properties.LOGINTIMEOUT, '60');
});
test('a custom driver class does not receive guessed properties from the profile engine', () => {
  const config = jdbcConfig({ ...base, engine: 'mysql', endpoint: 'mysql://localhost/db', jdbc: { driverClass: 'vendor.CustomDriver', options: { connectTimeoutSeconds: 1 } } });
  assert.equal(config.properties.connectTimeout, undefined);
  assert.equal(config.options.connectTimeoutSeconds, 1);
});
test('SQL Server URL priority respects escaped semicolons, braces and property name case', () => {
  const jdbc = { driverClass: 'com.microsoft.sqlserver.jdbc.SQLServerDriver', properties: { LOGINTIMEOUT: '60', databaseName: 'general' } };
  const escaped = jdbcConfig({ ...base, endpoint: 'jdbc:sqlserver://host;databaseName={name}};loginTimeout=999}', jdbc });
  assert.equal(escaped.properties.LOGINTIMEOUT, '60');
  assert.equal(escaped.properties.databaseName, undefined);
  const explicit = jdbcConfig({ ...base, endpoint: 'jdbc:sqlserver://host;databaseName={name}};loginTimeout=999};LOGINtimeout={9}', jdbc });
  assert.equal(explicit.properties.LOGINTIMEOUT, undefined);
  assert.equal(explicit.properties.loginTimeout, undefined);
  const question = jdbcConfig({ ...base, endpoint: 'jdbc:sqlserver://host;databaseName={?loginTimeout=9}', jdbc });
  assert.equal(question.properties.LOGINTIMEOUT, '60');
  assert.throws(() => jdbcConfig({ ...base, endpoint: 'jdbc:sqlserver://host;databaseName={broken', jdbc }), /незакрытое/);
});
