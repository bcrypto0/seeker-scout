@echo off
rem Seeker Scout discovery watchdog - invoked by Windows task
rem SeekerScoutWatchdog every 30 min. Self-heals the mint-watcher and the
rem catalog refresh; logs to %LOCALAPPDATA%\SeekerScout\watchdog.log.
rem ASCII ONLY in this file - cmd misparses multi-byte punctuation.
cd /d "C:\Users\b39cr\OneDrive\Documents\Claude\Projects\solana phone seeker\seeker-scout"
"C:\Program Files\nodejs\node.exe" scripts\watchdog.mjs
