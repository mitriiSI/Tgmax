import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm, stat, statfs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createMultipartUpload } from './multipart.js';

export const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_NATIVE_VIDEO_LIMIT_BYTES = 20 * 1024 * 1024;
const DEFAULT_TRANSFER_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_NATIVE_UPLOAD_LIMITS = {
  image: 50_000_000,
  video: 250_000_000,
  audio: 256_000_000,
  file: 4_000_000_000
};

const MIME_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/webm', '.webm'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/x-m4a', '.m4a'],
  ['audio/ogg', '.ogg'],
  ['application/ogg', '.ogg'],
  ['application/pdf', '.pdf'],
  ['application/zip', '.zip']
]);

const EXTENSION_MIME_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.zip': 'application/zip'
};

export class MediaRelayError extends Error {
  constructor(userMessage, cause) {
    super(userMessage, cause ? { cause } : undefined);
    this.name = 'MediaRelayError';
    this.userMessage = userMessage;
  }
}

function formatLimit(maxBytes) {
  const megabytes = maxBytes / (1024 * 1024);
  return Number.isInteger(megabytes) ? `${megabytes} МБ` : `${maxBytes} байт`;
}

function mediaScore(file) {
  return file?.file_size ?? ((file?.width ?? 0) * (file?.height ?? 0));
}

function extensionFor(fileName, mimeType, fallback) {
  const existing = path.extname(fileName ?? '');
  return existing || MIME_EXTENSIONS.get(mimeType) || fallback;
}

export function safeFileName(fileName, fallbackBase = 'file', fallbackExtension = '') {
  const baseName = path.basename(fileName || fallbackBase)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .trim()
    .slice(0, 140) || fallbackBase;
  return path.extname(baseName) || !fallbackExtension ? baseName : `${baseName}${fallbackExtension}`;
}

function telegramMedia({ message, field, maxKind, label, fallbackExtension, fallbackBase }) {
  const value = message[field];
  if (!value) return null;

  const file = Array.isArray(value)
    ? value.reduce((largest, candidate) => mediaScore(candidate) >= mediaScore(largest) ? candidate : largest)
    : value;
  const mimeType = file.mime_type;
  const extension = extensionFor(file.file_name, mimeType, fallbackExtension);
  const fileName = safeFileName(
    file.file_name,
    `${fallbackBase}-${message.message_id ?? Date.now()}`,
    extension
  );

  return {
    field,
    maxKind,
    label,
    fileId: file.file_id,
    fileName,
    fileSize: file.file_size,
    mimeType,
    isGif: field === 'animation' || mimeType === 'image/gif' || path.extname(file.file_name ?? '').toLowerCase() === '.gif',
    isStaticSticker: field === 'sticker' && !file.is_animated && !file.is_video
  };
}

export function telegramMediaFromMessage(message) {
  if (message.photo?.length) {
    return telegramMedia({
      message,
      field: 'photo',
      maxKind: 'image',
      label: 'фото',
      fallbackBase: 'telegram-photo',
      fallbackExtension: '.jpg'
    });
  }

  const documentIsGif = message.document && (
    message.document.mime_type === 'image/gif' ||
    path.extname(message.document.file_name ?? '').toLowerCase() === '.gif'
  );
  if (documentIsGif) {
    return telegramMedia({
      message,
      field: 'document',
      maxKind: 'video',
      label: 'GIF',
      fallbackBase: 'telegram-gif',
      fallbackExtension: '.gif'
    });
  }

  const animationExtension = message.animation?.mime_type === 'image/gif' ? '.gif' : '.mp4';
  const stickerKind = message.sticker?.is_video ? 'video' : message.sticker?.is_animated ? 'file' : 'image';
  const candidates = [
    ['video', 'video', 'видео', '.mp4', 'telegram-video'],
    ['video_note', 'video', 'видеосообщение', '.mp4', 'telegram-video-message'],
    ['voice', 'audio', 'голосовое', '.ogg', 'telegram-voice'],
    ['audio', 'file', 'аудио', '.mp3', 'telegram-audio'],
    ['animation', 'video', 'GIF', animationExtension, 'telegram-gif'],
    ['document', 'file', 'файл', '', 'telegram-document'],
    ['sticker', stickerKind, 'стикер', message.sticker?.is_animated ? '.tgs' : message.sticker?.is_video ? '.webm' : '.webp', 'telegram-sticker']
  ];

  for (const [field, maxKind, label, fallbackExtension, fallbackBase] of candidates) {
    const media = telegramMedia({ message, field, maxKind, label, fallbackExtension, fallbackBase });
    if (media) return media;
  }
  return null;
}

