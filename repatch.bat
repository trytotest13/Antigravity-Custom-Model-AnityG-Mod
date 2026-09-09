@echo off
echo Applying Antigravity patch...
cd /d "%~dp0"
call npm run build
if exist "%LOCALAPPDATA%\Programs\Antigravity IDE\resources\app\out\main.js" goto :found_ide
if defined AGY_INSTALL_DIR if exist "%AGY_INSTALL_DIR%\resources\app\out\main.js" goto :found_ide

powershell -ExecutionPolicy Bypass -File ".\deploy.ps1"
goto :done

:found_ide
powershell -ExecutionPolicy Bypass -File ".\deploy-ide.ps1"

:done
echo.
echo Patch applied successfully! Antigravity has been restarted.
pause
