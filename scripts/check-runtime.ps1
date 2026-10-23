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
Invoke-Checked node @('tools/ci/versions.mjs')
if ($Full) {
    throw 'The full frozen-oracle/lifecycle suite runs on Linux/WSL via scripts/check-runtime.sh --full. Windows native artifacts use node tools/native/build.mjs, pack.mjs and probe.mjs windows-x64; see docs/dev/NATIVE-PLATFORMS.md. This metadata audit is not full validation.'
}