async function createTempTarget(dataDir, prefix, fileName) {
  await mkdir(dataDir, { recursive: true });
  const directory = await mkdtemp(path.join(dataDir, prefix));
  return { directory, filePath: path.join(directory, fileName) };
}

export async function archiveMediaFile({ filePath, fileName, mimeType, kind, dataDir, move = false }) {
  const directory = path.join(dataDir, 'history');
  await mkdir(directory, { recursive: true });
  const extension = path.extname(fileName ?? '').slice(0, 12);
  const storedName = `${randomUUID()}${extension}`;
  const destination = path.join(directory, storedName);
  if (move) {
    try {
      await rename(filePath, destination);
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error;
      await copyFile(filePath, destination);
      await rm(filePath, { force: true });
    }
  } else {
    await copyFile(filePath, destination);
  }
  const fileStat = await stat(destination);
  return {
    id: randomUUID(),
    storedName,
    fileName: safeFileName(fileName, 'media', extension),
    mimeType: mimeType || EXTENSION_MIME_TYPES[extension.toLowerCase()] || 'application/octet-stream',
    kind: kind || 'file',
    size: fileStat.size
  };
}

function bytesToHuman(bytes) {
  const gigabytes = bytes / (1024 * 1024 * 1024);
  if (gigabytes >= 1) return `${gigabytes.toFixed(gigabytes >= 10 ? 0 : 1)} ГБ`;
  return `${Math.ceil(bytes / (1024 * 1024))} МБ`;
}

async function ensureDiskSpace(dataDir, requiredBytes, reserveBytes = 0) {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) return;
  try {
    const info = await statfs(dataDir);
    const availableBytes = Number(info.bavail) * Number(info.bsize);
    const totalNeeded = requiredBytes + Math.max(0, reserveBytes);
    if (availableBytes < totalNeeded) {
      throw new MediaRelayError(
        `недостаточно места на диске: свободно ${bytesToHuman(availableBytes)}, нужно не менее ${bytesToHuman(totalNeeded)}`
      );
    }
  } catch (error) {
    if (error instanceof MediaRelayError) throw error;
    // Some Android filesystems do not expose statfs correctly. The stream itself
    // will still report ENOSPC if the disk becomes full.
  }
}

export async function removeTempDirectory(directory) {
  if (directory) await rm(directory, { recursive: true, force: true });
}

