# Puts the daily backup on the Windows schedule. Run it once.
#
#   scripts\backup-schedule.cmd          register (or re-register) it
#   scripts\backup-schedule.cmd remove   take it off the schedule
#
# Change the hour by editing $At below, then run it again.
#
# This used to be a plain `schtasks /create` line, and that is where two of
# the misses came from: schtasks has no switch for the settings that matter,
# so the task was created with Windows' defaults, which are
#
#   * do not start when the computer is on battery
#   * stop if it goes onto battery while running
#   * if the scheduled time is missed, skip it entirely
#
# On a laptop that is three different ways for a backup to quietly not happen,
# and between 17 and 23 September it did. Register-ScheduledTask can set them,
# so the fix lives here rather than in a note somebody has to remember.

param([string]$Action = 'register')

$ErrorActionPreference = 'Stop'

$TaskName = 'Arabella Backup Reminder'   # the name the existing task already has
$At       = '07:00'
$root     = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot 'backup-auto.ps1'

if ($Action -eq 'remove') {
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host ''
    Write-Host 'Removed. The database will no longer be backed up on its own.' -ForegroundColor Yellow
    Write-Host 'You can still take one whenever you like: scripts\backup-live.cmd'
  } catch {
    Write-Host ("Nothing to remove - no task called '{0}'." -f $TaskName)
  }
  Write-Host ''
  return
}

if (-not (Test-Path $scriptPath)) { throw "Cannot find $scriptPath" }

$taskAction = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $scriptPath) `
  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -Daily -At $At

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew
# Not switches on the cmdlet, so they are set on the object. Without these the
# task does not run on battery at all, which on a laptop is most mornings.
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries     = $false

Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger `
  -Settings $settings -Description 'Backs the Arabella Papers live database up to Desktop\arabella-backups.' `
  -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ''
Write-Host ('The live database will be backed up every day at {0}.' -f $At) -ForegroundColor Green
Write-Host  '  Saved to:  Desktop\arabella-backups'
Write-Host  '  Log:       Desktop\arabella-backups\_backup-log.txt'
Write-Host ('  Next run:  {0}' -f $info.NextRunTime)
Write-Host ''
Write-Host 'It runs on its own and says nothing unless it fails, in which case'
Write-Host 'a message waits on screen until somebody reads it. A backup already'
Write-Host 'taken that day is not taken twice.'
Write-Host ''
Write-Host '  To stop it:  scripts\backup-schedule.cmd remove'
Write-Host ''
