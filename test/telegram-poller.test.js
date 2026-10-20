import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeDatabase } from '../src/database.js';
import { handleTelegramUpdate } from '../src/telegram-poller.js';

function dependencies(update, callbacks = {}) {
  return {
    update,
    telegram: {},
    db: {
      getSetting(key) {
        if (key === 'telegram_owner_id') return '999';
        if (key === 'telegram_business_connection_id') return 'business-1';
        return undefined;
      },
      setSetting() {}
    },
    pairingCode: 'long-pairing-code',
    onBusinessMessage: async () => {},
    log: { warn() {}, info() {} },
    ...callbacks
  };
}

test('edited business message calls the edited-message handler', async () => {
  let received;
  const message = {
    business_connection_id: 'business-1',
    message_id: 7,
    from: { id: 123 }
  };
  await handleTelegramUpdate(dependencies(
    { edited_business_message: message },
    { onEditedBusinessMessage: async (value) => { received = value; } }
  ));
  assert.equal(received, message);
});

test('deleted business messages call the deletion handler', async () => {
  let received;
  const deleted = {
    business_connection_id: 'business-1',
    chat: { id: 123 },
    message_ids: [7]
  };
  await handleTelegramUpdate(dependencies(
    { deleted_business_messages: deleted },
    { onDeletedBusinessMessages: async (value) => { received = value; } }
  ));
  assert.equal(received, deleted);
});

test('owner business message is passed to the bridge for mirror mode', async () => {
  let received;
  const message = {
    business_connection_id: 'business-1',
    message_id: 8,
    from: { id: 999 }
  };
  await handleTelegramUpdate(dependencies(
    { business_message: message },
    { onBusinessMessage: async (value) => { received = value; } }
  ));
  assert.equal(received, message);
});

test('mirror command changes the selected mode', async () => {
  let saved;
  let response;
  const deps = dependencies({
    message: { chat: { id: 999, type: 'private' }, from: { id: 999 }, text: '/mirror mine' }
  });
  deps.db.setSetting = (key, value) => { saved = [key, value]; };
  deps.telegram.sendBotText = async (_chatId, text) => { response = text; };
  await handleTelegramUpdate(deps);
  assert.deepEqual(saved, ['telegram_mirror_mode', 'mine']);
  assert.match(response, /только мои сообщения/);
});

test('censor command stores a complete multi-word phrase', async () => {
  let added;
  let response;
  const deps = dependencies({
    message: { chat: { id: 999, type: 'private' }, from: { id: 999 }, text: '/censor add очень плохая фраза' }
  });
  deps.db.addCensorTerm = (value) => { added = value; return true; };
  deps.telegram.sendBotText = async (_chatId, text) => { response = text; };
  await handleTelegramUpdate(deps);
  assert.equal(added, 'очень плохая фраза');
  assert.match(response, /Добавлено/);
});


