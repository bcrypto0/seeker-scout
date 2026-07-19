@echo off
rem Persistent launcher for the Seeker Scout on-chain mint-watcher.
rem Reads TRITON_GRPC_ENDPOINT + TRITON_X_TOKEN from the user registry
rem (set once via SetEnvironmentVariable/setx — NEVER stored in this file),
rem so it works whether launched at logon or from a stale-env parent.
rem Auto-started by Startup\SeekerScoutWatcher.vbs; self-restarts on exit.
rem Log: %LOCALAPPDATA%\SeekerScout\watcher.log
if not exist "%LOCALAPPDATA%\SeekerScout" mkdir "%LOCALAPPDATA%\SeekerScout"
cd /d "C:\Users\b39cr\OneDrive\Documents\Claude\Projects\solana phone seeker\seeker-scout\watcher"

rem Pull the Triton config from HKCU\Environment if not already in the env.
if "%TRITON_GRPC_ENDPOINT%"=="" for /f "tokens=2,*" %%a in ('reg query "HKCU\Environment" /v TRITON_GRPC_ENDPOINT 2^>nul ^| find "TRITON_GRPC_ENDPOINT"') do set "TRITON_GRPC_ENDPOINT=%%b"
if "%TRITON_X_TOKEN%"=="" for /f "tokens=2,*" %%a in ('reg query "HKCU\Environment" /v TRITON_X_TOKEN 2^>nul ^| find "TRITON_X_TOKEN"') do set "TRITON_X_TOKEN=%%b"

:loop
echo [%date% %time%] starting watcher >> "%LOCALAPPDATA%\SeekerScout\watcher.log"
"C:\Program Files\nodejs\node.exe" watch.mjs >> "%LOCALAPPDATA%\SeekerScout\watcher.log" 2>&1
echo [%date% %time%] watcher exited (code %errorlevel%); restarting in 15s >> "%LOCALAPPDATA%\SeekerScout\watcher.log"
timeout /t 15 /nobreak >nul
goto loop
