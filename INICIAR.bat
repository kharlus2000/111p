@echo off
setlocal
cd /d "%~dp0"
title xVideos Sniper - Addon Stremio

echo ================================================
echo   xVideos Sniper 17.0.0 - Inicializador
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERRO: Node.js nao foi encontrado.
  echo Instale Node.js 20.18.1 ou superior: https://nodejs.org/
  pause
  exit /b 1
)

node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<20 || (v[0]===20 && v[1]<18) || (v[0]===20 && v[1]===18 && v[2]<1)){console.error('Node.js 20.18.1 ou superior e necessario. Versao atual: '+process.version);process.exit(1)}"
if errorlevel 1 (
  echo.
  echo Atualize o Node.js e execute novamente.
  pause
  exit /b 1
)

if not exist "node_modules\stremio-addon-sdk" (
  echo Instalando dependencias. Aguarde...
  call npm ci
  if errorlevel 1 (
    echo.
    echo ERRO: nao foi possivel instalar as dependencias.
    pause
    exit /b 1
  )
)

echo.
echo Verificando sintaxe...
call npm run check
if errorlevel 1 (
  echo.
  echo ERRO: falha na verificacao do addon.js.
  pause
  exit /b 1
)

echo.
echo Iniciando servidor do addon...
echo Manifesto local: http://localhost:7014/manifest.json
echo Diagnostico:     http://localhost:7014/diagnostico
echo Para instalar no Stremio em outro aparelho, use o IP LAN deste PC no lugar de localhost.
echo.
call npm start

echo.
echo O servidor foi encerrado.
pause
