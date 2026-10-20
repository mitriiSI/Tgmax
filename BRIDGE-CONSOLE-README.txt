BRIDGE CONSOLE 2.2.0 — ВЕБ И DESKTOP

ВЕБ-ПАНЕЛЬ
1. Запустите Telegram–MAX Bridge 2.2.0.
2. Откройте http://127.0.0.1:8080/console
3. Введите PANEL_TOKEN из .env.
4. События идут в реальном времени через SSE.

DESKTOP WINDOWS
1. Откройте папку desktop.
2. Запустите BridgeConsole.cmd.
3. Введите PANEL_TOKEN.
4. Программа использует штатный Windows PowerShell/WPF, установка Node/Electron не нужна.

ЛОГИ
Файлы сохраняются в data/logs/events-ГГГГ-ММ-ДД.jsonl.
Каждая строка — отдельное JSON-событие. Старые журналы автоматически удаляются через CONSOLE_LOG_DAYS дней.

БЕЗОПАСНОСТЬ
Токены, API_HASH, коды привязки и пароли автоматически скрываются в details.
Полные тексты сообщений по умолчанию не сохраняются: CONSOLE_SHOW_MESSAGE_TEXT=false.
Не открывайте порт 8080 напрямую в интернет. Для удалённого доступа используйте VPN или HTTPS reverse proxy.

API
GET /api/console/events
GET /api/console/stats
GET /api/console/stream
GET /api/console/export
Во всех запросах нужен PANEL_TOKEN: query ?token=... или заголовок x-panel-token.
