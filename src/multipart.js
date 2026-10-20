import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

function escapeQuoted(value) {
  return String(value).replace(/[\r\n"]/g, '_');
}

function fieldValue(value) {
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function dispositionFileName(fileName) {
  const original = String(fileName || 'file');
  const ascii = escapeQuoted(original.replace(/[^\x20-\x7e]/g, '_')) || 'file';
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(original)}`;
}

/**
 * Builds a standards-compliant multipart body as a file-backed stream.
 * The file is never read fully into RAM, which keeps multi-gigabyte transfers safe.
 */
export async function createMultipartUpload({
  fields = {},
  fieldName,
  filePath,
  fileName,
  contentType = 'application/octet-stream',
  onProgress
}) {
  return createMultipartUploadFiles({
    fields,
    files: [{ fieldName, filePath, fileName, contentType }],
    onProgress
  });
}

/**
 * Builds one multipart request containing several file-backed streams.
 * This is used by Telegram sendMediaGroup: every media item references its
 * file through attach://<fieldName>, while the bytes remain streamed from disk.
 */
export async function createMultipartUploadFiles({ fields = {}, files = [], onProgress }) {
  const boundary = `----telegram-max-bridge-${randomUUID()}`;
  const chunks = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeQuoted(name)}"\r\n\r\n` +
      `${fieldValue(value)}\r\n`
    ));
  }

  const preparedFiles = [];
  for (const file of files) {
    if (!file?.fieldName || !file?.filePath) continue;
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeQuoted(file.fieldName)}"; ${dispositionFileName(file.fileName)}\r\n` +
      `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`
    );
    const separator = Buffer.from('\r\n');
    const fileStat = await stat(file.filePath);
    preparedFiles.push({ ...file, header, separator, size: fileStat.size });
  }
  if (!preparedFiles.length) throw new Error('multipart upload requires at least one file');

  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const contentLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    + preparedFiles.reduce((sum, file) => sum + file.header.length + file.size + file.separator.length, 0)
    - preparedFiles.at(-1).separator.length
    + footer.length;

  async function* bodyParts() {
    let transferred = 0;
    const totalFileBytes = preparedFiles.reduce((sum, file) => sum + file.size, 0);
    for (const chunk of chunks) yield chunk;
    for (const [index, file] of preparedFiles.entries()) {
      yield file.header;
      for await (const chunk of createReadStream(file.filePath)) {
        transferred += chunk.length;
        onProgress?.({ bytes: transferred, totalBytes: totalFileBytes, fileIndex: index, fileName: file.fileName });
        yield chunk;
      }
      if (index < preparedFiles.length - 1) yield file.separator;
    }
    onProgress?.({ bytes: totalFileBytes, totalBytes: totalFileBytes, done: true });
    yield footer;
  }

  return {
    body: Readable.from(bodyParts()),
    fileSize: preparedFiles.reduce((sum, file) => sum + file.size, 0),
    fileSizes: preparedFiles.map((file) => file.size),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(contentLength)
    }
  };
}
