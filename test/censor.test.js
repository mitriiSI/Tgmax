import assert from 'node:assert/strict';
import test from 'node:test';
import { censorTelegramMessage, censorText } from '../src/censor.js';

test('censor replaces words and phrases but preserves spaces and punctuation', () => {
  assert.equal(censorText('Плохое слово, а потом очень плохо!', ['плохое слово', 'плохо']), '██████ █████, а потом очень █████!');
});

test('censor is case insensitive, treats е and ё equally and respects word boundaries', () => {
  assert.equal(censorText('Ёлка елка ПОДЪЁЛКА', ['елка']), '████ ████ ПОДЪЁЛКА');
});

test('telegram message censor changes only text and caption in a clone', () => {
  const original = { text: 'секрет', chat: { id: 1 } };
  const filtered = censorTelegramMessage(original, ['секрет']);
  assert.equal(filtered.text, '██████');
  assert.equal(original.text, 'секрет');
  assert.equal(filtered.chat, original.chat);
});

test('censor keeps offsets correct after emoji', () => {
  assert.equal(censorText('🙂 секрет после', ['секрет']), '🙂 ██████ после');
});
