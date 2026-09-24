import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, QuerySnapshot } from '../src/shared';
import type { DriversState } from '../src/drivers';
import type { UpdateState } from '../src/updates';

async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  try { return await ipcRenderer.invoke(channel, ...args); }
  catch (error) { throw new Error((error as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
}

const api: DesktopAPI = {
  sources: { load: input => invoke('sources:load', input) },
  ddl: { list: () => invoke('ddl:list'), chooseDirectory: () => invoke('ddl:directory'), save: value => invoke('ddl:save', value), remove: id => invoke('ddl:remove', id), files: id => invoke('ddl:files', id), writeFile: (id, file, sql, hash) => invoke('ddl:write-file', id, file, sql, hash), preview: id => invoke('ddl:preview', id), writePreview: (token, files) => invoke('ddl:write-preview', token, files), index: id => invoke('ddl:index', id) },
  jdbc: { properties: profile => invoke('jdbc:properties', profile), preview: input => invoke('jdbc:preview', input), browse: (profile, input) => invoke('jdbc:browse', profile, input) },
  ssh: { fingerprint: (host, port) => invoke('ssh:fingerprint', host, port) },
  drivers: {
    state: () => invoke('drivers:state'), check: () => invoke('drivers:check'), automatic: enabled => invoke('drivers:automatic', enabled),
    install: id => invoke('drivers:install', id), select: (id, key) => invoke('drivers:select', id, key), import: (id, version) => invoke('drivers:import', id, version),
    onChange: listener => {
      const handler = (_: Electron.IpcRendererEvent, state: DriversState) => listener(state);
      ipcRenderer.on('drivers:change', handler); return () => ipcRenderer.removeListener('drivers:change', handler);
    },
  },
  updates: {
    state: () => invoke('updates:state'),
    configure: input => invoke('updates:configure', input),
    check: () => invoke('updates:check'),
    download: () => invoke('updates:download'),
    install: () => invoke('updates:install'),
    onChange: listener => {
      const handler = (_: Electron.IpcRendererEvent, value: UpdateState) => listener(value);
      ipcRenderer.on('updates:change', handler);
      return () => ipcRenderer.removeListener('updates:change', handler);
    },
  },
  profiles: {
    list: () => invoke('profiles:list'),
    save: value => invoke('profiles:save', value),
    remove: id => invoke('profiles:remove', id),
    test: value => invoke('profiles:test', value),
  },
  query: {
    run: input => invoke('query:run', input),
    cancel: id => invoke('query:cancel', id),
    release: (id, guard) => invoke('query:release', id, guard),
    onUpdate: listener => {
      const handler = (_: Electron.IpcRendererEvent, value: QuerySnapshot) => listener(value);
      ipcRenderer.on('query:update', handler);
      return () => ipcRenderer.removeListener('query:update', handler);
    },
  },
  metadata: input => invoke('metadata', input),
  schema: {
    load: input => invoke('schema:load', input),
    saveRelation: (profileId, relation) => invoke('schema:save-relation', profileId, relation),
    removeRelation: (profileId, id) => invoke('schema:remove-relation', profileId, id),
  },
  exportCSV: input => invoke('export:csv', input),
  files: { path: kind => invoke('files:path', kind), open: () => invoke('files:open'), save: sql => invoke('files:save', sql), database: () => invoke('files:database'), certificate: () => invoke('files:certificate') },
};
contextBridge.exposeInMainWorld('studio', api);
