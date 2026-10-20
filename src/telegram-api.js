import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createMultipartUpload, createMultipartUploadFiles } from './multipart.js';

export class TelegramApiError extends Error {
  constructor(method, description) {
    super(`Telegram ${method}: ${description}`);
    this.name = 'TelegramApiError';
  }
}

export class TelegramApi {
  constructor(token, {
    apiBaseUrl = 'https://api.telegram.org',
    localFilesRoot = '',
    mediaTransferTimeoutMs = 2 * 60 * 60 * 1000
  } = {}) {
    const root = apiBaseUrl.trim().replace(/\/+$/, '');
    this.baseUrl = `${root}/bot${token}`;
    this.fileBaseUrl = `${root}/file/bot${token}`;
    this.localFilesRoot = localFilesRoot ? path.resolve(localFilesRoot) : '';
    this.mediaTransferTimeoutMs = mediaTransferTimeoutMs;
  }

  async parseResponse(method, response) {
    let data;
    try {
      data = await response.json();
    } catch {
      throw new TelegramApiError(method, `HTTP ${response.status}`);
    }

    if (!response.ok || !data.ok) {
      throw new TelegramApiError(method, data.description ?? `HTTP ${response.status}`);
    }

    return data.result;
  }

  async request(method, payload = {}) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return this.parseResponse(method, response);
  }

  async requestMultipart(method, fields, { fieldName, filePath, fileName, contentType, onProgress } = {}) {
    const upload = await createMultipartUpload({ fields, fieldName, filePath, fileName, contentType, onProgress });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.mediaTransferTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: upload.headers,
        body: upload.body,
        duplex: 'half',
        signal: controller.signal
      });
      return await this.parseResponse(method, response);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new TelegramApiError(method, 'истекло время передачи большого файла');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async requestMultipartFiles(method, fields, files, { onProgress } = {}) {
    const upload = await createMultipartUploadFiles({ fields, files, onProgress });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.mediaTransferTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: upload.headers,
        body: upload.body,
        duplex: 'half',
        signal: controller.signal
      });
      return await this.parseResponse(method, response);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new TelegramApiError(method, 'истекло время передачи медиаальбома');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  getUpdates(offset, allowedUpdates = [
    'message',
    'callback_query',
    'channel_post',
    'edited_channel_post',
    'business_connection',
    'business_message',
    'edited_business_message',
    'deleted_business_messages'
  ]) {
    return this.request('getUpdates', {
      offset,
      timeout: 50,
      allowed_updates: allowedUpdates
    });
  }

  sendBotText(chatId, text, options = {}) {
    return this.request('sendMessage', { chat_id: chatId, text, ...options });
  }

  sendBotMediaUrl({ chatId, kind, url, caption }) {
    const methods = {
      photo: ['sendPhoto', 'photo'],
      video: ['sendVideo', 'video'],
      animation: ['sendAnimation', 'animation'],
      document: ['sendDocument', 'document']
    };
    const selected = methods[kind];
    if (!selected) throw new TelegramApiError('sendBotMediaUrl', `unsupported media kind ${kind}`);
    const [method, field] = selected;
    return this.request(method, {
      chat_id: chatId,
      [field]: url,
      ...(caption ? { caption } : {})
    });
  }

  sendBotMediaGroup(chatId, media) {
    return this.request('sendMediaGroup', { chat_id: chatId, media });
  }

  sendBotMediaFile({ chatId, kind, filePath, fileName, contentType, caption }) {
    const methods = {
      photo: ['sendPhoto', 'photo'],
      video: ['sendVideo', 'video'],
      animation: ['sendAnimation', 'animation'],
      document: ['sendDocument', 'document']
    };
    const selected = methods[kind];
    if (!selected) throw new TelegramApiError('sendBotMediaFile', `unsupported media kind ${kind}`);
    const [method, fieldName] = selected;
    return this.requestMultipart(method, {
      chat_id: chatId,
      ...(caption ? { caption } : {}),
      ...(kind === 'video' ? { supports_streaming: true } : {})
    }, { fieldName, filePath, fileName, contentType });
  }

  sendBotMediaGroupFiles(chatId, items) {
    if (!Array.isArray(items) || items.length < 2 || items.length > 10) {
      throw new TelegramApiError('sendMediaGroup', 'media group must contain from 2 to 10 files');
    }
    const media = items.map((item, index) => ({
      type: item.kind,
      media: `attach://media${index}`,
      ...(item.caption ? { caption: item.caption } : {}),
      ...(item.kind === 'video' ? { supports_streaming: true } : {})
    }));
    const files = items.map((item, index) => ({
      fieldName: `media${index}`,
      filePath: item.filePath,
      fileName: item.fileName,
      contentType: item.contentType
    }));
    return this.requestMultipartFiles('sendMediaGroup', { chat_id: chatId, media }, files);
  }

  setMyCommands(commands) {
    return this.request('setMyCommands', { commands });
  }

  answerCallbackQuery(callbackQueryId, text) {
    return this.request('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
  }

  sendBusinessText({ businessConnectionId, chatId, text, replyToMessageId }) {
    return this.request('sendMessage', {
      business_connection_id: businessConnectionId,
      chat_id: chatId,
      text,
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {})
    });
  }

  editBusinessText({ businessConnectionId, chatId, messageId, text }) {
    return this.request('editMessageText', {
      business_connection_id: businessConnectionId,
      chat_id: chatId,
      message_id: messageId,
      text
    });
  }

  deleteBusinessMessages({ businessConnectionId, messageIds }) {
    return this.request('deleteBusinessMessages', {
      business_connection_id: businessConnectionId,
      message_ids: messageIds
    });
  }

  async downloadFile(fileId, destinationPath, { maxBytes, onProgress, totalBytesHint = 0 } = {}) {
    const waitingStartedAt = Date.now();
    const waitingTimer = onProgress ? setInterval(() => {
      onProgress({ bytes: 0, totalBytes: Number(totalBytesHint) || 0, waiting: true, elapsedMs: Date.now() - waitingStartedAt, force: true });
    }, 1000) : null;
    waitingTimer?.unref?.();

    let file;
    try {
      file = await this.request('getFile', { file_id: fileId });
    } finally {
      if (waitingTimer) clearInterval(waitingTimer);
    }
    if (!file.file_path) {
      throw new TelegramApiError('getFile', 'Telegram did not return file_path');
    }
    if (maxBytes && file.file_size && file.file_size > maxBytes) {
      throw new TelegramApiError('getFile', `file is larger than ${maxBytes} bytes`);
    }

    if (path.isAbsolute(file.file_path)) {
      if (!this.localFilesRoot) {
        throw new TelegramApiError(
          'getFile',
          'local Telegram server returned an absolute path, but TELEGRAM_LOCAL_FILES_ROOT is not configured'
        );
      }

      const sourcePath = path.resolve(file.file_path);
      const relativePath = path.relative(this.localFilesRoot, sourcePath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new TelegramApiError('getFile', 'local Telegram server returned a path outside its shared directory');
      }

      const sourceStat = await stat(sourcePath);
      if (maxBytes && sourceStat.size > maxBytes) {
        throw new TelegramApiError('getFile', `file is larger than ${maxBytes} bytes`);
      }

      let bytes = 0;
      const announcedSize = Number(sourceStat.size) || Number(file.file_size) || Number(totalBytesHint) || 0;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          onProgress?.({ bytes, totalBytes: announcedSize });
          if (maxBytes && bytes > maxBytes) {
            callback(new TelegramApiError('downloadFile', `file is larger than ${maxBytes} bytes`));
            return;
          }
          callback(null, chunk);
        }
      });
      await pipeline(createReadStream(sourcePath), limiter, createWriteStream(destinationPath));
      onProgress?.({ bytes, totalBytes: announcedSize || bytes, done: true, force: true });
      return { ...file, bytesDownloaded: bytes };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.mediaTransferTimeoutMs);
    try {
      const response = await fetch(`${this.fileBaseUrl}/${file.file_path}`, { signal: controller.signal });
      if (!response.ok || !response.body) {
        throw new TelegramApiError('downloadFile', `HTTP ${response.status}`);
      }

      let bytes = 0;
      const announcedSize = Number(response.headers.get('content-length')) || Number(file.file_size) || Number(totalBytesHint) || 0;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          onProgress?.({ bytes, totalBytes: announcedSize });
          if (maxBytes && bytes > maxBytes) {
            callback(new TelegramApiError('downloadFile', `file is larger than ${maxBytes} bytes`));
            return;
          }
          callback(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destinationPath));
      onProgress?.({ bytes, totalBytes: announcedSize || bytes, done: true, force: true });
      return { ...file, bytesDownloaded: bytes };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new TelegramApiError('downloadFile', 'истекло время скачивания большого файла');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  sendBusinessMedia({
    businessConnectionId,
    chatId,
    telegramKind,
    filePath,
    fileName,
    contentType,
    caption,
    replyToMessageId,
    onProgress
  }) {
    const methods = {
      photo: 'sendPhoto',
      video: 'sendVideo',
      animation: 'sendAnimation',
      audio: 'sendAudio',
      voice: 'sendVoice',
      document: 'sendDocument'
    };
    const method = methods[telegramKind];
    if (!method) throw new TelegramApiError('sendBusinessMedia', `unsupported media kind ${telegramKind}`);

    return this.requestMultipart(method, {
      business_connection_id: businessConnectionId,
      chat_id: chatId,
      caption,
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {})
    }, {
      fieldName: telegramKind,
      filePath,
      fileName,
      contentType,
      onProgress
    });
  }

  sendBusinessLocation({ businessConnectionId, chatId, latitude, longitude, replyToMessageId }) {
    return this.request('sendLocation', {
      business_connection_id: businessConnectionId,
      chat_id: chatId,
      latitude,
      longitude,
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {})
    });
  }
}
