@echo off
rem AnityG Mod - double-click launcher for the model dashboard.
rem Starts the proxy if it is not running, then opens the dashboard
rem in your default browser. Same as the "AnityG Dashboard" desktop shortcut.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-dashboard.ps1"
