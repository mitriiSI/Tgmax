import path from 'node:path';

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return value;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPositiveInt(value, fallback, maximum) {
  return Math.min(positiveInt(value, fallback), maximum);
}

export function loadConfig(env = process.env) {
  const pairingCode = required(env, 'PAIRING_CODE');
  if (pairingCode.length < 12) {
    throw new Error('PAIRING_CODE must contain at least 12 characters');
  }

  const panelToken = required(env, 'PANEL_TOKEN');
  if (panelToken.length < 12) {
    throw new Error('PANEL_TOKEN must contain at least 12 characters');
  }
  if (panelToken === pairingCode) {
    throw new Error('PANEL_TOKEN must be different from PAIRING_CODE');
  }

  const dataDir = env.DATA_DIR?.trim() || path.resolve('data');
  const telegramDownloadLimitMb = boundedPositiveInt(env.TELEGRAM_DOWNLOAD_LIMIT_MB, 20, 2000);
  const telegramUploadLimitMb = boundedPositiveInt(env.TELEGRAM_UPLOAD_LIMIT_MB, 50, 2000);
  const mediaTransferTimeoutMinutes = boundedPositiveInt(env.MEDIA_TRANSFER_TIMEOUT_MINUTES, 120, 24 * 60);
  const mediaDiskReserveMb = boundedPositiveInt(env.MEDIA_DISK_RESERVE_MB, 512, 1024 * 1024);
  const webRelayPollSeconds = boundedPositiveInt(env.WEB_RELAY_POLL_SECONDS, 60, 3600);
  const webRelayMediaTargetMb = boundedPositiveInt(env.WEB_RELAY_MEDIA_TARGET_MB, 19, 49);
  const networkSpeedTestIntervalMinutes = boundedPositiveInt(env.NETWORK_SPEED_TEST_INTERVAL_MINUTES, 360, 24 * 60);
  const networkSpeedTestOnStart = String(env.NETWORK_SPEED_TEST_ON_START ?? 'true').toLowerCase() !== 'false';

  return {
    telegramBotToken: required(env, 'TELEGRAM_BOT_TOKEN'),
    webRelayBotToken: env.WEB_RELAY_BOT_TOKEN?.trim() || '',
    webRelayPollIntervalMs: Math.max(15, webRelayPollSeconds) * 1000,
    webRelayMediaTargetBytes: webRelayMediaTargetMb * 1024 * 1024,
    networkSpeedTestIntervalMs: networkSpeedTestIntervalMinutes * 60 * 1000,
    networkSpeedTestOnStart,
    telegramApiBaseUrl: env.TELEGRAM_API_BASE_URL?.trim() || 'https://api.telegram.org',
    telegramLocalFilesRoot: env.TELEGRAM_LOCAL_FILES_ROOT?.trim() || '',
    telegramDownloadLimitBytes: telegramDownloadLimitMb * 1024 * 1024,
    telegramUploadLimitBytes: telegramUploadLimitMb * 1024 * 1024,
    mediaTransferTimeoutMs: mediaTransferTimeoutMinutes * 60 * 1000,
    mediaDiskReserveBytes: mediaDiskReserveMb * 1024 * 1024,
    maxBotToken: required(env, 'MAX_BOT_TOKEN'),
    pairingCode,
    panelToken,
    dataDir,
    databasePath: path.join(dataDir, 'bridge.json'),
    port: positiveInt(env.PORT, 8080),
    messageLinkTtlDays: positiveInt(env.MESSAGE_LINK_TTL_DAYS, 30),
    consoleEnabled: env.CONSOLE_ENABLED?.trim().toLowerCase() !== 'false',
    consoleLogDays: boundedPositiveInt(env.CONSOLE_LOG_DAYS, 30, 3650),
    consoleMaxMemoryEvents: boundedPositiveInt(env.CONSOLE_MAX_MEMORY_EVENTS, 5000, 100000),
    consoleShowMessageText: env.CONSOLE_SHOW_MESSAGE_TEXT?.trim().toLowerCase() === 'true'
  };
}
