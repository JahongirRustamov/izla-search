@echo off
chcp 65001 >nul
start "" http://localhost:5173/
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"

