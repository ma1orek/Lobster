@echo off
title Lobster Browser
echo Starting Lobster Browser...

:: Kill any existing instances
taskkill /F /IM python.exe >nul 2>&1
taskkill /F /IM electron.exe >nul 2>&1
timeout /t 1 /nobreak >nul

:: Start backend in background
set PYTHONUNBUFFERED=1
start "Lobster Backend" /min cmd /c "cd /d %~dp0backend && C:\Users\idzik\AppData\Local\Programs\Python\Python312\python.exe main.py"

:: Wait for backend to be ready (health check loop)
echo Waiting for backend...
:wait_loop
timeout /t 1 /nobreak >nul
curl -s http://localhost:8080/ >nul 2>&1
if errorlevel 1 goto wait_loop
echo Backend ready!

:: Start Electron
cd /d %~dp0electron
npm start
