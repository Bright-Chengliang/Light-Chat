@echo off
setlocal
rem The file is UTF-8; switch the console code page so messages print correctly.
chcp 65001 >nul
rem Restart the Light-Chat service on port 3020.
rem This file must keep CRLF line endings (see .gitattributes); cmd.exe
rem mis-parses LF-only batch files.

set "STARTUP_SCRIPT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\start-light-chat-3020.cmd"
if exist "%STARTUP_SCRIPT%" (
    call "%STARTUP_SCRIPT%" restart
    goto :done
)

set "PS_EXE=pwsh.exe"
where pwsh.exe >nul 2>&1 || set "PS_EXE=powershell.exe"
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-background.ps1" -Port 3020 -Restart

:done
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo Light-Chat 3020 重启失败，退出码 %EXIT_CODE%。
    exit /b %EXIT_CODE%
)
echo Light-Chat 3020 服务已执行重启指令。
exit /b 0
