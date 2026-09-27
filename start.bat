@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js est introuvable. Installe Node.js 18 ou plus recent puis reessaie.
  pause
  exit /b 1
)

echo Demarrage des deux bots SICARIO SH...
npm start
if errorlevel 1 echo Le lanceur s'est arrete avec une erreur.
pause
