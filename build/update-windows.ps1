param([int]$ParentProcessId, [string]$Installer, [string]$Application, [string]$LogPath)
$ErrorActionPreference = 'Stop'
try {
    $parent = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
    if ($parent -and -not $parent.WaitForExit(60000)) { throw 'Local DB Viewer did not exit; update canceled' }
    $process = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode)" }
    Start-Process -FilePath $Application
    'Local DB Viewer updated' | Out-File -FilePath $LogPath -Encoding utf8
} catch {
    $_.Exception.Message | Out-File -FilePath $LogPath -Encoding utf8
    throw
}
