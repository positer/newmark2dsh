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

  # A REPLACEMENT THAT IS ALREADY UP IS THE RESTART SUCCEEDING, NOT THE OLD TREE LINGERING.
  #
  # This used to ask "is there ANY process whose ExecutablePath is the host's" and throw after 20 s
  # otherwise. That question cannot tell "the frozen tree is still dying" from "something already
  # brought the app back", because both are the same executable path - and measured 2026-11-17 22:26
  # it answered the second case with the first case's verdict: the app was running again at 22:26:43,
  # the helper wrote "Old DSH processes still hold the profile; no replacement launched" at 22:27:12,
  # launched nothing at all (its desktop.stdout.log stayed 0 bytes), and the user had to start DSH by
  # hand. A stop this component requested must end with a host, never with that sentence.
  #
  # The frozen tree is the only thing that can be "old"; anything alive on that path after it is gone
  # is a replacement. So: the old tree must be gone (identity), and a same-path process that is NOT in
  # it is the replacement - reported as running instead of being mistaken for a blocker.
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  $replacement=@()
  do {
    $left=@($targets | Where-Object {SameProcess $_})
    if ($left.Count) {
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Old DSH processes did not exit; no duplicate instance started' }
      Start-Sleep -Milliseconds 100
      continue
    }
    $replacement=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $job.owner.path -and $_.CommandLine -notmatch '--type=' })
    if ($replacement.Count) { break }
    if ([DateTime]::UtcNow -gt $deadline) { break }
    Start-Sleep -Milliseconds 200
  } while ($true)
  if ($replacement.Count) {
    # Wait for the replacement to be usable before saying so, but never turn its existence into a
    # failure: the host is already coming up, and a continuation delivered to a host still booting is
    # retried by the new process, while a "failed" receipt stops it from ever being delivered.
    $deadline=[DateTime]::UtcNow.AddSeconds(60)
    do {
      $window=@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
      if ($window.Count -gt 0) { break }
      if ([DateTime]::UtcNow -gt $deadline) { break }
      Start-Sleep -Milliseconds 300
    } while ($true)
    $windows=@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count
    Status 'running' "A replacement host was already running after the stop; no duplicate launched (visible windows: $windows)"
    exit 0
  }

  # One launch is not evidence. A launcher that re-execs exits and leaves the real host behind,
  # so readiness is judged by the host itself - its stdout line or its window - not by the pid we
  # happened to start.
  #
  # RESTART IS NOT AN OPTION (0.3.84). This loop used to stop after three attempts and throw
  # "DSH did not become ready after 3 attempt(s)", leaving the user to start the app by hand - but
  # the process is already down by then, so "failed" is not a safe end state: it is the exact state
  # the restart was supposed to leave behind. The window is now a MANDATORY five minutes: as long as
  # the executable exists, the helper keeps relaunching. A helper that cannot start the app at all
  # (missing executable, refused launch on every attempt) still reports failed, because claiming a
  # host exists when it does not would be worse than saying so.
  $attempts=0; $ready=$false; $lastDetail=''
  $mandatory=[DateTime]::UtcNow.AddSeconds(300)
  while (!$ready -and [DateTime]::UtcNow -lt $mandatory) {
    $attempts++
    Status 'starting' "Launching the installed desktop executable (attempt $attempts)"
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
    if (!$ready -and !(Test-Path -LiteralPath $job.owner.path)) { throw "DSH executable missing: $($job.owner.path)" }
    if (!$ready) { Start-Sleep -Seconds 3 }
  }
  if ($ready) { Status 'running' "DSH host ready after $attempts attempt(s)"; exit 0 }
  throw "DSH did not become ready after $attempts attempt(s) in the five-minute window: $lastDetail"
} catch {
  Status 'failed' $_.Exception.Message
  exit 1
}
