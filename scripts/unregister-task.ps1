# Removes the coachme logon task created by scripts\register-task.ps1 and stops it if running.
# Run:  powershell -ExecutionPolicy Bypass -File scripts\unregister-task.ps1
$ErrorActionPreference = 'Stop'
$TaskName = 'coachme'
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $Task) { Write-Host "No scheduled task named '$TaskName'."; exit 0 }
if ($Task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed scheduled task '$TaskName'. A server already started by it keeps running until you close it."
