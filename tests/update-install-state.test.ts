import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { confirmUpdateStartup, installState } from '../electron/update-install-state';
import { Updater } from '../electron/updater';

test('startup acknowledgement requires the expected version and fresh pending restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'install-state-'));
  try {
    const state = { phase: 'restarting', version: '0.4.1', message: 'ready', token: randomUUID(), timestamp: new Date().toISOString() };
    await writeFile(join(directory, 'install-state.json'), JSON.stringify(state));
    await confirmUpdateStartup(directory, '0.4.0');
    await assert.rejects(readFile(join(directory, 'startup-ack.json')));
    await confirmUpdateStartup(directory, '0.4.1');
    const ack = JSON.parse(await readFile(join(directory, 'startup-ack.json'), 'utf8'));
    assert.equal(ack.token, state.token); assert.equal(ack.version, state.version);
    await writeFile(join(directory, 'install-state.json'), JSON.stringify({ ...state, token: 'invalid-token' }));
    assert.equal(await installState(directory), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('failed installation remains visible after a later successful release check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'install-error-'));
  const updater = new Updater(directory, '0.4.0', { encrypt: value => value, decrypt: value => value }, () => {}, async () => {}, async () => new Response(JSON.stringify({ tag_name: 'v0.4.0', assets: [] })));
  try {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ repository: 'fixture/releases', automatic: false }));
    await writeFile(join(directory, 'install-state.json'), JSON.stringify({ phase: 'error', version: '0.4.1', message: 'Installer exited with code 2', token: randomUUID(), timestamp: new Date().toISOString() }));
    await updater.initialize(); await updater.check();
    assert.match(updater.state().installationError ?? '', /code 2/);
    assert.equal(updater.state().phase, 'idle');
  } finally { updater.dispose(); await rm(directory, { recursive: true, force: true }); }
});
