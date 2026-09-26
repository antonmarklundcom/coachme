# Registers a Windows scheduled task that starts coachme (npm start) when Anton logs on.
# Run once from the repo:  powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
# Undo with scripts\unregister-task.ps1. Runs as the current user, no admin rights needed.
$ErrorActionPreference = 'Stop'
$TaskName = 'coachme'
$Repo = Split-Path -Parent $PSScriptRoot
$Npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $Npm) { throw 'npm.cmd was not found on PATH. Install Node 22+ first.' }
$LogDir = Join-Path $Repo 'data'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'coachme.log'

# cmd /c keeps the working directory and appends output to data\coachme.log (git-ignored with data/).
$Action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$Npm`" start >> `"$Log`" 2>&1`"" -WorkingDirectory $Repo
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
  -Description 'coachme control tower on http://127.0.0.1:4000 (npm start at logon)' -Force | Out-Null
Write-Host "Registered scheduled task '$TaskName': npm start in $Repo at logon. Log: $Log"
Write-Host "Start it now without logging off:  Start-ScheduledTask -TaskName $TaskName"
