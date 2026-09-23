# Backs the live database up on a schedule, without asking.
#
# Railway keeps automatic backups on the Pro plan only, so on Hobby there is
# nothing standing between a bad UPDATE and 8,600 lost orders. This is the
# stand-in. Registered as a Windows scheduled task by backup-schedule.cmd.
#
#   powershell -ExecutionPolicy Bypass -File scripts\backup-auto.ps1
#
# It used to ask first - a Yes/No box, on the reasoning that nobody wants a
# dump starting by itself in the middle of a busy morning. That reasoning was
# wrong twice over. The dump only reads, with --single-transaction, so it
# costs the office nothing to have it run; and the question was the single
# point of failure. On 23 September the box appeared saying the last backup
# was six days old, was answered with the button that means "no", and exited
# silently - which is also what it does if you close it with the X, or press
# Escape, or never see it because the laptop was on battery. Six days of
# orders had no backup and nothing anywhere said so.
#
# So now it just runs. What is left of the old design is the part that was
# worth keeping: a failure is put in front of somebody, loudly, rather than
# disappearing into an exit code nobody reads.

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent $PSScriptRoot
$backupDir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'arabella-backups'
$logFile   = Join-Path $backupDir '_backup-log.txt'

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

# Every run leaves a line, including the ones that did nothing. The whole
# problem with the old script was that a run which took no backup looked
# exactly like a run that never happened.
function Write-Log($text) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  try { Add-Content -Path $logFile -Value $line -Encoding utf8 } catch { }
}

# Unobtrusive, and best effort: it auto-dismisses, and if the shell will not
# show it that must not fail the backup that already succeeded.
function Show-Balloon($title, $text) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::Information
    $n.Visible = $true
    $n.ShowBalloonTip(8000, $title, $text, [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Seconds 8
    $n.Dispose()
  } catch { }
}

# A failure waits for somebody. This is the one thing the old script got
# right, and the reason this whole file exists.
function Show-Failure($text) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      $text,
      'Arabella Papers - the backup FAILED',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
  } catch { }
}

# Somebody who has just taken one by hand does not need a second one an hour
# later. backup-live.cmd is still there for a deliberate extra.
$already = Get-ChildItem -Path $backupDir -Filter '*.sql' -ErrorAction SilentlyContinue |
           Where-Object { $_.LastWriteTime.Date -eq (Get-Date).Date } |
           Select-Object -First 1
if ($already) {
  Write-Log ("skipped - already backed up today ({0})" -f $already.Name)
  exit 0
}

# How long it has actually been, so the log and the message say something
# true even when runs have been missed.
$last = Get-ChildItem -Path $backupDir -Filter '*.sql' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($last) {
  $gap = [int]((Get-Date).Date - $last.LastWriteTime.Date).TotalDays
  Write-Log ("starting - last backup was {0} day(s) ago" -f $gap)
} else {
  $gap = -1
  Write-Log 'starting - there is no backup on this machine yet'
}

# Output goes to files rather than down the pipeline: in Windows PowerShell,
# redirecting a native program's stderr inline wraps every line in an error
# record and makes a successful run look like a failed one.
$outFile = [System.IO.Path]::GetTempFileName()
$errFile = [System.IO.Path]::GetTempFileName()
$code    = 1

try {
  $p = Start-Process -FilePath 'node' `
        -ArgumentList '"scripts/backup-live.js"' `
        -WorkingDirectory $root -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  $code = $p.ExitCode
} catch {
  Write-Log ("could not start node - {0}" -f $_.Exception.Message)
  Show-Failure ("The backup could not start.`n`n{0}`n`nIs Node.js installed and on PATH?" -f $_.Exception.Message)
  Remove-Item $outFile, $errFile -ErrorAction SilentlyContinue
  exit 1
}

$stdout = ''
$stderr = ''
if (Test-Path $outFile) { $stdout = (Get-Content $outFile -Raw -ErrorAction SilentlyContinue) }
if (Test-Path $errFile) { $stderr = (Get-Content $errFile -Raw -ErrorAction SilentlyContinue) }
Remove-Item $outFile, $errFile -ErrorAction SilentlyContinue

$fresh = Get-ChildItem -Path $backupDir -Filter '*.sql' -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1

# Both conditions, not just the exit code. A dump that is cut off partway
# still leaves a file behind, and a file is what somebody would restore from.
$looksRight = ($code -eq 0) -and ($fresh) -and ($fresh.LastWriteTime.Date -eq (Get-Date).Date) -and ($fresh.Length -gt 1MB)

if ($looksRight) {
  $size = '{0:N1} MB' -f ($fresh.Length / 1MB)
  Write-Log ("done - {0}, {1}" -f $fresh.Name, $size)

  # Only here, and only now. Thinning the folder on a morning the backup
  # failed is how you end up with nothing at all - so the one call site is
  # inside the branch that has just written a good one. And it is wrapped,
  # because a backup that succeeded must not be reported as a failure over
  # some housekeeping that did not.
  try {
    $pruned = @(& (Join-Path $PSScriptRoot 'backup-prune.ps1') -Path $backupDir)
    if ($pruned.Count) {
      Write-Log ("pruned {0} old backup(s) - {1}" -f $pruned.Count, ($pruned -join ', '))
    }
  } catch {
    Write-Log ("could not thin out old backups - {0}" -f $_.Exception.Message)
  }

  Show-Balloon 'Arabella Papers' ("Live database backed up - {0}, saved to Desktop\arabella-backups." -f $size)
  exit 0
}

$why = $stderr
if (-not $why) { $why = $stdout }
if (-not $why) { $why = "mysqldump exited with code $code" }
$why = $why.Trim()
if ($why.Length -gt 900) { $why = $why.Substring(0, 900) + ' ...' }

Write-Log ("FAILED - exit {0} - {1}" -f $code, ($why -replace '\r?\n', ' | '))
$sinceText = 'There is still no backup on this machine.'
if ($gap -ge 0) { $sinceText = "The newest backup is still the one from $gap day(s) ago." }
Show-Failure ("The live database was NOT backed up.`n`n$why`n`n$sinceText`n`nRun scripts\backup-live.cmd by hand, or tell whoever looks after the system.")
exit 1
