@echo off
REM Puts the daily database backup on the Windows schedule. Run it once.
REM
REM   scripts\backup-schedule.cmd          register (or re-register) it
REM   scripts\backup-schedule.cmd remove   take it off the schedule
REM
REM The work is in backup-schedule.ps1 next door - the settings that stop a
REM laptop skipping the run cannot be set from schtasks, only from PowerShell.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup-schedule.ps1" %1
pause
