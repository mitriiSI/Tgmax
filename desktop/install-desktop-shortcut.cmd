@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Bridge Console 2.2.0.lnk');$s.TargetPath='%~dp0BridgeConsole.cmd';$s.WorkingDirectory='%~dp0';$s.Description='Telegram-MAX Bridge Console 2.2.0';$s.Save()"
if errorlevel 1 (
  echo Не удалось создать ярлык.
  pause
  exit /b 1
)
echo Ярлык Bridge Console 2.2.0 создан на рабочем столе.
pause
