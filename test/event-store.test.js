import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventStore, createEventLogger } from '../src/event-store.js';

test('event store writes JSONL, filters events and redacts secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-console-'));
  try {
    const store = new EventStore({ dataDir: directory, consoleOutput: false, maxMemoryEvents: 100 });
    store.emit({
      level: 'info', category: 'message', event: 'received', message: 'ok', accountId: 'tg-1',
      operationId: 'op-1', status: 'running', details: { apiHash: 'secret', nested: { token: 'secret2' }, visible: 42 }
    });
    store.emit({ level: 'info', category: 'message', event: 'done', message: 'completed', accountId: 'tg-1', operationId: 'op-1', status: 'completed' });
    assert.equal(store.list({ accountId: 'tg-1' }).length, 2);
    assert.equal(store.list({ query: 'completed' }).length, 1);
    assert.equal(store.stats().activeOperations, 0);
    const first = store.list({ limit: 2 })[0];
    assert.equal(first.details.apiHash, '[REDACTED]');
    assert.equal(first.details.nested.token, '[REDACTED]');
    const logName = `events-${new Date().toISOString().slice(0, 10)}.jsonl`;
    const text = readFileSync(join(directory, 'logs', logName), 'utf8');
    assert.match(text, /\"apiHash\":\"\[REDACTED\]\"/);
    assert.doesNotMatch(text, /secret2?/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('message text is hidden by default and can be enabled explicitly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-console-'));
  try {
    const hidden = new EventStore({ dataDir: directory, consoleOutput: false, showMessageText: false });
    assert.equal(hidden.messageDetails({ text: 'Очень секретное сообщение' }).text, undefined);
    assert.equal(hidden.messageDetails({ text: 'Очень секретное сообщение' }).textLength, 25);
    const visible = new EventStore({ dataDir: directory, consoleOutput: false, showMessageText: true });
    assert.equal(visible.messageDetails({ text: 'видно' }).text, 'видно');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('event logger receives current account from provider', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-console-'));
  try {
    const store = new EventStore({ dataDir: directory, consoleOutput: false });
    const logger = createEventLogger(store, () => 'tg-77');
    logger.info('hello', { safe: true });
    assert.equal(store.list({ limit: 1 })[0].accountId, 'tg-77');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('memory ring is bounded and subscribers receive SSE payloads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-console-'));
  try {
    const store = new EventStore({ dataDir: directory, consoleOutput: false, maxMemoryEvents: 100 });
    const chunks = [];
    const unsubscribe = store.subscribe((chunk) => chunks.push(chunk));
    for (let index = 0; index < 140; index += 1) store.emit({ message: `event-${index}` });
    unsubscribe();
    assert.equal(store.list({ limit: 1000 }).length, 100);
    assert.equal(store.list({ limit: 1000 })[0].message, 'event-40');
    assert.match(chunks.join(''), /event: bridge-event/);
    assert.match(chunks.join(''), /event-139/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
