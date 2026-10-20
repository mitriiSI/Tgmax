import { randomBytes } from 'node:crypto';

const DEFAULT_DOWNLOAD_URLS = [
  'https://speed.cloudflare.com/__down?bytes=3000000',
  'https://speed.cloudflare.com/__down?bytes=3000000',
  'https://speed.cloudflare.com/__down?bytes=3000000'
];
const DEFAULT_UPLOAD_URL = 'https://speed.cloudflare.com/__up';

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function bytesPerSecondToMbps(bytesPerSecond) {
  return finite(bytesPerSecond) * 8 / 1_000_000;
}

export function mbpsToBytesPerSecond(mbps) {
  return finite(mbps) * 1_000_000 / 8;
}

export function formatEta(seconds) {
  const value = Math.max(0, Math.round(finite(seconds)));
  if (!value) return 'меньше минуты';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  if (hours) return `${hours} ч ${minutes} мин`;
  if (minutes) return `${minutes} мин ${secs} с`;
  return `${secs} с`;
}

export function estimateTransferTime(fileBytes, snapshot = {}) {
  const downloadBps = mbpsToBytesPerSecond(snapshot.downloadMbps);
  const uploadBps = mbpsToBytesPerSecond(snapshot.uploadMbps);
  const downloadSeconds = downloadBps > 0 ? fileBytes / downloadBps : null;
  const uploadSeconds = uploadBps > 0 ? fileBytes / uploadBps : null;
  const networkSeconds = (downloadSeconds ?? 0) + (uploadSeconds ?? 0);
  const overheadSeconds = networkSeconds ? Math.max(10, networkSeconds * 0.12) : null;
  const totalSeconds = downloadSeconds !== null && uploadSeconds !== null
    ? networkSeconds + overheadSeconds
    : null;
  return { downloadSeconds, uploadSeconds, overheadSeconds, totalSeconds };
}

async function consumeResponse(response, onChunk) {
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    onChunk?.(value.byteLength);
  }
  return bytes;
}

