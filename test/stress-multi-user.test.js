import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BridgeDatabase } from '../src/database.js';

test('100 profiles stay isolated after concurrent writes and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-stress-'));
  const databasePath = join(directory, 'bridge.json');
  const db = new BridgeDatabase(databasePath);

  try {
    const profiles = Array.from({ length: 100 }, (_, index) => {
      const ownerId = String(100_000 + index);
      const accountId = db.registerTelegramOwner(ownerId);
      return {
        index,
        ownerId,
        accountId,
        maxId: String(200_000 + index),
        businessId: `business-${index}`,
        maxChatId: String(300_000 + index),
        telegramChatId: String(400_000 + index)
      };
    });

    const pairingCodes = profiles.map(({ accountId }) => db.runAsAccount(accountId, () => db.getSetting('max_pairing_code')));
    assert.equal(new Set(pairingCodes).size, 100);

    await Promise.all(profiles.map(async (profile) => {
      assert.equal(db.bindMaxOwner(profile.accountId, profile.maxId), true);
      assert.equal(db.bindBusinessConnection(profile.accountId, profile.businessId), true);
      await db.runAsAccount(profile.accountId, async () => {
        await Promise.resolve();
        db.setSetting('profile_marker', `marker-${profile.index}`);
        db.rememberTelegramChat({
          telegramBusinessConnectionId: profile.businessId,
          telegramChatId: profile.telegramChatId,
          displayName: `Контакт ${profile.index}`
        });
        assert.ok(db.bindMaxGroup(profile.maxChatId, profile.telegramChatId));
        db.insertChatMessage({
          telegramChatId: profile.telegramChatId,
          direction: 'in',
          text: `Сообщение ${profile.index}`
        });
      });
    }));

    assert.equal(db.listAccounts().length, 100);
    for (const profile of profiles) {
      assert.equal(db.findAccountByTelegramOwner(profile.ownerId), profile.accountId);
      assert.equal(db.findAccountByMaxOwner(profile.maxId), profile.accountId);
      assert.equal(db.findAccountByBusinessConnection(profile.businessId), profile.accountId);
      assert.equal(db.findAccountByMaxChat(profile.maxChatId), profile.accountId);
      db.runAsAccount(profile.accountId, () => {
        assert.equal(db.getSetting('profile_marker'), `marker-${profile.index}`);
        assert.deepEqual(db.listTelegramChats().map((chat) => chat.telegramChatId), [profile.telegramChatId]);
        assert.deepEqual(db.listChatMessages(profile.telegramChatId).map((message) => message.text), [`Сообщение ${profile.index}`]);
      });
    }

    assert.equal(db.bindBusinessConnection(profiles[1].accountId, profiles[0].businessId), false);
    assert.equal(db.bindMaxOwner(profiles[1].accountId, profiles[0].maxId), false);
    assert.equal(db.runAsAccount(profiles[1].accountId, () => db.bindMaxGroup(profiles[0].maxChatId, '999')), undefined);

    db.close();
    const reopened = new BridgeDatabase(databasePath);
    try {
      assert.equal(reopened.listAccounts().length, 100);
      for (const profile of profiles) {
        reopened.runAsAccount(profile.accountId, () => {
          assert.equal(reopened.getSetting('profile_marker'), `marker-${profile.index}`);
          assert.equal(reopened.findTelegramChatIdForMaxGroup(profile.maxChatId), profile.telegramChatId);
          assert.equal(reopened.listChatMessages(profile.telegramChatId)[0].text, `Сообщение ${profile.index}`);
        });
      }
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
