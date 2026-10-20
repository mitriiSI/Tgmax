import 'dotenv/config';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { Bot as MaxBot, Keyboard } from '@maxhub/max-bot-api';
import { pairMaxAccount } from './account-pairing.js';
import { loadConfig } from './config.js';
import { censorTelegramMessage } from './censor.js';
import { BridgeDatabase } from './database.js';
import {
  archiveMediaFile,
  downloadMaxAttachment,
  maxAttachmentAsText,
  makeMaxVideoMessage,
  makeVoiceMessage,
  removeTempDirectory,
  safeFileName,
  telegramKindForMaxRelay,
  telegramMediaFromMessage,
  uploadTelegramMediaToMax,
  uploadFileToMax
} from './media.js';
import { startMaxPolling } from './max-poller.js';
import { formatMaxForwardNote, formatTelegramAlbumContentOnly, formatTelegramForMax, splitText, telegramForwardSource, telegramForwardSourceType, telegramSenderName, telegramSenderUsername } from './text.js';
import { TelegramApi } from './telegram-api.js';
import { startTelegramPolling } from './telegram-poller.js';
import { cleanRelayedPostText } from './web-channel-relay.js';
import { ChannelRelayManager } from './channel-relay-manager.js';
import { createEventLogger, EventStore } from './event-store.js';
import { createProgressEmitter, estimateTransferTime, formatEta, NetworkMonitor } from './network-monitor.js';

let log = {
  info: (message, details) => console.log(`[info] ${message}`, details ?? ''),
  warn: (message, details) => console.warn(`[warn] ${message}`, details ?? ''),
  error: (message, error) => {
    const cause = error?.cause;
    const details = cause?.code
      ? `${cause.code}: ${cause.message}`
      : error?.message ?? error ?? '';
    console.error(`[error] ${message}`, details);
  }
};

function formatChatLine(chat, index) {
  const username = chat.username ? ` @${chat.username}` : '';
  const muted = chat.muted ? ' · скрыт' : '';
  const original = chat.customName ? ` / Telegram: ${chat.displayName}${username}` : username;
  return `${index + 1}. ${chat.effectiveName}${original}\n   ID: ${chat.telegramChatId}${muted}`;
}

function formatFilters({ onlyChatId, activeChat, mutedChats }) {
  const only = onlyChatId
    ? `Только от: ${onlyChatId}`
    : 'Только от: выключено';
  const active = activeChat
    ? `Активный чат для ответов: ${active.effectiveName} (${active.telegramChatId})`
    : 'Активный чат для ответов: выключен';
  const muted = mutedChats.length
    ? `Скрыты:\n${mutedChats.map((chat, index) => formatChatLine(chat, index)).join('\n')}`
    : 'Скрыты: никого';
  return `${active}\n${only}\n${muted}`;
}

function parseCommandText(text) {
  const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return {
    command: (match?.[1] ?? '').toLowerCase(),
    argument: (match?.[2] ?? '').trim()
  };
}

const MIRROR_MODES = {
  all: 'все сообщения',
  mine: 'только ваши сообщения',
  others: 'только сообщения собеседников',
  off: 'зеркалирование выключено'
};

function maxKeyboard(rows) {
  return Keyboard.inlineKeyboard(rows.map((row) => row.map(({ text, payload, intent }) => (
    Keyboard.button.callback(text, payload, intent ? { intent } : undefined)
  ))));
}

