import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BridgeDatabase } from '../src/database.js';

test('message mapping resolves a MAX reply to its Telegram source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-'));
  const db = new BridgeDatabase(join(directory, 'bridge.json'));

  try {
    const inserted = db.insertMessageLink({
      telegramBusinessConnectionId: 'connection-1',
      telegramChatId: 42,
      telegramMessageId: 99,
      maxMessageId: 'max-message-1'
    });

    assert.equal(inserted, true);
    assert.deepEqual(db.findTelegramTarget('max-message-1'), {
      telegramBusinessConnectionId: 'connection-1',
      telegramChatId: '42',
      telegramMessageId: 99
    });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('one MAX album message can link all Telegram album items', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-'));
  const db = new BridgeDatabase(join(directory, 'bridge.json'));
  try {
    for (const telegramMessageId of [10, 11, 12]) {
      assert.equal(db.insertMessageLink({
        telegramBusinessConnectionId: 'connection-1',
        telegramChatId: 42,
        telegramMessageId,
        maxMessageId: 'max-album'
      }), true);
    }
    assert.equal(db.hasTelegramSource({ telegramBusinessConnectionId: 'connection-1', telegramChatId: 42, telegramMessageId: 12 }), true);
    assert.equal(db.findTelegramTarget('max-album').telegramMessageId, 10);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('telegram chat filters can remember and mute contacts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-'));
  const databasePath = join(directory, 'bridge.json');
  const db = new BridgeDatabase(databasePath);

  try {
    db.rememberTelegramChat({
      telegramBusinessConnectionId: 'connection-1',
      telegramChatId: 123,
      displayName: 'Иван',
      username: 'ivan'
    });

    assert.deepEqual(db.findTelegramChat(123), {
      telegramBusinessConnectionId: 'connection-1',
      telegramChatId: '123',
      displayName: 'Иван',
      customName: null,
      effectiveName: 'Иван',
      username: 'ivan',
      avatar: null,
      wallpaper: null,
      lastMessageAt: db.findTelegramChat(123).lastMessageAt,
      muted: 0
    });

    assert.equal(db.setTelegramChatCustomName(123, 'Клиент'), true);
    assert.equal(db.findTelegramChat(123).effectiveName, 'Клиент');

    assert.equal(db.setTelegramChatMuted(123, true), true);
    assert.equal(db.isTelegramChatMuted(123), true);
    assert.equal(db.setTelegramChatMuted(123, false), true);
    assert.equal(db.isTelegramChatMuted(123), false);

    db.setSetting('telegram_active_chat_id', 123);
    db.close();

    const reopened = new BridgeDatabase(databasePath);
    assert.equal(reopened.getSetting('telegram_active_chat_id'), '123');
    assert.equal(reopened.findTelegramChat(123).effectiveName, 'Клиент');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('chat history is stored and filtered by Telegram chat', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-'));
  const databasePath = join(directory, 'bridge.json');
  const db = new BridgeDatabase(databasePath);

  try {
    db.insertChatMessage({
      telegramChatId: 123,
      direction: 'in',
      text: 'Привет',
      type: 'Фото',
      media: { id: 'media-1', storedName: 'stored.jpg', fileName: 'photo.jpg', mimeType: 'image/jpeg', kind: 'image' }
    });
    db.insertChatMessage({ telegramChatId: 123, direction: 'out', text: 'Здравствуйте', type: 'Текст' });
    db.insertChatMessage({ telegramChatId: 999, direction: 'in', text: 'Другой чат', type: 'Текст' });

    const messages = db.listChatMessages(123);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].text, 'Привет');
    assert.equal(messages[1].direction, 'out');
    assert.equal(db.findMedia('media-1').fileName, 'photo.jpg');

    db.close();
    const reopened = new BridgeDatabase(databasePath);
    assert.equal(reopened.listChatMessages(123).length, 2);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('edited incoming message replaces history and old MAX links can be removed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-'));
  const db = new BridgeDatabase(join(directory, 'bridge.json'));
  try {
    db.upsertIncomingChatMessage({
      telegramChatId: 123,
      telegramMessageId: 77,
      text: 'Старый текст'
    });
    db.insertMessageLink({
      telegramBusinessConnectionId: 'connection-1',
      telegramChatId: 123,
      telegramMessageId: 77,
      maxMessageId: 'max-old'
    });

    db.upsertIncomingChatMessage({
      telegramChatId: 123,
      telegramMessageId: 77,
      text: 'Новый текст',
      edited: true
    });

    const messages = db.listChatMessages(123);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'Новый текст');
    assert.ok(messages[0].editedAt);
    const changed = db.updateChatMessage(messages[0].id, { pinned: true, reaction: '👍' });
    assert.equal(changed.pinned, true);
    assert.equal(changed.reaction, '👍');
    assert.deepEqual(db.findMaxMessageIdsForTelegramSource({
      telegramBusinessConnectionId: 'connection-1',
      telegramChatId: 123,
      telegramMessageId: 77
    }), ['max-old']);
    assert.equal(db.deleteMessageLinksForTelegramSource({
      telegramBusinessConnectionId: 'connection-1',
      telegramChatId: 123,
      telegramMessageId: 77
    }), 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('MAX group routing and unknown inbox persist across restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-'));
  const databasePath = join(directory, 'bridge.json');
  const db = new BridgeDatabase(databasePath);
  try {
    db.bindMaxGroup(1001, 123);
    db.bindMaxGroup(1002, 456);
    assert.equal(db.findTelegramChatIdForMaxGroup(1001), '123');
    assert.deepEqual(db.findMaxGroupForTelegramChat(456), { maxChatId: '1002', telegramChatId: '456' });

    db.bindMaxGroup(1003, 123);
    assert.equal(db.findTelegramChatIdForMaxGroup(1001), undefined);
    assert.equal(db.findMaxGroupForTelegramChat(123).maxChatId, '1003');

    db.setUnknownInboxMaxChatId(1002);
    assert.equal(db.getUnknownInboxMaxChatId(), '1002');
    assert.equal(db.findTelegramChatIdForMaxGroup(1002), undefined);
    db.close();

    const reopened = new BridgeDatabase(databasePath);
    assert.equal(reopened.findTelegramChatIdForMaxGroup(1003), '123');
    assert.equal(reopened.getUnknownInboxMaxChatId(), '1002');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('censor terms are unique and can be changed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-'));
  const db = new BridgeDatabase(join(directory, 'bridge.json'));
  try {
    assert.equal(db.addCensorTerm('Плохое слово'), true);
    assert.equal(db.addCensorTerm('плохое слово'), false);
    assert.deepEqual(db.getCensorTerms(), ['Плохое слово']);
    assert.equal(db.deleteCensorTerm('ПЛОХОЕ СЛОВО'), true);
    assert.deepEqual(db.getCensorTerms(), []);
    db.addCensorTerm('раз');
    db.addCensorTerm('два');
    assert.equal(db.clearCensorTerms(), 2);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('multiple users keep settings, chats and MAX owners isolated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-multi-'));
  const databasePath = join(directory, 'bridge.json');
  const db = new BridgeDatabase(databasePath);
  try {
    const first = db.registerTelegramOwner('100');
    const second = db.registerTelegramOwner('200');
    assert.notEqual(first, second);
    assert.equal(db.bindMaxOwner(first, '1000'), true);
    assert.equal(db.bindMaxOwner(second, '2000'), true);

    await db.runAsAccount(first, async () => {
      db.setSetting('telegram_business_connection_id', 'business-first');
      db.rememberTelegramChat({
        telegramBusinessConnectionId: 'business-first',
        telegramChatId: 11,
        displayName: 'Первый контакт'
      });
    });
    await db.runAsAccount(second, async () => {
      db.setSetting('telegram_business_connection_id', 'business-second');
      db.rememberTelegramChat({
        telegramBusinessConnectionId: 'business-second',
        telegramChatId: 22,
        displayName: 'Второй контакт'
      });
    });

    assert.equal(db.findAccountByBusinessConnection('business-first'), first);
    assert.equal(db.findAccountByBusinessConnection('business-second'), second);
    assert.equal(db.findAccountByMaxOwner('1000'), first);
    assert.equal(db.findAccountByMaxOwner('2000'), second);
    assert.deepEqual(db.runAsAccount(first, () => db.listTelegramChats()).map((chat) => chat.telegramChatId), ['11']);
    assert.deepEqual(db.runAsAccount(second, () => db.listTelegramChats()).map((chat) => chat.telegramChatId), ['22']);

    db.close();
    const reopened = new BridgeDatabase(databasePath);
    assert.equal(reopened.listAccounts().length, 2);
    assert.equal(reopened.findAccountByMaxOwner('2000'), second);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('each Telegram user receives a different plaintext MAX pairing code', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-codes-'));
  const db = new BridgeDatabase(join(directory, 'bridge.json'));
  try {
    const first = db.registerTelegramOwner('301');
    const second = db.registerTelegramOwner('302');
    const firstCode = db.runAsAccount(first, () => db.getSetting('max_pairing_code'));
    const secondCode = db.runAsAccount(second, () => db.getSetting('max_pairing_code'));
    assert.match(firstCode, /^[0-9A-F]{16}$/);
    assert.match(secondCode, /^[0-9A-F]{16}$/);
    assert.notEqual(firstCode, secondCode);
    assert.equal(db.findAccountByMaxPairingCode(firstCode), first);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy 1.15.1 database migrates without losing settings, chats or messages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-legacy-'));
  const databasePath = join(directory, 'bridge.json');
  const legacy = {
    settings: {
      telegram_owner_id: '777',
      max_owner_id: '888',
      telegram_business_connection_id: 'business-legacy',
      telegram_update_offset: '41',
      max_update_marker: 'marker-legacy',
      telegram_active_chat_id: '123',
      max_group_bindings: JSON.stringify({ '-555': '123' }),
      max_unknown_inbox_chat_id: '-556',
      web_relay_max_chat_id: '-557',
      web_relay_max_chat_title: 'Старый канал',
      web_relay_max_chat_type: 'channel'
    },
    messageLinks: [{
      telegramBusinessConnectionId: 'business-legacy',
      telegramChatId: '123',
      telegramMessageId: 9,
      maxMessageId: 'max-9',
      createdAt: Date.now()
    }],
    telegramChats: {
      'business-legacy:123': {
        telegramBusinessConnectionId: 'business-legacy',
        telegramChatId: '123',
        displayName: 'Старый контакт',
        lastMessageAt: Date.now(),
        muted: 0
      }
    },
    messages: [{
      id: 1,
      telegramChatId: '123',
      direction: 'in',
      text: 'Сохранённое сообщение',
      type: 'Текст',
      createdAt: Date.now()
    }]
  };
  writeFileSync(databasePath, JSON.stringify(legacy, null, 2));

  const db = new BridgeDatabase(databasePath);
  try {
    assert.equal(db.listAccounts().length, 1);
    assert.equal(db.findAccountByTelegramOwner('777'), 'tg-777');
    assert.equal(db.findAccountByMaxOwner('888'), 'tg-777');
    assert.equal(db.findAccountByBusinessConnection('business-legacy'), 'tg-777');
    assert.equal(db.getSetting('telegram_update_offset'), '41');
    assert.equal(db.getSetting('max_update_marker'), 'marker-legacy');
    assert.equal(db.runAsAccount('tg-777', () => db.findTelegramChat(123).effectiveName), 'Старый контакт');
    assert.equal(db.runAsAccount('tg-777', () => db.listChatMessages(123)[0].text), 'Сохранённое сообщение');
    assert.equal(db.runAsAccount('tg-777', () => db.findTelegramTarget('max-9').telegramMessageId), 9);
    assert.equal(db.runAsAccount('tg-777', () => db.findTelegramChatIdForMaxGroup('-555')), '123');
    assert.equal(db.runAsAccount('tg-777', () => db.getUnknownInboxMaxChatId()), '-556');
    assert.equal(db.runAsAccount('tg-777', () => db.getSetting('web_relay_max_chat_id')), '-557');
    assert.match(db.runAsAccount('tg-777', () => db.getSetting('max_pairing_code')), /^[0-9A-F]{16}$/);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Business Connection cannot be assigned to two profiles', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-business-unique-'));
  const db = new BridgeDatabase(join(directory, 'bridge.json'));
  try {
    const first = db.registerTelegramOwner('4101');
    const second = db.registerTelegramOwner('4102');
    assert.equal(db.bindBusinessConnection(first, 'business-shared'), true);
    assert.equal(db.bindBusinessConnection(second, 'business-shared'), false);
    assert.equal(db.findAccountByBusinessConnection('business-shared'), first);
    assert.equal(db.runAsAccount(second, () => db.getSetting('telegram_business_connection_id')), undefined);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('many profiles remain isolated across concurrent async work and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-many-'));
  const databasePath = join(directory, 'bridge.json');
  const db = new BridgeDatabase(databasePath);
  try {
    const accountIds = Array.from({ length: 32 }, (_, index) => db.registerTelegramOwner(String(5000 + index)));
    const codes = new Set(accountIds.map((accountId) => db.runAsAccount(accountId, () => db.getSetting('max_pairing_code'))));
    assert.equal(codes.size, accountIds.length);

    await Promise.all(accountIds.map((accountId, index) => db.runAsAccount(accountId, async () => {
      db.setSetting('parallel_value', `profile-${index}`);
      await new Promise((resolve) => setTimeout(resolve, index % 4));
      db.rememberTelegramChat({
        telegramBusinessConnectionId: `business-${index}`,
        telegramChatId: 7000 + index,
        displayName: `Контакт ${index}`
      });
      assert.equal(db.getSetting('parallel_value'), `profile-${index}`);
      assert.deepEqual(db.listTelegramChats().map((chat) => chat.telegramChatId), [String(7000 + index)]);
    })));

    db.close();
    const reopened = new BridgeDatabase(databasePath);
    assert.equal(reopened.listAccounts().length, accountIds.length);
    for (const [index, accountId] of accountIds.entries()) {
      assert.equal(reopened.runAsAccount(accountId, () => reopened.getSetting('parallel_value')), `profile-${index}`);
      assert.deepEqual(
        reopened.runAsAccount(accountId, () => reopened.listTelegramChats().map((chat) => chat.telegramChatId)),
        [String(7000 + index)]
      );
    }
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('one MAX group or channel cannot be claimed by two profiles', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-max-chat-unique-'));
  const db = new BridgeDatabase(join(directory, 'bridge.json'));
  try {
    const first = db.registerTelegramOwner('7101');
    const second = db.registerTelegramOwner('7102');

    assert.deepEqual(
      db.runAsAccount(first, () => db.bindMaxGroup('-9001', '10001')),
      { maxChatId: '-9001', telegramChatId: '10001' }
    );
    assert.equal(db.runAsAccount(second, () => db.bindMaxGroup('-9001', '20001')), undefined);

    assert.equal(db.runAsAccount(first, () => db.setUnknownInboxMaxChatId('-9002')), '-9002');
    assert.equal(db.runAsAccount(second, () => db.setUnknownInboxMaxChatId('-9002')), false);

    assert.equal(db.runAsAccount(first, () => db.setWebRelayMaxChat({
      maxChatId: '-9003',
      title: 'Канал первого',
      type: 'channel'
    })), true);
    assert.equal(db.runAsAccount(second, () => db.setWebRelayMaxChat({
      maxChatId: '-9003',
      title: 'Канал второго',
      type: 'channel'
    })), false);

    assert.equal(db.findAccountByMaxChat('-9001'), first);
    assert.equal(db.findAccountByMaxChat('-9002'), first);
    assert.equal(db.findAccountByMaxChat('-9003'), first);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('database writes are backed up and a damaged primary file is restored', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-backup-'));
  const databasePath = join(directory, 'bridge.json');
  const backupPath = `${databasePath}.bak`;
  try {
    const db = new BridgeDatabase(databasePath);
    const accountId = db.registerTelegramOwner('8101');
    db.runAsAccount(accountId, () => db.setSetting('saved_value', 'не потеряно'));
    db.close();

    assert.equal(existsSync(backupPath), true);
    assert.doesNotThrow(() => JSON.parse(readFileSync(backupPath, 'utf8')));
    writeFileSync(databasePath, '{сломанный json', 'utf8');

    const recovered = new BridgeDatabase(databasePath);
    assert.equal(recovered.runAsAccount(accountId, () => recovered.getSetting('saved_value')), 'не потеряно');
    recovered.close();
    assert.doesNotThrow(() => JSON.parse(readFileSync(databasePath, 'utf8')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a damaged database without a backup stops startup instead of erasing data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-corrupt-'));
  const databasePath = join(directory, 'bridge.json');
  try {
    const damaged = '{не перезаписывать';
    writeFileSync(databasePath, damaged, 'utf8');
    assert.throws(() => new BridgeDatabase(databasePath), /Database is damaged and was not overwritten/);
    assert.equal(readFileSync(databasePath, 'utf8'), damaged);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
