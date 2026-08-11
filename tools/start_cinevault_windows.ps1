param(
    [int]$Port = 8080,
    [string]$DataDir = "",
    [switch]$NoTranscode
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$serverScript = Join-Path $projectRoot "tools\media_library_server.py"

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Join-Path $projectRoot "data\media-library"
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$python = Get-Command py -ErrorAction SilentlyContinue
$pythonArgs = @("-3.12")
if ($null -eq $python) {
    $python = Get-Command python -ErrorAction SilentlyContinue
    $pythonArgs = @()
}
if ($null -eq $python) {
    throw "Python 3 не найден. Установите Python и повторите запуск."
}

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $NoTranscode -and $null -eq $ffmpeg) {
    throw "FFmpeg не найден в PATH. Установите FFmpeg или запустите с параметром -NoTranscode."
}

$arguments = @()
$arguments += $pythonArgs
$arguments += @(
    $serverScript,
    "--host", "0.0.0.0",
    "--port", "$Port",
    "--data-dir", $DataDir
)
if ($NoTranscode) {
    $arguments += "--no-transcode"
}

Write-Host "CineVault Windows server" -ForegroundColor Cyan
Write-Host "Каталог данных: $DataDir"
Write-Host "Порт: $Port"
Write-Host "Оставьте это окно открытым, пока сервер нужен."
Write-Host ""
Write-Host "Адреса для телефона:" -ForegroundColor Yellow
try {
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp -ErrorAction Stop |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
        Select-Object -ExpandProperty IPAddress)
    if ($addresses.Count -gt 0) {
        $addresses | ForEach-Object { Write-Host "  http://$($_):$Port" }
    } else {
        Write-Host "  Выполните ipconfig и возьмите IPv4-адрес активного Wi-Fi/Ethernet." 
    }
} catch {
    Write-Host "  Выполните ipconfig и возьмите IPv4-адрес активного Wi-Fi/Ethernet."
}
Write-Host ""

& $python.Source @arguments
exit $LASTEXITCODE
