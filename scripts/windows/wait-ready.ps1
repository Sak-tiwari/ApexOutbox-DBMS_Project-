# Waits up to 60 s for the API to answer /ready with HTTP 200 (MongoDB and Redis both reachable).
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3000/ready" -TimeoutSec 3
    if ($r.StatusCode -eq 200) { exit 0 }
  } catch { }
  Start-Sleep -Seconds 1
}
exit 1
