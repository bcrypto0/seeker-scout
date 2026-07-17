@echo off
rem Scheduled-task wrapper for the Seeker Scout catalog refresh.
rem Task: SeekerScoutCatalogRefresh (daily). Log: %LOCALAPPDATA%\SeekerScout\catalog-refresh.log
if not exist "%LOCALAPPDATA%\SeekerScout" mkdir "%LOCALAPPDATA%\SeekerScout"
cd /d "C:\Users\b39cr\OneDrive\Documents\Claude\Projects\solana phone seeker\seeker-scout"
"C:\Program Files\nodejs\node.exe" scripts\refresh-catalog.mjs >> "%LOCALAPPDATA%\SeekerScout\catalog-refresh.log" 2>&1
