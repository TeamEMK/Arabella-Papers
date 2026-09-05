@echo off
REM Registers the three-day backup reminder with Windows Task Scheduler.
REM Run it once. It needs no administrator rights - the task belongs to
REM whoever runs this, and only runs while they are logged in.
REM
REM   scripts\backup-schedule.cmd          register (or re-register) it
REM   scripts\backup-schedule.cmd remove   take it off the schedule
REM
REM Change the time by editing /st below, then run it again.

setlocal
set TASK=Arabella Backup Reminder

if /i "%~1"=="remove" (
  schtasks /delete /tn "%TASK%" /f
  echo.
  echo Removed. No more reminders.
  pause
  exit /b
)

schtasks /create /tn "%TASK%" /f ^
  /tr "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%~dp0backup-reminder.ps1\"" ^
  /sc daily /mo 3 /st 10:00

echo.
echo The reminder will appear every 3 days at 10:00 AM.
echo Say yes and it backs the live database up to Desktop\arabella-backups.
echo.
echo   To stop it:  scripts\backup-schedule.cmd remove
echo.
pause
