@echo off
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3001 ^| findstr LISTENING') do (
    echo Found process on port 3001 (PID: %%a)
    taskkill /F /PID %%a
)
