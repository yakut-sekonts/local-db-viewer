import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProfileStore } from '../electron/storage';
import { sessionTemplate } from '../electron/session-template';
import { validateJdbc } from '../electron/jdbc-config';
import type { Connection } from '../electron/trino';

const base: Connection = { id: 'profile', name: 'Template test', engine: 'trino', endpoint: 'https://db.example:8443', user: 'main', auth: 'basic', secret: 'main-password', tls: true, catalog: 'lake', schema: 'default', jdbc: { properties: { password: 'advanced-password', SSLKeyStorePassword: 'tls-password' }, options: { singleSession: true, readOnly: false, startupStatements: ['SELECT 1'] }, sessionTemplates: [{ id: 'reader', name: 'Reader', authentication: { user: 'reader', auth: 'basic', secret: 'reader-secret' }, driverVersion: 'bundled', options: { readOnly: true, startupStatements: [] } }, { id: 'introspection', name: 'Introspection', options: { queryTimeoutSeconds: 15 } }], defaultSessionTemplate: 'reader', introspectionSessionTemplate: 'introspection' } };
test('template overrides are isolated and remove unused credentials before starting a worker', () => {
  const reader = sessionTemplate(base, 'console'), introspection = sessionTemplate(base,'introspection');
  assert.equal(reader.user,'reader'); assert.equal(reader.secret,'reader-secret'); assert.equal(reader.jdbc?.properties?.password,undefined);
  assert.equal(reader.jdbc?.properties?.SSLKeyStorePassword,'tls-password');
  assert.equal(reader.jdbc?.options?.readOnly,true); assert.deepEqual(reader.jdbc?.options?.startupStatements,[]);
  assert.equal(reader.jdbc?.sessionTemplates,undefined); assert.equal(reader.sessionTemplateId,'reader');
  assert.equal(introspection.user,'main'); assert.deepEqual(introspection.jdbc?.options?.startupStatements,['SELECT 1']);
  assert.equal(sessionTemplate(base,'console','').user,'main');
  assert.throws(() => sessionTemplate(base,'console','missing'), /удалён/);
  assert.equal(base.user,'main'); assert.equal(base.jdbc?.properties?.password,'advanced-password');
});
test('template secrets are encrypted, masked, preserved only for the same identity and clearable', async () => {
  const work = await mkdtemp(join(tmpdir(),'session-templates-'));
  try {
    const store = new ProfileStore(join(work,'profiles.json'), { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value,'base64').toString() });
    let saved = await store.save({ ...base, id: undefined });
    assert.equal(saved.jdbc?.sessionTemplates?.[0]?.authentication?.secret,undefined);
    assert.equal(saved.jdbc?.sessionTemplates?.[0]?.authentication?.hasSecret,true);
    assert.ok(!(await readFile(join(work,'profiles.json'),'utf8')).includes('reader-secret'));
    saved = await store.save({ ...saved, name: 'Renamed' });
    assert.equal(sessionTemplate(await store.get(saved.id),'console').secret,'reader-secret');
    saved.jdbc!.sessionTemplates![0]!.authentication!.user='changed-user';
    saved = await store.save(saved);
    assert.equal((await store.get(saved.id)).jdbc?.sessionTemplates?.[0]?.authentication?.secret,undefined);
    saved.jdbc!.sessionTemplates![0]!.authentication!.secret='replacement';
    saved=await store.save(saved);
    saved.jdbc!.sessionTemplates![0]!.authentication!.secret='';
    saved=await store.save(saved);
    assert.equal(saved.jdbc?.sessionTemplates?.[0]?.authentication?.hasSecret,false);
  } finally { await rm(work,{recursive:true,force:true}); }
});
test('invalid references, duplicate templates and corrupt fields fail before renderer receives settings', () => {
  assert.throws(() => validateJdbc({ defaultSessionTemplate:'missing' }),/не существует/);
  assert.throws(() => validateJdbc({ sessionTemplates:[{id:'a',name:'A'},{id:'a',name:'B'}] }),/уникальные/);
  assert.throws(() => validateJdbc({ sessionTemplates:[{id:'a',name:'A',authentication:null as never}] }),/аутентификация/);
  assert.throws(() => validateJdbc({ sessionTemplates:[{id:'a',name:'A',options:{startupStatements:[null as never]}}] }),/startup/);
});
