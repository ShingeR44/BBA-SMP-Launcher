@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron не установлен. Выполните в этой папке: npm install
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
