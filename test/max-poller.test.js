import test from 'node:test';
import assert from 'node:assert/strict';
import { maxMessageFromUpdate, startMaxPolling } from '../src/max-poller.js';

test('MAX message update can be read from current and compatibility payloads', () => {
  const direct = { body: { mid: 'direct' } };
  const nested = { body: { mid: 'nested' } };
  assert.equal(maxMessageFromUpdate({ message: direct }), direct);
  assert.equal(maxMessageFromUpdate({ message_created: { message: nested } }), nested);
  assert.equal(maxMessageFromUpdate({ update_type: 'message_created' }), undefined);
});

test('malformed MAX update does not block the following ready message', async () => {
  const savedSettings = new Map();
  const received = [];
  const warnings = [];
  const errors = [];
  let poller;
  const readyMessage = {
    sender: { user_id: 42 },
    body: { mid: 'ready', text: null, attachments: [{ type: 'video' }] }
  };

  poller = startMaxPolling({
    maxBot: {
      api: {
        async getUpdates() {
          return {
            marker: 15,
            updates: [
              { update_type: 'message_created', timestamp: 1 },
              { update_type: 'message_created', timestamp: 2, message_created: { message: readyMessage } }
            ]
          };
        }
      }
    },
    db: {
      getSetting(key) { return savedSettings.get(key); },
      setSetting(key, value) { savedSettings.set(key, value); }
    },
    async onMessage(message) {
      received.push(message);
      poller.stop();
    },
    log: {
      warn(message) { warnings.push(message); },
      error(message) { errors.push(message); }
    }
  });

  await poller.promise;
  assert.deepEqual(received, [readyMessage]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(errors, []);
  assert.equal(savedSettings.get('max_update_marker'), '15');
});

test('MAX chat lifecycle updates are requested and dispatched', async () => {
  const savedSettings = new Map();
  const received = [];
  let requestedTypes;
  let poller;

  poller = startMaxPolling({
    maxBot: {
      api: {
        async getUpdates(types) {
          requestedTypes = types;
          return {
            marker: 19,
            updates: [{ update_type: 'bot_added', chat_id: -10042, is_channel: true }]
          };
        }
      }
    },
    db: {
      getSetting(key) { return savedSettings.get(key); },
      setSetting(key, value) { savedSettings.set(key, value); }
    },
    async onMessage() {},
    async onChatUpdate(update) {
      received.push(update);
      poller.stop();
    },
    log: { warn() {}, error() {} }
  });

  await poller.promise;
  assert.ok(requestedTypes.includes('bot_added'));
  assert.ok(requestedTypes.includes('bot_removed'));
  assert.ok(requestedTypes.includes('chat_title_changed'));
  assert.equal(received[0].chat_id, -10042);
  assert.equal(savedSettings.get('max_update_marker'), '19');
});
