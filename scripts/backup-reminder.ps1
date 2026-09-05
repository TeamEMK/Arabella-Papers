# Every three days, asks whether to back the live database up, and does it if
# told to. Railway keeps automatic backups on the Pro plan only, so on Hobby
# there is nothing between a bad UPDATE and 8,600 lost orders.
#
# Registered as a Windows scheduled task by scripts/backup-schedule.cmd. It
# asks rather than running on its own: the dump reads the live database, and
# nobody wants that starting by itself in the middle of a busy morning.
#
#   powershell -ExecutionPolicy Bypass -File scripts\backup-reminder.ps1

Add-Type -AssemblyName System.Windows.Forms | Out-Null

$root      = Split-Path -Parent $PSScriptRoot
$backupDir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'arabella-backups'

# How long it has actually been, rather than how long the schedule says. The
# task can be missed - the machine is off, somebody is on leave - and "3 days"
# would then be a lie on the one screen meant to be trusted.
$last = $null
if (Test-Path $backupDir) {
  $last = Get-ChildItem -Path $backupDir -Filter '*.sql' -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

if ($last) {
  # Calendar days, not elapsed hours. A backup taken at 4pm yesterday is 20
  # hours old, which floors to zero and would read "today" the next morning.
  $days = [int]((Get-Date).Date - $last.LastWriteTime.Date).TotalDays
  $size = '{0:N1} MB' -f ($last.Length / 1MB)
  $when = if ($days -eq 0) { 'today' } elseif ($days -eq 1) { 'yesterday' } else { "$days days ago" }
  $line = "Last backup: $when  ($($last.LastWriteTime.ToString('dd MMM yyyy, h:mm tt')), $size)"
} else {
  $line = 'There is no backup on this machine yet.'
}

$answer = [System.Windows.Forms.MessageBox]::Show(
  "$line`n`nTake a backup of the live database now?`n`nIt is saved to Desktop\arabella-backups and takes about a minute. Nothing on the live system is changed - the dump only reads.",
  'Arabella Papers - backup due',
  [System.Windows.Forms.MessageBoxButtons]::YesNo,
  [System.Windows.Forms.MessageBoxIcon]::Question)

if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }

# Shown in a window that stays open, so a failure is read rather than flashing
# past - a backup that quietly did not happen is worse than none at all.
Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/k', "cd /d `"$root`" && node `"scripts/backup-live.js`"" `
  -WorkingDirectory $root
