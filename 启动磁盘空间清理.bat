@echo off
chcp 65001 >nul
title Disk Space Cleaner
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found.
  echo Install Node.js 18 or newer from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)

echo Starting Disk Space Cleaner...
echo The browser will open automatically. Keep this window open while using it.
echo.

if not exist "data\scan.json" (
  echo No scan data found. Scanning the system drive now, this usually takes about a minute...
  echo.
  node scan.js
  if errorlevel 1 (
    echo.
    echo Scan failed. Check the messages above and try again.
    pause
    exit /b 1
  )
  echo.
  echo Scan complete. Starting the interface...
  echo.
)

node server.js

if errorlevel 1 (
  echo.
  echo The server exited. See the messages above for details.
  pause
)