function runFfmpeg(argumentsList) {
  return new Promise((resolve, reject) => {
    const process = spawn('ffmpeg', argumentsList, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    process.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    process.once('error', reject);
    process.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

const CIRCULAR_VIDEO_FILTER = "crop='trunc(min(iw,ih)/2)*2':'trunc(min(iw,ih)/2)*2',scale=640:640:flags=lanczos,geq=r='if(lte(hypot(X-W/2,Y-H/2),min(W,H)/2),r(X,Y),0)':g='if(lte(hypot(X-W/2,Y-H/2),min(W,H)/2),g(X,Y),0)':b='if(lte(hypot(X-W/2,Y-H/2),min(W,H)/2),b(X,Y),0)',pad=720:720:40:40:black,setsar=1,format=yuv420p";

export async function makeRoundVideoMessage(inputPath, outputPath) {
  await runFfmpeg([
    '-hide_banner',
    '-loglevel', 'error',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', CIRCULAR_VIDEO_FILTER,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '21',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-shortest',
    '-y', outputPath
  ]);
}

export async function makeMaxVideoMessage(inputPath, outputPath) {
  await runFfmpeg([
    '-hide_banner',
    '-loglevel', 'error',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', CIRCULAR_VIDEO_FILTER,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '21',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-shortest',
    '-y', outputPath
  ]);
}

export async function makeGifVideo(inputPath, outputPath) {
  await runFfmpeg([
    '-hide_banner',
    '-loglevel', 'error',
    '-i', inputPath,
    '-an',
    '-vf', "scale='trunc(iw/2)*2':'trunc(ih/2)*2':flags=lanczos,format=yuv420p",
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '21',
    '-movflags', '+faststart',
    '-y', outputPath
  ]);
}

export async function makeStickerImage(inputPath, outputPath) {
  await runFfmpeg([
    '-hide_banner',
    '-loglevel', 'error',
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', 'format=rgba',
    '-c:v', 'png',
    '-y', outputPath
  ]);
}

export async function makeVoiceMessage(inputPath, outputPath) {
  await runFfmpeg([
    '-hide_banner',
    '-loglevel', 'error',
    '-i', inputPath,
    '-map', '0:a:0',
    '-vn',
    '-ac', '1',
    '-ar', '48000',
    '-c:a', 'libopus',
    '-b:a', '48k',
    '-vbr', 'on',
    '-application', 'voip',
    '-f', 'ogg',
    '-y', outputPath
  ]);
}

function runProgram(command, argumentsList) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, argumentsList, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    process.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    process.once('error', reject);
    process.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

export async function packageAsZip({ inputPath, outputPath }) {
  await runProgram('zip', ['-0', '-j', '-q', outputPath, inputPath]);
  const result = await stat(outputPath);
  if (!result.size) throw new Error('ZIP archive is empty');
  return result;
}

function tokenFromUpload(payload) {
  if (typeof payload?.token === 'string' && payload.token) return payload.token;
  if (typeof payload?.retval?.token === 'string' && payload.retval.token) return payload.retval.token;
  const photoValues = Object.values(payload?.photos ?? {});
  for (const photo of photoValues) {
    if (typeof photo === 'string' && photo) return photo;
    if (typeof photo?.token === 'string' && photo.token) return photo.token;
  }
  return undefined;
}

export function maxUploadKindForSize(kind, fileSize) {
  const limit = MAX_NATIVE_UPLOAD_LIMITS[kind];
  return limit && Number.isFinite(fileSize) && fileSize > limit ? 'file' : kind;
}

export async function uploadFileToMax({
  maxBot,
  kind,
  filePath,
  fileName,
  mimeType,
  timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS,
  onProgress
}) {
  const endpoint = await maxBot.api.raw.uploads.getUploadUrl({ type: kind });
  if (!endpoint?.url) throw new Error('MAX did not return an upload URL');
  const upload = await createMultipartUpload({
    fieldName: 'data',
    filePath,
    fileName,
    contentType: mimeType || 'application/octet-stream',
    onProgress
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(endpoint.url, {
      method: 'POST',
      headers: upload.headers,
      body: upload.body,
      duplex: 'half',
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('MAX upload timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  let payload = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const description = payload.message || payload.error || `HTTP ${response.status}`;
    throw new Error(`MAX upload failed: ${description}`);
  }

  const token = endpoint.token || tokenFromUpload(payload);
  if (!token) {
    const fields = Object.keys(payload).join(', ') || 'empty response';
    throw new Error(`MAX upload response has no token (${fields})`);
  }
  return { type: kind, payload: { token } };
}

export async function uploadTelegramMediaToMax({
  telegram,
  maxBot,
  media,
  dataDir,
  maxBytes = TELEGRAM_DOWNLOAD_LIMIT_BYTES,
  timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS,
  diskReserveBytes = 0,
  onDownloadProgress,
  onUploadProgress,
  onStage
}) {
  if (!media?.fileId) return null;
  if (media.fileSize && media.fileSize > maxBytes) {
    throw new MediaRelayError(`файл больше установленного лимита ${formatLimit(maxBytes)}`);
  }

  const temp = await createTempTarget(dataDir, 'telegram-media-', media.fileName);
  try {
    await ensureDiskSpace(dataDir, media.fileSize, diskReserveBytes);
    onStage?.({ stage: 'download', status: 'started', message: 'Скачивание файла из Telegram' });
    await telegram.downloadFile(media.fileId, temp.filePath, {
      maxBytes,
      totalBytesHint: media.fileSize,
      onProgress: onDownloadProgress
    });
    onStage?.({ stage: 'download', status: 'completed', message: 'Файл скачан из Telegram' });

    let uploadPath = temp.filePath;
    let uploadFileName = media.fileName;
    let uploadMimeType = media.mimeType;
    if (media.field === 'video_note') {
      onStage?.({ stage: 'convert', status: 'started', message: 'Подготовка видеосообщения' });
      const roundPath = path.join(temp.directory, 'telegram-video-message.mp4');
      try {
        await makeRoundVideoMessage(temp.filePath, roundPath);
        uploadPath = roundPath;
        uploadFileName = 'telegram-video-message.mp4';
        uploadMimeType = 'video/mp4';
      } catch {
        // If ffmpeg cannot process a particular clip, preserve and send the original video.
      }
      onStage?.({ stage: 'convert', status: 'completed', message: 'Видеосообщение подготовлено' });
    }
    if (media.isGif) {
      onStage?.({ stage: 'convert', status: 'started', message: 'Преобразование GIF в MP4' });
      const gifVideoPath = path.join(temp.directory, 'telegram-gif.mp4');
      try {
        await makeGifVideo(temp.filePath, gifVideoPath);
        uploadPath = gifVideoPath;
        uploadFileName = 'telegram-gif.mp4';
        uploadMimeType = 'video/mp4';
      } catch (error) {
        throw new MediaRelayError('не удалось преобразовать GIF в MP4', error);
      }
      onStage?.({ stage: 'convert', status: 'completed', message: 'GIF преобразован в MP4' });
    }
    if (media.isStaticSticker) {
      onStage?.({ stage: 'convert', status: 'started', message: 'Преобразование стикера в PNG' });
      const stickerImagePath = path.join(temp.directory, 'telegram-sticker.png');
      try {
        await makeStickerImage(temp.filePath, stickerImagePath);
        uploadPath = stickerImagePath;
        uploadFileName = 'telegram-sticker.png';
        uploadMimeType = 'image/png';
      } catch {
        // If conversion fails, the upload fallback below preserves the original WebP file.
      }
      onStage?.({ stage: 'convert', status: 'completed', message: 'Стикер подготовлен' });
    }

    const uploadStat = await stat(uploadPath);
    if (uploadStat.size > maxBytes) {
      throw new MediaRelayError(`файл после обработки больше установленного лимита ${formatLimit(maxBytes)}`);
    }
    let preferredKind = maxUploadKindForSize(media.maxKind, uploadStat.size);
    let packagedAsZip = false;
    const originalFileName = uploadFileName;

    // MAX accepts native video only up to 250 MB and native audio only up to 256 MB.
    // Uploading a large MP4/M4A with type=file may be rejected by MAX because the
    // extension is not allowed for the generic-file endpoint. Store-only ZIP keeps
    // the original bytes intact and uses a format that the file endpoint accepts.
    if (preferredKind === 'file' && media.maxKind !== 'file') {
      onStage?.({ stage: 'package', status: 'started', message: 'Упаковка большого медиафайла в ZIP для MAX' });
      await ensureDiskSpace(dataDir, uploadStat.size, diskReserveBytes);
      const zipName = safeFileName(`${uploadFileName}.zip`, 'telegram-media.zip', '.zip');
      const zipPath = path.join(temp.directory, zipName);
      try {
        await packageAsZip({ inputPath: uploadPath, outputPath: zipPath });
      } catch (error) {
        throw new MediaRelayError('не удалось упаковать большой файл в ZIP перед отправкой в MAX', error);
      }
      uploadPath = zipPath;
      uploadFileName = zipName;
      uploadMimeType = 'application/zip';
      preferredKind = 'file';
      packagedAsZip = true;
      onStage?.({ stage: 'package', status: 'completed', message: 'Большой медиафайл упакован в ZIP без сжатия' });
    }

    let maxAttachment;
    try {
      maxAttachment = await uploadFileToMax({
        maxBot,
        kind: preferredKind,
        filePath: uploadPath,
        fileName: uploadFileName,
        mimeType: uploadMimeType,
        timeoutMs,
        onProgress: onUploadProgress
      });
    } catch (error) {
      if (preferredKind === 'file') throw error;
      // If MAX rejects a native format, retry as a real ZIP file rather than merely
      // changing type=video/audio to type=file while keeping a forbidden extension.
      onStage?.({ stage: 'package', status: 'started', message: 'Повторная упаковка вложения в ZIP для MAX' });
      await ensureDiskSpace(dataDir, uploadStat.size, diskReserveBytes);
      const zipName = safeFileName(`${uploadFileName}.zip`, 'telegram-media.zip', '.zip');
      const zipPath = path.join(temp.directory, zipName);
      await packageAsZip({ inputPath: uploadPath, outputPath: zipPath });
      uploadPath = zipPath;
      uploadFileName = zipName;
      uploadMimeType = 'application/zip';
      packagedAsZip = true;
      maxAttachment = await uploadFileToMax({
        maxBot,
        kind: 'file',
        filePath: uploadPath,
        fileName: uploadFileName,
        mimeType: uploadMimeType,
        timeoutMs,
        onProgress: onUploadProgress
      });
      onStage?.({ stage: 'package', status: 'completed', message: 'Вложение упаковано в ZIP и повторно загружено' });
    }
    const historyMedia = await archiveMediaFile({
      filePath: uploadPath,
      fileName: uploadFileName,
      mimeType: uploadMimeType,
      kind: packagedAsZip ? 'file' : media.maxKind,
      dataDir,
      move: true
    });
    return { maxAttachment, historyMedia, packagedAsZip, originalFileName };
  } catch (error) {
    if (error instanceof MediaRelayError) throw error;
    throw new MediaRelayError(`не удалось передать ${media.label}: ${String(error?.message || error).slice(0, 300)}`, error);
  } finally {
    await removeTempDirectory(temp.directory);
  }
}

class SizeLimitTransform extends Transform {
  constructor(maxBytes, userMessage) {
    super();
    this.maxBytes = maxBytes;
    this.userMessage = userMessage;
    this.bytes = 0;
  }

  _transform(chunk, encoding, callback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new MediaRelayError(this.userMessage));
      return;
    }
    callback(null, chunk);
  }
}

function nameFromUrl(url, fallback) {
  try {
    return decodeURIComponent(path.basename(new URL(url).pathname)) || fallback;
  } catch {
    return fallback;
  }
}

export function isMaxVideoMessageAttachment(attachment) {
  const type = String(attachment?.type ?? '').toLowerCase();
  if (['video_message', 'video_note', 'circle'].includes(type)) return true;
  if (type !== 'video') return false;

  const payload = attachment?.payload ?? {};
  const explicitMarkers = [
    attachment?.is_video_message,
    attachment?.isVideoMessage,
    attachment?.video_message,
    attachment?.videoMessage,
    payload?.is_video_message,
    payload?.isVideoMessage,
    payload?.video_message,
    payload?.videoMessage,
    payload?.type
  ];
  if (explicitMarkers.some((value) => value === true || ['video_message', 'video_note', 'circle'].includes(String(value).toLowerCase()))) {
    return true;
  }

  // Do not infer a video message only from square dimensions. Ordinary square
  // videos were previously mistaken for circles and passed through FFmpeg,
  // which changed their frame and rotation. MAX must provide an explicit marker.
  return false;
}


export function isMaxVoiceAttachment(attachment) {
  const type = String(attachment?.type ?? '').toLowerCase();
  if (['voice', 'voice_message', 'audio_message'].includes(type)) return true;
  if (type !== 'audio') return false;
  const payload = attachment?.payload ?? {};
  const marker = String(payload.type ?? payload.media_type ?? attachment?.subtype ?? '').toLowerCase();
  if (['voice', 'voice_message', 'audio_message'].includes(marker)) return true;
  const name = String(attachment?.filename ?? payload.filename ?? '').toLowerCase();
  const noMusicMetadata = !payload.title && !payload.artist && !attachment?.title && !attachment?.artist;
  return noMusicMetadata && (!name || /\.(ogg|opus|oga|m4a|aac)$/.test(name));
}

export function maxDownloadableAttachment(attachment, index = 0) {
  const defaults = {
    image: { telegramKind: 'photo', extension: '.jpg', base: 'max-image' },
    video: { telegramKind: 'video', extension: '.mp4', base: 'max-video' },
    video_message: { telegramKind: 'video', extension: '.mp4', base: 'max-video-message' },
    video_note: { telegramKind: 'video', extension: '.mp4', base: 'max-video-message' },
    circle: { telegramKind: 'video', extension: '.mp4', base: 'max-video-message' },
    audio: { telegramKind: 'audio', extension: '.m4a', base: 'max-audio' },
    voice: { telegramKind: 'voice', extension: '.ogg', base: 'max-voice' },
    voice_message: { telegramKind: 'voice', extension: '.ogg', base: 'max-voice' },
    audio_message: { telegramKind: 'voice', extension: '.ogg', base: 'max-voice' },
    file: { telegramKind: 'document', extension: '', base: 'max-file' },
    sticker: { telegramKind: 'document', extension: '.webp', base: 'max-sticker' }
  };
  const baseInfo = defaults[attachment?.type];
  if (!baseInfo) return null;
  const info = isMaxVoiceAttachment(attachment)
    ? { telegramKind: 'voice', extension: '.ogg', base: 'max-voice' }
    : baseInfo;

  let url = attachment.payload?.url || attachment.payload?.file_url || attachment.url;
  if (!url) return null;
  if (String(url).startsWith('//')) url = `https:${url}`;
  const fallbackName = `${info.base}-${index + 1}`;
  const originalName = attachment.filename || attachment.payload?.filename || nameFromUrl(url, fallbackName);
  // Do not pretend an extensionless MAX voice is already OGG. It may actually be
  // M4A/AAC; FFmpeg will inspect the bytes and create a genuine OGG/Opus file.
  const fallbackExtension = info.telegramKind === 'voice' ? '.bin' : info.extension;
  const extension = extensionFor(originalName, undefined, fallbackExtension);
  return {
    url,
    telegramKind: info.telegramKind,
    fileName: safeFileName(originalName, fallbackName, extension),
    isVideoMessage: isMaxVideoMessageAttachment(attachment)
  };
}

// Telegram may process media sent through sendVideo. For large videos received
// from MAX, use sendDocument so the original bytes, aspect ratio and rotation
// metadata reach Telegram unchanged.
export function telegramKindForMaxRelay({ telegramKind, size } = {}) {
  if (telegramKind === 'video' && Number(size) > TELEGRAM_NATIVE_VIDEO_LIMIT_BYTES) {
    return 'document';
  }
  return telegramKind;
}

export async function downloadMaxAttachment({
  attachment,
  index,
  dataDir,
  maxBytes = TELEGRAM_UPLOAD_LIMIT_BYTES,
  timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS,
  diskReserveBytes = 0,
  onProgress
}) {
  const info = maxDownloadableAttachment(attachment, index);
  if (!info) return null;
  const temp = await createTempTarget(dataDir, 'max-media-', info.fileName);

  try {
    const retryDelaysMs = [0, 1_000, 2_500, 5_000, 10_000, 20_000];
    let lastError;
    for (const delayMs of retryDelaysMs) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(info.url, { signal: controller.signal });
        if (!response.ok || !response.body) {
          const retryable = [403, 404, 408, 409, 425, 429, 500, 502, 503, 504].includes(response.status);
          const error = new Error(`HTTP ${response.status}`);
          if (!retryable) throw error;
          lastError = error;
          continue;
        }
        const announcedSize = Number(response.headers.get('content-length'));
        const limitMessage = `файл из MAX больше установленного лимита ${formatLimit(maxBytes)}`;
        if (Number.isFinite(announcedSize) && announcedSize > maxBytes) {
          throw new MediaRelayError(limitMessage);
        }
        await ensureDiskSpace(dataDir, announcedSize, diskReserveBytes);

        const limiter = new SizeLimitTransform(maxBytes, limitMessage);
        limiter.on('data', () => onProgress?.({ bytes: limiter.bytes, totalBytes: announcedSize || 0 }));
        await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(temp.filePath));
        onProgress?.({ bytes: limiter.bytes, totalBytes: announcedSize || limiter.bytes, done: true });
        const fileStat = await stat(temp.filePath);
        return {
          ...temp,
          ...info,
          contentType: response.headers.get('content-type') || undefined,
          size: fileStat.size
        };
      } catch (error) {
        if (error?.name === 'AbortError') lastError = new Error('истекло время одной попытки скачивания');
        else if (error instanceof MediaRelayError) throw error;
        else lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new MediaRelayError(`MAX не подготовил ссылку на вложение после повторных попыток: ${lastError?.message || 'неизвестная ошибка'}`, lastError);
  } catch (error) {
    await removeTempDirectory(temp.directory);
    if (error instanceof MediaRelayError) throw error;
    throw new MediaRelayError('не удалось скачать вложение из MAX', error);
  }
}

export function maxAttachmentAsText(attachment) {
  if (attachment?.type === 'share' && attachment.payload?.url) {
    return attachment.payload.url;
  }
  if (attachment?.type === 'contact') {
    return attachment.payload?.vcf_info || '[Контакт из MAX]';
  }
  return null;
}
