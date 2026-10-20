import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanRelayedPostText,
  fetchPublicChannelHistory,
  fetchPublicChannelPosts,
  isAdvertisingPost,
  normalizePublicChannelUrl,
  parsePublicChannelHtml,
  sendWebPostToTelegram
} from '../src/web-channel-relay.js';

test('relay removes channel heading and source footer', () => {
  assert.equal(cleanRelayedPostText({
    title: 'Varlamov News',
    text: 'Varlamov News\n\nСам текст новости\n\nИсточник: https://t.me/varlamov_news/72640'
  }), 'Сам текст новости');
  assert.equal(cleanRelayedPostText({
    title: 'Varlamov News',
    text: 'Сам текст новости'
  }), 'Сам текст новости');
});

test('advertising hashtags are detected without matching ordinary words', () => {
  assert.equal(isAdvertisingPost({ text: 'Публикация #ad' }), true);
  assert.equal(isAdvertisingPost({ text: 'Публикация\n#РЕКЛАМА.' }), true);
  assert.equal(isAdvertisingPost({ text: 'Публикация #advertising' }), false);
  assert.equal(isAdvertisingPost({ text: 'Обычная публикация' }), false);
});

test('public Telegram channel links are normalized to the web preview', () => {
  assert.equal(normalizePublicChannelUrl('https://t.me/varlamov_news'), 'https://t.me/s/varlamov_news');
  assert.equal(normalizePublicChannelUrl('@varlamov_news'), 'https://t.me/s/varlamov_news');
  assert.throws(() => normalizePublicChannelUrl('https://example.com/channel'), /t\.me/);
  assert.throws(() => normalizePublicChannelUrl('https://t.me/+invite'), /публичный/i);
});

test('public Telegram HTML is parsed into ordered posts and albums', () => {
  const html = `
    <meta property="og:title" content="Test channel">
    <div class="tgme_widget_message" data-post="test_channel/12">
      <div class="tgme_widget_message_text">Second<br>line</div>
      <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn.example/two.jpg')"></a>
      <video src="https://cdn.example/video.mp4"></video>
      <a class="tgme_widget_message_date" href="https://t.me/test_channel/12"></a>
    </div>
    <div class="tgme_widget_message" data-post="test_channel/11">
      <div class="tgme_widget_message_text">First</div>
    </div>`;
  const posts = parsePublicChannelHtml(html, 'https://t.me/s/test_channel');
  assert.deepEqual(posts.map((post) => post.id), [11, 12]);
  assert.equal(posts[1].text, 'Second\nline');
  assert.deepEqual(posts[1].media, [
    { kind: 'photo', url: 'https://cdn.example/two.jpg' },
    { kind: 'video', url: 'https://cdn.example/video.mp4' }
  ]);
  assert.equal(posts[1].title, 'Test channel');
});

test('web post uses Telegram media groups without source attribution', async () => {
  const calls = [];
  const telegram = {
    async sendBotMediaGroup(chatId, media) {
      calls.push({ method: 'group', chatId, media });
      return [{ message_id: 1, photo: [{ file_id: 'a' }] }, { message_id: 2, video: { file_id: 'b' } }];
    },
    async sendBotText(chatId, text) {
      calls.push({ method: 'text', chatId, text });
      return { message_id: 3, text };
    }
  };
  const messages = await sendWebPostToTelegram({
    telegram,
    chatId: '-1001',
    post: {
      id: 8,
      channel: 'test_channel',
      title: 'Test channel',
      text: 'A post',
      link: 'https://t.me/test_channel/8',
      media: [
        { kind: 'photo', url: 'https://cdn.example/a.jpg' },
        { kind: 'video', url: 'https://cdn.example/b.mp4' }
      ]
    }
  });
  assert.equal(messages.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].media[0].caption, 'A post');
});



test('public channel reader falls back from t.me to telegram.me and parses the page', async () => {
  const calls = [];
  const html = `
    <meta property="og:title" content="Fallback channel">
    <div class="tgme_widget_message" data-post="fallback_channel/77">
      <div class="tgme_widget_message_text">Рабочий пост</div>
      <a class="tgme_widget_message_date" href="https://t.me/fallback_channel/77"></a>
    </div>`;
  const posts = await fetchPublicChannelPosts('https://t.me/fallback_channel', {
    async fetchText(url) {
      calls.push(url);
      if (new URL(url).hostname === 't.me') throw new Error('primary blocked');
      return { text: html, finalUrl: url, contentType: 'text/html' };
    }
  });
  assert.equal(new URL(calls[0]).hostname, 't.me');
  assert.equal(new URL(calls[1]).hostname, 'telegram.me');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, 77);
  assert.equal(posts[0].text, 'Рабочий пост');
});

test('history loader walks older web pages and returns the requested ordered tail', async () => {
  const calls = [];
  const makePosts = (first, last) => Array.from(
    { length: last - first + 1 },
    (_value, index) => ({ id: first + index, channel: 'test_channel' })
  );
  const posts = await fetchPublicChannelHistory('https://t.me/s/test_channel', 25, {
    async fetchPosts(url) {
      calls.push(url);
      const before = new URL(url).searchParams.get('before');
      return before ? makePosts(1, 20) : makePosts(21, 40);
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]).searchParams.get('before'), '21');
  assert.deepEqual(posts.map((post) => post.id), makePosts(16, 40).map((post) => post.id));
});

test('history loader rejects unsafe backfill sizes', async () => {
  await assert.rejects(
    fetchPublicChannelHistory('https://t.me/s/test_channel', 101, { fetchPosts: async () => [] }),
    /от 1 до 100/
  );
});
