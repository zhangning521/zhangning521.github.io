@echo off
setlocal
chcp 65001 >nul
title 樱花音乐相册 - 本地服务器

cd /d "%~dp0"

echo 正在启动服务（会自动扫描 mp3 与 img-one 并生成/更新 JSON 配置）...

where python >nul 2>&1
if %errorlevel%==0 (
  python run_server.py
) else (
  echo 未找到 python，可尝试使用 py 启动...
  py run_server.py
)

echo.
echo 服务已结束，按任意键关闭窗口...
pause >nul