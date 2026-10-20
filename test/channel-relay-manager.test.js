import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelRelayManager } from '../src/channel-relay-manager.js';

function fakeDb() {
  const settings = new Map();
  return {
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => value === undefined || value === null || value === '' ? settings.delete(key) : settings.set(key, String(value)),
    listAccounts: () => [],
    runAsAccount: (_id, fn) => fn(),
    settings
  };
}

test('channel manager stores several public channels and enables relay without env edits', () => {
  const db = fakeDb();
  const manager = new ChannelRelayManager({ db, log: {}, onPost: async () => true, dataDir: '/tmp' });
  manager.addSource('@first_channel');
  manager.addSource('https://t.me/second_channel');
  manager.addSource('https://t.me/s/first_channel');
  const status = manager.status();
  assert.equal(status.enabled, true);
  assert.deepEqual(status.sources.map((item) => item.url), [
    'https://t.me/s/first_channel',
    'https://t.me/s/second_channel'
  ]);
  assert.equal(manager.removeSource('@first_channel').removed, true);
  assert.deepEqual(manager.listSources().map((item) => item.url), ['https://t.me/s/second_channel']);
  manager.stop();
});


test('direct Telegram channel_post is relayed through Bot API and marks source as reliable', async () => {
  const db = fakeDb();
  db.listAccounts = () => [{ id: 'tg-1' }];
  const delivered = [];
  const manager = new ChannelRelayManager({
    db,
    log: {},
    onPost: async (payload) => { delivered.push(payload); return true; },
    dataDir: '/tmp'
  });
  manager.addSource('@first_channel');
  const matched = await manager.handleTelegramChannelPost({
    message_id: 42,
    chat: { id: -100123, type: 'channel', username: 'first_channel', title: 'First' },
    text: 'Новая публикация'
  });
  assert.equal(matched, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].post.id, 42);
  assert.equal(delivered[0].telegramMessages[0].text, 'Новая публикация');
  const source = manager.status().sources[0];
  assert.equal(source.mode, 'bot-api');
  assert.equal(source.chatId, '-100123');
  assert.equal(source.lastPostId, 42);
  manager.stop();
});


test('TGK uses exactly three numbered slots and keeps them independent', async () => {
  const db = fakeDb();
  const manager = new ChannelRelayManager({
    db,
    log: {},
    onPost: async () => true,
    dataDir: '/tmp',
    fetchPosts: async (url) => [{ id: url.includes('first') ? 10 : 20, title: 'Test', channel: 'test', text: '', media: [] }]
  });
  const one = await manager.configureSlot(1, 'https://t.me/first_channel');
  const two = await manager.configureSlot(2, 'https://t.me/second_channel');
  assert.equal(one.verified, true);
  assert.equal(two.verified, true);
  assert.equal(manager.getSlot(1).lastPostId, 10);
  assert.equal(manager.getSlot(2).lastPostId, 20);
  assert.equal(manager.getSlot(3).url, undefined);
  assert.throws(() => manager.setSlot(4, 'https://t.me/fourth_channel'), /1, 2 или 3/);
  manager.stop();
});

test('TGK add command chooses the next free slot for a second channel', async () => {
  const db = fakeDb();
  const manager = new ChannelRelayManager({
    db,
    log: {},
    onPost: async () => true,
    dataDir: '/tmp',
    fetchPosts: async (url) => [{ id: url.includes('first') ? 11 : 22, title: 'Test', channel: 'test', text: '', media: [] }]
  });
  const first = await manager.configureNextSlot('https://t.me/first_channel');
  const second = await manager.configureNextSlot('https://t.me/second_channel');
  assert.equal(first.slot.slot, 1);
  assert.equal(second.slot.slot, 2);
  assert.equal(manager.getSlot(1).url, 'https://t.me/s/first_channel');
  assert.equal(manager.getSlot(2).url, 'https://t.me/s/second_channel');
  manager.stop();
});

test('TGK passes the selected slot and its own MAX destination to the relay', async () => {
  const db = fakeDb();
  db.listAccounts = () => [{ id: 'tg-1' }];
  db.maxChatAvailableForCurrentAccount = () => true;
  const delivered = [];
  let cycle = 0;
  const manager = new ChannelRelayManager({
    db,
    log: {},
    onPost: async (payload) => { delivered.push(payload); return true; },
    dataDir: '/tmp',
    fetchPosts: async () => cycle++ === 0
      ? [{ id: 1, channel: 'first_channel', title: 'First', text: 'old', media: [] }]
      : [{ id: 1, channel: 'first_channel', title: 'First', text: 'old', media: [] }, { id: 2, channel: 'first_channel', title: 'First', text: 'new', media: [] }]
  });
  manager.setSlot(1, 'https://t.me/first_channel');
  manager.stop();
  manager.setSlotTarget(1, { maxChatId: '-10055', title: 'Target', type: 'chat' });
  await manager.relayCurrentAccountOnce();
  assert.equal(delivered.length, 0);
  await manager.relayCurrentAccountOnce();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].tgkSlot, 1);
  assert.deepEqual(delivered[0].tgkTarget, { maxChatId: '-10055', title: 'Target', type: 'chat' });
  assert.equal(delivered[0].post.text, 'new');
  manager.stop();
});