async function main() {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });

  const db = new BridgeDatabase(config.databasePath);
  const eventStore = new EventStore({
    dataDir: config.dataDir,
    maxMemoryEvents: config.consoleMaxMemoryEvents,
    retentionDays: config.consoleLogDays,
    showMessageText: config.consoleShowMessageText,
    accountProvider: () => db.currentAccountId(),
    consoleOutput: true
  });
  log = createEventLogger(eventStore, () => db.currentAccountId());
  const networkMonitor = new NetworkMonitor({ db, log, intervalMs: config.networkSpeedTestIntervalMs, testOnStart: config.networkSpeedTestOnStart });
  networkMonitor.start();
  log.event({ level: 'info', category: 'system', event: 'bridge_starting', message: 'Bridge 2.2.0 запускается', status: 'running', details: { version: '2.2.0', pid: process.pid } });
  const telegram = new TelegramApi(config.telegramBotToken, {
    apiBaseUrl: config.telegramApiBaseUrl,
    localFilesRoot: config.telegramLocalFilesRoot,
    mediaTransferTimeoutMs: config.mediaTransferTimeoutMs
  });
  const webRelayTelegram = config.webRelayBotToken
    ? new TelegramApi(config.webRelayBotToken, {
        apiBaseUrl: config.telegramApiBaseUrl,
        localFilesRoot: config.telegramLocalFilesRoot,
        mediaTransferTimeoutMs: config.mediaTransferTimeoutMs
      })
    : null;
  telegram.setMyCommands([
    { command: 'help', description: 'Показать все команды' },
    { command: 'whoami', description: 'Показать Telegram ID' },
    { command: 'bind', description: 'Привязать аккаунт' },
    { command: 'mirror', description: 'Настроить копирование сообщений' },
    { command: 'censor', description: 'Настроить цензуру слов и фраз' },
    { command: 'code', description: 'Показать личный код MAX' },
    { command: 'tgk', description: 'TGK 1–3 по публичным ссылкам' },
    { command: 'speed', description: 'Скорость интернета сервера' },
    { command: 'eta', description: 'Оценить время передачи файла' }
  ]).catch((error) => log.warn('Telegram command menu setup failed', error.message));
  webRelayTelegram?.setMyCommands([
    { command: 'bind', description: 'Привязать владельца' },
    { command: 'source', description: 'Выбрать публичный канал' },
    { command: 'relay', description: 'Включить или выключить пересылку' },
    { command: 'load', description: 'Выгрузить последние публикации' },
    { command: 'status', description: 'Показать состояние' },
    { command: 'help', description: 'Показать инструкцию' }
  ]).catch((error) => log.warn('Web relay command menu setup failed', error.message));
  const maxBot = new MaxBot(config.maxBotToken);
  const app = Fastify({ logger: false, trustProxy: true, bodyTimeout: config.mediaTransferTimeoutMs });
  await app.register(multipart, {
    limits: { files: 10, fileSize: config.telegramUploadLimitBytes }
  });

  app.addHook('onRequest', async (request) => {
    const pathOnly = String(request.url || '').split('?')[0];
    if (pathOnly === '/console' || pathOnly.startsWith('/api/console/')) return;
    request.bridgeRequestStartedAt = Date.now();
    log.event({
      level: 'debug', category: 'http', event: 'http_request_started',
      message: `${request.method} ${pathOnly}`,
      stage: 'request', status: 'running', progress: 10,
      details: { method: request.method, path: pathOnly, ip: request.ip }
    });
  });
  app.addHook('onResponse', async (request, reply) => {
    const pathOnly = String(request.url || '').split('?')[0];
    if (pathOnly === '/console' || pathOnly.startsWith('/api/console/')) return;
    log.event({
      level: reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'debug',
      category: 'http', event: 'http_request_completed',
      message: `${request.method} ${pathOnly} → ${reply.statusCode}`,
      accountId: request.bridgeAccountId ?? db.currentAccountId(),
      stage: 'request', status: reply.statusCode >= 400 ? 'failed' : 'completed', progress: 100,
      durationMs: request.bridgeRequestStartedAt ? Date.now() - request.bridgeRequestStartedAt : null,
      details: { method: request.method, path: pathOnly, statusCode: reply.statusCode, ip: request.ip }
    });
  });
  const miniAppHtml = readFileSync(join(process.cwd(), 'public', 'miniapp.html'), 'utf8');
  const consoleHtml = readFileSync(join(process.cwd(), 'public', 'console.html'), 'utf8');

  app.get('/health', async () => ({
    ok: true,
    accounts: db.listAccounts().length,
    telegramBound: Boolean(db.getSetting('telegram_owner_id')),
    telegramBusinessConnected: Boolean(db.getSetting('telegram_business_connection_id')),
    maxBound: Boolean(db.getSetting('max_owner_id')),
    webRelayConfigured: true,
    webRelayEnabled: db.getSetting('web_relay_enabled') === 'true',
    webRelaySource: db.getSetting('web_relay_source_url') ?? null,
    webRelayTarget: db.getSetting('web_relay_target_chat_id') ?? null,
    webRelayMaxTarget: db.getSetting('web_relay_max_chat_id') ?? null,
    webRelayLastPostId: db.getSetting('web_relay_last_post_id') ?? null,
    webRelayLastError: db.getSetting('web_relay_last_error') ?? null,
    largeFileMode: Boolean(config.telegramLocalFilesRoot),
    streamingMedia: true,
    consoleEnabled: config.consoleEnabled,
    consoleUrl: config.consoleEnabled ? `http://127.0.0.1:${config.port}/console` : null,
    limits: {
      telegramDownloadMb: config.telegramDownloadLimitBytes / (1024 * 1024),
      telegramUploadMb: config.telegramUploadLimitBytes / (1024 * 1024),
      transferTimeoutMinutes: config.mediaTransferTimeoutMs / (60 * 1000),
      diskReserveMb: config.mediaDiskReserveBytes / (1024 * 1024),
      webRelayMediaTargetMb: config.webRelayMediaTargetBytes / (1024 * 1024)
    }
  }));

  app.get('/miniapp', async (_request, reply) => {
    reply
      .header('cache-control', 'no-store, no-cache, must-revalidate')
      .type('text/html; charset=utf-8')
      .send(miniAppHtml);
  });

  app.get('/console', async (_request, reply) => {
    if (!config.consoleEnabled) return reply.code(404).send('Bridge Console отключена');
    reply
      .header('cache-control', 'no-store, no-cache, must-revalidate')
      .type('text/html; charset=utf-8')
      .send(consoleHtml);
  });

  app.get('/assets/:name', async (request, reply) => {
    const allowed = new Set(['wallpaper-dark.jpg', 'wallpaper-light.jpg']);
    if (!allowed.has(request.params.name)) return reply.code(404).send({ error: 'Файл не найден' });
    reply.type('image/jpeg').header('cache-control', 'public, max-age=86400');
    return reply.send(createReadStream(join(process.cwd(), 'public', 'assets', request.params.name)));
  });

  function panelAuthorized(request) {
    const token = request.headers['x-panel-token'] ?? request.query?.token;
    return typeof token === 'string' && token === config.panelToken;
  }

  function requestedAccountId(request) {
    const value = request.headers['x-account-id'] ?? request.query?.accountId;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  app.addHook('preHandler', (request, reply, done) => {
    if (!request.url.startsWith('/api/')) return done();
    const accountId = requestedAccountId(request) ?? db.defaultAccountId();
    if (!accountId) return done();
    if (!db.accountExists(accountId)) {
      reply.code(404).send({ error: 'Профиль пользователя не найден' });
      return;
    }
    request.bridgeAccountId = accountId;
    db.runAsAccount(accountId, () => {
      if (panelAuthorized(request)) db.recordAccountIp(accountId, request.ip);
      done();
    });
  });

  app.get('/api/accounts', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    return { accounts: db.listAccounts() };
  });


  app.get('/api/console/events', async (request, reply) => {
    if (!config.consoleEnabled) return reply.code(404).send({ error: 'Bridge Console отключена' });
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const events = eventStore.list({
      after: request.query?.after,
      limit: request.query?.limit,
      level: request.query?.level,
      category: request.query?.category,
      accountId: request.query?.accountId,
      operationId: request.query?.operationId,
      query: request.query?.query
    });
    return { events, lastSequence: eventStore.stats().lastSequence };
  });

  app.get('/api/console/stats', async (request, reply) => {
    if (!config.consoleEnabled) return reply.code(404).send({ error: 'Bridge Console отключена' });
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const memory = process.memoryUsage();
    return {
      ...eventStore.stats(),
      accounts: db.listAccounts().length,
      memoryMb: Math.round(memory.rss / 1024 / 1024),
      heapMb: Math.round(memory.heapUsed / 1024 / 1024),
      largeFileMode: Boolean(config.telegramLocalFilesRoot),
      network: networkMonitor.snapshot(),
      limits: {
        telegramDownloadMb: config.telegramDownloadLimitBytes / 1024 / 1024,
        telegramUploadMb: config.telegramUploadLimitBytes / 1024 / 1024
      }
    };
  });

  app.get('/api/console/network', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    return { network: networkMonitor.snapshot() };
  });

  app.post('/api/console/network/test', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    try {
      return { network: await networkMonitor.test({ force: true }) };
    } catch (error) {
      return reply.code(502).send({ error: `Не удалось измерить скорость: ${error.message}` });
    }
  });

  app.get('/api/channels', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    return channelRelay.status();
  });

  app.post('/api/channels', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    try {
      return channelRelay.addSource(request.body?.url);
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.delete('/api/channels', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    try {
      return channelRelay.removeSource(request.body?.url ?? request.query?.url);
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.post('/api/channels/state', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    return { enabled: channelRelay.setEnabled(Boolean(request.body?.enabled)) };
  });


  app.get('/api/tgk', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    return channelRelay.status();
  });

  app.put('/api/tgk/:slot', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    try {
      return await channelRelay.configureSlot(request.params.slot, request.body?.url);
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.delete('/api/tgk/:slot', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    try {
      return channelRelay.removeSlot(request.params.slot);
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.post('/api/tgk/:slot/test', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    try {
      return await channelRelay.probeSlot(request.params.slot);
    } catch (error) {
      return reply.code(502).send({ error: error.message });
    }
  });

  app.post('/api/tgk/:slot/load', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    try {
      return { loaded: await channelRelay.loadLatest(request.params.slot, Number(request.body?.count || 1)) };
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.post('/api/tgk/state', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    return { enabled: channelRelay.setEnabled(Boolean(request.body?.enabled)) };
  });

  app.get('/api/console/export', async (request, reply) => {
    if (!config.consoleEnabled) return reply.code(404).send({ error: 'Bridge Console отключена' });
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const requestedDate = String(request.query?.date ?? new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) return reply.code(400).send({ error: 'Неверная дата журнала' });
    const filePath = join(config.dataDir, 'logs', `events-${requestedDate}.jsonl`);
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'Журнал за эту дату не найден' });
    reply
      .header('content-disposition', `attachment; filename=bridge-events-${requestedDate}.jsonl`)
      .type('application/x-ndjson; charset=utf-8');
    return reply.send(createReadStream(filePath));
  });

  app.get('/api/console/stream', async (request, reply) => {
    if (!config.consoleEnabled) return reply.code(404).send({ error: 'Bridge Console отключена' });
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no'
    });
    const after = Math.max(Number(request.query?.after) || 0, Number(request.headers['last-event-id']) || 0);
    const buffered = [];
    let live = false;
    const unsubscribe = eventStore.subscribe((payload) => {
      if (live) reply.raw.write(payload);
      else buffered.push(payload);
    });
    for (const event of eventStore.list({ after, limit: 2000 })) {
      reply.raw.write(`id: ${event.seq}\nevent: bridge-event\ndata: ${JSON.stringify(event)}\n\n`);
    }
    live = true;
    for (const payload of buffered) reply.raw.write(payload);
    const heartbeat = setInterval(() => reply.raw.write(`: ping ${Date.now()}\n\n`), 20_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get('/api/chats', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    return { chats: db.listTelegramChats(200) };
  });

  app.get('/api/settings', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    return { chatHistoryLimit: Number(db.getSetting('chat_history_limit')) || 5000 };
  });

  app.patch('/api/settings', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const requested = Number(request.body?.chatHistoryLimit);
    if (!Number.isInteger(requested) || requested < 1 || requested > 10000) {
      return reply.code(400).send({ error: 'Лимит должен быть целым числом от 1 до 10000' });
    }
    return { chatHistoryLimit: db.setChatHistoryLimit(requested) };
  });

  app.get('/api/chats/:chatId/messages', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const chat = db.findTelegramChat(request.params.chatId);
    if (!chat) return reply.code(404).send({ error: 'Чат не найден' });
    const configuredLimit = Number(db.getSetting('chat_history_limit')) || 5000;
    const limit = Math.min(Number(request.query?.limit) || 100, configuredLimit);
    const before = Number(request.query?.before) || Infinity;
    const messages = db.listChatMessages(chat.telegramChatId, limit, before);
    return { chat, messages, hasMore: messages.length === limit };
  });

  app.delete('/api/chats/:chatId/messages', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    if (!db.findTelegramChat(request.params.chatId)) return reply.code(404).send({ error: 'Чат не найден' });
    return { ok: true, removed: db.clearChatMessages(request.params.chatId) };
  });

  app.get('/api/media/:mediaId', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const media = db.findMedia(request.params.mediaId);
    if (!media) return reply.code(404).send({ error: 'Файл не найден' });
    const filePath = join(config.dataDir, 'history', media.storedName);
    reply.header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(media.fileName)}`);
    reply.type(media.mimeType || 'application/octet-stream');
    return reply.send(createReadStream(filePath));
  });

  app.patch('/api/chats/:chatId', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const chatId = request.params.chatId;
    const body = request.body ?? {};
    if (typeof body.name === 'string') db.setTelegramChatCustomName(chatId, body.name);
    if (typeof body.muted === 'boolean') db.setTelegramChatMuted(chatId, body.muted);
    const chat = db.findTelegramChat(chatId);
    if (!chat) return reply.code(404).send({ error: 'Чат не найден' });
    return { chat };
  });

  async function receivePanelFile(request) {
    const part = await request.file();
    if (!part) throw new Error('Файл не выбран');
    const directory = await mkdtemp(join(config.dataDir, 'panel-upload-'));
    const fileName = safeFileName(part.filename, 'upload');
    const filePath = join(directory, fileName);
    try {
      await pipeline(part.file, createWriteStream(filePath));
      if (part.file.truncated) throw new Error('Файл превышает установленный лимит');
      return { directory, filePath, fileName, mimeType: part.mimetype, fields: part.fields };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  app.post('/api/chats/:chatId/avatar', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const chat = db.findTelegramChat(request.params.chatId);
    if (!chat) return reply.code(404).send({ error: 'Чат не найден' });
    let uploaded;
    try {
      uploaded = await receivePanelFile(request);
      if (!uploaded.mimeType?.startsWith('image/')) {
        return reply.code(400).send({ error: 'Для аватарки выбери изображение' });
      }
      const avatar = await archiveMediaFile({
        filePath: uploaded.filePath,
        fileName: uploaded.fileName,
        mimeType: uploaded.mimeType,
        kind: 'image',
        dataDir: config.dataDir,
        move: true
      });
      db.setTelegramChatAvatar(chat.telegramChatId, avatar);
      return { chat: db.findTelegramChat(chat.telegramChatId) };
    } finally {
      if (uploaded?.directory) await rm(uploaded.directory, { recursive: true, force: true });
    }
  });

  app.delete('/api/chats/:chatId/avatar', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    if (!db.setTelegramChatAvatar(request.params.chatId, null)) return reply.code(404).send({ error: 'Чат не найден' });
    return { chat: db.findTelegramChat(request.params.chatId) };
  });

  app.post('/api/chats/:chatId/wallpaper', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const chat = db.findTelegramChat(request.params.chatId);
    if (!chat) return reply.code(404).send({ error: 'Чат не найден' });
    let uploaded;
    try {
      uploaded = await receivePanelFile(request);
      if (!uploaded.mimeType?.startsWith('image/')) {
        return reply.code(400).send({ error: 'Для обоев выбери изображение' });
      }
      const wallpaper = await archiveMediaFile({
        filePath: uploaded.filePath,
        fileName: uploaded.fileName,
        mimeType: uploaded.mimeType,
        kind: 'image',
        dataDir: config.dataDir,
        move: true
      });
      db.setTelegramChatWallpaper(chat.telegramChatId, wallpaper);
      return { chat: db.findTelegramChat(chat.telegramChatId) };
    } finally {
      if (uploaded?.directory) await rm(uploaded.directory, { recursive: true, force: true });
    }
  });

  app.delete('/api/chats/:chatId/wallpaper', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    if (!db.setTelegramChatWallpaper(request.params.chatId, null)) {
      return reply.code(404).send({ error: 'Чат не найден' });
    }
    return { chat: db.findTelegramChat(request.params.chatId) };
  });

  function maxDestinationForTelegram(telegramChatId, isOwnMessage) {
    const maxOwnerId = db.getSetting('max_owner_id');
    if (!maxOwnerId) return undefined;

    if (!isOwnMessage) {
      const binding = db.findMaxGroupForTelegramChat(telegramChatId);
      if (binding) return { type: 'chat', id: binding.maxChatId, mode: 'dedicated' };
      const inboxChatId = db.getUnknownInboxMaxChatId();
      if (inboxChatId) return { type: 'chat', id: inboxChatId, mode: 'inbox' };
    }
    return { type: 'user', id: maxOwnerId, mode: 'private' };
  }

  function maxAttachmentStillProcessing(error) {
    const details = `${error?.message ?? ''} ${error?.code ?? ''}`.toLowerCase();
    const attachmentMentioned = details.includes('attachment') || details.includes('upload') || details.includes('file');
    const pendingMentioned = details.includes('processing')
      || details.includes('not ready')
      || details.includes('not.ready')
      || details.includes('not processed')
      || details.includes('not_processed')
      || details.includes('pending');
    return attachmentMentioned && pendingMentioned;
  }

  async function sendToMax(destination, text, extra) {
    if (!destination) throw new Error('MAX destination is not configured');
    const send = () => destination.type === 'chat'
      ? maxBot.api.sendMessageToChat(Number(destination.id), text, extra)
      : maxBot.api.sendMessageToUser(Number(destination.id), text, extra);
    const retryDelaysMs = extra?.attachments?.length
      ? [2_000, 5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 180_000, 240_000, 300_000, 300_000, 300_000]
      : [];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        if (!maxAttachmentStillProcessing(error) || attempt >= retryDelaysMs.length) throw error;
        const delay = retryDelaysMs[attempt];
        log.info(`MAX is still processing an attachment; retrying in ${Math.round(delay / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async function forwardWebRelayPostToMax({ post, telegramMessages = [], preparedMedia = [], tgkSlot = post?.tgkSlot, tgkTarget = null }) {
    const maxOwnerId = db.getSetting('max_owner_id');
    const maxChatId = tgkTarget?.maxChatId ? String(tgkTarget.maxChatId) : null;
    if (!maxOwnerId && !maxChatId) return false;
    const operationId = eventStore.operation('channel-max');
    const startedAt = Date.now();
    log.event({ level: 'info', category: 'channel', event: 'channel_post_received', message: `TGK ${tgkSlot || '?'}: публикация из @${post.channel} получена`, operationId, direction: 'telegram_channel_to_max', stage: 'receive', status: 'running', progress: 5, details: { channel: post.channel, postId: post.id, mediaCount: preparedMedia.length || telegramMessages.length } });
    const attachments = [];

    for (const [index, item] of preparedMedia.entries()) {
      try {
        const progress = createProgressEmitter({
          log, networkMonitor, operationId, direction: 'telegram_channel_to_max', stage: 'upload',
          event: 'channel_media_upload_progress', label: `TGK ${tgkSlot || '?'}: загрузка файла ${index + 1}/${preparedMedia.length}`,
          startProgress: 20, endProgress: 75, networkDirection: 'upload'
        });
        const maxAttachment = await uploadFileToMax({
          maxBot,
          kind: item.kind === 'photo' ? 'image' : 'video',
          filePath: item.filePath,
          fileName: item.fileName,
          mimeType: item.contentType,
          timeoutMs: config.mediaTransferTimeoutMs,
          onProgress: progress
        });
        attachments.push(maxAttachment);
      } catch (error) {
        log.event({ level: 'warn', category: 'channel', event: 'channel_media_upload_failed', message: `Не удалось передать медиа публикации: ${error.message}`, operationId, direction: 'telegram_channel_to_max', stage: 'upload', status: 'running', progress: 75, details: { error, index } });
      }
    }

    for (const message of telegramMessages) {
      const media = telegramMediaFromMessage(message);
      if (!media) continue;
      try {
        const uploaded = await uploadTelegramMediaToMax({
          telegram: webRelayTelegram || telegram,
          maxBot,
          media,
          dataDir: config.dataDir,
          maxBytes: config.telegramDownloadLimitBytes,
          timeoutMs: config.mediaTransferTimeoutMs,
          diskReserveBytes: config.mediaDiskReserveBytes
        });
        if (uploaded?.maxAttachment) attachments.push(uploaded.maxAttachment);
      } catch (error) {
        log.warn('Public channel media could not be duplicated to MAX', error.userMessage ?? error.message);
      }
    }

    const text = cleanRelayedPostText(post) || `Публикация из @${post.channel}`;
    const chunks = splitText(text, 3900);
    const destination = maxChatId
      ? { type: 'chat', id: maxChatId, mode: 'channel-relay' }
      : { type: 'user', id: maxOwnerId, mode: 'private' };
    for (const [index, chunk] of chunks.entries()) {
      await sendToMax(destination, chunk, index === 0 && attachments.length ? { attachments: attachments.slice(0, 10) } : undefined);
    }
    for (let offset = 10; offset < attachments.length; offset += 10) {
      await sendToMax(destination, '\u2063', { attachments: attachments.slice(offset, offset + 10) });
    }
    log.event({ level: 'info', category: 'channel', event: 'channel_post_completed', message: `TGK ${tgkSlot || '?'}: публикация @${post.channel}/${post.id} передана в MAX`, operationId, direction: 'telegram_channel_to_max', stage: 'complete', status: 'completed', progress: 100, durationMs: Date.now() - startedAt, details: { attachments: attachments.length, destination } });
    return true;
  }

  function unknownInboxKeyboard(telegramChatId) {
    return maxKeyboard([
      [{ text: 'Показать ID', payload: `copyid:${telegramChatId}` }, { text: 'Контакт', payload: `contact:${telegramChatId}` }],
      [{ text: 'Скрыть сообщения', payload: `mute:${telegramChatId}`, intent: 'negative' }]
    ]);
  }

  function filteredTelegramMessage(message) {
    if (db.getSetting('censor_enabled') !== 'true') return message;
    return censorTelegramMessage(message, db.getCensorTerms());
  }

  const telegramAlbums = new Map();

  async function forwardTelegramMessageToMax(message, options = {}) {
    if (!message.media_group_id || options.edited) return forwardTelegramMessageNow(message, options);
    const key = `${message.business_connection_id}:${message.chat.id}:${message.media_group_id}`;
    const current = telegramAlbums.get(key) ?? { messages: [], timer: null };
    current.messages.push(message);
    clearTimeout(current.timer);
    current.timer = setTimeout(() => {
      telegramAlbums.delete(key);
      forwardTelegramAlbumToMax(current.messages).catch((error) => log.error('Telegram album forwarding failed', error));
    }, 900);
    telegramAlbums.set(key, current);
  }

  async function forwardTelegramAlbumToMax(messages) {
    const first = messages[0];
    if (!first || !db.getSetting('max_owner_id')) return;
    const operationId = eventStore.operation('tg-album-max');
    const operationStartedAt = Date.now();
    log.event({ level: 'info', category: 'message', event: 'telegram_album_received', message: `Получен альбом Telegram: ${messages.length} элементов`, operationId, direction: 'telegram_to_max', stage: 'receive', status: 'received', progress: 5, details: { telegramChatId: first.chat?.id, mediaGroupId: first.media_group_id, items: messages.length } });
    const isOwnMessage = String(first.from?.id ?? '') === db.getSetting('telegram_owner_id');
    const mirrorMode = db.getSetting('telegram_mirror_mode') ?? 'all';
    if (mirrorMode === 'off' || (mirrorMode === 'mine' && !isOwnMessage) || (mirrorMode === 'others' && isOwnMessage)) return;
    if (db.isTelegramChatMuted(first.chat.id)) return;
    const onlyChatId = db.getSetting('telegram_only_chat_id');
    if (onlyChatId && String(first.chat.id) !== onlyChatId) return;
    const destination = maxDestinationForTelegram(first.chat.id, isOwnMessage);
    if (!destination) {
      log.event({ level: 'warn', category: 'route', event: 'telegram_album_route_missing', message: 'Для альбома Telegram не найден маршрут в MAX', operationId, direction: 'telegram_to_max', stage: 'route', status: 'failed', progress: 100, durationMs: Date.now() - operationStartedAt });
      return;
    }
    log.event({ level: 'info', category: 'route', event: 'telegram_album_route_selected', message: `Выбран маршрут альбома в MAX: ${destination.type}/${destination.mode}`, operationId, direction: 'telegram_to_max', stage: 'route', status: 'running', progress: 15, details: { destination } });

    const displayName = isOwnMessage ? 'Вы' : telegramSenderName(first);
    db.rememberTelegramChat({
      telegramBusinessConnectionId: first.business_connection_id,
      telegramChatId: first.chat.id,
      displayName: isOwnMessage ? ([first.chat?.first_name, first.chat?.last_name].filter(Boolean).join(' ') || `ID ${first.chat.id}`) : telegramSenderName(first),
      username: isOwnMessage ? first.chat?.username : telegramSenderUsername(first)
    });
    const savedChat = db.findTelegramChat(first.chat.id);
    const attachments = [];
    const sources = [];
    for (const message of messages.sort((a, b) => a.message_id - b.message_id)) {
      const source = { telegramBusinessConnectionId: message.business_connection_id, telegramChatId: message.chat.id, telegramMessageId: message.message_id };
      if (db.hasTelegramSource(source)) continue;
      const media = telegramMediaFromMessage(message);
      let historyMedia = null;
      if (media) {
        log.event({ level: 'info', category: 'file', event: 'telegram_album_item_started', message: `Подготовка элемента альбома ${attachments.length + 1}/${messages.length}`, operationId, direction: 'telegram_to_max', stage: 'media', status: 'running', progress: Math.min(70, 20 + Math.round((attachments.length / Math.max(messages.length, 1)) * 45)), details: { mediaLabel: media.label, telegramMessageId: message.message_id } });
        const itemIndex = sources.length;
        const itemSpan = 52 / Math.max(messages.length, 1);
        const itemStart = 20 + itemIndex * itemSpan;
        const itemMid = itemStart + itemSpan * 0.58;
        const itemEnd = itemStart + itemSpan;
        const uploaded = await uploadTelegramMediaToMax({
          telegram,
          maxBot,
          media,
          dataDir: config.dataDir,
          maxBytes: config.telegramDownloadLimitBytes,
          timeoutMs: config.mediaTransferTimeoutMs,
          diskReserveBytes: config.mediaDiskReserveBytes,
          onDownloadProgress: createProgressEmitter({
            log, networkMonitor, operationId, direction: 'telegram_to_max', stage: 'download',
            event: 'telegram_album_download_progress', label: `Альбом ${itemIndex + 1}/${messages.length}: Telegram → сервер`,
            startProgress: itemStart, endProgress: itemMid, networkDirection: 'download', totalBytesHint: media.fileSize
          }),
          onUploadProgress: createProgressEmitter({
            log, networkMonitor, operationId, direction: 'telegram_to_max', stage: 'upload',
            event: 'telegram_album_upload_progress', label: `Альбом ${itemIndex + 1}/${messages.length}: сервер → MAX`,
            startProgress: itemMid, endProgress: itemEnd, networkDirection: 'upload', totalBytesHint: media.fileSize
          }),
          onStage: ({ stage, status, message: stageMessage }) => log.event({
            level: 'info', category: 'file', event: `telegram_album_${stage}_${status}`,
            message: stageMessage, operationId, direction: 'telegram_to_max', stage,
            status: 'running', progress: Math.round(stage === 'convert' ? itemMid : itemStart)
          })
        });
        attachments.push(uploaded.maxAttachment);
        historyMedia = uploaded.historyMedia;
      }
      db.upsertChatMessage({
        telegramChatId: message.chat.id,
        telegramMessageId: message.message_id,
        direction: isOwnMessage ? 'out' : 'in',
        text: message.caption ?? (['стикер', 'GIF', 'видеосообщение'].includes(media?.label) ? media.label[0].toUpperCase() + media.label.slice(1) : ''),
        type: media?.label ?? 'Фото',
        media: historyMedia,
        mediaGroupId: message.media_group_id,
        replyToMessageId: message.reply_to_message?.message_id
        ,forwardedFrom: telegramForwardSource(message)
      });
      sources.push(source);
    }
    if (!sources.length) return;
    const caption = messages.map((message) => filteredTelegramMessage(message).caption).find(Boolean) ?? '';
    const title = isOwnMessage ? 'Вы' : (savedChat?.effectiveName || displayName);
    const inboxDetails = destination.mode === 'inbox'
      ? [
          `ID: ${first.chat.id}`,
          `Имя: ${title}`,
          telegramSenderUsername(first) ? `Username: @${telegramSenderUsername(first)}` : ''
        ].filter(Boolean)
      : [title];
    const rawText = destination.mode === 'dedicated'
      ? formatTelegramAlbumContentOnly(messages.map(filteredTelegramMessage))
      : [...inboxDetails, `Альбом · ${attachments.length} файла`, caption].filter(Boolean).join('\n');
    const forwardedMessage = messages.find((message) => telegramForwardSource(message));
    const forwardedFrom = forwardedMessage ? telegramForwardSource(forwardedMessage) : null;
    const formattedForward = formatMaxForwardNote(
      rawText,
      forwardedFrom,
      destination?.type,
      forwardedMessage ? telegramForwardSourceType(forwardedMessage) : null
    );
    const maxAttachments = destination.mode === 'inbox' && attachments.length < 10
      ? [...attachments, unknownInboxKeyboard(first.chat.id)]
      : attachments;
    log.event({ level: 'info', category: 'message', event: 'telegram_album_send_started', message: `Отправка альбома в MAX: ${attachments.length} вложений`, operationId, direction: 'telegram_to_max', stage: 'send', status: 'running', progress: 85, details: { destination, attachments: attachments.length } });
    const sent = await sendToMax(destination, formattedForward.text, {
      attachments: maxAttachments,
      ...(formattedForward.format ? { format: formattedForward.format } : {})
    });
    for (const source of sources) db.insertMessageLink({ ...source, maxMessageId: sent.body.mid });
    log.event({ level: 'info', category: 'message', event: 'telegram_album_completed', message: 'Альбом Telegram передан в MAX', operationId, direction: 'telegram_to_max', stage: 'complete', status: 'completed', progress: 100, durationMs: Date.now() - operationStartedAt, details: { attachments: attachments.length, maxMessageId: sent.body.mid } });
    log.info('Telegram album forwarded to MAX');
  }

  async function forwardTelegramMessageNow(message, { edited = false } = {}) {
    const operationId = eventStore.operation('tg-max');
    const operationStartedAt = Date.now();
    log.event({
      level: 'info', category: 'message', event: 'telegram_message_received',
      message: edited ? 'Получено изменённое сообщение Telegram' : 'Получено сообщение Telegram',
      operationId, direction: 'telegram_to_max', stage: 'receive', status: 'received', progress: 5,
      details: eventStore.messageDetails({
        text: message.text ?? message.caption ?? '',
        telegramChatId: message.chat?.id,
        telegramMessageId: message.message_id,
        businessConnectionId: message.business_connection_id,
        mediaGroupId: message.media_group_id,
        edited
      })
    });
    const maxOwnerId = db.getSetting('max_owner_id');
    if (!maxOwnerId) {
      log.warn('Telegram message skipped because MAX is not paired yet');
      return;
    }

    const source = {
      telegramBusinessConnectionId: message.business_connection_id,
      telegramChatId: message.chat.id,
      telegramMessageId: message.message_id
    };
    const isOwnMessage = String(message.from?.id ?? '') === db.getSetting('telegram_owner_id');
    const mirrorMode = db.getSetting('telegram_mirror_mode') ?? 'all';
    if (
      mirrorMode === 'off' ||
      (mirrorMode === 'mine' && !isOwnMessage) ||
      (mirrorMode === 'others' && isOwnMessage)
    ) return;
    if (!edited && db.hasTelegramSource(source)) return;
    if (edited) {
      const oldMaxMessageIds = db.findMaxMessageIdsForTelegramSource(source);
      for (const maxMessageId of oldMaxMessageIds) {
        try {
          await maxBot.api.deleteMessage(maxMessageId);
        } catch (error) {
          log.warn('Could not delete old edited message from MAX', error.message);
        }
      }
      db.deleteMessageLinksForTelegramSource(source);
    }

    const displayName = isOwnMessage
      ? [message.chat?.first_name, message.chat?.last_name].filter(Boolean).join(' ') || `ID ${source.telegramChatId}`
      : telegramSenderName(message);
    const username = isOwnMessage ? message.chat?.username : telegramSenderUsername(message);
    if (!isOwnMessage || !db.findTelegramChat(source.telegramChatId)) {
      db.rememberTelegramChat({
        telegramBusinessConnectionId: source.telegramBusinessConnectionId,
        telegramChatId: source.telegramChatId,
        displayName,
        username
      });
    }
    const savedChat = db.findTelegramChat(source.telegramChatId);

    const onlyChatId = db.getSetting('telegram_only_chat_id');
    if (onlyChatId && String(source.telegramChatId) !== onlyChatId) {
      log.info('Telegram message skipped by only-filter');
      return;
    }
    if (db.isTelegramChatMuted(source.telegramChatId)) {
      log.info('Telegram message skipped because chat is muted');
      return;
    }
    const destination = maxDestinationForTelegram(source.telegramChatId, isOwnMessage);
    if (!destination) {
      log.event({ level: 'warn', category: 'route', event: 'telegram_route_missing', message: 'Для Telegram-сообщения не найден маршрут в MAX', operationId, direction: 'telegram_to_max', stage: 'route', status: 'failed', progress: 100, durationMs: Date.now() - operationStartedAt, details: { telegramChatId: source.telegramChatId } });
      return;
    }
    log.event({ level: 'info', category: 'route', event: 'telegram_route_selected', message: `Выбран маршрут в MAX: ${destination.type}/${destination.mode}`, operationId, direction: 'telegram_to_max', stage: 'route', status: 'running', progress: 20, details: { destination } });

    const media = telegramMediaFromMessage(message);
    let attachment;
    let historyMedia;
    let transferProblem;
    if (media) {
      const speedSnapshot = networkMonitor.snapshot();
      const estimate = media.fileSize ? estimateTransferTime(media.fileSize, speedSnapshot) : {};
      log.event({ level: 'info', category: 'file', event: 'telegram_media_transfer_started', message: estimate.totalSeconds
        ? `Начата передача ${media.label || media.kind || 'файла'} · ориентировочно ${formatEta(estimate.totalSeconds)}`
        : `Начата передача ${media.label || media.kind || 'файла'}`, operationId, direction: 'telegram_to_max', stage: 'prepare', status: 'running', progress: 22, details: { media: { label: media.label, kind: media.kind, fileName: media.fileName, fileSize: media.fileSize }, speedSnapshot, estimate } });
      const downloadProgress = createProgressEmitter({
        log, networkMonitor, operationId, direction: 'telegram_to_max', stage: 'download',
        event: 'telegram_media_download_progress', label: 'Telegram → сервер',
        startProgress: 24, endProgress: 52, networkDirection: 'download', totalBytesHint: media.fileSize
      });
      const uploadProgress = createProgressEmitter({
        log, networkMonitor, operationId, direction: 'telegram_to_max', stage: 'upload',
        event: 'max_media_upload_progress', label: 'Сервер → MAX',
        startProgress: 58, endProgress: 78, networkDirection: 'upload', totalBytesHint: media.fileSize
      });
      try {
        const uploaded = await uploadTelegramMediaToMax({
          telegram,
          maxBot,
          media,
          dataDir: config.dataDir,
          maxBytes: config.telegramDownloadLimitBytes,
          timeoutMs: config.mediaTransferTimeoutMs,
          diskReserveBytes: config.mediaDiskReserveBytes,
          onDownloadProgress: downloadProgress,
          onUploadProgress: uploadProgress,
          onStage: ({ stage, status, message: stageMessage }) => log.event({
            level: 'info', category: 'file', event: `telegram_media_${stage}_${status}`,
            message: stageMessage, operationId, direction: 'telegram_to_max', stage,
            status: 'running', progress: stage === 'convert' ? (status === 'started' ? 54 : 57) : (status === 'completed' ? 53 : 24)
          })
        });
        attachment = uploaded.maxAttachment;
        historyMedia = uploaded.historyMedia;
        log.event({ level: 'info', category: 'file', event: 'telegram_media_prepared', message: 'Вложение Telegram полностью подготовлено для отправки в MAX', operationId, direction: 'telegram_to_max', stage: 'media', status: 'running', progress: 79, details: { historyMedia } });
      } catch (error) {
        transferProblem = error.userMessage ?? error.message;
        log.event({ level: 'error', category: 'file', event: 'telegram_media_transfer_failed', message: `Не удалось передать вложение Telegram: ${transferProblem}`, operationId, direction: 'telegram_to_max', stage: 'media', status: 'failed', progress: 100, durationMs: Date.now() - operationStartedAt, details: { error } });
        log.warn('Telegram media transfer failed', `${transferProblem}: ${error.cause?.message ?? ''}`);
      }
    }

    const formattedMessage = filteredTelegramMessage(message);
    const formatted = formatTelegramForMax(formattedMessage, {
      displayName: isOwnMessage ? 'Вы' : (savedChat?.effectiveName || displayName),
      includeUsername: destination.mode === 'inbox',
      contentOnly: destination.mode === 'dedicated'
    });
    db.upsertChatMessage({
      telegramChatId: source.telegramChatId,
      telegramMessageId: source.telegramMessageId,
      direction: isOwnMessage ? 'out' : 'in',
      text: message.text ?? message.caption ?? (['стикер', 'GIF', 'видеосообщение'].includes(media?.label) ? media.label[0].toUpperCase() + media.label.slice(1) : ''),
      type: media?.label ?? (media ? 'Вложение' : 'Текст'),
      media: historyMedia,
      mediaGroupId: message.media_group_id,
      replyToMessageId: message.reply_to_message?.message_id,
      forwardedFrom: telegramForwardSource(message),
      edited
    });
    const baseText = transferProblem
      ? `${formatted}\n\n[Файл не передан: ${transferProblem}]`
      : formatted;
    const editedText = edited ? `${baseText}\n\nИзменено` : baseText;
    const forwardedFrom = telegramForwardSource(message);
    const rawChunks = splitText(editedText, forwardedFrom ? 3600 : 3900);
    const chunks = rawChunks.map((chunk, index) => (
      index === rawChunks.length - 1
        ? formatMaxForwardNote(chunk, forwardedFrom, destination?.type, telegramForwardSourceType(message))
        : { text: chunk, format: undefined }
    ));
    log.event({ level: 'info', category: 'message', event: 'max_send_started', message: `Отправка в MAX (${chunks.length} часть/частей)`, operationId, direction: 'telegram_to_max', stage: 'send', status: 'running', progress: 80, details: { destination, chunks: chunks.length, hasAttachment: Boolean(attachment) } });
    for (const [index, outgoing] of chunks.entries()) {
      const chunk = outgoing.text;
      const maxAttachments = [];
      if (index === 0 && attachment) maxAttachments.push(attachment);
      if (index === 0 && destination.mode === 'inbox') maxAttachments.push(unknownInboxKeyboard(source.telegramChatId));
      const extra = (maxAttachments.length || outgoing.format)
        ? {
            ...(maxAttachments.length ? { attachments: maxAttachments } : {}),
            ...(outgoing.format ? { format: outgoing.format } : {})
          }
        : undefined;
      try {
        const maxMessage = await sendToMax(destination, chunk, extra);
        db.insertMessageLink({ ...source, maxMessageId: maxMessage.body.mid });
      } catch (error) {
        if (!attachment || index !== 0) throw error;
        log.warn('MAX rejected uploaded media', error.message);
        const fallbackExtra = {
          ...(destination.mode === 'inbox' ? { attachments: [unknownInboxKeyboard(source.telegramChatId)] } : {}),
          ...(outgoing.format ? { format: outgoing.format } : {})
        };
        const fallbackMessage = await sendToMax(destination, chunk, fallbackExtra);
        db.insertMessageLink({ ...source, maxMessageId: fallbackMessage.body.mid });
        const safeReason = String(error?.message || 'MAX отклонил загруженный файл').replace(/[\r\n]+/g, ' ').slice(0, 500);
        const noticeMessage = await sendToMax(destination, `[Вложение не передано: ${safeReason}]`);
        db.insertMessageLink({ ...source, maxMessageId: noticeMessage.body.mid });
        attachment = undefined;
      }
    }

    db.pruneMessageLinks(Date.now() - config.messageLinkTtlDays * 86_400_000);
    log.event({ level: 'info', category: 'message', event: 'telegram_to_max_completed', message: media && attachment ? 'Сообщение и вложение переданы из Telegram в MAX' : 'Сообщение передано из Telegram в MAX', operationId, direction: 'telegram_to_max', stage: 'complete', status: 'completed', progress: 100, durationMs: Date.now() - operationStartedAt, details: { telegramChatId: source.telegramChatId, telegramMessageId: source.telegramMessageId, destination } });
    log.info(media && attachment ? 'Telegram message and media forwarded to MAX' : 'Telegram message forwarded to MAX');
  }

  async function sendTelegramText(target, text) {
    for (const chunk of splitText(text, 4000)) {
      const sentMessage = await telegram.sendBusinessText({
        businessConnectionId: target.telegramBusinessConnectionId,
        chatId: target.telegramChatId,
        text: chunk,
        replyToMessageId: target.telegramMessageId
      });
      db.insertChatMessage({
        telegramChatId: target.telegramChatId,
        telegramMessageId: sentMessage.message_id,
        direction: 'out',
        text: chunk,
        type: 'Текст',
        replyToMessageId: target.telegramMessageId
      });
    }
  }

  app.post('/api/chats/:chatId/messages', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const chat = db.findTelegramChat(request.params.chatId);
    if (!chat) return reply.code(404).send({ error: 'Чат не найден' });
    const text = String(request.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'Напиши сообщение' });
    const target = targetFromChat(chat);
    const replyToMessageId = Number(request.body?.replyToMessageId);
    if (Number.isInteger(replyToMessageId) && replyToMessageId > 0) target.telegramMessageId = replyToMessageId;
    await sendTelegramText(target, text);
    return { ok: true };
  });

  app.patch('/api/messages/:messageId', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const message = db.findChatMessage(request.params.messageId);
    if (!message) return reply.code(404).send({ error: 'Сообщение не найдено' });
    const chat = db.findTelegramChat(message.telegramChatId);
    const action = request.body?.action;
    if (action === 'pin') {
      return { message: db.updateChatMessage(message.id, { pinned: !Boolean(message.pinned) }) };
    }
    if (action === 'reaction') {
      return { message: db.updateChatMessage(message.id, { reaction: String(request.body?.reaction ?? '') }) };
    }
    if (action === 'edit') {
      const text = String(request.body?.text ?? '').trim();
      if (message.direction !== 'out' || !message.telegramMessageId || !text) {
        return reply.code(400).send({ error: 'Редактировать можно только своё текстовое сообщение' });
      }
      await telegram.editBusinessText({
        businessConnectionId: chat.telegramBusinessConnectionId,
        chatId: chat.telegramChatId,
        messageId: message.telegramMessageId,
        text
      });
      return { message: db.updateChatMessage(message.id, { text, edited: true }) };
    }
    return reply.code(400).send({ error: 'Неизвестное действие' });
  });

  app.delete('/api/messages/:messageId', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const message = db.findChatMessage(request.params.messageId);
    if (!message) return reply.code(404).send({ error: 'Сообщение не найдено' });
    const chat = db.findTelegramChat(message.telegramChatId);
    if (message.telegramMessageId) {
      await telegram.deleteBusinessMessages({
        businessConnectionId: chat.telegramBusinessConnectionId,
        messageIds: [message.telegramMessageId]
      });
    }
    db.updateChatMessage(message.id, { deleted: true });
    return { ok: true };
  });

  app.post('/api/messages/:messageId/forward', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const message = db.findChatMessage(request.params.messageId);
    const targetChat = db.findTelegramChat(request.body?.targetChatId);
    if (!message || !targetChat) return reply.code(404).send({ error: 'Сообщение или чат не найден' });
    if (message.media) {
      const mimeType = message.media.mimeType || 'application/octet-stream';
      const telegramKind = mimeType === 'image/gif'
        ? 'animation'
        : message.media.kind === 'image' ? 'photo'
          : message.media.kind === 'voice' ? 'voice'
            : ['video', 'audio'].includes(message.media.kind) ? message.media.kind : 'document';
      const sentMessage = await telegram.sendBusinessMedia({
        businessConnectionId: targetChat.telegramBusinessConnectionId,
        chatId: targetChat.telegramChatId,
        telegramKind,
        filePath: join(config.dataDir, 'history', message.media.storedName),
        fileName: message.media.fileName,
        contentType: mimeType,
        caption: message.text
      });
      db.insertChatMessage({
        telegramChatId: targetChat.telegramChatId,
        telegramMessageId: sentMessage.message_id,
        direction: 'out',
        text: message.text,
        type: message.type,
        media: message.media
      });
    } else if (message.text) {
      await sendTelegramText(targetFromChat(targetChat), message.text);
    }
    return { ok: true };
  });

  app.post('/api/chats/:chatId/media', async (request, reply) => {
    if (!panelAuthorized(request)) return reply.code(401).send({ error: 'Неверный код доступа' });
    const chat = db.findTelegramChat(request.params.chatId);
    if (!chat) return reply.code(404).send({ error: 'Чат не найден' });
    let uploaded;
    try {
      uploaded = await receivePanelFile(request);
      const requestedKind = String(uploaded.fields?.kind?.value ?? 'auto');
      const caption = String(uploaded.fields?.caption?.value ?? '').trim();
      const mimeType = uploaded.mimeType || 'application/octet-stream';
      let telegramKind = requestedKind;
      if (telegramKind === 'auto') {
        if (mimeType === 'image/gif') telegramKind = 'animation';
        else if (mimeType.startsWith('image/')) telegramKind = 'photo';
        else if (mimeType.startsWith('video/')) telegramKind = 'video';
        else if (mimeType.startsWith('audio/')) telegramKind = 'audio';
        else telegramKind = 'document';
      }

      let sendPath = uploaded.filePath;
      let sendName = uploaded.fileName;
      let sendMimeType = mimeType;
      if (telegramKind === 'voice') {
        const voicePath = join(uploaded.directory, 'voice.ogg');
        await makeVoiceMessage(uploaded.filePath, voicePath);
        sendPath = voicePath;
        sendName = 'voice.ogg';
        sendMimeType = 'audio/ogg';
      }

      const sentMessage = await telegram.sendBusinessMedia({
        businessConnectionId: chat.telegramBusinessConnectionId,
        chatId: chat.telegramChatId,
        telegramKind,
        filePath: sendPath,
        fileName: sendName,
        contentType: sendMimeType,
        caption
      });
      const historyMedia = await archiveMediaFile({
        filePath: sendPath,
        fileName: sendName,
        mimeType: sendMimeType,
        kind: ['photo', 'animation'].includes(telegramKind) ? 'image' : telegramKind,
        dataDir: config.dataDir,
        move: true
      });
      db.insertChatMessage({
        telegramChatId: chat.telegramChatId,
        telegramMessageId: sentMessage.message_id,
        direction: 'out',
        text: caption,
        type: telegramKind === 'voice' ? 'Голосовое сообщение' : telegramKind,
        media: historyMedia
      });
      return { ok: true };
    } catch (error) {
      log.warn('Panel media upload failed', error.message);
      return reply.code(400).send({ error: error.message || 'Не удалось отправить файл' });
    } finally {
      if (uploaded?.directory) await rm(uploaded.directory, { recursive: true, force: true });
    }
  });

  function targetFromChat(chat) {
    if (!chat) return undefined;
    return {
      telegramBusinessConnectionId: chat.telegramBusinessConnectionId,
      telegramChatId: chat.telegramChatId,
      telegramMessageId: undefined
    };
  }

  async function sendMaxMainMenu(userId) {
    const mirrorMode = db.getSetting('telegram_mirror_mode') ?? 'all';
    const activeChatId = db.getSetting('telegram_active_chat_id');
    const activeChat = activeChatId ? db.findTelegramChat(activeChatId) : undefined;
    const limit = Number(db.getSetting('chat_history_limit')) || 5000;
    const lines = [
      'Управление Telegram прямо из MAX',
      '',
      `Активный чат: ${activeChat ? `${activeChat.effectiveName} (${activeChat.telegramChatId})` : 'выключен'}`,
      `Зеркалирование: ${MIRROR_MODES[mirrorMode] ?? MIRROR_MODES.all}`,
      `Цензура: ${db.getSetting('censor_enabled') === 'true' ? 'включена' : 'выключена'}`,
      `Лимит локальной истории: ${limit}`
    ];
    await maxBot.api.sendMessageToUser(userId, lines.join('\n'), {
      attachments: [maxKeyboard([
        [{ text: 'Все контакты', payload: 'contacts:page:0', intent: 'positive' }],
        [{ text: 'Выбрать активный чат', payload: 'chat:prompt' }],
        [{ text: 'Отключить активный чат', payload: 'chat:off', intent: 'negative' }],
        [{ text: 'Зеркалирование', payload: 'menu:mirror' }, { text: 'Фильтры', payload: 'menu:filters' }],
        [{ text: 'Цензура слов', payload: 'menu:censor' }, { text: 'Группы', payload: 'menu:groups' }],
        [{ text: 'TGK 1–3', payload: 'menu:news' }],
        [{ text: 'Лимит истории', payload: 'menu:limit' }, { text: 'Справка', payload: 'menu:help' }],
        [{ text: '🗑 Удалить меню', payload: 'message:delete', intent: 'negative' }]
      ])]
    });
  }

  async function sendMaxMirrorMenu(userId) {
    const mode = db.getSetting('telegram_mirror_mode') ?? 'all';
    await maxBot.api.sendMessageToUser(userId, `Сейчас: ${MIRROR_MODES[mode] ?? MIRROR_MODES.all}.\nВыбери, какие сообщения копировать из Telegram в MAX:`, {
      attachments: [maxKeyboard([
        [{ text: `${mode === 'all' ? '✓ ' : ''}Все`, payload: 'mirror:all', intent: 'positive' }],
        [{ text: `${mode === 'mine' ? '✓ ' : ''}Только мои`, payload: 'mirror:mine' }],
        [{ text: `${mode === 'others' ? '✓ ' : ''}Только собеседников`, payload: 'mirror:others' }],
        [{ text: `${mode === 'off' ? '✓ ' : ''}Выключить`, payload: 'mirror:off', intent: 'negative' }],
        [{ text: '← Главное меню', payload: 'menu:main' }],
        [{ text: '🗑 Удалить', payload: 'message:delete', intent: 'negative' }]
      ])]
    });
  }

  async function sendMaxContactsMenu(userId, requestedPage = 0) {
    const chats = db.listTelegramChats(10000);
    if (!chats.length) {
      await maxBot.api.sendMessageToUser(userId, 'Пока нет сохранённых Telegram-контактов. Они появятся после новых сообщений.', {
        attachments: [maxKeyboard([
          [{ text: '← Главное меню', payload: 'menu:main' }],
          [{ text: '🗑 Удалить', payload: 'message:delete', intent: 'negative' }]
        ])]
      });
      return;
    }
    const pageSize = 8;
    const pages = Math.max(1, Math.ceil(chats.length / pageSize));
    const page = Math.max(0, Math.min(Number(requestedPage) || 0, pages - 1));
    const rows = chats.slice(page * pageSize, (page + 1) * pageSize).map((chat) => [{
      text: `${chat.muted ? '🔇 ' : ''}${chat.effectiveName} · ${chat.telegramChatId}`,
      payload: `contact:${chat.telegramChatId}`
    }]);
    if (pages > 1) {
      const navigation = [];
      if (page > 0) navigation.push({ text: '← Назад', payload: `contacts:page:${page - 1}` });
      if (page < pages - 1) navigation.push({ text: 'Дальше →', payload: `contacts:page:${page + 1}` });
      rows.push(navigation);
    }
    rows.push([{ text: '← Главное меню', payload: 'menu:main' }]);
    rows.push([{ text: '🗑 Удалить список', payload: 'message:delete', intent: 'negative' }]);
    await maxBot.api.sendMessageToUser(userId, `Все Telegram-контакты · страница ${page + 1}/${pages}:`, {
      attachments: [maxKeyboard(rows)]
    });
  }

  async function sendMaxContactMenu(userId, telegramChatId) {
    const chat = db.findTelegramChat(telegramChatId);
    if (!chat) {
      await maxBot.api.sendMessageToUser(userId, 'Контакт не найден. Обнови список контактов.');
      return;
    }
    const active = db.getSetting('telegram_active_chat_id') === chat.telegramChatId;
    const only = db.getSetting('telegram_only_chat_id') === chat.telegramChatId;
    await maxBot.api.sendMessageToUser(userId, [
      chat.effectiveName,
      `ID: ${chat.telegramChatId}`,
      chat.username ? `Username: @${chat.username}` : '',
      chat.customName ? `Имя в Telegram: ${chat.displayName}` : '',
      '',
      'Чтобы переименовать: /name ID Новое имя'
    ].filter(Boolean).join('\n'), {
      attachments: [maxKeyboard([
        [{ text: 'Показать ID для копирования', payload: `copyid:${chat.telegramChatId}` }],
        [{ text: active ? '✓ Активный чат' : 'Писать этому человеку', payload: `chat:set:${chat.telegramChatId}`, intent: 'positive' }],
        [{ text: only ? '✓ Принимать только его' : 'Принимать только его', payload: `only:set:${chat.telegramChatId}` }],
        [{ text: chat.muted ? 'Показывать сообщения' : 'Скрыть сообщения', payload: `${chat.muted ? 'unmute' : 'mute'}:${chat.telegramChatId}` }],
        [{ text: 'Очистить локальную историю', payload: `clear:ask:${chat.telegramChatId}`, intent: 'negative' }],
        [{ text: '← Все контакты', payload: 'contacts:page:0' }],
        [{ text: '🗑 Удалить', payload: 'message:delete', intent: 'negative' }]
      ])]
    });
  }

  async function sendMaxLimitMenu(userId) {
    const limit = Number(db.getSetting('chat_history_limit')) || 5000;
    await maxBot.api.sendMessageToUser(userId, `Текущий лимит локальной истории: ${limit}.\nСообщения удаляются только из мини-приложения/локальной базы, а не из Telegram.`, {
      attachments: [maxKeyboard([
        [50, 500].map((value) => ({ text: `${value === limit ? '✓ ' : ''}${value}`, payload: `limit:${value}` })),
        [1000, 5000].map((value) => ({ text: `${value === limit ? '✓ ' : ''}${value}`, payload: `limit:${value}` })),
        [{ text: `${limit === 10000 ? '✓ ' : ''}10000`, payload: 'limit:10000' }],
        [{ text: 'Другое число: /limit ЧИСЛО', payload: 'hint:limit' }],
        [{ text: '← Главное меню', payload: 'menu:main' }],
        [{ text: '🗑 Удалить', payload: 'message:delete', intent: 'negative' }]
      ])]
    });
  }

  function maxCensorStatusText() {
    const enabled = db.getSetting('censor_enabled') === 'true';
    const terms = db.getCensorTerms();
    return [
      `Цензура: ${enabled ? 'включена' : 'выключена'}.`,
      `Запрещённых слов и фраз: ${terms.length}.`,
      '',
      '/censor add слово или фраза',
      '/censor del слово или фраза',
      '/censor list',
      '/censor clear'
    ].join('\n');
  }

  async function sendMaxCensorMenu(userId) {
    const enabled = db.getSetting('censor_enabled') === 'true';
    await maxBot.api.sendMessageToUser(userId, maxCensorStatusText(), {
      attachments: [maxKeyboard([
        [{ text: `${enabled ? '✓ ' : ''}Включить`, payload: 'censor:on', intent: 'positive' }],
        [{ text: `${!enabled ? '✓ ' : ''}Выключить`, payload: 'censor:off', intent: 'negative' }],
        [{ text: 'Показать список', payload: 'censor:list' }],
        [{ text: '← Главное меню', payload: 'menu:main' }],
        [{ text: '🗑 Удалить', payload: 'message:delete', intent: 'negative' }]
      ])]
    });
  }

  async function sendMaxGroupsStatus(userId) {
    const bindings = db.getMaxGroupBindings();
    const lines = Object.entries(bindings).map(([groupId, telegramChatId], index) => {
      const chat = db.findTelegramChat(telegramChatId);
      return `${index + 1}. ${chat?.effectiveName ?? 'Контакт'} (${telegramChatId}) → группа ${groupId}`;
    });
    await maxBot.api.sendMessageToUser(userId, [
      'Группы-копии Telegram-чатов',
      '',
      ...(lines.length ? lines : ['Отдельных групп пока нет.']),
      '',
      `Группа неизвестных: ${db.getUnknownInboxMaxChatId() ?? 'не назначена'}`,
      '',
      'В нужной MAX-группе напиши /link TELEGRAM_ID.',
      'Для общей группы неизвестных напиши в ней /inbox set.'
    ].join('\n'), {
      attachments: [maxKeyboard([
        [{ text: '← Главное меню', payload: 'menu:main' }],
        [{ text: '🗑 Удалить', payload: 'message:delete', intent: 'negative' }]
      ])]
    });
  }

  async function sendMaxNewsStatus(userId) {
    const status = channelRelay.status();
    await maxBot.api.sendMessageToUser(userId, [
      `TGK: ${status.enabled ? 'включён' : 'выключен'}`,
      '',
      ...status.slots.map((item) => item.url
        ? `TGK ${item.slot}: ${item.url}\n→ ${item.targetMaxTitle || item.targetMaxChatId || 'этот личный чат'}${item.lastError ? `\nОшибка: ${item.lastError}` : ''}`
        : `TGK ${item.slot}: не настроен`),
      '',
      'Ссылки задаются в основном Telegram-боте:',
      '/tgk add https://t.me/channel_name',
      '/tgk 1 https://t.me/channel_name',
      '',
      'Чтобы направить слот в MAX-группу, напиши внутри неё:',
      '/tgk 1 here',
      '',
      'Вернуть слот в личный чат:',
      '/tgk 1 dm'
    ].join('\n'), {
      attachments: [maxKeyboard([
        [{ text: '← Главное меню', payload: 'menu:main' }],
        [{ text: '🗑 Удалить', payload: 'message:delete', intent: 'negative' }]
      ])]
    });
  }

  async function deleteMaxMessageBestEffort(messageId) {
    if (!messageId) return false;
    try {
      await maxBot.api.deleteMessage(String(messageId));
      return true;
    } catch (error) {
      log.warn('Could not delete temporary MAX message', error.message);
      return false;
    }
  }

  async function handleMaxMessage(message) {
    if (!message) return handleMaxMessageScoped(message);
    const senderId = message.sender?.user_id;
    if (!senderId || message.sender?.is_bot) return;
    let accountId = db.findAccountByMaxOwner(senderId);
    const text = message.body?.text?.trim() ?? '';
    if (!accountId) {
      const pairing = pairMaxAccount({ db, senderId, text });
      if (pairing.status === 'paired') {
        accountId = pairing.accountId;
        if (accountId) {
          await db.runAsAccount(accountId, async () => {
            await maxBot.api.sendMessageToUser(senderId, [
              'MAX-аккаунт привязан к твоему Telegram-профилю.',
              'Теперь отвечай реплаем на сообщения из Telegram или открой /menu.'
            ].join('\n'));
          });
          log.event({ level: 'info', category: 'account', event: 'max_account_paired', message: 'MAX-аккаунт привязан к Telegram-профилю', accountId, stage: 'onboarding', status: 'completed', progress: 100, details: { maxOwnerId: senderId } });
          log.info('MAX account paired', accountId);
          return;
        }
      }
      if (pairing.status !== 'not-bind') {
        await maxBot.api.sendMessageToUser(senderId, 'Код не найден или уже использован. Возьми личный код в Telegram после команды /bind КОД_СЕРВЕРА.');
        return;
      }
      await maxBot.api.sendMessageToUser(senderId, 'Сначала зарегистрируйся в Telegram-боте командой /bind КОД_СЕРВЕРА, затем пришли сюда выданный личный код.');
      return;
    }
    return db.runAsAccount(accountId, () => handleMaxMessageScoped(message));
  }

  async function handleMaxMessageScoped(message) {
    if (!message) {
      log.warn('MAX sent an empty message update');
      return;
    }
    const senderId = message.sender?.user_id;
    if (!senderId || message.sender?.is_bot) return;

    const text = message.body?.text?.trim() ?? '';
    const savedOwnerId = db.getSetting('max_owner_id');
    const recipientChatId = message.recipient?.chat_id;
    const isGroup = message.recipient?.chat_type === 'chat' && recipientChatId !== null && recipientChatId !== undefined;
    const isChannel = message.recipient?.chat_type === 'channel' && recipientChatId !== null && recipientChatId !== undefined;
    const isSharedChat = isGroup || isChannel;
    const maxOperationId = eventStore.operation('max-tg');
    const maxOperationStartedAt = Date.now();
    log.event({
      level: 'info', category: 'message', event: 'max_message_received', message: 'Получено сообщение MAX',
      operationId: maxOperationId, direction: 'max_to_telegram', stage: 'receive', status: 'received', progress: 5,
      details: eventStore.messageDetails({ text, senderId, recipientChatId, chatType: message.recipient?.chat_type, maxMessageId: message.body?.mid, attachmentTypes: (message.body?.attachments ?? []).map((item) => item.type) })
    });
    const respond = (responseText, extra) => isSharedChat
      ? maxBot.api.sendMessageToChat(Number(recipientChatId), responseText, extra)
      : maxBot.api.sendMessageToUser(Number(senderId), responseText, extra);

    if (!savedOwnerId) {
      await maxBot.api.sendMessageToUser(senderId, 'Сначала получи личный код в Telegram-боте командой /bind КОД_СЕРВЕРА, затем отправь этот личный код сюда.');
      return;
    }

    if (String(senderId) !== savedOwnerId) {
      log.warn('Ignored MAX message from an unpaired account');
      return;
    }

    async function handleCensorCommand(argument) {
      const match = String(argument ?? '').match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const action = (match?.[1] ?? '').toLowerCase();
      const value = (match?.[2] ?? '').trim();
      if (!action) {
        if (isGroup) await respond(maxCensorStatusText());
        else await sendMaxCensorMenu(senderId);
        return true;
      }
      if (action === 'on' || action === 'off') {
        db.setSetting('censor_enabled', action === 'on' ? 'true' : 'false');
        await respond(action === 'on' ? 'Цензура включена.' : 'Цензура выключена.');
        return true;
      }
      if (action === 'add') {
        if (!value) await respond('Напиши слово или фразу после add. Например: /censor add запрещённая фраза');
        else await respond(db.addCensorTerm(value) ? `Добавлено: ${value}` : 'Такая фраза уже есть в списке.');
        return true;
      }
      if (['del', 'delete', 'remove'].includes(action)) {
        if (!value) await respond('Напиши слово или фразу, которую нужно удалить.');
        else await respond(db.deleteCensorTerm(value) ? `Удалено: ${value}` : 'Такой фразы нет в списке.');
        return true;
      }
      if (action === 'clear') {
        await respond(`Список очищен. Удалено записей: ${db.clearCensorTerms()}.`);
        return true;
      }
      if (action === 'list') {
        const terms = db.getCensorTerms();
        await respond(terms.length
          ? `Запрещённые слова и фразы:\n${terms.map((term, index) => `${index + 1}. ${term}`).join('\n')}`
          : 'Список запрещённых слов и фраз пуст.');
        return true;
      }
      await respond('Допустимые команды: /censor on, off, add, del, list или clear.');
      return true;
    }

    if (isSharedChat && text.startsWith('/')) {
      const { command, argument } = parseCommandText(text);
      if (command === '/tgk') {
        const parts = String(argument || '').trim().split(/\s+/).filter(Boolean);
        const slot = Number(parts[0]);
        const action = String(parts[1] || 'here').toLowerCase();
        if (![1, 2, 3].includes(slot)) {
          await respond('Укажи номер: /tgk 1 here, /tgk 2 here или /tgk 3 here');
          return;
        }
        if (['off', 'dm', 'private'].includes(action)) {
          const current = channelRelay.getSlot(slot);
          if (current.targetMaxChatId === String(recipientChatId)) channelRelay.setSlotTarget(slot);
          await respond(`TGK ${slot} снова будет приходить в личный чат с MAX-ботом.`);
          return;
        }
        let chat;
        try { chat = await maxBot.api.getChat(Number(recipientChatId)); } catch { chat = undefined; }
        const claimed = channelRelay.setSlotTarget(slot, {
          maxChatId: recipientChatId,
          title: chat?.title || (isChannel ? 'MAX-канал' : 'MAX-группа'),
          type: chat?.type || message.recipient?.chat_type || 'chat'
        });
        await respond(claimed
          ? `Готово. TGK ${slot} будет приходить сюда.`
          : 'Эта MAX-группа или канал уже назначены другому профилю сервера.');
        return;
      }

      if (!isGroup) {
        if (command === '/help' || command === '/start') {
          await respond('/tgk 1 here — направить TGK 1 сюда\n/tgk 1 dm — вернуть TGK 1 в личный чат');
        }
        return;
      }
      if (command === '/link') {
        if (!/^\d+$/.test(argument) || !db.findTelegramChat(argument)) {
          await respond('Напиши существующий Telegram ID: /link 123456789. ID можно скопировать из группы неизвестных или списка /contacts в личном чате с ботом.');
          return;
        }
        const chat = db.findTelegramChat(argument);
        const binding = db.bindMaxGroup(recipientChatId, chat.telegramChatId);
        log.event({ level: binding ? 'info' : 'warn', category: 'route', event: binding ? 'max_group_bound' : 'max_group_bind_rejected', message: binding ? 'MAX-группа привязана к Telegram-контакту' : 'Привязка MAX-группы отклонена', stage: 'configuration', status: binding ? 'completed' : 'failed', progress: 100, details: { maxChatId: recipientChatId, telegramChatId: chat.telegramChatId } });
        await respond(binding
          ? `Группа привязана к ${chat.effectiveName} (${chat.telegramChatId}). Теперь входящие сообщения этого человека будут приходить сюда, а обычные сообщения из этой группы — уходить ему в Telegram.`
          : 'Эта MAX-группа уже назначена другому профилю сервера. Один MAX-чат нельзя использовать для двух пользователей.');
        return;
      }
      if (command === '/unlink') {
        const removed = db.unbindMaxGroup(recipientChatId);
        await respond(removed ? `Привязка к Telegram ID ${removed.telegramChatId} удалена.` : 'Эта группа не была привязана к отдельному контакту.');
        return;
      }
      if (command === '/inbox') {
        const action = argument.toLowerCase();
        if (action === 'set' || action === 'on') {
          const claimed = db.setUnknownInboxMaxChatId(recipientChatId);
          await respond(claimed === false
            ? 'Эта MAX-группа уже назначена другому профилю сервера. Один MAX-чат нельзя использовать для двух пользователей.'
            : 'Эта группа назначена группой неизвестных. Сюда будут приходить сообщения контактов, для которых ещё нет отдельной MAX-группы. Отвечай только реплаем на конкретное сообщение.');
        } else if (action === 'off') {
          if (db.getUnknownInboxMaxChatId() === String(recipientChatId)) {
            db.setUnknownInboxMaxChatId();
            await respond('Группа неизвестных отключена. Непривязанные контакты снова будут приходить в личный чат с ботом.');
          } else {
            await respond('Эта группа не назначена группой неизвестных, поэтому отключать здесь нечего.');
          }
        } else {
          await respond(`Группа неизвестных: ${db.getUnknownInboxMaxChatId() === String(recipientChatId) ? 'это текущая группа' : (db.getUnknownInboxMaxChatId() ?? 'не назначена')}.\n/inbox set — назначить эту группу\n/inbox off — отключить`);
        }
        return;
      }
      if (command === '/status') {
        const telegramChatId = db.findTelegramChatIdForMaxGroup(recipientChatId);
        const chat = telegramChatId ? db.findTelegramChat(telegramChatId) : undefined;
        const inbox = db.getUnknownInboxMaxChatId() === String(recipientChatId);
        await respond(telegramChatId
          ? `Группа привязана к ${chat?.effectiveName ?? 'контакту'} (${telegramChatId}).`
          : inbox ? 'Это группа неизвестных контактов.' : 'Группа пока не настроена. Используй /link ID или /inbox set.');
        return;
      }
      if (command === '/censor') {
        await handleCensorCommand(argument);
        return;
      }
      if (command === '/help' || command === '/start') {
        await respond([
          'Команды этой MAX-группы:',
          '/link TELEGRAM_ID — привязать отдельный Telegram-чат',
          '/unlink — убрать привязку',
          '/inbox set — сделать группой неизвестных',
          '/inbox off — отключить группу неизвестных',
          '/status — показать назначение группы',
          '/censor — настройка цензуры',
          '',
          'В отдельной группе можно писать без реплая. В группе неизвестных отвечай реплаем на конкретное сообщение.'
        ].join('\n'));
        return;
      }
      await respond('Неизвестная команда для группы. Отправь /help.');
      return;
    }

    if (isChannel) return;

    const pendingAction = db.getSetting('max_pending_action');
    if (!isGroup && pendingAction === 'set_active_chat' && text && !text.startsWith('/')) {
      const requestedId = text.replace(/\s+/g, '');
      const chat = /^\d+$/.test(requestedId) ? db.findTelegramChat(requestedId) : undefined;
      if (!chat) {
        await maxBot.api.sendMessageToUser(senderId, 'Такой ID не найден. Вставь только цифры ID из списка контактов или нажми «Отмена».', {
          attachments: [maxKeyboard([
            [{ text: 'Все контакты', payload: 'contacts:page:0' }],
            [{ text: 'Отмена', payload: 'pending:cancel', intent: 'negative' }]
          ])]
        });
        return;
      }
      db.setSetting('telegram_active_chat_id', chat.telegramChatId);
      db.setSetting('max_pending_action', '');
      await deleteMaxMessageBestEffort(db.getSetting('max_pending_prompt_mid'));
      db.setSetting('max_pending_prompt_mid', '');
      await deleteMaxMessageBestEffort(message.body?.mid);
      await sendMaxMainMenu(senderId);
      return;
    }

    async function sendMaxHelp() {
      await maxBot.api.sendMessageToUser(senderId, [
        'Команды управления:',
        '',
        '/menu — открыть управление кнопками',
        '/contacts — показать все Telegram-контакты',
        '/name ID Имя — назначить своё имя для Telegram ID',
        '/name ID off — убрать своё имя и вернуть имя из Telegram',
        '/chat ID — включить активный чат: обычные сообщения будут уходить этому человеку',
        '/chat off — выключить активный чат',
        '/mirror — выбрать, чьи сообщения зеркалировать',
        '/mirror all — все сообщения',
        '/mirror mine — только ваши сообщения',
        '/mirror others — только сообщения собеседников',
        '/mirror off — выключить зеркалирование',
        '/censor — включение и список запрещённых слов/фраз',
        '/groups — показать привязанные MAX-группы',
        '/tgk — назначить TGK 1, 2 или 3 в MAX',
        'Ссылки TGK задаются в основном Telegram-боте командой /tgk.',
        '/speed — показать скорость сервера; /speed test — измерить',
        '/eta 1600 — примерное время передачи файла 1600 МБ',
        '/only ID — принимать сообщения только от этого Telegram ID',
        '/only off — снова принимать сообщения от всех',
        '/mute ID — скрыть человека',
        '/unmute ID — снова показывать человека',
        '/filters — показать текущие фильтры',
        '/limit ЧИСЛО — лимит локальной истории от 1 до 10000',
        '/clear ID — очистить локальную историю контакта (Telegram не затрагивается)',
        '/cancel — отменить ожидание ID',
        '',
        'Чтобы ответить человеку в Telegram, как раньше ответь реплаем на его сообщение в MAX.'
      ].join('\n'), {
        attachments: [maxKeyboard([
          [{ text: 'Открыть меню', payload: 'menu:main', intent: 'positive' }],
          [{ text: '🗑 Удалить справку', payload: 'message:delete', intent: 'negative' }]
        ])]
      });
    }

    async function handleMaxCommand() {
      const { command, argument } = parseCommandText(text);

      if (command === '/help' || command === '/start') {
        await sendMaxHelp();
        return true;
      }

      if (command === '/menu' || command === '/settings') {
        await sendMaxMainMenu(senderId);
        return true;
      }

      if (command === '/censor') return handleCensorCommand(argument);

      if (command === '/groups') {
        await sendMaxGroupsStatus(senderId);
        return true;
      }

      if (command === '/speed') {
        if (argument.toLowerCase() === 'test') {
          await maxBot.api.sendMessageToUser(senderId, 'Измеряю скорость сервера. Это займёт до минуты.');
          try {
            const snapshot = await networkMonitor.test({ force: true });
            await maxBot.api.sendMessageToUser(senderId, [
              'Скорость интернета сервера:',
              `↓ ${snapshot.downloadMbps} Мбит/с`,
              `↑ ${snapshot.uploadMbps} Мбит/с`,
              snapshot.latencyMs ? `Задержка: ${snapshot.latencyMs} мс` : ''
            ].filter(Boolean).join('\n'));
          } catch (error) {
            await maxBot.api.sendMessageToUser(senderId, `Не удалось измерить скорость: ${error.message}`);
          }
        } else {
          const snapshot = networkMonitor.snapshot();
          await maxBot.api.sendMessageToUser(senderId, snapshot.downloadMbps && snapshot.uploadMbps
            ? `Скорость сервера: ↓ ${snapshot.downloadMbps} Мбит/с · ↑ ${snapshot.uploadMbps} Мбит/с${snapshot.latencyMs ? ` · ${snapshot.latencyMs} мс` : ''}`
            : 'Скорость ещё не измерена. Запусти /speed test.');
        }
        return true;
      }

      if (command === '/eta') {
        const sizeMb = Number(String(argument).replace(',', '.'));
        if (!Number.isFinite(sizeMb) || sizeMb <= 0 || sizeMb > 2000) {
          await maxBot.api.sendMessageToUser(senderId, 'Напиши размер файла в МБ. Например: /eta 1600');
          return true;
        }
        const estimate = estimateTransferTime(sizeMb * 1024 * 1024, networkMonitor.snapshot());
        await maxBot.api.sendMessageToUser(senderId, estimate.totalSeconds
          ? [`Файл: ${sizeMb} МБ`, `Telegram → сервер: ${formatEta(estimate.downloadSeconds)}`, `Сервер → MAX: ${formatEta(estimate.uploadSeconds)}`, `Общий ориентир: ${formatEta(estimate.totalSeconds)}`].join('\n')
          : 'Сначала измерь скорость командой /speed test.');
        return true;
      }

      if (command === '/tgk' || command === '/channel' || command === '/channels') {
        const parts = String(argument || '').trim().split(/\s+/).filter(Boolean);
        if (!parts.length || ['status', 'list'].includes(String(parts[0]).toLowerCase())) {
          await sendMaxNewsStatus(senderId);
          return true;
        }
        const slot = Number(parts[0]);
        if (![1, 2, 3].includes(slot)) {
          await maxBot.api.sendMessageToUser(senderId, 'Укажи TGK 1, 2 или 3. Ссылку источника задавай в основном Telegram-боте.');
          return true;
        }
        const action = String(parts[1] || '').toLowerCase();
        if (!action) {
          const item = channelRelay.getSlot(slot);
          await maxBot.api.sendMessageToUser(senderId, item.url
            ? `TGK ${slot}: ${item.url}\nНазначение: ${item.targetMaxTitle || item.targetMaxChatId || 'этот личный чат'}`
            : `TGK ${slot} не настроен. Задай ссылку в Telegram-боте: /tgk ${slot} https://t.me/channel_name`);
          return true;
        }
        if (['dm', 'off', 'private'].includes(action)) {
          channelRelay.setSlotTarget(slot);
          await maxBot.api.sendMessageToUser(senderId, `TGK ${slot} будет приходить в этот личный чат.`);
          return true;
        }
        if (/^https?:\/\//i.test(parts[1])) {
          try {
            const chat = await maxBot.api.getChatByLink(parts.slice(1).join(' '));
            if (!chat?.chat_id || !['chat', 'channel'].includes(chat.type)) throw new Error('группа или канал не найдены');
            if (!channelRelay.setSlotTarget(slot, { maxChatId: chat.chat_id, title: chat.title, type: chat.type })) {
              throw new Error('этот MAX-чат занят другим профилем');
            }
            await maxBot.api.sendMessageToChat(Number(chat.chat_id), `Этот чат назначен для TGK ${slot}.`);
            await maxBot.api.sendMessageToUser(senderId, `TGK ${slot} будет приходить в ${chat.title || chat.type}.`);
          } catch (error) {
            await maxBot.api.sendMessageToUser(senderId, `Не удалось назначить TGK ${slot}: ${error.message}`);
          }
          return true;
        }
        await maxBot.api.sendMessageToUser(senderId, 'Ссылку публичного Telegram-канала задавай в основном Telegram-боте. Здесь можно написать /tgk 1 dm или прислать ссылку на MAX-группу/канал.');
        return true;
      }

      if (command === '/news') {
        await maxBot.api.sendMessageToUser(senderId, [
          'Команда переименована в /tgk.',
          'Ссылки чужих публичных Telegram-каналов задаются в основном Telegram-боте:',
          '/tgk add https://t.me/channel_name — следующий свободный слот',
          '/tgk 1 https://t.me/channel_name',
          '/tgk 2 https://t.me/second_channel',
          '/tgk 3 https://t.me/third_channel',
          '',
          'В MAX используй /tgk 1 dm или отправь /tgk 1 here внутри нужной группы.'
        ].join('\n'));
        return true;
      }

      if (command === '/cancel') {
        db.setSetting('max_pending_action', '');
        await deleteMaxMessageBestEffort(db.getSetting('max_pending_prompt_mid'));
        db.setSetting('max_pending_prompt_mid', '');
        await maxBot.api.sendMessageToUser(senderId, 'Ожидание ID отменено.');
        return true;
      }

      if (command === '/mirror') {
        if (!argument) {
          await sendMaxMirrorMenu(senderId);
          return true;
        }
        const mode = argument.toLowerCase();
        if (!Object.hasOwn(MIRROR_MODES, mode)) {
          await maxBot.api.sendMessageToUser(senderId, 'Допустимые режимы: all, mine, others или off.');
          return true;
        }
        db.setSetting('telegram_mirror_mode', mode);
        await maxBot.api.sendMessageToUser(senderId, `Готово: ${MIRROR_MODES[mode]}.`);
        return true;
      }

      if (command === '/limit') {
        if (!argument) {
          await sendMaxLimitMenu(senderId);
          return true;
        }
        const limit = Number(argument);
        if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
          await maxBot.api.sendMessageToUser(senderId, 'Напиши целое число от 1 до 10000. Например: /limit 5000');
          return true;
        }
        db.setChatHistoryLimit(limit);
        await maxBot.api.sendMessageToUser(senderId, `Лимит локальной истории установлен: ${limit}. Telegram-сообщения не удалялись.`);
        return true;
      }

      if (command === '/clear') {
        if (!argument || !db.findTelegramChat(argument)) {
          await maxBot.api.sendMessageToUser(senderId, 'Напиши ID существующего контакта. Например: /clear 123456789');
          return true;
        }
        const removed = db.clearChatMessages(argument);
        await maxBot.api.sendMessageToUser(senderId, `Локальная история очищена: ${removed} сообщений. В Telegram ничего не удалено.`);
        return true;
      }

      if (command === '/contacts') {
        await sendMaxContactsMenu(senderId, 0);
        return true;
      }

      if (command === '/name') {
        const [telegramChatId, ...nameParts] = argument.split(/\s+/).filter(Boolean);
        const customName = nameParts.join(' ').trim();
        if (!telegramChatId || !customName) {
          await maxBot.api.sendMessageToUser(senderId, 'Напиши так: /name ID Имя\nНапример: /name 123456789 Мама');
          return true;
        }

        const chat = db.findTelegramChat(telegramChatId);
        if (!chat) {
          await maxBot.api.sendMessageToUser(senderId, 'Такого ID пока нет в списке. Дождись сообщения от человека или проверь /contacts.');
          return true;
        }

        const nextName = ['off', 'clear', 'сброс', 'убрать'].includes(customName.toLowerCase()) ? '' : customName;
        db.setTelegramChatCustomName(telegramChatId, nextName);
        await maxBot.api.sendMessageToUser(
          senderId,
          nextName
            ? `Готово. Теперь ${telegramChatId} будет показываться как: ${nextName}.`
            : `Готово. Для ${telegramChatId} снова будет показываться имя из Telegram: ${chat.displayName}.`
        );
        return true;
      }

      if (command === '/filters') {
        const mutedChats = db.listTelegramChats(100).filter((chat) => chat.muted);
        const activeChatId = db.getSetting('telegram_active_chat_id');
        await maxBot.api.sendMessageToUser(senderId, formatFilters({
          onlyChatId: db.getSetting('telegram_only_chat_id'),
          activeChat: activeChatId ? db.findTelegramChat(activeChatId) : undefined,
          mutedChats
        }));
        return true;
      }

      if (command === '/chat') {
        if (['off', 'clear', 'сброс', 'выкл', 'нет'].includes(argument.toLowerCase())) {
          db.setSetting('telegram_active_chat_id', '');
          await maxBot.api.sendMessageToUser(senderId, 'Активный чат выключен. Теперь без реплая сообщения не будут уходить в Telegram.');
          return true;
        }
        if (!argument) {
          await maxBot.api.sendMessageToUser(senderId, 'Напиши так: /chat ID\nID можно посмотреть командой /contacts.');
          return true;
        }
        const chat = db.findTelegramChat(argument);
        if (!chat) {
          await maxBot.api.sendMessageToUser(senderId, 'Такого ID пока нет в списке. Дождись сообщения от человека или проверь /contacts.');
          return true;
        }
        db.setSetting('telegram_active_chat_id', chat.telegramChatId);
        await maxBot.api.sendMessageToUser(
          senderId,
          `Активный чат включён: ${chat.effectiveName} (${chat.telegramChatId}). Теперь обычные сообщения без реплая будут отправляться ему.`
        );
        return true;
      }

      if (command === '/only') {
        if (['off', 'all', 'выкл', 'все'].includes(argument.toLowerCase())) {
          db.setSetting('telegram_only_chat_id', '');
          await maxBot.api.sendMessageToUser(senderId, 'Фильтр выключен. Теперь будут приходить сообщения от всех нескрытых Telegram-контактов.');
          return true;
        }
        if (!argument) {
          await maxBot.api.sendMessageToUser(senderId, 'Напиши так: /only ID\nID можно посмотреть командой /contacts.');
          return true;
        }
        const chat = db.findTelegramChat(argument);
        db.setSetting('telegram_only_chat_id', String(argument));
        await maxBot.api.sendMessageToUser(
          senderId,
          chat
            ? `Готово. Теперь будут приходить сообщения только от: ${chat.displayName} (${chat.telegramChatId}).`
            : `Готово. Теперь будут приходить сообщения только от Telegram ID: ${argument}.`
        );
        return true;
      }

      if (command === '/mute' || command === '/unmute') {
        if (!argument) {
          await maxBot.api.sendMessageToUser(senderId, `Напиши так: ${command} ID\nID можно посмотреть командой /contacts.`);
          return true;
        }
        const changed = db.setTelegramChatMuted(argument, command === '/mute');
        if (!changed) {
          await maxBot.api.sendMessageToUser(senderId, 'Такого ID пока нет в списке. Дождись сообщения от человека или проверь /contacts.');
          return true;
        }
        const chat = db.findTelegramChat(argument);
        await maxBot.api.sendMessageToUser(
          senderId,
          command === '/mute'
            ? `Готово. ${chat?.displayName ?? argument} скрыт.`
            : `Готово. ${chat?.displayName ?? argument} снова показывается.`
        );
        return true;
      }

      return false;
    }

    if (text.startsWith('/')) {
      const handled = await handleMaxCommand();
      if (handled) return;
    }

    const sourceMaxMessageId = message.link?.type === 'reply' ? message.link.message?.mid : undefined;
    const activeChatId = db.getSetting('telegram_active_chat_id');
    const groupTelegramChatId = isGroup ? db.findTelegramChatIdForMaxGroup(recipientChatId) : undefined;
    const isUnknownInbox = isGroup && db.getUnknownInboxMaxChatId() === String(recipientChatId);
    const target = sourceMaxMessageId
      ? db.findTelegramTarget(sourceMaxMessageId)
      : isGroup
        ? targetFromChat(groupTelegramChatId ? db.findTelegramChat(groupTelegramChatId) : undefined)
        : targetFromChat(activeChatId ? db.findTelegramChat(activeChatId) : undefined);
    if (!target) {
      await respond(sourceMaxMessageId
        ? 'Не нашёл исходный Telegram-чат. Попробуй ответить на более свежее сообщение.'
        : isUnknownInbox
          ? 'В группе неизвестных нужно отвечать реплаем на конкретное пересланное сообщение.'
          : isGroup
            ? 'Эта группа не привязана. Напиши /link TELEGRAM_ID или /inbox set.'
            : 'Ответь реплаем на конкретное сообщение или включи активный чат командой /chat ID.');
      return;
    }

    log.event({ level: 'info', category: 'route', event: 'max_route_selected', message: 'Выбран Telegram-чат для ответа из MAX', operationId: maxOperationId, direction: 'max_to_telegram', stage: 'route', status: 'running', progress: 20, details: { telegramChatId: target.telegramChatId, replyToMessageId: target.telegramMessageId, isGroup, isUnknownInbox } });
    const attachments = (message.body?.attachments ?? [])
      .filter((attachment) => attachment.type !== 'inline_keyboard');

    if (!text && attachments.length === 0) {
      await respond('В ответе нет текста или поддерживаемого вложения.');
      return;
    }

    let pendingCaption = text.length <= 1000 ? text : '';
    let sentAnything = false;
    if (text && !pendingCaption) {
      await sendTelegramText(target, text);
      sentAnything = true;
    }

    for (const [index, attachment] of attachments.entries()) {
      if (attachment.type === 'location') {
        if (pendingCaption) {
          await sendTelegramText(target, pendingCaption);
          pendingCaption = '';
          sentAnything = true;
        }
        await telegram.sendBusinessLocation({
          businessConnectionId: target.telegramBusinessConnectionId,
          chatId: target.telegramChatId,
          latitude: attachment.latitude,
          longitude: attachment.longitude,
          replyToMessageId: target.telegramMessageId
        });
        sentAnything = true;
        continue;
      }

      const attachmentText = maxAttachmentAsText(attachment);
      if (attachmentText) {
        const combined = [pendingCaption, attachmentText].filter(Boolean).join('\n');
        await sendTelegramText(target, combined);
        pendingCaption = '';
        sentAnything = true;
        continue;
      }

      let downloaded;
      try {
        log.event({ level: 'info', category: 'file', event: 'max_media_download_started', message: `Начато скачивание вложения MAX: ${attachment.type || 'файл'}`, operationId: maxOperationId, direction: 'max_to_telegram', stage: 'download', status: 'running', progress: 30, details: { index, attachmentType: attachment.type } });
        const maxDownloadProgress = createProgressEmitter({
          log, networkMonitor, operationId: maxOperationId, direction: 'max_to_telegram', stage: 'download',
          event: 'max_media_download_progress', label: 'MAX → сервер',
          startProgress: 30, endProgress: 55, networkDirection: 'download'
        });
        downloaded = await downloadMaxAttachment({
          attachment,
          index,
          dataDir: config.dataDir,
          maxBytes: config.telegramUploadLimitBytes,
          timeoutMs: config.mediaTransferTimeoutMs,
          diskReserveBytes: config.mediaDiskReserveBytes,
          onProgress: maxDownloadProgress
        });
        if (!downloaded) continue;
        log.event({ level: 'info', category: 'file', event: 'max_media_downloaded', message: 'Вложение MAX скачано', operationId: maxOperationId, direction: 'max_to_telegram', stage: 'download', status: 'running', progress: 56, details: { fileName: downloaded.fileName, contentType: downloaded.contentType, telegramKind: downloaded.telegramKind, size: downloaded.size } });

        let outgoingPath = downloaded.filePath;
        let outgoingFileName = downloaded.fileName;
        let outgoingContentType = downloaded.contentType;
        let outgoingKind = telegramKindForMaxRelay(downloaded);
        let outgoingCaption = pendingCaption;
        if (downloaded.isVideoMessage) {
          // Keep the existing round-video presentation for genuine MAX video
          // messages, but never transcode a large video that must be preserved
          // byte-for-byte and delivered as a Telegram document.
          if (outgoingKind !== 'document') {
            const convertedPath = join(downloaded.directory, 'max-video-message.mp4');
            try {
              await makeMaxVideoMessage(downloaded.filePath, convertedPath);
              outgoingPath = convertedPath;
              outgoingFileName = 'max-video-message.mp4';
              outgoingContentType = 'video/mp4';
            } catch (error) {
              log.warn('MAX video message conversion failed; sending original video', error.message);
            }
          }
          outgoingCaption = [pendingCaption, 'Видеосообщение'].filter(Boolean).join('\n');
        }
        if (downloaded.telegramKind === 'voice') {
          const voicePath = join(downloaded.directory, 'max-voice.ogg');
          log.event({ level: 'info', category: 'file', event: 'max_voice_conversion_started', message: 'Преобразование голосового MAX в OGG/Opus', operationId: maxOperationId, direction: 'max_to_telegram', stage: 'convert', status: 'running', progress: 58 });
          try {
            await makeVoiceMessage(downloaded.filePath, voicePath);
            outgoingPath = voicePath;
            outgoingFileName = 'max-voice.ogg';
            outgoingContentType = 'audio/ogg';
            outgoingKind = 'voice';
          } catch (error) {
            // An extensionless MAX audio URL is not guaranteed to contain OGG/Opus.
            // If conversion fails, send the original as audio/document, never as a fake voice.
            outgoingKind = 'audio';
            log.event({ level: 'warn', category: 'file', event: 'max_voice_conversion_failed', message: `Не удалось преобразовать голосовое MAX: ${error.message}. Будет отправлено как аудиофайл.`, operationId: maxOperationId, direction: 'max_to_telegram', stage: 'convert', status: 'running', progress: 62, details: { error } });
          }
          log.event({ level: 'info', category: 'file', event: 'max_voice_conversion_completed', message: outgoingKind === 'voice' ? 'Голосовое MAX подготовлено для Telegram' : 'Аудио MAX подготовлено как файл', operationId: maxOperationId, direction: 'max_to_telegram', stage: 'convert', status: 'running', progress: 62 });
        }

        const sendOptions = {
          businessConnectionId: target.telegramBusinessConnectionId,
          chatId: target.telegramChatId,
          telegramKind: outgoingKind,
          filePath: outgoingPath,
          fileName: outgoingFileName,
          contentType: outgoingContentType,
          caption: outgoingCaption,
          replyToMessageId: target.telegramMessageId
        };

        const telegramUploadProgress = createProgressEmitter({
          log, networkMonitor, operationId: maxOperationId, direction: 'max_to_telegram', stage: 'upload',
          event: 'telegram_media_upload_progress', label: 'Сервер → Telegram',
          startProgress: 63, endProgress: 84, networkDirection: 'upload', totalBytesHint: downloaded.size
        });
        try {
          await telegram.sendBusinessMedia({ ...sendOptions, onProgress: telegramUploadProgress });
        } catch (error) {
          if (outgoingKind === 'document') throw error;
          await telegram.sendBusinessMedia({
            ...sendOptions,
            telegramKind: 'document',
            contentType: 'application/octet-stream',
            onProgress: telegramUploadProgress
          });
        }
        log.event({ level: 'info', category: 'file', event: 'telegram_media_uploaded', message: 'Вложение отправлено в Telegram', operationId: maxOperationId, direction: 'max_to_telegram', stage: 'send', status: 'running', progress: 85, details: { fileName: outgoingFileName, telegramKind: outgoingKind } });
        const historyMedia = await archiveMediaFile({
          filePath: outgoingPath,
          fileName: outgoingFileName,
          mimeType: outgoingContentType,
          kind: downloaded.isVideoMessage ? 'video_message' : attachment.type,
          dataDir: config.dataDir,
          move: true
        });
        db.insertChatMessage({
          telegramChatId: target.telegramChatId,
          direction: 'out',
          text: outgoingCaption,
          type: outgoingKind,
          media: historyMedia
        });
        pendingCaption = '';
        sentAnything = true;
      } catch (error) {
        const reason = error.userMessage ?? error.message;
        log.event({ level: 'error', category: 'file', event: 'max_media_transfer_failed', message: `Не удалось передать вложение MAX: ${reason}`, operationId: maxOperationId, direction: 'max_to_telegram', stage: 'media', status: 'failed', progress: 100, durationMs: Date.now() - maxOperationStartedAt, details: { error } });
        log.warn('MAX media transfer failed', `${reason}: ${error.cause?.message ?? ''}`);
        await respond(`Не удалось отправить вложение в Telegram: ${reason}`);
      } finally {
        await removeTempDirectory(downloaded?.directory);
      }
    }

    if (pendingCaption) {
      await sendTelegramText(target, pendingCaption);
      sentAnything = true;
    }

    if (!sentAnything) {
      await respond('Этот тип вложения из MAX пока не поддерживается.');
      return;
    }
    log.event({ level: 'info', category: 'message', event: 'max_to_telegram_completed', message: attachments.length ? 'Ответ и вложения переданы из MAX в Telegram' : 'Ответ передан из MAX в Telegram', operationId: maxOperationId, direction: 'max_to_telegram', stage: 'complete', status: 'completed', progress: 100, durationMs: Date.now() - maxOperationStartedAt, details: { telegramChatId: target.telegramChatId, attachmentCount: attachments.length } });
    log.info(attachments.length ? 'MAX reply and media sent to Telegram' : 'MAX reply sent to Telegram');
  }

  async function handleMaxCallback(callback, sourceMessage) {
    const senderId = callback?.user?.user_id;
    const accountId = senderId ? db.findAccountByMaxOwner(senderId) : undefined;
    if (!accountId) return;
    return db.runAsAccount(accountId, () => handleMaxCallbackScoped(callback, sourceMessage));
  }

  async function handleMaxCallbackScoped(callback, sourceMessage) {
    const senderId = callback?.user?.user_id;
    const savedOwnerId = db.getSetting('max_owner_id');
    if (!senderId || String(senderId) !== savedOwnerId) return;
    const payload = String(callback.payload ?? '');
    const sourceMid = sourceMessage?.body?.mid;
    const sourceText = sourceMessage?.body?.text ?? '';
    const isMainPanel = sourceText.startsWith('Управление Telegram прямо из MAX');
    const isGroupSource = sourceMessage?.recipient?.chat_type === 'chat';
    const deleteSource = () => deleteMaxMessageBestEffort(sourceMid);
    try {
      await maxBot.api.answerOnCallback(callback.callback_id, { notification: 'Готово' });

      if (payload === 'message:delete') {
        await deleteSource();
        return;
      }

      if (payload === 'menu:main') {
        if (!isMainPanel) await deleteSource();
        return sendMaxMainMenu(senderId);
      }
      if (payload === 'menu:contacts') {
        if (!isMainPanel) await deleteSource();
        return sendMaxContactsMenu(senderId, 0);
      }
      if (payload.startsWith('contacts:page:')) {
        if (!isMainPanel) await deleteSource();
        return sendMaxContactsMenu(senderId, payload.slice('contacts:page:'.length));
      }
      if (payload === 'menu:mirror') return sendMaxMirrorMenu(senderId);
      if (payload === 'menu:censor') return sendMaxCensorMenu(senderId);
      if (payload === 'menu:groups') return sendMaxGroupsStatus(senderId);
      if (payload === 'menu:news') return sendMaxNewsStatus(senderId);
      if (payload.startsWith('tgk:setid:')) {
        const match = payload.match(/^tgk:setid:([123]):(-?\d+)$/);
        if (!match) throw new Error('MAX передал неправильный TGK или ID чата');
        const slot = Number(match[1]);
        const chatId = match[2];
        const chat = await maxBot.api.getChat(Number(chatId));
        if (!chat?.chat_id || !['chat', 'channel'].includes(chat.type)) throw new Error('группа или канал больше не доступны боту');
        if (!channelRelay.setSlotTarget(slot, { maxChatId: chat.chat_id, title: chat.title, type: chat.type })) {
          throw new Error('эта MAX-группа или канал уже назначены другому профилю сервера');
        }
        await maxBot.api.sendMessageToChat(Number(chat.chat_id), `Этот чат назначен для TGK ${slot}.`);
        await deleteSource();
        return maxBot.api.sendMessageToUser(senderId, `Готово. TGK ${slot} будет приходить в «${chat.title || chat.type}».`);
      }
      if (payload.startsWith('news:setid:')) {
        const chatId = payload.slice('news:setid:'.length);
        if (!/^-?\d+$/.test(chatId)) throw new Error('MAX передал неправильный ID канала');
        const chat = await maxBot.api.getChat(Number(chatId));
        if (!chat?.chat_id || !['chat', 'channel'].includes(chat.type)) {
          throw new Error('группа или канал больше не доступны боту');
        }
        if (!db.maxChatAvailableForCurrentAccount(chat.chat_id)) {
          throw new Error('эта MAX-группа или канал уже назначены другому профилю сервера');
        }
        await maxBot.api.sendMessageToChat(Number(chat.chat_id), 'Этот чат назначен для публикаций публичного Telegram-канала.');
        db.setWebRelayMaxChat({
          maxChatId: chat.chat_id,
          title: chat.title || (chat.type === 'channel' ? 'MAX-канал' : 'MAX-группа'),
          type: chat.type
        });
        await deleteSource();
        return maxBot.api.sendMessageToUser(senderId, `Готово. Новые публикации будут приходить в «${chat.title || chat.type}».`);
      }
      if (payload === 'menu:limit') return sendMaxLimitMenu(senderId);
      if (payload === 'menu:help') {
        return maxBot.api.sendMessageToUser(senderId, [
          '/menu — меню с кнопками',
          '/contacts — контакты',
          '/name ID Имя — изменить имя',
          '/chat ID или /chat off — активный чат',
          '/mirror — настройка зеркалирования',
          '/censor — настройка цензуры слов и фраз',
          '/groups — привязанные MAX-группы',
          '/tgk — TGK 1, 2 и 3',
          'В группе: /link ID, /unlink, /inbox set, /inbox off, /status',
          '/only ID или /only off — фильтр контакта',
          '/mute ID и /unmute ID — скрыть/показать',
          '/limit ЧИСЛО — лимит локальной истории',
          '/clear ID — очистить локальную историю',
          '/filters — текущие настройки'
        ].join('\n'), {
          attachments: [maxKeyboard([
            [{ text: '← Главное меню', payload: 'menu:main' }],
            [{ text: '🗑 Удалить справку', payload: 'message:delete', intent: 'negative' }]
          ])]
        });
      }
      if (payload === 'menu:filters') {
        const activeChatId = db.getSetting('telegram_active_chat_id');
        const onlyChatId = db.getSetting('telegram_only_chat_id');
        const mutedChats = db.listTelegramChats(100).filter((chat) => chat.muted);
        return maxBot.api.sendMessageToUser(senderId, formatFilters({
          onlyChatId,
          activeChat: activeChatId ? db.findTelegramChat(activeChatId) : undefined,
          mutedChats
        }), {
          attachments: [maxKeyboard([
            [{ text: 'Выключить активный чат', payload: 'chat:off' }],
            [{ text: 'Принимать сообщения от всех', payload: 'only:off' }],
            [{ text: '← Главное меню', payload: 'menu:main' }],
            [{ text: '🗑 Удалить фильтры', payload: 'message:delete', intent: 'negative' }]
          ])]
        });
      }
      if (payload.startsWith('contact:')) {
        if (!isGroupSource) await deleteSource();
        return sendMaxContactMenu(senderId, payload.slice('contact:'.length));
      }

      if (payload === 'censor:on' || payload === 'censor:off') {
        db.setSetting('censor_enabled', payload.endsWith(':on') ? 'true' : 'false');
        await deleteSource();
        return sendMaxCensorMenu(senderId);
      }
      if (payload === 'censor:list') {
        const terms = db.getCensorTerms();
        return maxBot.api.sendMessageToUser(senderId, terms.length
          ? `Запрещённые слова и фразы:\n${terms.map((term, index) => `${index + 1}. ${term}`).join('\n')}`
          : 'Список запрещённых слов и фраз пуст.', {
          attachments: [maxKeyboard([
            [{ text: '← Цензура', payload: 'menu:censor' }],
            [{ text: '🗑 Удалить список', payload: 'message:delete', intent: 'negative' }]
          ])]
        });
      }

      if (payload.startsWith('copyid:')) {
        const chatId = payload.slice('copyid:'.length);
        const chat = db.findTelegramChat(chatId);
        if (!chat) return maxBot.api.sendMessageToUser(senderId, 'Контакт больше не найден.');
        return maxBot.api.sendMessageToUser(senderId, `ID для копирования:\n${chat.telegramChatId}`, {
          attachments: [maxKeyboard([
            [{ text: '🗑 Удалить ID', payload: 'message:delete', intent: 'negative' }]
          ])]
        });
      }

      if (payload === 'chat:prompt') {
        await deleteMaxMessageBestEffort(db.getSetting('max_pending_prompt_mid'));
        db.setSetting('max_pending_action', 'set_active_chat');
        const prompt = await maxBot.api.sendMessageToUser(senderId, 'Вставь ID нужного человека следующим сообщением — только цифры, без команды /chat.', {
          attachments: [maxKeyboard([
            [{ text: 'Показать все контакты', payload: 'contacts:page:0' }],
            [{ text: 'Отмена', payload: 'pending:cancel', intent: 'negative' }]
          ])]
        });
        db.setSetting('max_pending_prompt_mid', prompt.body?.mid ?? '');
        return prompt;
      }
      if (payload === 'pending:cancel') {
        db.setSetting('max_pending_action', '');
        await deleteSource();
        await deleteMaxMessageBestEffort(db.getSetting('max_pending_prompt_mid'));
        db.setSetting('max_pending_prompt_mid', '');
        return sendMaxMainMenu(senderId);
      }

      if (payload.startsWith('mirror:')) {
        const mode = payload.slice('mirror:'.length);
        if (!Object.hasOwn(MIRROR_MODES, mode)) return;
        db.setSetting('telegram_mirror_mode', mode);
        await deleteSource();
        return sendMaxMirrorMenu(senderId);
      }
      if (payload.startsWith('limit:')) {
        const limit = Number(payload.slice('limit:'.length));
        if (!Number.isInteger(limit) || limit < 1 || limit > 10000) return;
        db.setChatHistoryLimit(limit);
        await deleteSource();
        return sendMaxLimitMenu(senderId);
      }
      if (payload === 'hint:limit') {
        return maxBot.api.sendMessageToUser(senderId, 'Отправь команду с нужным числом, например: /limit 2500', {
          attachments: [maxKeyboard([
            [{ text: '🗑 Удалить подсказку', payload: 'message:delete', intent: 'negative' }]
          ])]
        });
      }
      if (payload === 'chat:off') {
        db.setSetting('telegram_active_chat_id', '');
        db.setSetting('max_pending_action', '');
        await deleteSource();
        return sendMaxMainMenu(senderId);
      }
      if (payload.startsWith('chat:set:')) {
        const chat = db.findTelegramChat(payload.slice('chat:set:'.length));
        if (!chat) return maxBot.api.sendMessageToUser(senderId, 'Контакт больше не найден.');
        db.setSetting('telegram_active_chat_id', chat.telegramChatId);
        await deleteSource();
        return sendMaxContactMenu(senderId, chat.telegramChatId);
      }
      if (payload === 'only:off') {
        db.setSetting('telegram_only_chat_id', '');
        await deleteSource();
        return sendMaxMainMenu(senderId);
      }
      if (payload.startsWith('only:set:')) {
        const chat = db.findTelegramChat(payload.slice('only:set:'.length));
        if (!chat) return maxBot.api.sendMessageToUser(senderId, 'Контакт больше не найден.');
        db.setSetting('telegram_only_chat_id', chat.telegramChatId);
        await deleteSource();
        return sendMaxContactMenu(senderId, chat.telegramChatId);
      }
      if (payload.startsWith('mute:') || payload.startsWith('unmute:')) {
        const muted = payload.startsWith('mute:');
        const chatId = payload.slice(payload.indexOf(':') + 1);
        if (!db.setTelegramChatMuted(chatId, muted)) return maxBot.api.sendMessageToUser(senderId, 'Контакт больше не найден.');
        if (!isGroupSource) await deleteSource();
        return sendMaxContactMenu(senderId, chatId);
      }
      if (payload.startsWith('clear:ask:')) {
        const chatId = payload.slice('clear:ask:'.length);
        const chat = db.findTelegramChat(chatId);
        if (!chat) return maxBot.api.sendMessageToUser(senderId, 'Контакт больше не найден.');
        await deleteSource();
        return maxBot.api.sendMessageToUser(senderId, `Очистить локальную историю «${chat.effectiveName}»? В Telegram сообщения останутся.`, {
          attachments: [maxKeyboard([
            [{ text: 'Да, очистить', payload: `clear:do:${chatId}`, intent: 'negative' }],
            [{ text: 'Отмена', payload: `contact:${chatId}` }],
            [{ text: '🗑 Удалить окно', payload: 'message:delete', intent: 'negative' }]
          ])]
        });
      }
      if (payload.startsWith('clear:do:')) {
        const chatId = payload.slice('clear:do:'.length);
        db.clearChatMessages(chatId);
        await deleteSource();
        return sendMaxContactMenu(senderId, chatId);
      }
    } catch (error) {
      log.warn('MAX callback failed', error.message);
      await maxBot.api.sendMessageToUser(senderId, `Не удалось выполнить действие: ${error.message}`).catch(() => {});
    }
  }

  async function handleEditedBusinessMessage(message) {
    await forwardTelegramMessageToMax(message, { edited: true });
    log.info('Edited Telegram message synchronized');
  }

  async function handleDeletedBusinessMessages(deleted) {
    const telegramChatId = deleted.chat?.id;
    if (!telegramChatId) return;
    for (const telegramMessageId of deleted.message_ids ?? []) {
      const source = {
        telegramBusinessConnectionId: deleted.business_connection_id,
        telegramChatId,
        telegramMessageId
      };
      for (const maxMessageId of db.findMaxMessageIdsForTelegramSource(source)) {
        try {
          await maxBot.api.deleteMessage(maxMessageId);
        } catch (error) {
          log.warn('Could not delete Telegram-deleted message from MAX', error.message);
        }
      }
      db.deleteMessageLinksForTelegramSource(source);
    }
    db.markIncomingMessagesDeleted(telegramChatId, deleted.message_ids ?? []);
    log.info('Deleted Telegram messages synchronized');
  }

  async function handleMaxChatUpdate(update) {
    const chatId = update?.chat_id;
    const accountId = chatId !== undefined && chatId !== null ? db.findAccountByMaxChat(chatId) : undefined;
    if (accountId) return db.runAsAccount(accountId, () => handleMaxChatUpdateScoped(update));
    if (update?.update_type !== 'bot_added' || chatId === undefined || chatId === null) return;

    let chat;
    try {
      chat = await maxBot.api.getChat(Number(chatId));
    } catch (error) {
      log.warn('Could not read newly added unclaimed MAX chat', error.message);
    }
    const title = chat?.title || (update.is_channel ? 'Новый MAX-канал' : 'Новая MAX-группа');
    for (const account of db.listAccounts().filter((item) => item.maxOwnerId)) {
      await maxBot.api.sendMessageToUser(Number(account.maxOwnerId), [
        `Бот добавлен в «${title}».`,
        'Чат пока не принадлежит ни одному профилю. Для обычного контакта используй /link TELEGRAM_ID, а для TGK выбери слот ниже.'
      ].join('\n'), {
        attachments: [maxKeyboard([
          [{ text: 'TGK 1 сюда', payload: `tgk:setid:1:${chatId}`, intent: 'positive' }],
          [{ text: 'TGK 2 сюда', payload: `tgk:setid:2:${chatId}`, intent: 'positive' }],
          [{ text: 'TGK 3 сюда', payload: `tgk:setid:3:${chatId}`, intent: 'positive' }],
          [{ text: 'Не назначать', payload: 'message:delete' }]
        ])]
      }).catch((error) => log.warn('Could not notify MAX owner about new chat', error.message));
    }
  }

  async function handleMaxChatUpdateScoped(update) {
    const ownerId = db.getSetting('max_owner_id');
    const chatId = update?.chat_id;
    if (!ownerId || chatId === undefined || chatId === null) return;

    if (update.update_type === 'bot_added') {
      let chat;
      try {
        chat = await maxBot.api.getChat(Number(chatId));
      } catch (error) {
        log.warn('Could not read newly added MAX chat', error.message);
      }
      const title = chat?.title || (update.is_channel ? 'Новый MAX-канал' : 'Новая MAX-группа');
      await maxBot.api.sendMessageToUser(Number(ownerId), [
        `Бот добавлен в «${title}».`,
        'Чтобы направить сюда публичный канал, выбери TGK 1, 2 или 3.'
      ].join('\n'), {
        attachments: [maxKeyboard([
          [{ text: 'TGK 1 сюда', payload: `tgk:setid:1:${chatId}`, intent: 'positive' }],
          [{ text: 'TGK 2 сюда', payload: `tgk:setid:2:${chatId}`, intent: 'positive' }],
          [{ text: 'TGK 3 сюда', payload: `tgk:setid:3:${chatId}`, intent: 'positive' }],
          [{ text: 'Не назначать', payload: 'message:delete' }]
        ])]
      });
      return;
    }

    if (update.update_type === 'bot_removed') {
      const slots = channelRelay.clearTargetsByChatId(chatId);
      if (slots.length) {
        await maxBot.api.sendMessageToUser(Number(ownerId), `Бот удалён из MAX-чата. TGK ${slots.join(', ')} снова будут приходить в личный чат.`);
      }
      return;
    }

    if (update.update_type === 'chat_title_changed') {
      channelRelay.renameTarget(chatId, update.title || 'MAX-чат');
    }
  }

  const channelRelay = new ChannelRelayManager({
    db,
    log,
    onPost: forwardWebRelayPostToMax,
    dataDir: config.dataDir,
    pollIntervalMs: config.webRelayPollIntervalMs,
    mediaTargetBytes: Math.max(config.webRelayMediaTargetBytes, 49 * 1024 * 1024),
    mediaTransferTimeoutMs: config.mediaTransferTimeoutMs
  });
  channelRelay.start();

  const telegramPoller = startTelegramPolling({
    telegram,
    db,
    pairingCode: config.pairingCode,
    channelRelay,
    networkMonitor,
    onBusinessMessage: forwardTelegramMessageToMax,
    onEditedBusinessMessage: handleEditedBusinessMessage,
    onDeletedBusinessMessages: handleDeletedBusinessMessages,
    log
  });
  const maxPoller = startMaxPolling({
    maxBot,
    db,
    onMessage: handleMaxMessage,
    onCallback: handleMaxCallback,
    onChatUpdate: handleMaxChatUpdate,
    log
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  log.event({ level: 'info', category: 'system', event: 'bridge_ready', message: `Bridge 2.2.0 запущен. Console: http://127.0.0.1:${config.port}/console`, stage: 'ready', status: 'completed', progress: 100, details: { healthUrl: `http://127.0.0.1:${config.port}/health`, consoleUrl: `http://127.0.0.1:${config.port}/console`, accounts: db.listAccounts().length, largeFileMode: Boolean(config.telegramLocalFilesRoot) } });
  log.info(`Bridge is running. Health: http://127.0.0.1:${config.port}/health`);

  const shutdown = async () => {
    log.info('Stopping bridge');
    telegramPoller.stop();
    maxPoller.stop();
    channelRelay.stop();
    networkMonitor.stop();
    await app.close();
    eventStore.close();
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  log.error('Bridge failed to start', error);
  process.exit(1);
});
