@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js n'est pas installe : https://nodejs.org ^(version LTS^), puis relance ce fichier.
  pause
  exit /b 1
)
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo  Un fichier .env vient d'etre cree : colle ta cle apres GEMINI_API_KEY=, enregistre, ferme, puis relance.
  notepad ".env"
  pause
  exit /b 0
)
node scripts\phone-setup.js
echo  Sur le telephone ^(meme Wi-Fi^), ouvre l'adresse "Telephone" affichee ci-dessous.
echo  Si Windows demande d'autoriser le reseau, accepte ^(reseau prive^).
echo  Laisse cette fenetre ouverte.
echo.
node server\server.js
pause
