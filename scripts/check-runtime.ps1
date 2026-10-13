param([switch]$Full)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed ($LASTEXITCODE)" }
}
Invoke-Checked cargo @('--version')
Invoke-Checked rustc @('--version')
Invoke-Checked cargo @('metadata', '--locked', '--no-deps', '--format-version', '1')
if ($Full) {
    throw 'M1B full validation is verified on Linux/WSL. Windows build and runtime validation is an M2 deliverable; use WSL scripts/check-runtime.sh --full for this phase.'
}
