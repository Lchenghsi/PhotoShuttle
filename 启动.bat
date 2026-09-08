@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在启动 简单传（浏览器将自动打开）...
node server\index.js
pause
