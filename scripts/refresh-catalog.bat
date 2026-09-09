@echo off
rem Scheduled-task wrapper for the Seeker Scout catalog refresh.
rem Task: SeekerScoutCatalogRefresh (daily). Log: %LOCALAPPDATA%\SeekerScout\catalog-refresh.log
if not exist "%LOCALAPPDATA%\SeekerScout" mkdir "%LOCALAPPDATA%\SeekerScout"
cd /d "C:\Users\b39cr\OneDrive\Documents\Claude\Projects\solana phone seeker\seeker-scout"
rem Triton config lives in HKCU\Environment (setx), never in this file; the
rem on-chain enrichment step needs it and fails loudly without it.
if "%TRITON_GRPC_ENDPOINT%"=="" for /f "tokens=2,*" %%a in ('reg query "HKCU\Environment" /v TRITON_GRPC_ENDPOINT 2^>nul ^| find "TRITON_GRPC_ENDPOINT"') do set "TRITON_GRPC_ENDPOINT=%%b"
if "%TRITON_X_TOKEN%"=="" for /f "tokens=2,*" %%a in ('reg query "HKCU\Environment" /v TRITON_X_TOKEN 2^>nul ^| find "TRITON_X_TOKEN"') do set "TRITON_X_TOKEN=%%b"
"C:\Program Files\nodejs\node.exe" scripts\refresh-catalog.mjs >> "%LOCALAPPDATA%\SeekerScout\catalog-refresh.log" 2>&1
