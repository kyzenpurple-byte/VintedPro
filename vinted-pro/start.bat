@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js n'est pas installe sur cet ordinateur.
  echo  1. Va sur https://nodejs.org et telecharge la version "LTS"
  echo  2. Installe-la ^(Suivant, Suivant...^)
  echo  3. Relance ce fichier start.bat
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo  Un fichier .env vient d'etre cree.
  echo  Le Bloc-notes va s'ouvrir : colle ta cle apres GEMINI_API_KEY=
  echo  Enregistre ^(Ctrl+S^), ferme le Bloc-notes, puis relance start.bat.
  echo.
  notepad ".env"
  pause
  exit /b 0
)

echo  Demarrage de VintedPro... Laisse cette fenetre ouverte.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server\server.js
echo.
echo  Le serveur s'est arrete.
pause
