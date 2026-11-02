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
'CLI_SHELL_PASS'
