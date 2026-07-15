@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title Xiuxingju V3.4.4 Cloud Demo

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo Install Node.js 18 or newer, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\ws\package.json" (
  where npm.cmd >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Runtime dependency ws is missing and npm was not found.
    pause
    exit /b 1
  )
  echo [INFO] Installing dependencies for the first launch...
  call npm.cmd ci
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo [INFO] Created .env from .env.example.
  echo [INFO] Edit .env to configure AI_BASE_URL, AI_API_KEY and AI_MODEL.
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if not "%%A"=="" set "%%A=%%B"
)

if not defined HOST set "HOST=0.0.0.0"
if not defined PORT set "PORT=8787"
echo %PORT%| findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 set "PORT=8787"

echo.
echo [INFO] Xiuxingju is starting at http://127.0.0.1:%PORT%/
echo [INFO] Keep this window open. Press Ctrl+C to stop the server.
if /i "%AI_ENABLED%"=="true" if "%AI_API_KEY%"=="" echo [WARN] AI is enabled but AI_API_KEY is empty.
echo.

start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%/'"
node.exe server\index.js
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo [INFO] Server stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
