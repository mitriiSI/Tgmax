import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const required = {
  TELEGRAM_BOT_TOKEN: 'telegram-token',
  MAX_BOT_TOKEN: 'max-token',
  PAIRING_CODE: 'long-pairing-code',
  PANEL_TOKEN: 'separate-panel-token'
};

test('cloud Telegram limits remain the defaults', () => {
  const config = loadConfig(required);
  assert.equal(config.telegramApiBaseUrl, 'https://api.telegram.org');
  assert.equal(config.telegramLocalFilesRoot, '');
  assert.equal(config.telegramDownloadLimitBytes, 20 * 1024 * 1024);
  assert.equal(config.telegramUploadLimitBytes, 50 * 1024 * 1024);
  assert.equal(config.mediaTransferTimeoutMs, 120 * 60 * 1000);
  assert.equal(config.mediaDiskReserveBytes, 512 * 1024 * 1024);
});

test('local Telegram limits and paths are configurable', () => {
  const config = loadConfig({
    ...required,
    TELEGRAM_API_BASE_URL: 'http://telegram-bot-api:8081',
    TELEGRAM_LOCAL_FILES_ROOT: '/var/lib/telegram-bot-api',
    TELEGRAM_DOWNLOAD_LIMIT_MB: '9000',
    TELEGRAM_UPLOAD_LIMIT_MB: '9000',
    MEDIA_TRANSFER_TIMEOUT_MINUTES: '720',
    MEDIA_DISK_RESERVE_MB: '1024'
  });
  assert.equal(config.telegramApiBaseUrl, 'http://telegram-bot-api:8081');
  assert.equal(config.telegramLocalFilesRoot, '/var/lib/telegram-bot-api');
  assert.equal(config.telegramDownloadLimitBytes, 2000 * 1024 * 1024);
  assert.equal(config.telegramUploadLimitBytes, 2000 * 1024 * 1024);
  assert.equal(config.mediaTransferTimeoutMs, 720 * 60 * 1000);
  assert.equal(config.mediaDiskReserveBytes, 1024 * 1024 * 1024);
});

test('public channel web relay is optional and configurable', () => {
  const disabled = loadConfig(required);
  assert.equal(disabled.webRelayBotToken, '');
  assert.equal(disabled.webRelayPollIntervalMs, 60_000);
  assert.equal(disabled.webRelayMediaTargetBytes, 19 * 1024 * 1024);

  const enabled = loadConfig({
    ...required,
    WEB_RELAY_BOT_TOKEN: 'relay-token',
    WEB_RELAY_POLL_SECONDS: '20',
    WEB_RELAY_MEDIA_TARGET_MB: '25'
  });
  assert.equal(enabled.webRelayBotToken, 'relay-token');
  assert.equal(enabled.webRelayPollIntervalMs, 20_000);
  assert.equal(enabled.webRelayMediaTargetBytes, 25 * 1024 * 1024);

  const bounded = loadConfig({ ...required, WEB_RELAY_MEDIA_TARGET_MB: '500' });
  assert.equal(bounded.webRelayMediaTargetBytes, 49 * 1024 * 1024);
});

test('Bridge Console defaults are safe and can be configured', () => {
  const defaults = loadConfig(required);
  assert.equal(defaults.consoleEnabled, true);
  assert.equal(defaults.consoleLogDays, 30);
  assert.equal(defaults.consoleMaxMemoryEvents, 5000);
  assert.equal(defaults.consoleShowMessageText, false);
  assert.equal(defaults.networkSpeedTestIntervalMs, 360 * 60 * 1000);
  assert.equal(defaults.networkSpeedTestOnStart, true);

  const configured = loadConfig({
    ...required,
    CONSOLE_ENABLED: 'false',
    CONSOLE_LOG_DAYS: '90',
    CONSOLE_MAX_MEMORY_EVENTS: '20000',
    CONSOLE_SHOW_MESSAGE_TEXT: 'true',
    NETWORK_SPEED_TEST_INTERVAL_MINUTES: '30',
    NETWORK_SPEED_TEST_ON_START: 'false'
  });
  assert.equal(configured.consoleEnabled, false);
  assert.equal(configured.consoleLogDays, 90);
  assert.equal(configured.consoleMaxMemoryEvents, 20000);
  assert.equal(configured.consoleShowMessageText, true);
  assert.equal(configured.networkSpeedTestIntervalMs, 30 * 60 * 1000);
  assert.equal(configured.networkSpeedTestOnStart, false);
});


test('PANEL_TOKEN is required and must be separate from PAIRING_CODE', () => {
  assert.throws(
    () => loadConfig({ ...required, PANEL_TOKEN: '' }),
    /Missing PANEL_TOKEN/
  );
  assert.throws(
    () => loadConfig({ ...required, PANEL_TOKEN: required.PAIRING_CODE }),
    /different from PAIRING_CODE/
  );
  assert.throws(
    () => loadConfig({ ...required, PANEL_TOKEN: 'short' }),
    /at least 12 characters/
  );
});
