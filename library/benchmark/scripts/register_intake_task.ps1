# register_intake_task.ps1  (ASCII only) -- registers a weekly Windows scheduled task that runs klaw_intake_task.ps1.
# Run once in PowerShell (no admin needed for a per-user task).
param(
    [string]$Repo = "$env:USERPROFILE\Downloads\klaw",
    [string]$Day  = "Monday",
    [string]$Time = "09:00",
    [switch]$NoRunDeepseek
)
$script = "$Repo\library\benchmark\scripts\klaw_intake_task.ps1"
if (-not (Test-Path $script)) { throw "not found: $script" }
$arg = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Repo `"$Repo`"" + $(if ($NoRunDeepseek) { " -NoRunDeepseek" } else { "" })
$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $Time
$set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 6)
Register-ScheduledTask -TaskName "KLaw-Intake" -Action $action -Trigger $trigger -Settings $set -Description "K-Law: poll new Supreme Court civil judgments, build a round every 10 new cases" -Force | Out-Null
Get-ScheduledTask -TaskName "KLaw-Intake" | Select TaskName, State
