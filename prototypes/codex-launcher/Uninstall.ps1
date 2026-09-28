param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$installRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\GatherThread Launcher'))
$programsRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
if (-not $installRoot.StartsWith($programsRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unsafe Launcher installation path.'
}
if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) {
    Write-Host 'GatherThread Launcher is not installed.'
    exit 0
}
foreach ($marker in @('launcher.py', 'runtime\node.exe', 'connector\codex-connect.js', '.agents\plugins\marketplace.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot $marker) -PathType Leaf)) {
        throw "The installation does not match GatherThread Launcher: $marker is missing."
    }
}

$live = Get-Process -Name pythonw,python,node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($installRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) }
if ($live) {
    throw 'Stop the Launcher and its connector before uninstalling, then retry.'
}

if ($DryRun) {
    Write-Host "Would remove any Launcher-owned plugin and marketplace, URL Scheme, and $installRoot"
    Write-Host 'Project workspaces, Codex tasks, and GatherThread connector state would be retained.'
    exit 0
}

$codex = Get-Command codex.exe -ErrorAction SilentlyContinue
$codexPath = if ($codex) { $codex.Source } else { $null }
if (-not $codexPath) {
    $desktopBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $desktopBin -PathType Container) {
        $codexPath = Get-ChildItem -LiteralPath $desktopBin -Filter codex.exe -Recurse -File |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
}
if (-not $codexPath) {
    $codex = Get-Command codex -ErrorAction SilentlyContinue
    $codexPath = if ($codex) { $codex.Source } else { $null }
}
if ($codexPath) {
    $oldPath = $env:PATH
    $env:PATH = (Join-Path $installRoot 'runtime') + [System.IO.Path]::PathSeparator + $oldPath
    try {
        $marketplacesJson = & $codexPath plugin marketplace list --json 2>&1
        if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Codex marketplaces. The installation was retained.' }
        $marketplaces = ($marketplacesJson | Out-String | ConvertFrom-Json).marketplaces
        if ($marketplaces | Where-Object { $_.name -eq 'gatherthread-launcher' }) {
            & $codexPath plugin remove gatherthread@gatherthread-launcher 2>&1 | Out-Host
            if ($LASTEXITCODE -ne 0) { Write-Warning 'The Launcher plugin was not installed or could not be removed.' }
            & $codexPath plugin marketplace remove gatherthread-launcher 2>&1 | Out-Host
            if ($LASTEXITCODE -ne 0) { throw 'Could not remove the Launcher marketplace from Codex. The installation was retained.' }
        }
    } finally {
        $env:PATH = $oldPath
    }
} else {
    Write-Warning 'Codex CLI is unavailable. Confirm that the optional gatherthread-launcher marketplace was not installed before removing the Launcher.'
}

$schemeRoot = 'HKCU:\Software\Classes\gatherthread-connect'
$schemeCommand = Join-Path $schemeRoot 'shell\open\command'
if (Test-Path -LiteralPath $schemeCommand) {
    $registered = (Get-Item -LiteralPath $schemeCommand).GetValue('')
    if ($registered -and $registered.IndexOf($installRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Remove-Item -LiteralPath $schemeRoot -Recurse -Force
    }
}
Remove-Item -LiteralPath $installRoot -Recurse -Force
Write-Host 'GatherThread Launcher uninstalled. Local projects, Codex tasks, and connector state were retained.'
