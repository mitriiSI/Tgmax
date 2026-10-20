import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isMaxVideoMessageAttachment,
  isMaxVoiceAttachment,
  maxDownloadableAttachment,
  maxUploadKindForSize,
  makeVoiceMessage,
  packageAsZip,
  safeFileName,
  telegramKindForMaxRelay,
  telegramMediaFromMessage,
  uploadTelegramMediaToMax
} from '../src/media.js';

test('telegramMediaFromMessage chooses the largest Telegram photo', () => {
  const media = telegramMediaFromMessage({
    message_id: 17,
    photo: [
      { file_id: 'small', file_size: 100, width: 90, height: 90 },
      { file_id: 'large', file_size: 1000, width: 1280, height: 720 }
    ]
  });

  assert.equal(media.fileId, 'large');
  assert.equal(media.maxKind, 'image');
  assert.equal(media.fileName, 'telegram-photo-17.jpg');
});

test('Telegram media types are mapped to MAX upload types', () => {
  const cases = [
    [{ video: { file_id: '1', file_name: 'clip.mp4' } }, 'video'],
    [{ video_note: { file_id: '2' } }, 'video'],
    [{ voice: { file_id: '3', mime_type: 'audio/ogg' } }, 'audio'],
    [{ audio: { file_id: '4', file_name: 'song.mp3' } }, 'file'],
    [{ document: { file_id: '5', file_name: 'report.pdf' } }, 'file'],
    [{ animation: { file_id: '6', mime_type: 'image/gif' } }, 'video'],
    [{ sticker: { file_id: '7', is_video: true } }, 'video']
  ];

  for (const [message, expectedKind] of cases) {
    assert.equal(telegramMediaFromMessage({ message_id: 1, ...message }).maxKind, expectedKind);
  }

  assert.equal(
    telegramMediaFromMessage({ message_id: 1, video_note: { file_id: 'note' } }).label,
    'видеосообщение'
  );

  const telegramGif = telegramMediaFromMessage({
    message_id: 2,
    animation: { file_id: 'animation', file_name: 'animation.mp4', mime_type: 'video/mp4' },
    document: { file_id: 'legacy-document', file_name: 'animation.mp4', mime_type: 'video/mp4' }
  });
  assert.equal(telegramGif.field, 'animation');
  assert.equal(telegramGif.maxKind, 'video');
  assert.equal(telegramGif.label, 'GIF');

  const staticSticker = telegramMediaFromMessage({
    message_id: 3,
    sticker: { file_id: 'sticker', is_animated: false, is_video: false }
  });
  assert.equal(staticSticker.maxKind, 'image');
  assert.equal(staticSticker.isStaticSticker, true);
});

test('MAX media attachment supplies Telegram kind and safe filename', () => {
  const video = maxDownloadableAttachment({
    type: 'video',
    payload: { url: 'https://cdn.example.test/path/movie.mp4?token=secret' }
  });
  assert.equal(video.telegramKind, 'video');
  assert.equal(video.fileName, 'movie.mp4');

  const file = maxDownloadableAttachment({
    type: 'file',
    filename: '../bad:name.pdf',
    payload: { url: 'https://cdn.example.test/file' }
  });
  assert.equal(file.fileName, 'bad_name.pdf');
});

test('large MAX video is relayed as an unchanged Telegram document', () => {
  assert.equal(telegramKindForMaxRelay({ telegramKind: 'video', size: 20 * 1024 * 1024 }), 'video');
  assert.equal(telegramKindForMaxRelay({ telegramKind: 'video', size: 20 * 1024 * 1024 + 1 }), 'document');
  assert.equal(telegramKindForMaxRelay({ telegramKind: 'photo', size: 25 * 1024 * 1024 }), 'photo');
});

test('MAX video messages are detected and mapped to ordinary Telegram video', () => {
  const explicit = maxDownloadableAttachment({
    type: 'video_message',
    payload: { url: 'https://cdn.example.test/video-message' }
  });
  assert.equal(explicit.telegramKind, 'video');
  assert.equal(explicit.isVideoMessage, true);
  assert.equal(explicit.fileName, 'video-message.mp4');

  assert.equal(isMaxVideoMessageAttachment({
    type: 'video',
    width: 480,
    height: 480,
    duration: 32,
    payload: { url: 'https://cdn.example.test/video' }
  }), false);
  assert.equal(isMaxVideoMessageAttachment({
    type: 'video',
    width: 480,
    height: 480,
    duration: 32,
    payload: { url: 'https://cdn.example.test/video', is_video_message: true }
  }), true);
  assert.equal(isMaxVideoMessageAttachment({
    type: 'video',
    width: 1920,
    height: 1080,
    duration: 32,
    payload: { url: 'https://cdn.example.test/video' }
  }), false);
});



