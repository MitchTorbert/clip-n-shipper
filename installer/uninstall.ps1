# Removes Clip-n-Shipper completely (Windows).
#
#   irm https://github.com/MitchTorbert/clip-n-shipper/releases/latest/download/uninstall.ps1 | iex
#
# Run with "| iex", so no "exit" here (it would close the PowerShell window). Plain ASCII only.

& {
  $HomeDir = if ($env:CNS_HOME) { $env:CNS_HOME } else { Join-Path $env:LOCALAPPDATA 'Clip-n-Shipper' }
  $Runner  = Join-Path $HomeDir 'run-helper.ps1'

  # 1. stop starting at log on
  Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Clip-n-Shipper Helper' -ErrorAction SilentlyContinue

  # 2. stop the running helper (the hidden runner first, so it doesn't start node again)
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Runner*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "$HomeDir\node\*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2

  # 3. remove the Premiere panel
  foreach ($root in @($env:CommonProgramW6432, $env:CommonProgramFiles) | Where-Object { $_ }) {
    $upia = Join-Path $root 'Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe'
    if (Test-Path -LiteralPath $upia) {
      Start-Process -FilePath $upia -ArgumentList @('/remove', 'Clip-n-Shipper') -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
      break
    }
  }

  # 4. remove the files
  Remove-Item $HomeDir -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $HomeDir) {
    Write-Host "Some files in $HomeDir couldn't be removed (something is still using them). Restart the PC and run this again."
  } else {
    Write-Host 'Clip-n-Shipper has been removed. Restart Premiere to finish.'
  }
}
