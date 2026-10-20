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
echo Первый запуск режима файлов до 2 ГБ.
echo Проверяю и запускаю локальный Telegram Bot API...
docker compose -f compose.yaml -f compose.large-files.yaml up -d telegram-bot-api
if errorlevel 1 goto error
timeout /t 5 /nobreak >nul
echo Отключаю бота от облачного Telegram Bot API (это делается один раз)...
docker compose -f compose.yaml -f compose.large-files.yaml run --rm --build bridge npm run telegram:logout-cloud
if errorlevel 1 goto error
echo Запускаю мост в фоне в режиме до 2 ГБ...
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
echo Проверь PANEL_TOKEN, TELEGRAM_API_ID и TELEGRAM_API_HASH в файле .env.
echo Логи: docker compose -f compose.yaml -f compose.large-files.yaml logs --tail=100 telegram-bot-api
pause
exit /b 1
