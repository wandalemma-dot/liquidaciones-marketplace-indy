@echo off
title Liquidaciones Shopify - Iniciando App
echo ==========================================================
echo       APLICACION DE LIQUIDACIONES PARA MARKETPLACE
echo ==========================================================
echo.

:: 1. Verificar si Node.js está instalado
node -v >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js no esta instalado o no se encuentra en el PATH.
    echo.
    echo Para ejecutar esta aplicacion necesitas tener instalado Node.js.
    echo.
    echo 1. Descarga e instala Node.js (Version Recomendada LTS) desde:
    echo    https://nodejs.org/
    echo 2. Una vez instalado, cierra todas las ventanas y vuelve a abrir este archivo.
    echo.
    echo ==========================================================
    pause
    exit /b
)

echo [1/3] Verificando e instalando dependencias (puede tardar unos segundos)...
call npm install --no-audit --no-fund

echo.
echo [2/3] Construyendo el panel visual...
call npm run build

echo.
echo [3/3] Iniciando el servidor local...
echo.
echo ==========================================================
echo >>> Abriendo aplicacion en tu navegador... <<<
echo >>> URL: http://localhost:3001 <<<
echo.
echo (Para cerrar la aplicacion, presiona Ctrl+C o cierra esta ventana)
echo ==========================================================
echo.

:: Abrir el navegador por defecto automáticamente
start http://localhost:3001

:: Iniciar el servidor
call npm run start
pause
