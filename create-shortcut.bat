@echo off
chcp 65001 >nul
title Create C Drive Cleaner Shortcut
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1"

if errorlevel 1 (
  echo.
  echo Failed to create the shortcut. Make sure the Desktop folder is writable.
) else (
  echo.
  echo A shortcut has been placed on your Desktop.
)
echo.
if /i not "%~1"=="--no-pause" pause
