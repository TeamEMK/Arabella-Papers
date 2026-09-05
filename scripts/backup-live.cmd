@echo off
cd /d "%~dp0.."
node "scripts/backup-live.js"
pause
