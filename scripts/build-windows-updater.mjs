import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
if (process.platform === 'win32') {
  const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', '/win32manifest:build/update-windows.manifest', '/out:build/update-windows.exe', 'build/UpdateWindows.cs'], { stdio: 'inherit' });
}
