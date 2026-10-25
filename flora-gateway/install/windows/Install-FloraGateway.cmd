@echo off
rem Flora Gateway installer for Windows 10/11: double-click to start.
rem Asks for administrator rights, then runs Install-FloraGateway.ps1 (settings window, installs
rem WSL2 + Docker Desktop if missing, writes the site files, starts the gateway).
rem Extra options are passed on, e.g.  Install-FloraGateway.cmd -Answers site.env   or   -DryRun
net session >nul 2>&1
if errorlevel 1 (
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  )
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-FloraGateway.ps1" %*
echo.
pause
