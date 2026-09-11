import test from 'node:test';
import assert from 'node:assert/strict';
import { sslEnabled, toggleSSL } from '../src/connectionSettings';
import { tlsOptions, validateCertificate } from '../electron/tls';
import { validateConnection, type Connection } from '../electron/trino';
const profile: Connection = { id: 'test', name: 'Test', endpoint: 'http://example.test:8443', user: 'test', engine: 'trino', auth: 'none', tls: false, catalog: '', schema: '' };
test('SSL toggle keeps explicit corporate port and migrates legacy HTTPS profiles', () => {
  const secured = toggleSSL(profile, true);
  assert.equal(secured.endpoint, 'https://example.test:8443');
  assert.equal(sslEnabled(secured), true);
  assert.equal(validateConnection({ ...secured, id: profile.id, tls: false }).tls, true);
  assert.equal(toggleSSL(secured, false).endpoint, profile.endpoint);
});
test('TLS chain/name verification settings remain distinct and CA imports reject private keys', () => {
  assert.equal(tlsOptions({ ...profile, sslVerification: 'FULL' }).rejectUnauthorized, true);
  assert.equal(tlsOptions({ ...profile, sslVerification: 'CA' }).rejectUnauthorized, true);
  assert.equal(tlsOptions({ ...profile, sslVerification: 'NONE' }).rejectUnauthorized, false);
  assert.throws(() => validateCertificate('-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----'));
  assert.throws(() => validateConnection({ ...profile, sslVerification: 'unrecognized' as any }));
});
