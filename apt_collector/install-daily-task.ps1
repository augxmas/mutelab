[CmdletBinding()]
param(
    [string]$TaskName = "MuteLab-Apartment-Daily-Migration",
    [ValidatePattern("^(?:[01]\d|2[0-3]):[0-5]\d$")]
    [string]$At = "03:10",
    [switch]$RunNow
)

$ErrorActionPreference = "Stop"
$collectorRoot = $PSScriptRoot
$runnerPath = Join-Path $collectorRoot "run-daily.ps1"
$compiledPath = Join-Path $collectorRoot "dist\daily-collector.js"
$preflightPath = Join-Path $collectorRoot "dist\preflight.js"
$envPath = Join-Path (Split-Path -Parent $collectorRoot) "server\.env"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$pwshPath = (Get-Process -Id $PID).Path

if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    throw "Runner not found: $runnerPath"
}
if (-not (Test-Path -LiteralPath $compiledPath -PathType Leaf)) {
    throw "Compiled collector not found. Run npm run build in $collectorRoot first."
}
if (-not (Test-Path -LiteralPath $preflightPath -PathType Leaf)) {
    throw "Compiled preflight not found. Run npm run build in $collectorRoot first."
}
if ([TimeZoneInfo]::Local.Id -ne "Korea Standard Time") {
    throw "The host time zone must be 'Korea Standard Time' before registering the 03:10 KST task."
}

& $nodePath "--env-file=$envPath" $preflightPath
if ($LASTEXITCODE -ne 0) {
    throw "Apartment migration preflight failed. Configure the service key and apply daily-schema.sql before registering the task."
}

$time = [TimeSpan]::ParseExact($At, "hh\:mm", [Globalization.CultureInfo]::InvariantCulture)
$triggerAt = (Get-Date).Date.Add($time)
$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runnerPath`" -NodePath `"$nodePath`""
$action = New-ScheduledTaskAction -Execute $pwshPath -Argument $arguments -WorkingDirectory $collectorRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $triggerAt
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 15) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 8) `
    -StartWhenAvailable
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Limited
$task = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Quota-safe daily migration of public apartment complex data into MuteLab SQL Server"

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Write-Output "Registered task '$TaskName' for daily execution at $At KST."

if ($RunNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Started task '$TaskName'."
}
