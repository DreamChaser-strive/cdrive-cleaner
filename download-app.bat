@echo off
setlocal
cd /d "%~dp0"

echo Downloading the latest DriveCleaner portable app from GitHub Releases...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0download-app.ps1"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo Done.
) else (
  echo Download failed. Check your network and try again.
)

pause
exit /b %RC%
