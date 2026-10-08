param([ValidateSet('Probe','Run')][string]$Mode, [int]$HostProcessId, [string]$JobFile)
$ErrorActionPreference = 'Stop'
function Identity($p) {
  return @{ pid=[int]$p.ProcessId; path=[string]$p.ExecutablePath; created=$p.CreationDate.ToUniversalTime().ToString('o') }
}
function SameProcess($expected) {
  $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($expected.pid)"
  if (!$p) { return $null }
  $actual=Identity $p
  if ($actual.path -ne $expected.path -or $actual.created -ne $expected.created) { throw 'Process identity changed; restart stopped' }
  return $p
}
if ($Mode -eq 'Probe') {
  $current=$HostProcessId
  for($i=0;$i -lt 16 -and $current -gt 0;$i++) {
    $p=Get-CimInstance Win32_Process -Filter "ProcessId=$current"
    if (!$p) { break }
    if ($p.Name -eq 'DeepSeek Harness.exe' -and $p.CommandLine -notmatch '--type=|dsh-desktop-host|ELECTRON_RUN_AS_NODE') {
      $resource=Join-Path (Split-Path $p.ExecutablePath) 'resources/app.asar'
      if (!(Test-Path -LiteralPath $resource)) { throw 'Official desktop resources unavailable' }
      Identity $p | ConvertTo-Json -Compress
      exit 0
    }
    $current=[int]$p.ParentProcessId
  }
  throw 'This host does not belong to a supported Windows DeepSeek Harness desktop'
}
$job=Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json
$folder=Split-Path $JobFile
function Status($state,$detail) {
  @{state=$state;detail=$detail;at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $folder 'status.json') -Encoding UTF8
}
try {
  if (!(SameProcess $job.owner)) { throw 'DSH has already exited' }
  if (!(Test-Path -LiteralPath $job.owner.path)) { throw 'DSH executable missing' }
  Status 'ready' 'Waiting for the confirmed HTTP response to finish'
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  while (!(Test-Path -LiteralPath (Join-Path $folder 'go'))) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Restart response was not delivered; DSH left running' }
    Start-Sleep -Milliseconds 100
  }
  if (!(SameProcess $job.owner)) { throw 'DSH exited before restart' }
  # Freeze identities before stopping anything; never kill by image name.
  $all=@(Get-CimInstance Win32_Process)
  $ids=@([int]$job.owner.pid)
  do {
    $next=@($all | Where-Object {$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids -and $_.ProcessId -ne $PID} | ForEach-Object {[int]$_.ProcessId})
    $ids+=$next
  } while ($next.Count -gt 0)
  $targets=@($all | Where-Object {$_.ProcessId -in $ids} | ForEach-Object {Identity $_})
  Status 'stopping' 'Stopping only the verified DSH process tree'
  foreach($target in $targets) {
    if (SameProcess $target) { Stop-Process -Id $target.pid -Force -ErrorAction SilentlyContinue }
  }
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  do {
    $remaining=@($targets | Where-Object {SameProcess $_})
    if (!$remaining.Count) { break }
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Old DSH processes did not exit; no duplicate instance started' }
    Start-Sleep -Milliseconds 100
  } while ($true)
  # The host may be launched via Electron-as-Node; do not propagate that mode.
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  Status 'starting' 'Launching the same installed desktop executable'
  $started=Start-Process -FilePath $job.owner.path -WorkingDirectory (Split-Path $job.owner.path) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $folder 'desktop.stdout.log') -RedirectStandardError (Join-Path $folder 'desktop.stderr.log') -PassThru
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  do {
    if ($started.HasExited) { throw "DSH exited during startup ($($started.ExitCode)); launch the installed app manually" }
    $output=Get-Content -LiteralPath (Join-Path $folder 'desktop.stdout.log') -Raw -ErrorAction SilentlyContinue
    if ($output -match 'dsh web: http://127\.0\.0\.1:') { Status 'running' "DSH host ready; new main PID $($started.Id)"; exit 0 }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'DSH launched but host readiness timed out; inspect local restart logs'
} catch {
  Status 'failed' $_.Exception.Message
  exit 1
}
