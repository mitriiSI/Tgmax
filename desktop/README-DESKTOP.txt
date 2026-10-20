BRIDGE CONSOLE DESKTOP 2.0

1. Сервер Telegram–MAX Bridge 2.0 должен быть запущен.
2. Дважды нажмите BridgeConsole.cmd.
3. Введите PANEL_TOKEN из файла .env.
4. Программа подключится к http://127.0.0.1:8080.

Другой адрес сервера:
powershell -ExecutionPolicy Bypass -File BridgeConsole.ps1 -ServerUrl http://192.168.1.50:8080

Важно: если сервер доступен не только на этом компьютере, не открывайте порт 8080 в интернет без VPN/обратного прокси с HTTPS. PANEL_TOKEN даёт доступ к журналам и панели.
