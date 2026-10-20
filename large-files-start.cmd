@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".env" (
  echo Не найден файл .env в папке проекта.
  echo Скопируй .env.example в .env и заполни токены, отдельный PANEL_TOKEN, API_ID и API_HASH.
  pause
  exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop не запущен или Docker недоступен.
  pause
  exit /b 1
)
docker compose -f compose.yaml -f compose.large-files.yaml config >nul
if errorlevel 1 (
  echo Ошибка в .env или Docker Compose. Проверь значения без кавычек и пробелов вокруг знака =.
  pause
  exit /b 1
)
echo Запускаю мост в фоне в режиме файлов до 2 ГБ...
docker compose -f compose.yaml -f compose.large-files.yaml up -d --build
if errorlevel 1 goto error
echo.
echo Готово. Проверка: http://127.0.0.1:8080/health
docker compose -f compose.yaml -f compose.large-files.yaml ps
pause
exit /b 0

:error
echo.
echo Запуск остановлен из-за ошибки.
echo Логи: docker compose -f compose.yaml -f compose.large-files.yaml logs --tail=100
pause
exit /b 1
