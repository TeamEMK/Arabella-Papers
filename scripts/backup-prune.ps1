# Thins out the backup folder, so a daily dump does not fill the Desktop.
#
# A backup a day is about 7.7 MB, which is 2.8 GB a year. What is actually
# worth keeping is: everything from the last month, because that is the window
# in which somebody notices a mistake and wants yesterday's data - and one from
# each month before that, because after a month you no longer want a
# particular Tuesday, you want "roughly August".
#
#   scripts\backup-prune.ps1 -WhatIf     say what it would delete, delete nothing
#   scripts\backup-prune.ps1             do it
#
# backup-auto.ps1 calls this itself, but only ever after a backup that
# succeeded. Deleting old backups on a day the new one failed is how you end
# up with nothing at all.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Path = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'arabella-backups'),
  # Every backup inside this many days is kept, whatever else the rules say.
  [int]$KeepDays = 30,
  # And never thin below this many files in total. A folder that has somehow
  # ended up with a handful of backups is not one to be deleting from.
  [int]$FloorCount = 10
)

if (-not (Test-Path $Path)) { return @() }

$all = @(Get-ChildItem -Path $Path -Filter '*.sql' -File -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending)
if ($all.Count -le $FloorCount) { return @() }

$cutoff = (Get-Date).Date.AddDays(-$KeepDays)

# The keeper for each month is the oldest file in it, so the one that survives
# is a real month boundary rather than whichever happened to be last.
$monthly = @{}
foreach ($f in ($all | Sort-Object LastWriteTime)) {
  $key = $f.LastWriteTime.ToString('yyyy-MM')
  if (-not $monthly.ContainsKey($key)) { $monthly[$key] = $f.FullName }
}
$keepers = [System.Collections.Generic.HashSet[string]]::new()
foreach ($v in $monthly.Values) { [void]$keepers.Add($v) }

$removed = @()
foreach ($f in $all) {
  if ($f.LastWriteTime -ge $cutoff) { continue }        # inside the recent window
  if ($keepers.Contains($f.FullName)) { continue }      # this month's keeper
  if ($PSCmdlet.ShouldProcess($f.Name, 'Delete old backup')) {
    try {
      Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
      $removed += $f.Name
    } catch {
      Write-Warning ("Could not delete {0}: {1}" -f $f.Name, $_.Exception.Message)
    }
  } else {
    $removed += $f.Name
  }
}

return $removed
