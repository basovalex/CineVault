param(
    [Parameter(Mandatory = $true)]
    [string]$Folder,
    [Parameter(Mandatory = $true)]
    [string]$Title,
    [string]$DataDir = "",
    [switch]$DryRun,
    [switch]$NoTranscode
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$importScript = Join-Path $projectRoot "tools\import_media_folder.py"
if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Join-Path $projectRoot "data\media-library"
}

$python = Get-Command py -ErrorAction SilentlyContinue
$pythonArgs = @("-3.12")
if ($null -eq $python) {
    $python = Get-Command python -ErrorAction SilentlyContinue
    $pythonArgs = @()
}
if ($null -eq $python) {
    throw "Python 3 не найден."
}

$arguments = @()
$arguments += $pythonArgs
$arguments += @(
    $importScript,
    $Folder,
    "--title", $Title,
    "--data-dir", $DataDir
)
if ($DryRun) {
    $arguments += "--dry-run"
}
if ($NoTranscode) {
    $arguments += "--no-transcode"
}

& $python.Source @arguments
exit $LASTEXITCODE