test('MAX voice messages are detected and mapped to Telegram voice', () => {
  const explicit = maxDownloadableAttachment({
    type: 'voice',
    payload: { url: 'https://cdn.example.test/voice/123' }
  });
  assert.equal(explicit.telegramKind, 'voice');
  assert.equal(explicit.fileName, '123.bin');
  assert.equal(isMaxVoiceAttachment({ type: 'voice_message', payload: {} }), true);
  assert.equal(isMaxVoiceAttachment({ type: 'audio', payload: { url: 'https://cdn.example.test/no-name' } }), true);
  assert.equal(isMaxVoiceAttachment({ type: 'audio', filename: 'song.mp3', payload: { title: 'Song', artist: 'Artist' } }), false);
});
test('safeFileName adds an extension and removes Windows-reserved characters', () => {
  assert.equal(safeFileName('voice:note', 'voice', '.ogg'), 'voice_note.ogg');
});

test('oversized native MAX media is sent as a file before uploading', () => {
  assert.equal(maxUploadKindForSize('image', 50_000_000), 'image');
  assert.equal(maxUploadKindForSize('image', 50_000_001), 'file');
  assert.equal(maxUploadKindForSize('video', 250_000_001), 'file');
  assert.equal(maxUploadKindForSize('audio', 256_000_001), 'file');
  assert.equal(maxUploadKindForSize('file', 2 * 1024 * 1024 * 1024), 'file');
});

test('Telegram media is downloaded, uploaded to MAX and then removed locally', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bridge-media-test-'));
  const originalFetch = globalThis.fetch;
  const telegram = {
    async downloadFile(fileId, destination) {
      assert.equal(fileId, 'telegram-file-id');
      await writeFile(destination, 'video bytes');
    }
  };
  const maxBot = {
    api: {
      raw: {
        uploads: {
          async getUploadUrl({ type }) {
            assert.equal(type, 'video');
            return { url: 'https://upload.max.test/video', token: 'max-token' };
          }
        }
      }
    }
  };

  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://upload.max.test/video');
      assert.equal(options.method, 'POST');
      assert.match(options.headers['content-type'], /^multipart\/form-data; boundary=/);
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const uploaded = Buffer.concat(chunks).toString('utf8');
      assert.match(uploaded, /Content-Disposition: form-data; name="data"/);
      assert.match(uploaded, /video bytes/);
      return new Response('{"retval":1}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };

    const attachment = await uploadTelegramMediaToMax({
      telegram,
      maxBot,
      dataDir,
      media: {
        fileId: 'telegram-file-id',
        fileName: 'clip.mp4',
        fileSize: 11,
        maxKind: 'video',
        label: 'видео'
      }
    });

    assert.deepEqual(attachment.maxAttachment, { type: 'video', payload: { token: 'max-token' } });
    assert.equal(attachment.historyMedia.kind, 'video');
    assert.deepEqual(await readdir(dataDir), ['history']);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('MAX photo upload response is converted to an image token payload', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bridge-photo-test-'));
  const originalFetch = globalThis.fetch;
  const telegram = {
    async downloadFile(fileId, destination) {
      await writeFile(destination, 'image bytes');
    }
  };
  const maxBot = {
    api: {
      raw: {
        uploads: {
          async getUploadUrl({ type }) {
            assert.equal(type, 'image');
            return { url: 'https://upload.max.test/image' };
          }
        }
      }
    }
  };

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      photos: { original: { token: 'photo-token' } }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });

    const attachment = await uploadTelegramMediaToMax({
      telegram,
      maxBot,
      dataDir,
      media: {
        fileId: 'photo-id',
        fileName: 'photo.jpg',
        fileSize: 11,
        maxKind: 'image',
        mimeType: 'image/jpeg',
        label: 'фото'
      }
    });

    assert.deepEqual(attachment.maxAttachment, { type: 'image', payload: { token: 'photo-token' } });
    assert.equal(attachment.historyMedia.mimeType, 'image/jpeg');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});


test('MAX voice conversion produces a genuine OGG/Opus file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-voice-test-'));
  const input = path.join(directory, 'voice.m4a');
  const output = path.join(directory, 'voice.ogg');
  const { spawn } = await import('node:child_process');
  const run = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${code}`)));
  });
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=1', '-c:a', 'aac', '-y', input]);
    await makeVoiceMessage(input, output);
    const bytes = await (await import('node:fs/promises')).readFile(output);
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'OggS');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('oversized media can be wrapped in a store-only ZIP for MAX file upload', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-zip-test-'));
  const input = path.join(directory, 'movie.mp4');
  const output = path.join(directory, 'movie.mp4.zip');
  try {
    await writeFile(input, Buffer.from('original-video-bytes'));
    await packageAsZip({ inputPath: input, outputPath: output });
    const names = await new Promise((resolve, reject) => {
      import('node:child_process').then(({ execFile }) => execFile('unzip', ['-Z1', output], (error, stdout) => error ? reject(error) : resolve(stdout.trim().split(/\r?\n/))));
    });
    assert.deepEqual(names, ['movie.mp4']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