async function timedDownload(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
      signal: controller.signal
    });
    const firstByteAt = performance.now();
    const bytes = await consumeResponse(response);
    const endedAt = performance.now();
    return {
      bytes,
      durationMs: Math.max(1, endedAt - startedAt),
      latencyMs: Math.max(0, firstByteAt - startedAt)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function timedUpload(url, bytes, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const body = randomBytes(bytes);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
      signal: controller.signal
    });
    const firstByteAt = performance.now();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.arrayBuffer().catch(() => new ArrayBuffer(0));
    const endedAt = performance.now();
    return {
      bytes,
      durationMs: Math.max(1, endedAt - startedAt),
      latencyMs: Math.max(0, firstByteAt - startedAt)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function weightedAverage(current, next, weight = 0.25) {
  if (!(current > 0)) return next;
  return current * (1 - weight) + next * weight;
}

export class NetworkMonitor {
  constructor({ db, log, downloadUrls = DEFAULT_DOWNLOAD_URLS, uploadUrl = DEFAULT_UPLOAD_URL, timeoutMs = 25_000, intervalMs = 6 * 60 * 60 * 1000, testOnStart = true } = {}) {
    this.db = db;
    this.log = log;
    this.downloadUrls = downloadUrls;
    this.uploadUrl = uploadUrl;
    this.timeoutMs = timeoutMs;
    this.intervalMs = intervalMs;
    this.testOnStart = testOnStart;
    this.running = null;
    this.timer = null;
    this.snapshotValue = this.#readSnapshot();
  }

  #readSnapshot() {
    try {
      const parsed = JSON.parse(this.db?.getSetting?.('network_speed_snapshot') || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  #saveSnapshot(snapshot) {
    this.snapshotValue = { ...snapshot };
    this.db?.setSetting?.('network_speed_snapshot', JSON.stringify(this.snapshotValue));
  }

  snapshot() {
    return { ...this.snapshotValue };
  }

  estimate(fileBytes) {
    return estimateTransferTime(fileBytes, this.snapshotValue);
  }

  recordTransfer(direction, bytes, durationMs) {
    if (!(bytes > 0) || !(durationMs > 0)) return this.snapshot();
    const measuredMbps = bytesPerSecondToMbps(bytes / (durationMs / 1000));
    const key = direction === 'download' ? 'downloadMbps' : 'uploadMbps';
    const snapshot = this.snapshot();
    snapshot[key] = Number(weightedAverage(finite(snapshot[key]), measuredMbps, 0.35).toFixed(2));
    snapshot.measuredAt = new Date().toISOString();
    snapshot.source = 'real-transfer';
    this.#saveSnapshot(snapshot);
    return snapshot;
  }

  async test({ force = false } = {}) {
    if (this.running) return this.running;
    const age = Date.now() - Date.parse(this.snapshotValue.measuredAt || 0);
    if (!force && Number.isFinite(age) && age >= 0 && age < 10 * 60 * 1000) return this.snapshot();

    this.running = (async () => {
      const operationId = `speed-${Date.now()}`;
      this.log?.event?.({ level: 'info', category: 'network', event: 'speed_test_started', message: 'Запущено измерение скорости сервера', operationId, stage: 'speed-test', status: 'running', progress: 5 });
      try {
        const downloadResults = await Promise.all(this.downloadUrls.map((url) => timedDownload(url, this.timeoutMs)));
        const downloadBytes = downloadResults.reduce((sum, item) => sum + item.bytes, 0);
        const downloadDurationMs = Math.max(...downloadResults.map((item) => item.durationMs));
        const latencyMs = downloadResults.reduce((sum, item) => sum + item.latencyMs, 0) / downloadResults.length;
        this.log?.event?.({ level: 'info', category: 'network', event: 'speed_test_download_completed', message: 'Измерена входящая скорость', operationId, stage: 'speed-test', status: 'running', progress: 55, details: { downloadMbps: bytesPerSecondToMbps(downloadBytes / (downloadDurationMs / 1000)), latencyMs } });

        const uploadResults = await Promise.all([0, 1, 2].map(() => timedUpload(this.uploadUrl, 1_000_000, this.timeoutMs)));
        const uploadBytes = uploadResults.reduce((sum, item) => sum + item.bytes, 0);
        const uploadDurationMs = Math.max(...uploadResults.map((item) => item.durationMs));
        const snapshot = {
          downloadMbps: Number(bytesPerSecondToMbps(downloadBytes / (downloadDurationMs / 1000)).toFixed(2)),
          uploadMbps: Number(bytesPerSecondToMbps(uploadBytes / (uploadDurationMs / 1000)).toFixed(2)),
          latencyMs: Number(latencyMs.toFixed(1)),
          measuredAt: new Date().toISOString(),
          source: 'multi-probe'
        };
        this.#saveSnapshot(snapshot);
        this.log?.event?.({ level: 'info', category: 'network', event: 'speed_test_completed', message: `Скорость измерена: ↓ ${snapshot.downloadMbps} Мбит/с · ↑ ${snapshot.uploadMbps} Мбит/с`, operationId, stage: 'complete', status: 'completed', progress: 100, details: snapshot });
        return snapshot;
      } catch (error) {
        this.log?.event?.({ level: 'warn', category: 'network', event: 'speed_test_failed', message: `Не удалось измерить скорость: ${error.message}`, operationId, stage: 'complete', status: 'failed', progress: 100, details: { error } });
        throw error;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  start() {
    if (this.timer) return;
    if (this.testOnStart) setTimeout(() => this.test().catch(() => {}), 5_000).unref?.();
    this.timer = setInterval(() => this.test({ force: true }).catch(() => {}), clamp(this.intervalMs, 10 * 60 * 1000, 24 * 60 * 60 * 1000));
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function createProgressEmitter({ log, networkMonitor, operationId, direction, stage, event, label, startProgress, endProgress, networkDirection, totalBytesHint = 0, minIntervalMs = 650 }) {
  const startedAt = Date.now();
  let lastAt = 0;
  let lastBytes = 0;
  let lastSampleAt = startedAt;
  const recent = [];

  return (input = {}) => {
    const now = Date.now();
    const bytes = Math.max(0, finite(input.bytes));
    const totalBytes = Math.max(0, finite(input.totalBytes, totalBytesHint));
    const force = Boolean(input.done || input.force || input.waiting);
    if (!force && now - lastAt < minIntervalMs) return;

    if (input.waiting) {
      const elapsedMs = Math.max(0, finite(input.elapsedMs, now - startedAt));
      log?.event?.({
        level: 'info', category: 'file', event, operationId, direction, stage,
        status: 'running', progress: startProgress,
        message: `${label}: Telegram подготавливает большой файл · прошло ${formatEta(elapsedMs / 1000)}`,
        details: { bytes: 0, totalBytes, percent: 0, waiting: true, elapsedMs }
      });
      lastAt = now;
      return;
    }

    const deltaBytes = Math.max(0, bytes - lastBytes);
    const deltaMs = Math.max(1, now - lastSampleAt);
    const instantBps = deltaBytes / (deltaMs / 1000);
    recent.push({ at: now, bytes, instantBps });
    while (recent.length > 20 || (recent[0] && now - recent[0].at > 10_000)) recent.shift();
    const averageBps = bytes / Math.max(0.001, (now - startedAt) / 1000);
    const smoothedBps = recent.length
      ? recent.reduce((sum, item) => sum + item.instantBps, 0) / recent.length
      : averageBps;
    const fraction = totalBytes > 0 ? clamp(bytes / totalBytes, 0, 1) : 0;
    const overallProgress = Math.round(startProgress + (endProgress - startProgress) * fraction);
    const etaSeconds = totalBytes > bytes && smoothedBps > 0 ? (totalBytes - bytes) / smoothedBps : 0;
    const message = `${label}: ${(bytes / 1024 / 1024).toFixed(1)}${totalBytes ? ` / ${(totalBytes / 1024 / 1024).toFixed(1)}` : ''} МБ · ${(fraction * 100).toFixed(1)}% · ${bytesPerSecondToMbps(smoothedBps).toFixed(1)} Мбит/с${etaSeconds ? ` · осталось ${formatEta(etaSeconds)}` : ''}`;
    log?.event?.({
      level: 'info', category: 'file', event, message, operationId, direction, stage,
      status: 'running', progress: overallProgress,
      details: { bytes, totalBytes, percent: Number((fraction * 100).toFixed(2)), instantMbps: Number(bytesPerSecondToMbps(instantBps).toFixed(2)), averageMbps: Number(bytesPerSecondToMbps(averageBps).toFixed(2)), smoothedMbps: Number(bytesPerSecondToMbps(smoothedBps).toFixed(2)), etaSeconds: Math.round(etaSeconds), elapsedMs: now - startedAt }
    });
    lastAt = now;
    lastBytes = bytes;
    lastSampleAt = now;
    if (input.done && networkDirection && bytes > 0) networkMonitor?.recordTransfer?.(networkDirection, bytes, now - startedAt);
  };
}
