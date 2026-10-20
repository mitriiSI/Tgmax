import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const SECRET_KEY = /(token|api[_-]?hash|pairing[_-]?code|password|secret|authorization|cookie)/i;
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function safeString(value, maximum = 4000) {
  const text = String(value ?? '');
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

function normalizeError(error) {
  if (!error) return undefined;
  if (typeof error === 'string') return safeString(error);
  return {
    name: safeString(error.name || 'Error', 100),
    message: safeString(error.message || error, 4000),
    code: error.code ? safeString(error.code, 100) : undefined,
    stack: error.stack ? safeString(error.stack, 8000) : undefined,
    cause: error.cause ? normalizeError(error.cause) : undefined
  };
}

function sanitize(value, depth = 0, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (depth > 7) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return normalizeError(value);
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return safeString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  const output = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
    output[childKey] = sanitize(childValue, depth + 1, childKey);
  }
  return output;
}

function dateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function numeric(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class EventStore {
  constructor({
    dataDir,
    maxMemoryEvents = 5000,
    retentionDays = 30,
    showMessageText = false,
    accountProvider = () => null,
    consoleOutput = true
  }) {
    this.directory = join(dataDir, 'logs');
    this.maxMemoryEvents = Math.max(100, numeric(maxMemoryEvents, 5000));
    this.retentionDays = Math.max(1, numeric(retentionDays, 30));
    this.showMessageText = Boolean(showMessageText);
    this.accountProvider = accountProvider;
    this.consoleOutput = consoleOutput;
    this.events = [];
    this.subscribers = new Set();
    this.sequence = 0;
    this.startedAt = Date.now();
    mkdirSync(this.directory, { recursive: true });
    this.cleanup();
  }

  operation(prefix = 'op') {
    return `${prefix}-${randomUUID()}`;
  }

  cleanup(now = Date.now()) {
    if (!existsSync(this.directory)) return;
    const threshold = now - this.retentionDays * 86_400_000;
    for (const name of readdirSync(this.directory)) {
      const match = name.match(/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) continue;
      const fileTime = Date.parse(`${match[1]}T00:00:00Z`);
      if (Number.isFinite(fileTime) && fileTime < threshold) {
        rmSync(join(this.directory, name), { force: true });
      }
    }
  }

  emit(input = {}) {
    const timestamp = Date.now();
    const event = {
      seq: ++this.sequence,
      id: randomUUID(),
      timestamp,
      isoTime: new Date(timestamp).toISOString(),
      level: LEVELS.has(input.level) ? input.level : 'info',
      category: safeString(input.category || 'system', 80),
      event: safeString(input.event || 'log', 120),
      message: safeString(input.message || '', 4000),
      accountId: input.accountId ?? this.accountProvider() ?? null,
      operationId: input.operationId ?? null,
      direction: input.direction ?? null,
      stage: input.stage ?? null,
      status: input.status ?? null,
      progress: input.progress === undefined ? null : Math.max(0, Math.min(100, numeric(input.progress, 0))),
      durationMs: input.durationMs === undefined ? null : Math.max(0, numeric(input.durationMs, 0)),
      details: sanitize(input.details)
    };

    this.events.push(event);
    if (this.events.length > this.maxMemoryEvents) {
      this.events.splice(0, this.events.length - this.maxMemoryEvents);
    }

    const filePath = join(this.directory, `events-${dateKey(timestamp)}.jsonl`);
    try {
      appendFileSync(filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      if (this.consoleOutput) console.error('[console] Could not append event log', error.message);
    }

    if (this.consoleOutput) {
      const prefix = `[${event.level}] [${event.category}]${event.accountId ? ` [${event.accountId}]` : ''}`;
      const writer = event.level === 'error' ? console.error : event.level === 'warn' ? console.warn : console.log;
      writer(`${prefix} ${event.message}`, event.details ?? '');
    }

    const payload = `id: ${event.seq}\nevent: bridge-event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const subscriber of this.subscribers) {
      try { subscriber(payload); } catch { this.subscribers.delete(subscriber); }
    }
    return event;
  }

  messageDetails({ text, ...details } = {}) {
    if (this.showMessageText) return sanitize({ text, ...details });
    return sanitize({
      ...details,
      textLength: typeof text === 'string' ? text.length : 0,
      textPreview: typeof text === 'string' && text ? `${text.slice(0, 20)}${text.length > 20 ? '…' : ''}` : undefined
    });
  }

  list({ after = 0, limit = 500, level, category, accountId, operationId, query } = {}) {
    const lowerQuery = String(query ?? '').trim().toLowerCase();
    const maximum = Math.min(Math.max(Number(limit) || 500, 1), 2000);
    return this.events.filter((event) => {
      if (event.seq <= Number(after || 0)) return false;
      if (level && event.level !== level) return false;
      if (category && event.category !== category) return false;
      if (accountId && event.accountId !== accountId) return false;
      if (operationId && event.operationId !== operationId) return false;
      if (lowerQuery) {
        const haystack = `${event.message} ${event.event} ${JSON.stringify(event.details ?? {})}`.toLowerCase();
        if (!haystack.includes(lowerQuery)) return false;
      }
      return true;
    }).slice(-maximum);
  }

  stats() {
    const recent = this.events.filter((event) => event.timestamp > Date.now() - 3_600_000);
    const latestOperations = new Map();
    for (const event of recent) {
      if (event.operationId) latestOperations.set(event.operationId, event);
    }
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      inMemory: this.events.length,
      lastSequence: this.sequence,
      lastHour: recent.length,
      errorsLastHour: recent.filter((event) => event.level === 'error').length,
      warningsLastHour: recent.filter((event) => event.level === 'warn').length,
      activeOperations: [...latestOperations.values()].filter((event) => event.status === 'running').length,
      logDirectory: this.directory
    };
  }

  subscribe(writer) {
    this.subscribers.add(writer);
    writer(`event: ready\ndata: ${JSON.stringify({ lastSequence: this.sequence })}\n\n`);
    return () => this.subscribers.delete(writer);
  }

  close() {
    for (const writer of this.subscribers) {
      try { writer('event: shutdown\ndata: {}\n\n'); } catch {}
    }
    this.subscribers.clear();
  }
}

export function createEventLogger(store, accountProvider = () => null) {
  function emit(level, message, details) {
    const normalizedDetails = details instanceof Error
      ? { error: details }
      : typeof details === 'string'
        ? { details }
        : details;
    return store.emit({
      level,
      category: 'bridge',
      event: 'application_log',
      message,
      accountId: accountProvider(),
      details: normalizedDetails
    });
  }
  return {
    debug: (message, details) => emit('debug', message, details),
    info: (message, details) => emit('info', message, details),
    warn: (message, details) => emit('warn', message, details),
    error: (message, details) => emit('error', message, details),
    event: (input) => store.emit({ accountId: accountProvider(), ...input })
  };
}
