import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TelegramApi } from '../src/telegram-api.js';

test('TelegramApi copies an absolute file returned by a local Bot API server', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'telegram-local-api-'));
  const source = path.join(root, 'video.mp4');
  const destination = path.join(root, 'copied.mp4');
  await writeFile(source, 'large local file');

  const telegram = new TelegramApi('test-token', {
    apiBaseUrl: 'http://telegram-bot-api:8081/',
    localFilesRoot: root
  });
  telegram.request = async (method, payload) => {
    assert.equal(method, 'getFile');
    assert.deepEqual(payload, { file_id: 'file-id' });
    return { file_path: source, file_size: 16 };
  };

  try {
    const result = await telegram.downloadFile('file-id', destination, { maxBytes: 1024 });
    assert.equal(await readFile(destination, 'utf8'), 'large local file');
    assert.equal(result.bytesDownloaded, 16);
    assert.equal(telegram.baseUrl, 'http://telegram-bot-api:8081/bottest-token');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TelegramApi rejects an absolute path outside the shared local directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'telegram-local-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'telegram-local-outside-'));
  const source = path.join(outside, 'secret.txt');
  await writeFile(source, 'do not copy');

  const telegram = new TelegramApi('test-token', { localFilesRoot: root });
  telegram.request = async () => ({ file_path: source, file_size: 11 });

  try {
    await assert.rejects(
      telegram.downloadFile('file-id', path.join(root, 'destination.txt')),
      /outside its shared directory/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});


test('TelegramApi reports byte progress when copying a local large file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'telegram-progress-api-'));
  const source = path.join(root, 'source.bin');
  const destination = path.join(root, 'destination.bin');
  await writeFile(source, Buffer.alloc(256 * 1024, 7));
  const telegram = new TelegramApi('test-token', { localFilesRoot: root });
  telegram.request = async () => ({ file_path: source, file_size: 256 * 1024 });
  const progress = [];
  try {
    await telegram.downloadFile('file-id', destination, {
      maxBytes: 1024 * 1024,
      onProgress: (item) => progress.push(item)
    });
    assert.ok(progress.length >= 1);
    assert.equal(progress.at(-1).done, true);
    assert.equal(progress.at(-1).bytes, 256 * 1024);
    assert.equal(progress.at(-1).totalBytes, 256 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('TelegramApi requests direct channel updates by default', async () => {
  const api = new TelegramApi({ token: 'test-token' });
  let captured;
  api.request = async (_method, payload) => { captured = payload; return []; };
  await api.getUpdates(10);
  assert.ok(captured.allowed_updates.includes('channel_post'));
  assert.ok(captured.allowed_updates.includes('edited_channel_post'));
});
