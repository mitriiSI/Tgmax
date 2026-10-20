import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMaxForwardNote, formatTelegramAlbumContentOnly, formatTelegramForMax, splitText, telegramForwardSource, telegramForwardSourceType } from '../src/text.js';

test('splitText keeps every character', () => {
  const source = 'one two three four five six seven eight';
  const chunks = splitText(source, 10);
  assert.equal(chunks.join(' '), source);
  assert.ok(chunks.every((chunk) => chunk.length <= 10));
});

test('Telegram GIF is labeled only as GIF even when legacy document is present', () => {
  const output = formatTelegramForMax({
    animation: { file_id: 'animation' },
    document: { file_id: 'document', file_name: 'animation.mp4' },
    from: { first_name: 'Иван' }
  });
  assert.match(output, /GIF/);
  assert.doesNotMatch(output, /Файл/);
});

test('formatTelegramForMax labels sender but omits ordinary attachment types', () => {
  const output = formatTelegramForMax({
    text: 'Привет',
    chat: { id: 42 },
    photo: [{}],
    from: { first_name: 'Иван', username: 'ivan' }
  });
  assert.match(output, /ID: 42/);
  assert.match(output, /Имя: Иван/);
  assert.match(output, /Привет/);
  assert.doesNotMatch(output, /Тип:/);
  assert.doesNotMatch(output, /Telegram ·/);
  assert.doesNotMatch(output, /Username/);
  assert.doesNotMatch(output, /Вложение/);
});

test('formatTelegramForMax keeps a label for a video message', () => {
  const output = formatTelegramForMax({ chat: { id: 42 }, from: { first_name: 'Иван' }, video_note: {} });
  assert.match(output, /Тип: Видеосообщение/);
});

test('formatTelegramForMax can use a custom display name', () => {
  const output = formatTelegramForMax({
    text: 'Привет',
    chat: { id: 42 },
    from: { first_name: 'Иван' }
  }, {
    displayName: 'Клиент'
  });

  assert.match(output, /ID: 42/);
  assert.match(output, /Имя: Клиент/);
  assert.doesNotMatch(output, /Имя: Иван/);
});

test('dedicated MAX group receives only the Telegram message body', () => {
  const output = formatTelegramForMax({
    text: 'Привет',
    chat: { id: 7734702943 },
    from: { first_name: 'второй акк' }
  }, {
    displayName: 'второй акк',
    contentOnly: true
  });

  assert.equal(output, 'Привет');
  assert.doesNotMatch(output, /ID:|Имя:|Telegram/);
});

test('dedicated MAX group keeps only a short label for special attachments', () => {
  const output = formatTelegramForMax({
    caption: 'Смотри',
    chat: { id: 42 },
    from: { first_name: 'Иван' },
    sticker: {}
  }, { contentOnly: true });

  assert.equal(output, 'Смотри\n\nСтикер');
});

test('ordinary attachment without caption has no visible service label in dedicated group', () => {
  const output = formatTelegramForMax({ photo: [{}] }, { contentOnly: true });
  assert.equal(output, '\u2063');
});

test('dedicated MAX group album omits sender and album service header', () => {
  const output = formatTelegramAlbumContentOnly([
    { chat: { id: 42 }, from: { first_name: 'Иван' }, photo: [{}], caption: 'Три фотографии' },
    { chat: { id: 42 }, from: { first_name: 'Иван' }, photo: [{}] }
  ]);

  assert.equal(output, 'Три фотографии');
  assert.doesNotMatch(output, /ID:|Имя:|Альбом|Telegram/);
});


test('forwarded source is an italic MAX note in private chats and groups', () => {
  const output = formatMaxForwardNote('Текст <сообщения>', 'Иван & Компания', 'chat');
  assert.equal(output.format, 'html');
  assert.equal(output.text, 'Текст &lt;сообщения&gt;\n\n<i>Переслано от: Иван &amp; Компания</i>');
});

test('forwarded source note is omitted in channels', () => {
  const output = formatMaxForwardNote('Публикация', 'Иван', 'channel');
  assert.deepEqual(output, { text: 'Публикация', format: undefined });
});


test('forward source supports current and legacy Telegram fields', () => {
  assert.equal(telegramForwardSource({
    forward_origin: { type: 'user', sender_user: { first_name: 'Иван', last_name: 'Петров' } }
  }), 'Иван Петров');
  assert.equal(telegramForwardSource({
    forward_from: { first_name: 'Анна', last_name: 'Смирнова' }
  }), 'Анна Смирнова');
  assert.equal(telegramForwardSource({ forward_sender_name: 'Скрытое имя' }), 'Скрытое имя');
});


test('forwarded source note is omitted when the original Telegram source is a channel', () => {
  const message = {
    forward_origin: { type: 'channel', chat: { title: 'Новости' } }
  };
  const output = formatMaxForwardNote(
    'Публикация',
    telegramForwardSource(message),
    'chat',
    telegramForwardSourceType(message)
  );
  assert.deepEqual(output, { text: 'Публикация', format: undefined });
});

test('forwarded group source keeps the italic note', () => {
  const message = {
    forward_origin: { type: 'chat', chat: { title: 'Рабочая группа' } }
  };
  const output = formatMaxForwardNote(
    'Сообщение',
    telegramForwardSource(message),
    'chat',
    telegramForwardSourceType(message)
  );
  assert.equal(output.format, 'html');
  assert.match(output.text, /<i>Переслано от: Рабочая группа<\/i>/);
});
