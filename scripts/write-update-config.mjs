import { writeFile } from 'node:fs/promises';
const repository = process.env.UPDATE_REPOSITORY || process.env.GITHUB_REPOSITORY || 'yakut-sekonts/local-db-viewer';
if (!/^[\w-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid update repository');
await writeFile('build/update-config.json', JSON.stringify({ repository }) + '\n');
