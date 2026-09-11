import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';

const common = 'runtime/common';
if (!existsSync(common)) throw new Error('Run scripts/prepare-runtime.py before building JDBC.');
const compilerHome = process.env.JAVA_HOME || 'runtime/compiler';
const javac = join(compilerHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
const jar = join(compilerHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar');
const classes = 'runtime/classes'; mkdirSync(classes, { recursive: true });
const jars = readdirSync(common).filter(name => name.endsWith('.jar') && name !== 'local-db-viewer-bridge.jar').map(name => join(common, name));
execFileSync(javac, ['--release', '21', '-encoding', 'UTF-8', '-cp', jars.join(delimiter), '-d', classes, 'jdbc/LocalDBViewerBridge.java'], { stdio: 'inherit' });
execFileSync(jar, ['--create', '--file', join(common, 'local-db-viewer-bridge.jar'), '-C', classes, '.'], { stdio: 'inherit' });
