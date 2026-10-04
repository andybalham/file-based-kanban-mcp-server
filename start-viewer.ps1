<#
.SYNOPSIS
    Starts the read-only File-Based Kanban viewer (HTTP/WebSocket API plus built React UI).

.DESCRIPTION
    Thin convenience wrapper around the root `npm run viewer` / `npm run viewer:built` scripts.
    The viewer itself is configured purely through environment variables (see
    packages/server/src/config.ts), so this script maps friendly parameters onto those variables,
    launches the viewer from the repository root, and restores the caller's environment on exit.

.PARAMETER Port
    HTTP/WebSocket listen port. Mapped to FILE_KANBAN_PORT. Defaults to 4010.

.PARAMETER Root
    One or more directories scanned and watched for `.worktracker/project.json` markers. Mapped to
    FILE_KANBAN_WATCH_ROOTS. Defaults to C:\Users\MONTEITH\source\repos.

.PARAMETER SkipBuild
    Skips the TypeScript/Vite build and serves the existing `dist` output (`npm run viewer:built`).
    Use this for faster restarts when nothing has changed since the last build.

.EXAMPLE
    .\start-viewer.ps1

.EXAMPLE
    .\start-viewer.ps1 -Port 4020 -Root C:\src, D:\work -SkipBuild
#>
[CmdletBinding()]
param(
    # The runtime config loader only accepts integers from 1 to 65535, so reject bad values here
    # with a clear parameter error instead of letting the server fail after a full build.
    [ValidateRange(1, 65535)]
    [int]$Port = 4010,

    # Accepts several roots so callers do not need to know the platform delimiter the server expects.
    [ValidateNotNullOrEmpty()]
    [string[]]$Root = @('C:\Users\MONTEITH\source\repos'),

    [switch]$SkipBuild
)

# Treat cmdlet failures as terminating so a bad root or missing repo stops the script early.
$ErrorActionPreference = 'Stop'

# Fail fast on roots that do not exist; the server would otherwise start and discover nothing,
# which looks like an empty viewer rather than a typo in the path.
foreach ($path in $Root) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        throw "Watch root does not exist or is not a directory: $path"
    }
}

# Remember the caller's values so running this script does not permanently change the session's
# environment (which could silently reconfigure an MCP stdio server started from the same shell).
$previousPort = $env:FILE_KANBAN_PORT
$previousRoots = $env:FILE_KANBAN_WATCH_ROOTS

# npm workspace scripts must run from the repository root, which is where this script lives.
# Push-Location lets the script be invoked from any working directory and return there afterwards.
Push-Location -LiteralPath $PSScriptRoot
try {
    $env:FILE_KANBAN_PORT = [string]$Port

    # FILE_KANBAN_WATCH_ROOTS is platform-delimited; PathSeparator is `;` on Windows and `:` on POSIX.
    $env:FILE_KANBAN_WATCH_ROOTS = $Root -join [System.IO.Path]::PathSeparator

    # `viewer` rebuilds core, server, and UI first; `viewer:built` serves whatever is already in dist.
    $npmScript = if ($SkipBuild) { 'viewer:built' } else { 'viewer' }

    Write-Host "Starting File-Based Kanban viewer on http://localhost:$Port"
    Write-Host "Watch roots: $($env:FILE_KANBAN_WATCH_ROOTS)"

    # Runs in the foreground until the viewer is stopped with Ctrl+C.
    npm run $npmScript

    # Native commands do not throw on failure, so surface npm's exit code to the caller explicitly.
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    # Restore the working directory and environment even when the viewer is interrupted or fails.
    Pop-Location
    $env:FILE_KANBAN_PORT = $previousPort
    $env:FILE_KANBAN_WATCH_ROOTS = $previousRoots
}