test('two Telegram users register as isolated bridge profiles and bind their own Business Connections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-poller-multi-'));
  const db = new BridgeDatabase(join(directory, 'bridge.json'));
  const replies = [];
  const telegram = {
    async sendBotText(chatId, text) {
      replies.push({ chatId: String(chatId), text });
    }
  };
  const base = {
    telegram,
    db,
    pairingCode: 'server-code',
    onBusinessMessage: async () => {},
    onEditedBusinessMessage: async () => {},
    onDeletedBusinessMessages: async () => {},
    log: { warn() {}, info() {} }
  };

  try {
    for (const userId of [101, 202]) {
      await handleTelegramUpdate({
        ...base,
        update: { message: { chat: { id: userId, type: 'private' }, from: { id: userId }, text: '/bind server-code' } }
      });
    }

    const first = db.findAccountByTelegramOwner('101');
    const second = db.findAccountByTelegramOwner('202');
    assert.equal(first, 'tg-101');
    assert.equal(second, 'tg-202');
    assert.notEqual(
      db.runAsAccount(first, () => db.getSetting('max_pairing_code')),
      db.runAsAccount(second, () => db.getSetting('max_pairing_code'))
    );
    assert.match(replies[0].text, /В MAX отправь этому же боту: \/bind [0-9A-F]{16}(?:\s|$)/);
    assert.match(replies[1].text, /В MAX отправь этому же боту: \/bind [0-9A-F]{16}(?:\s|$)/);

    await handleTelegramUpdate({
      ...base,
      update: { business_connection: { id: 'business-202', user: { id: 202 }, is_enabled: true, rights: { can_reply: true } } }
    });
    await handleTelegramUpdate({
      ...base,
      update: { business_connection: { id: 'business-101', user: { id: 101 }, is_enabled: true, rights: { can_reply: true } } }
    });

    assert.equal(db.findAccountByBusinessConnection('business-101'), first);
    assert.equal(db.findAccountByBusinessConnection('business-202'), second);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Telegram poller rejects a Business Connection already owned by another profile', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-poller-business-unique-'));
  const db = new BridgeDatabase(join(directory, 'bridge.json'));
  const warnings = [];
  const base = {
    telegram: { async sendBotText() {} },
    db,
    pairingCode: 'server-code',
    onBusinessMessage: async () => {},
    onEditedBusinessMessage: async () => {},
    onDeletedBusinessMessages: async () => {},
    log: { warn(message) { warnings.push(message); }, info() {} }
  };
  try {
    const first = db.registerTelegramOwner('6101');
    const second = db.registerTelegramOwner('6102');
    assert.equal(db.bindBusinessConnection(first, 'business-one'), true);

    await handleTelegramUpdate({
      ...base,
      update: { business_connection: { id: 'business-one', user: { id: 6102 }, is_enabled: true, rights: { can_reply: true } } }
    });

    assert.equal(db.findAccountByBusinessConnection('business-one'), first);
    assert.equal(db.runAsAccount(second, () => db.getSetting('telegram_business_connection_id')), undefined);
    assert.ok(warnings.some((message) => message.includes('already assigned')));
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('business messages from different connections run in the matching profile context', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-poller-routing-'));
  const db = new BridgeDatabase(join(directory, 'bridge.json'));
  const received = [];
  const base = {
    telegram: { async sendBotText() {} },
    db,
    pairingCode: 'server-code',
    onBusinessMessage: async (message) => {
      received.push({
        connectionId: message.business_connection_id,
        accountId: db.currentAccountId(),
        ownerId: db.getSetting('telegram_owner_id')
      });
    },
    onEditedBusinessMessage: async () => {},
    onDeletedBusinessMessages: async () => {},
    log: { warn() {}, info() {} }
  };

  try {
    const first = db.registerTelegramOwner('9101');
    const second = db.registerTelegramOwner('9102');
    assert.equal(db.bindBusinessConnection(first, 'business-9101'), true);
    assert.equal(db.bindBusinessConnection(second, 'business-9102'), true);

    await Promise.all([
      handleTelegramUpdate({
        ...base,
        update: { business_message: { business_connection_id: 'business-9102', message_id: 2, from: { id: 777 } } }
      }),
      handleTelegramUpdate({
        ...base,
        update: { business_message: { business_connection_id: 'business-9101', message_id: 1, from: { id: 888 } } }
      })
    ]);

    assert.deepEqual(received.sort((a, b) => a.ownerId.localeCompare(b.ownerId)), [
      { connectionId: 'business-9101', accountId: first, ownerId: '9101' },
      { connectionId: 'business-9102', accountId: second, ownerId: '9102' }
    ]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


test('repeated Telegram bind does not show an unusable MAX code after MAX is already linked', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-repeat-bind-'));
  const db = new BridgeDatabase(join(directory, 'bridge.json'));
  const replies = [];
  const base = {
    telegram: { async sendBotText(_chatId, text) { replies.push(String(text)); } },
    db,
    pairingCode: 'server-code',
    onBusinessMessage: async () => {},
    onEditedBusinessMessage: async () => {},
    onDeletedBusinessMessages: async () => {},
    log: { warn() {}, info() {}, event() {} }
  };
  try {
    await handleTelegramUpdate({
      ...base,
      update: { message: { chat: { id: 701, type: 'private' }, from: { id: 701 }, text: '/bind server-code' } }
    });
    const accountId = db.findAccountByTelegramOwner('701');
    assert.equal(db.bindMaxOwner(accountId, '9001'), true);
    replies.length = 0;

    await handleTelegramUpdate({
      ...base,
      update: { message: { chat: { id: 701, type: 'private' }, from: { id: 701 }, text: '/bind server-code' } }
    });

    assert.equal(replies.length, 1);
    assert.match(replies[0], /MAX-аккаунт уже привязан/);
    assert.doesNotMatch(replies[0], /\/bind\s+[0-9A-F]{16}/);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


test('TGK command configures one of three public-link slots through the main Telegram bot', async () => {
  let configured;
  const replies = [];
  const deps = dependencies({
    message: { chat: { id: 999, type: 'private' }, from: { id: 999 }, text: '/tgk 2 https://t.me/public_channel' }
  }, {
    channelRelay: {
      async configureSlot(slot, url) {
        configured = { slot, url };
        return { verified: true, latestPostId: 55, slot: { slot: Number(slot), url: 'https://t.me/s/public_channel' } };
      }
    }
  });
  deps.telegram.sendBotText = async (_chatId, text) => { replies.push(text); };
  await handleTelegramUpdate(deps);
  assert.deepEqual(configured, { slot: 2, url: 'https://t.me/public_channel' });
  assert.ok(replies.some((text) => /TGK 2 настроен/.test(text)));
  assert.ok(replies.some((text) => /права администратора чужого канала не нужны/.test(text)));
});

test('TGK add command registers a second channel in the next free slot', async () => {
  let added;
  const replies = [];
  const deps = dependencies({
    message: { chat: { id: 999, type: 'private' }, from: { id: 999 }, text: '/tgk add https://t.me/second_channel' }
  }, {
    channelRelay: {
      async configureNextSlot(url) {
        added = url;
        return { verified: true, latestPostId: 77, slot: { slot: 2, url: 'https://t.me/s/second_channel' } };
      }
    }
  });
  deps.telegram.sendBotText = async (_chatId, text) => { replies.push(text); };
  await handleTelegramUpdate(deps);
  assert.equal(added, 'https://t.me/second_channel');
  assert.ok(replies.some((text) => /TGK 2 добавлен/.test(text)));
});
