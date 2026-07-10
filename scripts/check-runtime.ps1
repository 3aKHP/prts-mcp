[CmdletBinding()]
param(
    [switch]$Full
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PythonDir = Join-Path $RepoRoot "python"
$TsDir = Join-Path $RepoRoot "ts"
$Failures = 0

function Assert-NativeExit {
    param(
        [Parameter(Mandatory = $true)][string]$CommandName
    )

    if ($LASTEXITCODE -ne 0) {
        throw "$CommandName exited with code $LASTEXITCODE."
    }
}

function Invoke-Required {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Script
    )

    Write-Host ""
    Write-Host "== $Name =="
    try {
        & $Script
        Write-Host "[OK] $Name"
    } catch {
        $script:Failures += 1
        Write-Host "[FAIL] $Name"
        Write-Host $_.Exception.Message
    }
}

Write-Host "Repo root: $RepoRoot"

Invoke-Required "PowerShell 7+" {
    $version = $PSVersionTable.PSVersion
    Write-Host "PowerShell $version"
    if ($version.Major -lt 7) {
        throw "PowerShell 7 or newer is required."
    }
}

Invoke-Required "uv runtime" {
    $uv = Get-Command uv -ErrorAction Stop
    Write-Host "uv=$($uv.Source)"
    & uv --version
    Assert-NativeExit "uv --version"
}

Invoke-Required "Python lock and environment" {
    if (-not (Test-Path -LiteralPath (Join-Path $PythonDir "uv.lock"))) {
        throw "Missing python/uv.lock."
    }

    Push-Location $PythonDir
    try {
        & uv lock --check
        Assert-NativeExit "uv lock --check"

        & uv sync --check
        Assert-NativeExit "uv sync --check"

        $probe = @'
import importlib.metadata as md
import sys

import mcp
import pydantic
import pytest
from prts_mcp.server import main

print(sys.executable)
print(sys.version.split()[0])
print("mcp=" + md.version("mcp"))
print("pydantic=" + md.version("pydantic"))
print("pytest=" + md.version("pytest"))
print("prts_mcp.server import ok")
'@
        & uv run --frozen --no-sync python -c $probe
        Assert-NativeExit "uv run python probe"
    } finally {
        Pop-Location
    }
}

Invoke-Required "Node runtime" {
    $nodeVersion = & node -v
    Assert-NativeExit "node -v"
    Write-Host "node=$nodeVersion"
    if ($nodeVersion -notmatch '^v(\d+)\.') {
        throw "Could not parse Node version: $nodeVersion"
    }
    if ([int]$Matches[1] -lt 22) {
        throw "Node >=22 is required by ts/package.json."
    }
}

$NpmCommand = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
    "npm.cmd"
} else {
    "npm"
}

Invoke-Required "npm runtime" {
    $npm = Get-Command $NpmCommand -ErrorAction Stop
    Write-Host "npm=$($npm.Source)"
    & $NpmCommand --version
    Assert-NativeExit "$NpmCommand --version"
}

Invoke-Required "Bun runtime" {
    $bun = Get-Command bun -ErrorAction Stop
    $bunVersion = & $bun.Source --version
    Assert-NativeExit "bun --version"
    Write-Host "bun=$bunVersion"
    if ($bunVersion -match '^[0-9]+\.[0-9]+\.[0-9]+-') {
        throw "Bun prerelease versions are not supported: $bunVersion. Use Bun >=1.3.14 stable."
    }

    $parsedBunVersion = $null
    if (
        $bunVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or
        -not [version]::TryParse($bunVersion, [ref]$parsedBunVersion)
    ) {
        throw "Unsupported or malformed Bun version: $bunVersion. Expected stable MAJOR.MINOR.PATCH."
    }

    if ($parsedBunVersion -lt [version]"1.3.14") {
        throw "Bun >=1.3.14 is required."
    }
}

Invoke-Required "TypeScript dependencies" {
    $tsc = Join-Path $TsDir "node_modules/typescript/bin/tsc"
    $tsx = Join-Path $TsDir "node_modules/tsx/dist/cli.mjs"
    if (-not (Test-Path -LiteralPath $tsc)) {
        throw "Missing TypeScript dependencies. Run npm ci in ts/."
    }
    if (-not (Test-Path -LiteralPath $tsx)) {
        throw "Missing tsx dependency. Run npm ci in ts/."
    }

    Push-Location $TsDir
    try {
        & $NpmCommand ls --depth=0
        Assert-NativeExit "$NpmCommand ls --depth=0"
    } finally {
        Pop-Location
    }
}

if ($Full) {
    Invoke-Required "Python tests" {
        Push-Location $PythonDir
        try {
            & uv run --frozen --no-sync python -m pytest tests -q
            Assert-NativeExit "Python tests"
        } finally {
            Pop-Location
        }
    }

    Invoke-Required "TypeScript build" {
        Push-Location $TsDir
        try {
            & $NpmCommand run build
            Assert-NativeExit "TypeScript build"
        } finally {
            Pop-Location
        }
    }

    Invoke-Required "TypeScript tests" {
        Push-Location $TsDir
        try {
            & $NpmCommand test
            Assert-NativeExit "TypeScript tests"
        } finally {
            Pop-Location
        }
    }

    Invoke-Required "TypeScript typecheck" {
        Push-Location $TsDir
        try {
            & $NpmCommand run typecheck
            Assert-NativeExit "TypeScript typecheck"
        } finally {
            Pop-Location
        }
    }

    Invoke-Required "Bun HTTP smoke" {
        Push-Location $TsDir
        try {
            & $NpmCommand run smoke:bun
            Assert-NativeExit "Bun HTTP smoke"
        } finally {
            Pop-Location
        }
    }
}

Write-Host ""
Write-Host "Runtime check complete: $Failures failure(s)."
if ($Failures -gt 0) {
    exit 1
}
