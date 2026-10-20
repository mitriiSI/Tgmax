import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pairMaxAccount } from '../src/account-pairing.js';
import { BridgeDatabase } from '../src/database.js';
import { handleTelegramUpdate } from '../src/telegram-poller.js';

test('25 users complete the documented Telegram → MAX → Business onboarding flow independently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-onboarding-'));
  const databasePath = join(directory, 'bridge.json');
  const db = new BridgeDatabase(databasePath);
  const replies = new Map();
  const routed = [];
  const telegram = {
    async sendBotText(chatId, text) {
      replies.set(String(chatId), String(text));
    }
  };
  const base = {
    telegram,
    db,
    pairingCode: 'COMMON-SERVER-CODE',
    onBusinessMessage: async (message) => {
      routed.push({
        accountId: db.currentAccountId(),
        ownerId: db.getSetting('telegram_owner_id'),
        connectionId: message.business_connection_id
      });
    },
    onEditedBusinessMessage: async () => {},
    onDeletedBusinessMessages: async () => {},
    log: { warn() {}, info() {} }
  };

  try {
    const users = Array.from({ length: 25 }, (_, index) => ({
      telegramId: String(700_000 + index),
      maxId: String(800_000 + index),
      businessId: `business-onboarding-${index}`
    }));

    for (const user of users) {
      await handleTelegramUpdate({
        ...base,
        update: {
          message: {
            chat: { id: user.telegramId, type: 'private' },
            from: { id: user.telegramId },
            text: '/bind COMMON-SERVER-CODE'
          }
        }
      });

      const reply = replies.get(user.telegramId);
      const personalCode = reply?.match(/\/bind\s+([0-9A-F]{16})/)?.[1];
      assert.ok(personalCode, `Telegram user ${user.telegramId} did not receive a personal MAX code`);

      const paired = pairMaxAccount({ db, senderId: user.maxId, text: `/bind ${personalCode}` });
      assert.deepEqual(paired, { status: 'paired', accountId: `tg-${user.telegramId}` });

      await handleTelegramUpdate({
        ...base,
        update: {
          business_connection: {
            id: user.businessId,
            user: { id: user.telegramId },
            is_enabled: true,
            rights: { can_reply: true }
          }
        }
      });
    }

    assert.equal(db.listAccounts().length, users.length);
    assert.equal(new Set(db.listAccounts().map((account) => account.maxPairingCode)).size, users.length);

    await Promise.all(users.map((user, index) => handleTelegramUpdate({
      ...base,
      update: {
        business_message: {
          business_connection_id: user.businessId,
          message_id: index + 1,
          from: { id: String(900_000 + index) },
          text: `message-${index}`
        }
      }
    })));

    assert.equal(routed.length, users.length);
    for (const user of users) {
      const accountId = `tg-${user.telegramId}`;
      assert.equal(db.findAccountByTelegramOwner(user.telegramId), accountId);
      assert.equal(db.findAccountByMaxOwner(user.maxId), accountId);
      assert.equal(db.findAccountByBusinessConnection(user.businessId), accountId);
      assert.ok(routed.some((item) => (
        item.accountId === accountId
        && item.ownerId === user.telegramId
        && item.connectionId === user.businessId
      )));
    }

    db.close();
    const reopened = new BridgeDatabase(databasePath);
    try {
      assert.equal(reopened.listAccounts().length, users.length);
      for (const user of users) {
        assert.equal(reopened.findAccountByTelegramOwner(user.telegramId), `tg-${user.telegramId}`);
        assert.equal(reopened.findAccountByMaxOwner(user.maxId), `tg-${user.telegramId}`);
        assert.equal(reopened.findAccountByBusinessConnection(user.businessId), `tg-${user.telegramId}`);
      }
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
