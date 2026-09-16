@echo off
setlocal
set "STARTUP_SCRIPT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\start-light-chat-3020.cmd"
if exist "%STARTUP_SCRIPT%" (
    call "%STARTUP_SCRIPT%" restart
) else (
    pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-background.ps1" -Port 3020 -Restart
)
echo Light-Chat 3020 服务已执行重启指令。
timeout /t 2 /nobreak >nul
