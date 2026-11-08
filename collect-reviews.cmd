@echo off
cd /d "%~dp0" || exit /b 1
node --env-file=backend/.env backend/scripts/steam-reviews.mjs produce >> "%~dp0review-collection.log" 2>&1
exit /b %errorlevel%