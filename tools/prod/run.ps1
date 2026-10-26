$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$config = Get-Content (Join-Path $root '.prod/config.json') -Raw | ConvertFrom-Json
if (-not $config.scratch) { throw 'Shared-data activation is gated on both slice reviews. Use a scratch root for now.' }
if (Get-NetTCPConnection -LocalPort 3101,8186 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Production ports are already occupied.'
}
$env:HOT_STEP_PROFILE_DIR = Join-Path $root '.prod/scratch-profile'
Remove-Item Env:HOT_STEP_ROOT,Env:HOT_STEP_DEV,Env:HOT_STEP_DATA_ROOT -ErrorAction SilentlyContinue
$env:SERVER_PORT = '3101'
$env:ACESTEPCPP_PORT = '8186'
$env:ACESTEPCPP_HOST = '127.0.0.1'
$env:ACESTEPCPP_MODELS = $config.models
$env:ACESTEPCPP_EXE = Join-Path $root 'engine/build/Release/ace-server.exe'
$env:ACESTEPCPP_WARM_ON_STARTUP = '0'
$env:ACESTEPCPP_KEEP_LOADED = '0'
$env:HOTSTEP_PROD_TOKEN = $config.token
# Shared settings must never redirect scratch writes into the real library.
$env:DATA_DIR = Join-Path $config.scratch 'library'
$env:TRAINING_DIR = Join-Path $config.scratch 'library/training'
$env:ACESTEPCPP_ADAPTERS = Join-Path $config.scratch 'adapters'
Set-Location (Join-Path $root 'server')
$node = (Get-Command node).Source
$preload = ([Uri](Join-Path $root 'tools/prod/runtime.mjs')).AbsoluteUri
$child = Start-Process -FilePath $node -ArgumentList @('--import', $preload, '--import','tsx',('"' + (Join-Path $root 'server/src/index.ts') + '"')) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root '.prod/server.stdout.log') -RedirectStandardError (Join-Path $root '.prod/server.stderr.log')
@{ pid = $child.Id; started = $child.StartTime.ToUniversalTime().ToString('o'); commit = $config.commit } |
    ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $root '.prod/process.json')
$child.WaitForExit()
exit $child.ExitCode
