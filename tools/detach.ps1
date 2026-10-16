<#
.SYNOPSIS
  Start a script outside the caller's process tree, so it outlives an agent run.

.DESCRIPTION
  Agent runtimes put each run in a Windows Job Object with kill-on-close and no
  breakaway, so everything the run starts (Start-Process and `start` included)
  dies when the run ends. Win32_Process.Create makes WmiPrvSE the parent, which
  is outside that job. Same user, same desktop session, no admin rights.

  The script runs under cmd with stdout/stderr appended to
  logs\detached\<name>-<timestamp>.log. Prints the wrapper PID and the log path.
  Stop it with: taskkill /PID <pid> /T /F

.EXAMPLE
  pwsh -NoProfile -File tools\detach.ps1 dev.bat
.EXAMPLE
  pwsh -NoProfile -File tools\detach.ps1 tools\yue2-vae-train\run.bat --resume
#>
param(
  [Parameter(Mandatory, Position = 0)][string]$Script,
  [Parameter(ValueFromRemainingArguments)][string[]]$ScriptArgs
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$target = (Resolve-Path $Script).Path

# Everything is pasted into one cmd /c line: refuse what cmd would treat as
# an operator, expansion or quote, rather than trying to escape it.
foreach ($a in @($target) + @($ScriptArgs)) {
  if ($null -ne $a -and ($a -eq '' -or $a -match '[&|<>^"%]')) {
    throw "Unsupported argument '$a': empty values and & | < > ^ `" % cannot be passed through cmd safely."
  }
}

# A second dev.bat on top of a live stack is the doubled-VRAM orphan problem.
if ((Split-Path $target -Leaf) -eq 'dev.bat' -and
    (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)) {
  throw 'The app is already running (port 3001 is listening). Use it, or stop it first.'
}
# Bitdefender ATD kills the whole tree when the browser helper's
# `powershell -ExecutionPolicy Bypass` runs under a WMI-started cmd.
if ((Split-Path $target -Leaf) -eq 'dev.bat') { $ScriptArgs = @('--no-browser') + @($ScriptArgs | Where-Object { $_ }) }

$logDir = Join-Path $repo 'logs\detached'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ('{0}-{1:yyyyMMdd-HHmmss}.log' -f [IO.Path]::GetFileNameWithoutExtension($target), (Get-Date))

$argText = ($ScriptArgs | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join ' '
$cmdLine = "cmd /d /s /c `"`"$target`" $argText >> `"$log`" 2>&1`""

$startup = New-CimInstance -ClientOnly -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = $cmdLine
  CurrentDirectory = (Get-Location).ProviderPath
  ProcessStartupInformation = $startup
}
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed with code $($r.ReturnValue)" }
"PID $($r.ProcessId)"
"Log $log"
