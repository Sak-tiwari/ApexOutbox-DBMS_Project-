param([switch]$Quiet)
# Stops the API and worker that start-apexoutbox.bat launched (and their console windows).
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$procs = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -in @("node.exe", "cmd.exe")) -and $_.CommandLine -and (
    ($_.CommandLine -like "*$root*" -and $_.CommandLine -match "server\.ts|worker\.ts|tsx") -or
    ($_.Name -eq "cmd.exe" -and $_.CommandLine -match "title ApexOutbox (API|Worker)")
  )
}
foreach ($p in $procs) {
  if ($p.ProcessId -ne $PID) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}
if (-not $Quiet) { Write-Host ("Stopped {0} process(es)." -f @($procs).Count) }
