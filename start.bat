@echo off
REM One-click launcher for codex-responses-adapter (Windows).
REM Double-click this file in Explorer or run from cmd / PowerShell.
REM
REM This script delegates to scripts\start.mjs which does the real
REM work (Node version check, npm install if needed, build if needed,
REM config bootstrap, port cleanup, then `start --config <yaml>`).

setlocal

REM Switch to the directory this .bat lives in so relative paths work
REM regardless of how it was launched.
cd /d "%~dp0"

REM Make sure node is on PATH.
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
  echo.
  echo [ERROR] Node.js not found on PATH.
  echo.
  echo Install Node.js 20 or newer from https://nodejs.org/ then re-run this script.
  echo.
  pause
  exit /b 1
)

REM Run the cross-platform launcher. Pass any arguments through.
node "%~dp0scripts\start.mjs" %*

REM Keep the window open after the adapter exits so the user can read
REM any final messages. Skip when running from a parent script that
REM already provides its own keep-alive.
if "%CRA_NO_PAUSE%"=="" (
  echo.
  pause
)

endlocal
