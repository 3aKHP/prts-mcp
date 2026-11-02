param([string]$Program, [string]$ConfigPath, [string]$ExpectedVersion)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$actual = & $Program --version
if ($LASTEXITCODE -ne 0 -or $actual.Trim() -ne "prtsctl $ExpectedVersion") { throw 'Version mismatch' }
& $Program --config $ConfigPath config init | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Init failed' }
$literal = 'literal $value with spaces' + [char]0x4e2d + [char]0x6587
& $Program --config $ConfigPath config set HOST $literal | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'String argument failed' }
& $Program --config $ConfigPath config set PORT 3210 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Integer argument failed' }
$raw = & $Program --config $ConfigPath config show -o json
if ($LASTEXITCODE -ne 0) { throw 'Show failed' }
$config = $raw | ConvertFrom-Json
$hosts = @($config.fields | Where-Object { $_.key -eq 'HOST' })
$ports = @($config.fields | Where-Object { $_.key -eq 'PORT' })
if ($hosts.Count -ne 1 -or $hosts[0].value -ne $literal) { throw 'String pipeline mismatch' }
if ($ports.Count -ne 1 -or $ports[0].value -ne 3210) { throw 'Numeric pipeline mismatch' }
# Windows names are case-preserving but case-insensitive, including inherited
# names created by PowerShell rather than a Rust Command environment builder.
foreach ($key in @('PORT', 'PRTS_DATA_BACKEND', 'PRTS_TRANSPORT', 'HTTPS_PROXY')) {
    [Environment]::SetEnvironmentVariable($key, $null)
}
[Environment]::SetEnvironmentVariable('pOrT', '4321')
[Environment]::SetEnvironmentVariable('prts_data_backend', 'json')
[Environment]::SetEnvironmentVariable('prts_transport', 'stdio')
[Environment]::SetEnvironmentVariable('https_proxy', 'http://127.0.0.1:9')
$raw = & $Program --config $ConfigPath config show -o json
if ($LASTEXITCODE -ne 0) { throw 'Mixed-case environment inspection failed' }
$config = $raw | ConvertFrom-Json
foreach ($pair in @(@('PORT', 4321), @('PRTS_DATA_BACKEND', 'json'), @('PRTS_TRANSPORT', 'stdio'))) {
    $field = @($config.fields | Where-Object { $_.key -eq $pair[0] })
    if ($field.Count -ne 1 -or $field[0].value -ne $pair[1] -or $field[0].source -ne 'environment') {
        throw 'Windows environment precedence mismatch'
    }
}
$proxy = @($config.network_environment | Where-Object { $_.key -ceq 'HTTPS_PROXY' })
if ($proxy.Count -ne 1 -or -not $proxy[0].configured -or $proxy[0].value -ne '[redacted]') { throw 'Windows proxy source mismatch' }
'CLI_SHELL_PASS'
