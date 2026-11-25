[CmdletBinding()]
param(
    [string]$NodePath = "",
    [ValidateRange(1, 3650)]
    [int]$LogRetentionDays = 30
)

$ErrorActionPreference = "Stop"
$collectorRoot = $PSScriptRoot
$projectRoot = Split-Path -Parent $collectorRoot
$envPath = Join-Path $projectRoot "server\.env"
$collectorPath = Join-Path $collectorRoot "dist\daily-collector.js"
$logRoot = Join-Path $collectorRoot "logs"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$cutoff = (Get-Date).AddDays(-$LogRetentionDays)
Get-ChildItem -LiteralPath $logRoot -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    Remove-Item -Force -ErrorAction SilentlyContinue
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stdoutPath = Join-Path $logRoot "$stamp.out.log"
$stderrPath = Join-Path $logRoot "$stamp.err.log"

try {
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        throw "Environment file not found: $envPath"
    }
    if (-not (Test-Path -LiteralPath $collectorPath -PathType Leaf)) {
        throw "Compiled collector not found. Run npm run build in $collectorRoot first."
    }
    if ([string]::IsNullOrWhiteSpace($NodePath)) {
        $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
    }
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        throw "Node executable not found: $NodePath"
    }

    $arguments = @(
        "--env-file=`"$envPath`""
        "`"$collectorPath`""
        "--daily"
    )
    $process = Start-Process `
        -FilePath $NodePath `
        -ArgumentList $arguments `
        -WorkingDirectory $collectorRoot `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden `
        -Wait `
        -PassThru

    if ($process.ExitCode -ne 0) {
        throw "Apartment migration failed with exit code $($process.ExitCode). See $stderrPath"
    }
    Write-Output "Apartment migration completed. Log: $stdoutPath"
}
catch {
    Add-Content -LiteralPath $stderrPath -Value ("{0:o} runner: {1}" -f (Get-Date), $_.Exception.Message)
    throw
}
