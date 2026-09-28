import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function buildMultipleResultsFixture() {
  const compiler=process.env.JAVA_HOME || resolve('runtime/compiler');
  const binary=name=>join(compiler,'bin',name+(process.platform==='win32'?'.exe':''));
  const directory=resolve('dist-tests/multiple-results');
  mkdirSync(directory,{recursive:true});
  execFileSync(binary('javac'),['--release','21','-encoding','UTF-8','-d',directory,'tests/jdbc/MultipleResultsDriver.java'],{stdio:'inherit'});
  const jar=join(directory,'fixture.jar');
  execFileSync(binary('jar'),['--create','--file',jar,'-C',directory,'fixture'],{stdio:'inherit'});
  return jar;
}
