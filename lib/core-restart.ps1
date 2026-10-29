param([ValidateSet('Probe','Run')][string]$Mode, [int]$HostProcessId, [string]$JobFile)
$ErrorActionPreference = 'Stop'
function Identity($p) {
  return @{ pid=[int]$p.ProcessId; path=[string]$p.ExecutablePath; created=$p.CreationDate.ToUniversalTime().ToString('o') }
}
function SameProcess($expected) {
  $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($expected.pid)"
  if (!$p) { return $null }
  $actual=Identity $p
  if ($actual.path -ne $expected.path -or $actual.created -ne $expected.created) { return $null }
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

  # Wait until the Electron profile is actually released. The identity wait above only covers
  # the tree frozen before the kill; a helper that outlives it keeps the user-data lock, and the
  # replacement then exits within a second. Measured 2026-10-27 12:31:16: status.json said
  # "DSH exited during startup ()" and the user had to launch the app by hand.
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  do {
    $samePath=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $job.owner.path })
    if (!$samePath.Count) { break }
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Old DSH processes still hold the profile; no replacement launched' }
    Start-Sleep -Milliseconds 200
  } while ($true)

  # One launch is not evidence. A launcher that re-execs exits and leaves the real host behind,
  # so readiness is judged by the host itself - its stdout line or its window - not by the pid we
  # happened to start. A launch that dies with nothing left behind is retried, bounded.
  $attempts=0; $ready=$false; $lastDetail=''
  while ($attempts -lt 3 -and !$ready) {
    $attempts++
    Status 'starting' "Launching the installed desktop executable (attempt $attempts of 3)"
    # NOT -WindowStyle Hidden for the app itself. Measured 2026-10-27 12:35:31: the host came back
    # with the HTTP server up and ZERO visible windows, because this Electron build creates its
    # first window with the startup show state it was given. The helper stays hidden; the app must
    # start normal or the restart looks to the user exactly like "it did not start".
    $started=Start-Process -FilePath $job.owner.path -WorkingDirectory (Split-Path $job.owner.path) -WindowStyle Normal -RedirectStandardOutput (Join-Path $folder 'desktop.stdout.log') -RedirectStandardError (Join-Path $folder 'desktop.stderr.log') -PassThru
    $deadline=[DateTime]::UtcNow.AddSeconds(45)
    do {
      $output=Get-Content -LiteralPath (Join-Path $folder 'desktop.stdout.log') -Raw -ErrorAction SilentlyContinue
      if ($output -match 'dsh web: http://127\.0\.0\.1:') { $lastDetail='HTTP server up, waiting for a visible window' }
      $alive=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $job.owner.path -and $_.CommandLine -notmatch '--type=' })
      # A desktop app is not "ready" until it has a visible window. The stdout line only proves the
      # HTTP server is up, and a windowless host is precisely the failure the user reported.
      $window=@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
      if ($window.Count -gt 0) { $ready=$true; break }
      if ($started.HasExited -and !$alive.Count) { $lastDetail="launched process exited ($($started.ExitCode)) with no host left behind"; break }
      Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$ready -and $attempts -lt 3) { Start-Sleep -Seconds 2 }
  }
  if ($ready) { Status 'running' "DSH host ready after $attempts attempt(s)"; exit 0 }
  throw "DSH did not become ready after $attempts attempt(s): $lastDetail"
} catch {
  Status 'failed' $_.Exception.Message
  exit 1
}
