# Clip-n-Shipper installer for Windows. Safe to run again: running it is also how you update.
#
#   irm https://github.com/MitchTorbert/clip-n-shipper/releases/latest/download/install.ps1 | iex
#
# What it does (all inside your own user account, no admin needed):
#   1. puts the helper and its tools in %LOCALAPPDATA%\Clip-n-Shipper
#   2. installs the Premiere panel (through Adobe's own plugin installer)
#   3. makes the helper start by itself when you log in (hidden, no window)
#
# Settings for testing (environment variables, same as the Mac installer):
#   CNS_HOME, CNS_PORT, CNS_LOCAL_RELEASE (a local dist folder instead of the web),
#   CNS_SKIP_PANEL=1, CNS_SKIP_AGENT=1
#
# Note: this file is run with "| iex", so it must never call "exit" (that would close the
# editor's PowerShell window). Everything lives in one script block and errors are thrown.
# Keep this file plain ASCII: Windows PowerShell 5.1 misreads other characters.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads 10x slower in PowerShell 5
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

  $Repo        = 'MitchTorbert/clip-n-shipper'
  $Release     = "https://github.com/$Repo/releases/latest/download"
  $HomeDir     = if ($env:CNS_HOME) { $env:CNS_HOME } else { Join-Path $env:LOCALAPPDATA 'Clip-n-Shipper' }
  $NodeVersion = 'v24.21.0'
  $Port        = if ($env:CNS_PORT) { $env:CNS_PORT } else { '8934' }
  $RunKey      = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $RunName     = 'Clip-n-Shipper Helper'
  $PowerShell  = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $Desktop     = [Environment]::GetFolderPath('Desktop')   # follows OneDrive's Desktop if it's redirected
  $Runner      = Join-Path $HomeDir 'run-helper.ps1'
  $Log         = Join-Path $HomeDir 'helper.log'

  function Say($msg) { Write-Host ''; Write-Host $msg -ForegroundColor White }
  function Fail($msg) { throw "CNS: $msg" }

  # Adobe's plugin installer (confirmed location on a Creative Cloud PC).
  function Find-Upia {
    $roots = @($env:CommonProgramW6432, $env:CommonProgramFiles, "$env:ProgramFiles\Common Files") | Where-Object { $_ } | Select-Object -Unique
    foreach ($root in $roots) {
      $dir = Join-Path $root 'Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent'
      $exe = Join-Path $dir 'UnifiedPluginInstallerAgent.exe'
      if (Test-Path -LiteralPath $exe) { return $exe }
    }
    return $null
  }

  # Runs a program, waits, and returns its exit code. Output goes to a log file, not the screen.
  # (Start-Process avoids PowerShell 5 treating a tool's warnings as errors.)
  function Run-Quiet($file, [string[]]$arguments, $logFile, $workDir) {
    $quoted = $arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
    $p = @{ FilePath = $file; ArgumentList = $quoted; Wait = $true; PassThru = $true; NoNewWindow = $true
            RedirectStandardOutput = "$logFile.out"; RedirectStandardError = "$logFile.err" }
    if ($workDir) { $p.WorkingDirectory = $workDir }
    $proc = Start-Process @p
    Get-Content "$logFile.out", "$logFile.err" -ErrorAction SilentlyContinue | Set-Content $logFile
    return $proc.ExitCode
  }

  function Show-LogTail($logFile) {
    if (Test-Path $logFile) { Get-Content $logFile -Tail 15 | ForEach-Object { Write-Host "  $_" } }
  }

  function Fetch($name, $dest) {
    if ($env:CNS_LOCAL_RELEASE) { Copy-Item (Join-Path $env:CNS_LOCAL_RELEASE $name) $dest -Force }
    else { Invoke-WebRequest -UseBasicParsing -Uri "$Release/$name" -OutFile $dest }
  }

  # Unzip with Windows' built-in tar (fast); fall back to Expand-Archive (slow but always there).
  function Unzip($zip, $dest) {
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tar) {
      $code = Run-Quiet $tar @('-xf', $zip, '-C', $dest) (Join-Path $Tmp 'tar.log')
      if ($code -eq 0) { return }
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
  }

  function Test-Helper {
    try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$Port/ping"; return $r.StatusCode -eq 200 }
    catch { return $false }
  }

  # Stops our own helper (the hidden runner first, so it doesn't start node again).
  function Stop-Helper {
    $runners = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Runner*" }
    $nodes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "$HomeDir\node\*" }
    foreach ($p in @($runners) + @($nodes)) {
      if ($p) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    if ($runners -or $nodes) { Start-Sleep -Seconds 2 }
  }

  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("cns-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

  try {
    if ($env:OS -ne 'Windows_NT') { Fail 'This installer is for Windows.' }
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
      'AMD64' { $NodeArch = 'x64' }
      'ARM64' { $NodeArch = 'arm64' }
      default { Fail "Unknown PC type $arch (Clip-n-Shipper needs 64-bit Windows)" }
    }

    Say '1/5  Getting the latest Clip-n-Shipper...'
    New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir 'bin') | Out-Null
    # Windows won't replace files a running program is using, so stop an older helper first.
    Stop-Helper
    try { Fetch 'clip-n-shipper-helper.zip' (Join-Path $Tmp 'helper.zip') } catch { Fail "couldn't download the helper (check your internet connection)" }
    $AppNew = Join-Path $HomeDir 'app.new'
    $App    = Join-Path $HomeDir 'app'
    if (Test-Path $AppNew) { Remove-Item $AppNew -Recurse -Force }
    Unzip (Join-Path $Tmp 'helper.zip') $AppNew
    $Version = '?'
    if (Test-Path (Join-Path $AppNew 'VERSION')) { $Version = (Get-Content (Join-Path $AppNew 'VERSION') -Raw).Trim() }
    # keep the installed packages across updates so they don't re-download
    $oldModules = Join-Path $App 'server\node_modules'
    if (Test-Path $oldModules) { Move-Item $oldModules (Join-Path $AppNew 'server\node_modules') }
    if (Test-Path $App) {
      try { Remove-Item $App -Recurse -Force }
      catch { Fail "couldn't replace the old copy in $App (close any window or program using that folder, then run this again)" }
    }
    Move-Item $AppNew $App
    Write-Host "Version $Version"

    Say '2/5  Setting up the tools it needs...'
    $NodeDir = Join-Path $HomeDir 'node'
    $NodeExe = Join-Path $NodeDir 'node.exe'
    $haveNode = $false
    if (Test-Path $NodeExe) { $haveNode = ((& $NodeExe --version) -eq $NodeVersion) }
    if (-not $haveNode) {
      Write-Host 'Downloading Node...'
      $nodeName = "node-$NodeVersion-win-$NodeArch"
      try { Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$NodeVersion/$nodeName.zip" -OutFile (Join-Path $Tmp 'node.zip') }
      catch { Fail "couldn't download Node" }
      Unzip (Join-Path $Tmp 'node.zip') (Join-Path $Tmp 'node')
      if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
      Move-Item (Join-Path $Tmp "node\$nodeName") $NodeDir
    }
    Write-Host 'Downloading the video downloader (yt-dlp)...'
    $YtDlp = Join-Path $HomeDir 'bin\yt-dlp.exe'
    try { Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile $YtDlp }
    catch { Fail "couldn't download yt-dlp" }
    Unblock-File -LiteralPath $YtDlp -ErrorAction SilentlyContinue
    Write-Host "Installing the helper's packages (a minute or two the first time)..."
    $env:Path = "$NodeDir;$env:Path"
    $npmCli = Join-Path $NodeDir 'node_modules\npm\bin\npm-cli.js'
    $npmLog = Join-Path $Tmp 'npm.log'
    $code = Run-Quiet $NodeExe @($npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund') $npmLog (Join-Path $App 'server')
    if ($code -ne 0) { Show-LogTail $npmLog; Fail "couldn't install the helper's packages" }

    Say '3/5  Installing the Premiere panel...'
    $Ccx = Join-Path $Tmp 'Clip-n-Shipper.ccx'
    try { Fetch 'clip-n-shipper-panel.ccx' $Ccx } catch { Fail "couldn't download the panel" }
    $Upia = Find-Upia
    if ($env:CNS_SKIP_PANEL -eq '1') {
      Write-Host '(skipped)'
    } elseif ($Upia) {
      # Replace any older copy first, so an update is clean.
      foreach ($old in @('Clip-n-Shipper', 'Clip-n-Ship Setup')) {
        Run-Quiet $Upia @('/remove', $old) (Join-Path $Tmp 'upia-remove.log') | Out-Null
      }
      $upiaLog = Join-Path $Tmp 'upia.log'
      # Adobe documents "/install" on Windows; "--install" is the Mac spelling, tried as a backup.
      $code = Run-Quiet $Upia @('/install', $Ccx) $upiaLog
      if ($code -ne 0) { $code = Run-Quiet $Upia @('--install', $Ccx) $upiaLog }
      if ($code -eq 0) {
        Write-Host 'Panel installed.'
      } else {
        Copy-Item $upiaLog (Join-Path $HomeDir 'panel-install.log') -Force -ErrorAction SilentlyContinue
        Copy-Item $Ccx (Join-Path $Desktop 'Clip-n-Shipper.ccx') -Force
        Write-Host "Adobe's installer didn't accept it automatically."
        Write-Host 'Double-click  Clip-n-Shipper.ccx  on your Desktop to finish (Creative Cloud will install it).'
      }
    } else {
      Copy-Item $Ccx (Join-Path $Desktop 'Clip-n-Shipper.ccx') -Force
      Write-Host "Creative Cloud's plugin installer wasn't found."
      Write-Host 'Double-click  Clip-n-Shipper.ccx  on your Desktop to finish (Creative Cloud will install it).'
    }

    Say '4/5  Making the helper start by itself...'
    if ($env:CNS_SKIP_AGENT -eq '1') {
      Write-Host '(skipped)'
    } else {
      # A small hidden PowerShell loop keeps the helper running, like the Mac's launch agent:
      # the helper quits by itself after an update, and this starts it again 10 seconds later.
      $runnerText = @'
# Keeps the Clip-n-Shipper helper running (started hidden at log on). Written by install.ps1.
$ErrorActionPreference = 'Continue'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$log  = Join-Path $base 'helper.log'
$env:CNS_BIN = Join-Path $base 'bin'
$env:CNS_PORT = '__PORT__'
$env:CLIPNSHIP_AUTORESTART = '1'
$env:Path = (Join-Path $base 'bin') + ';' + (Join-Path $base 'node') + ';' + $env:Path
Set-Location (Join-Path $base 'app')
while ($true) {
  try { if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) { Move-Item $log "$log.old" -Force } } catch {}
  ('--- helper starting ' + (Get-Date -Format 's')) | Out-File -FilePath $log -Append -Encoding utf8
  & (Join-Path $base 'node\node.exe') (Join-Path $base 'app\server\index.js') 2>&1 |
    ForEach-Object { "$_" } | Out-File -FilePath $log -Append -Encoding utf8
  Start-Sleep -Seconds 10
}
'@
      $runnerText.Replace('__PORT__', $Port) | Set-Content -Path $Runner -Encoding ASCII
      $command = "`"$PowerShell`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Runner`""
      New-Item -Path $RunKey -Force -ErrorAction SilentlyContinue | Out-Null
      Set-ItemProperty -Path $RunKey -Name $RunName -Value $command
      if (Test-Helper) {
        Write-Host 'Note: another copy of the helper is already running (maybe one started by hand).'
        Write-Host 'Close it, or restart the PC, so only the installed one runs.'
      }
      Start-Process -FilePath $PowerShell -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$Runner`"")
    }

    Say '5/5  Checking that the helper is up...'
    if ($env:CNS_SKIP_AGENT -eq '1') {
      Write-Host '(skipped)'
    } else {
      $ok = $false
      for ($i = 0; $i -lt 15; $i++) { if (Test-Helper) { $ok = $true; break }; Start-Sleep -Seconds 2 }
      if (-not $ok) { Fail "the helper didn't start (details are in $Log)" }
      Write-Host 'Helper is running.'
    }

    Say "All done!  (version $Version)"
    Write-Host 'Next: quit Premiere if it is open, then open it again.'
    Write-Host 'Find the panel in the Window menu, under UXP Plugins (or Extensions) > Clip-n-Shipper.'
    Write-Host 'To update later, just run this installer again.'
  }
  catch {
    $msg = $_.Exception.Message -replace '^CNS: ', ''
    Write-Host ''
    Write-Host "Something went wrong: $msg" -ForegroundColor Red
    Write-Host 'Take a screenshot of this window and send it to Mitch.'
  }
  finally {
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
