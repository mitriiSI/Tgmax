import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMultipartUpload } from '../src/multipart.js';

test('multipart upload streams fields and a file with an exact content length', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-multipart-'));
  const filePath = path.join(directory, 'large.bin');
  await writeFile(filePath, Buffer.alloc(1024 * 1024, 7));
  try {
    const upload = await createMultipartUpload({
      fields: { chat_id: 42, metadata: { ok: true } },
      fieldName: 'document',
      filePath,
      fileName: 'тест.bin',
      contentType: 'application/octet-stream'
    });
    let bytes = 0;
    const chunks = [];
    for await (const chunk of upload.body) {
      bytes += chunk.length;
      if (chunks.length < 3) chunks.push(chunk);
    }
    assert.equal(bytes, Number(upload.headers['content-length']));
    assert.equal(upload.fileSize, 1024 * 1024);
    assert.match(Buffer.concat(chunks).toString('utf8'), /name="chat_id"/);
    assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('multipart metadata supports a sparse 2000 MB file without reading it into memory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-multipart-2gb-'));
  const filePath = path.join(directory, 'two-gigabytes.bin');
  const size = 2000 * 1024 * 1024;
  await writeFile(filePath, '');
  await truncate(filePath, size);
  try {
    const upload = await createMultipartUpload({
      fieldName: 'document',
      filePath,
      fileName: 'two-gigabytes.bin'
    });
    assert.equal(upload.fileSize, size);
    assert.ok(Number(upload.headers['content-length']) > size);
    upload.body.destroy();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
