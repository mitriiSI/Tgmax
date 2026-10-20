import { fetchTextResilient } from './resilient-http.js';
import { splitText } from './text.js';
import { prepareWebPostMedia } from './web-media.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function absoluteUrl(value) {
  if (!value) return '';
  try {
    return new URL(value, 'https://t.me').toString();
  } catch {
    return '';
  }
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizePublicChannelUrl(input) {
  let value = String(input ?? '').trim();
  if (!value) throw new Error('Не указана ссылка на публичный Telegram-канал');
  if (value.startsWith('@')) value = `https://t.me/${value.slice(1)}`;
  if (/^(?:www\.)?t\.me\//i.test(value)) value = `https://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Нужна ссылка вида https://t.me/channel_name');
  }
  if (!['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me'].includes(url.hostname.toLowerCase())) {
    throw new Error('Поддерживаются только публичные ссылки t.me');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const channel = segments[0]?.toLowerCase() === 's' ? segments[1] : segments[0];
  if (!channel || channel.startsWith('+') || channel === 'joinchat' || !/^[a-zA-Z0-9_]{5,}$/.test(channel)) {
    throw new Error('Это не публичный username канала');
  }
  return `https://t.me/s/${channel}`;
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
    laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…'
  };
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    }
    return named[entity.toLowerCase()] ?? _match;
  });
}

function attrFromTag(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = String(tag ?? '').match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  if (quoted) return decodeHtmlEntities(quoted[2]);
  const bare = String(tag ?? '').match(new RegExp(`\\b${escaped}\\s*=\\s*([^\\s>]+)`, 'i'));
  return decodeHtmlEntities(bare?.[1] ?? '');
}

function tagHasClass(tag, className) {
  return attrFromTag(tag, 'class').split(/\s+/).includes(className);
}

function htmlToText(value) {
  return normalizeText(decodeHtmlEntities(String(value ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|blockquote|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')));
}

function photoUrlFromStyle(style) {
  const match = String(style ?? '').match(/background-image\s*:\s*url\((?:&quot;|['"])?(.*?)(?:&quot;|['"])?\)/i);
  return absoluteUrl(decodeHtmlEntities(match?.[1] ?? ''));
}

function titleFromHtml(html) {
  const tags = String(html ?? '').match(/<[^>]+>/g) ?? [];
  for (const tag of tags) {
    if (tagHasClass(tag, 'tgme_channel_info_header_title')) {
      const start = String(html).indexOf(tag) + tag.length;
      const close = String(html).indexOf('</', start);
      if (close > start) return htmlToText(String(html).slice(start, close));
    }
    if (/^<meta\b/i.test(tag) && attrFromTag(tag, 'property').toLowerCase() === 'og:title') {
      const title = normalizeText(attrFromTag(tag, 'content'));
      if (title) return title;
    }
  }
  return 'Telegram-канал';
}

function extractClassInnerHtml(segment, className) {
  const open = new RegExp(`<([a-z0-9]+)\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`, 'i').exec(segment);
  if (!open) return '';
  const from = open.index + open[0].length;
  const close = new RegExp(`</${open[1]}\\s*>`, 'i').exec(segment.slice(from));
  return close ? segment.slice(from, from + close.index) : '';
}

export function parsePublicChannelHtml(html, sourceUrl = '') {
  const source = String(html ?? '');
  const title = titleFromHtml(source);
  const fallbackChannel = (() => {
    try {
      const segments = new URL(sourceUrl).pathname.split('/').filter(Boolean);
      return segments[0] === 's' ? segments[1] : segments[0];
    } catch {
      return '';
    }
  })();

  const roots = [];
  const tagRegex = /<div\b[^>]*>/gi;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(source))) {
    if (!tagHasClass(tagMatch[0], 'tgme_widget_message')) continue;
    const dataPost = attrFromTag(tagMatch[0], 'data-post');
    if (dataPost) roots.push({ index: tagMatch.index, dataPost });
  }

  const posts = [];
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex];
    const segment = source.slice(root.index, roots[rootIndex + 1]?.index ?? source.length);
    const match = root.dataPost.match(/^([^/]+)\/(\d+)$/);
    if (!match) continue;
    const channel = match[1] || fallbackChannel;
    const id = Number(match[2]);
    if (!Number.isSafeInteger(id)) continue;

    const text = htmlToText(extractClassInnerHtml(segment, 'tgme_widget_message_text'));
    let dateLink = '';
    for (const tag of segment.match(/<a\b[^>]*>/gi) ?? []) {
      if (tagHasClass(tag, 'tgme_widget_message_date')) {
        dateLink = attrFromTag(tag, 'href');
        break;
      }
    }
    const link = absoluteUrl(dateLink) || `https://t.me/${channel}/${id}`;
    const media = [];
    const seen = new Set();

    for (const tag of segment.match(/<a\b[^>]*>/gi) ?? []) {
      if (!tagHasClass(tag, 'tgme_widget_message_photo_wrap')) continue;
      const url = photoUrlFromStyle(attrFromTag(tag, 'style'));
      if (url && !seen.has(url)) {
        seen.add(url);
        media.push({ kind: 'photo', url });
      }
    }

    const videoRegex = /<video\b([^>]*)>([\s\S]*?)<\/video>|<video\b([^>]*)\/>/gi;
    let videoMatch;
    while ((videoMatch = videoRegex.exec(segment))) {
      const videoTag = `<video ${videoMatch[1] ?? videoMatch[3] ?? ''}>`;
      const body = videoMatch[2] ?? '';
      let url = attrFromTag(videoTag, 'src');
      if (!url) {
        const sourceTag = body.match(/<source\b[^>]*>/i)?.[0];
        url = attrFromTag(sourceTag, 'src');
      }
      url = absoluteUrl(url);
      if (url && !seen.has(url)) {
        seen.add(url);
        media.push({ kind: 'video', url });
      }
    }

    posts.push({ id, channel, title, text, link, media });
  }

  return posts.sort((left, right) => left.id - right.id);
}

function publicChannelFetchCandidates(sourceUrl) {
  const canonical = normalizePublicChannelUrl(sourceUrl);
  const url = new URL(canonical);
  const suffix = `${url.pathname}${url.search}`;
  return [
    `https://t.me${suffix}`,
    `https://telegram.me${suffix}`,
    `https://www.t.me${suffix}`
  ];
}

export async function fetchPublicChannelPosts(sourceUrl, { timeoutMs = 20_000, fetchText = fetchTextResilient } = {}) {
  const errors = [];
  for (const candidate of publicChannelFetchCandidates(sourceUrl)) {
    try {
      const response = await fetchText(candidate, {
        timeoutMs,
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'ru-RU,ru;q=0.9,en;q=0.7',
          'cache-control': 'no-cache',
          pragma: 'no-cache'
        }
      });
      const posts = parsePublicChannelHtml(response.text, candidate);
      if (!posts.length) {
        const lower = String(response.text || '').toLowerCase();
        if (lower.includes('channel_private') || lower.includes('this channel is private')) {
          throw new Error('канал закрытый или недоступен без приглашения');
        }
        throw new Error('на публичной странице не найдено ни одной публикации');
      }
      return posts;
    } catch (error) {
      const message = error?.name === 'AbortError' || /timeout/i.test(error?.message ?? '')
        ? `не ответил за ${Math.ceil(timeoutMs / 1000)} секунд`
        : String(error?.message || error);
      errors.push(`${new URL(candidate).hostname}: ${message}`);
    }
  }
  throw new Error(`не удалось прочитать публичный Telegram-канал по ссылке. ${errors.join(' | ')}`);
}

export async function fetchPublicChannelHistory(
  sourceUrl,
  count,
  { fetchPosts = fetchPublicChannelPosts, maxPages = 20 } = {}
) {
  const requested = Number(count);
  if (!Number.isInteger(requested) || requested < 1 || requested > 100) {
    throw new Error('Количество публикаций должно быть целым числом от 1 до 100');
  }

  const collected = new Map();
  let before;
  for (let page = 0; page < maxPages && collected.size < requested; page += 1) {
    const pageUrl = new URL(sourceUrl);
    if (before) pageUrl.searchParams.set('before', String(before));
    const posts = await fetchPosts(pageUrl.toString());
    for (const post of posts) collected.set(post.id, post);
    const oldest = Math.min(...posts.map((post) => post.id));
    if (!Number.isSafeInteger(oldest) || oldest <= 1 || oldest === before) break;
    before = oldest;
  }

  return [...collected.values()]
    .sort((left, right) => left.id - right.id)
    .slice(-requested);
}

function commandParts(text) {
  const match = String(text ?? '').trim().match(/^\/([^\s@]+)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/);
  return { command: (match?.[1] ?? '').toLowerCase(), argument: (match?.[2] ?? '').trim() };
}

export function cleanRelayedPostText(post) {
  const title = String(post?.title ?? '').trim();
  let text = String(post?.text ?? '').trim();

  if (title) {
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`^${escapedTitle}(?:\\r?\\n)+`, 'iu'), '');
  }

  // Older versions appended a source footer. Removing its URL also prevents
  // MAX from creating a Telegram link-preview card under the publication.
  text = text.replace(
    /(?:\r?\n){1,2}Источник:\s*https?:\/\/(?:t\.me|telegram\.me)\/[^\s]+\s*$/iu,
    ''
  );

  return text.trim();
}

function captionParts(post) {
  const budget = 1024;
  const text = cleanRelayedPostText(post);
  const first = text.slice(0, budget).trimEnd();
  return {
    caption: first,
    remainder: text.slice(first.length).trimStart()
  };
}

export function isAdvertisingPost(post) {
  const text = String(post?.text ?? post?.caption ?? '');
  return /(^|\s)#(?:ad|реклама)(?=$|[\s.,!?;:()\[\]{}"'«»])/iu.test(text);
}

async function sendTextChunks(telegram, chatId, text) {
  const messages = [];
  for (const chunk of splitText(text, 4000)) {
    messages.push(await telegram.sendBotText(chatId, chunk, { disable_web_page_preview: true }));
  }
  return messages;
}

async function sendRemoteMedia({ telegram, chatId, supportedMedia, caption, log }) {
  const messages = [];
  let mediaSent = false;
  if (supportedMedia.length === 1) {
    try {
      messages.push(await telegram.sendBotMediaUrl({
        chatId,
        kind: supportedMedia[0].kind,
        url: supportedMedia[0].url,
        caption
      }));
      mediaSent = true;
    } catch (error) {
      log?.warn?.('Web relay could not send one media file', error.message);
    }
  } else if (supportedMedia.length > 1) {
    try {
      for (let offset = 0; offset < supportedMedia.length; offset += 10) {
        const chunk = supportedMedia.slice(offset, offset + 10);
        if (chunk.length === 1) {
          messages.push(await telegram.sendBotMediaUrl({
            chatId,
            kind: chunk[0].kind,
            url: chunk[0].url,
            caption: offset === 0 ? caption : ''
          }));
          mediaSent = true;
          continue;
        }
        const group = chunk.map((item, index) => ({
          type: item.kind,
          media: item.url,
          ...((offset === 0 && index === 0) ? { caption } : {})
        }));
        messages.push(...await telegram.sendBotMediaGroup(chatId, group));
        mediaSent = true;
      }
    } catch (error) {
      log?.warn?.('Web relay could not send media group', error.message);
    }
  }
  return { messages, mediaSent };
}

async function sendLocalMedia({ telegram, chatId, items, caption }) {
  const messages = [];
  for (let offset = 0; offset < items.length; offset += 10) {
    const chunk = items.slice(offset, offset + 10).map((item, index) => ({
      ...item,
      ...((offset === 0 && index === 0 && caption) ? { caption } : {})
    }));
    if (chunk.length === 1) {
      messages.push(await telegram.sendBotMediaFile({ chatId, ...chunk[0] }));
    } else {
      messages.push(...await telegram.sendBotMediaGroupFiles(chatId, chunk));
    }
  }
  return messages;
}

export async function sendWebPostToTelegram({
  telegram,
  chatId,
  post,
  log,
  dataDir,
  mediaTargetBytes = 19 * 1024 * 1024,
  mediaTransferTimeoutMs = 30 * 60 * 1000,
  prepareMedia = prepareWebPostMedia
}) {
  const messages = [];
  const supportedMedia = post.media.filter((item) => item.kind === 'photo' || item.kind === 'video');
  const { caption, remainder } = captionParts(post);
  let mediaSent = false;

  if (supportedMedia.length && dataDir) {
    let prepared;
    try {
      prepared = await prepareMedia({
        post: { ...post, media: supportedMedia },
        dataDir,
        targetBytes: mediaTargetBytes,
        timeoutMs: mediaTransferTimeoutMs,
        // Do not download a huge source file just to discover that Telegram
        // cannot accept it. The post text still continues through the relay.
        sourceLimitBytes: mediaTargetBytes + (1024 * 1024),
        log
      });
      if (prepared.items.length) {
        messages.push(...await sendLocalMedia({
          telegram,
          chatId,
          items: prepared.items,
          caption
        }));
        mediaSent = true;
      }
    } catch (error) {
      log?.warn?.('Web relay local media preparation failed', error.message);
    } finally {
      await prepared?.cleanup?.().catch((error) => log?.warn?.('Could not remove web relay temp files', error.message));
    }
  }

  if (!mediaSent && supportedMedia.length) {
    const remote = await sendRemoteMedia({ telegram, chatId, supportedMedia, caption, log });
    messages.push(...remote.messages);
    mediaSent = remote.mediaSent;
  }

  if (mediaSent && remainder) {
    messages.push(...await sendTextChunks(telegram, chatId, remainder));
  }
  if (!mediaSent) {
    const fallback = [cleanRelayedPostText(post), supportedMedia.length ? '[Видео пропущено: размер превышает допустимый лимит]' : '']
      .filter(Boolean)
      .join('\n\n');
    messages.push(...await sendTextChunks(telegram, chatId, fallback));
  }
  return messages;
}

export function startWebChannelRelay({
  telegram,
  db,
  pairingCode,
  pollIntervalMs = 60_000,
  dataDir,
  mediaTargetBytes = 19 * 1024 * 1024,
  mediaTransferTimeoutMs = 30 * 60 * 1000,
  onRelayedPost,
  log = console
}) {
  let stopped = false;
  let sourceTimer;
  let sourcePolling = false;
  let commandOffset = Number(db.getSetting('web_relay_update_offset')) || 0;

  const saveError = (error) => {
    const message = String(error?.message ?? error ?? 'неизвестная ошибка').slice(0, 500);
    db.setSetting('web_relay_last_error', message);
    log.warn?.('Public Telegram web relay failed', message);
  };

  const clearError = () => db.setSetting('web_relay_last_error', '');

  const getSources = () => {
    try {
      const parsed = JSON.parse(db.getSetting('web_relay_sources') || '[]');
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {}
    const url = db.getSetting('web_relay_source_url');
    return url ? [{ url, lastPostId: Number(db.getSetting('web_relay_last_post_id')) || 0 }] : [];
  };

  const saveSources = (sources) => {
    db.setSetting('web_relay_sources', JSON.stringify(sources));
    const active = sources[0];
    db.setSetting('web_relay_source_url', active?.url || '');
    db.setSetting('web_relay_last_post_id', active?.lastPostId ? String(active.lastPostId) : '');
  };

  const retryAfterSeconds = (error) => {
    const direct = Number(error?.parameters?.retry_after ?? error?.response?.parameters?.retry_after);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const match = String(error?.message ?? '').match(/retry after\s+(\d+)/i);
    return match ? Number(match[1]) : 0;
  };

  async function relayPost(post, targetChatId) {
    if (isAdvertisingPost(post)) {
      log.info?.(`Advertising post ${post.channel}/${post.id} skipped`);
      return [];
    }
    let telegramMessages;
    for (let attempt = 0; ; attempt += 1) {
      try {
        telegramMessages = await sendWebPostToTelegram({
          telegram, chatId: targetChatId, post, log, dataDir,
          mediaTargetBytes, mediaTransferTimeoutMs
        });
        break;
      } catch (error) {
        const seconds = retryAfterSeconds(error);
        if (!seconds || attempt >= 2) throw error;
        log.warn?.(`Telegram rate limit; retrying post ${post.id} after ${seconds}s`);
        await delay((seconds + 1) * 1000);
      }
    }
    db.setSetting('web_relay_last_post_id', Math.max(
      Number(db.getSetting('web_relay_last_post_id')) || 0,
      post.id
    ));
    db.setSetting('web_relay_last_title', post.title);
    clearError();
    try {
      await onRelayedPost?.({ post, telegramMessages });
    } catch (error) {
      log.warn?.('Public post reached Telegram but MAX duplication failed', error.message);
    }
    log.info?.(`Public Telegram post ${post.channel}/${post.id} relayed`);
    return telegramMessages;
  }

  async function relayOnce() {
    if (sourcePolling || stopped || db.getSetting('web_relay_enabled') !== 'true') return;
      const targetChatId = db.getSetting('web_relay_target_chat_id');
    const sources = getSources();
    if (!sources.length || !targetChatId) return;
    sourcePolling = true;
    try {
      for (const source of sources) {
        try {
          const posts = await fetchPublicChannelPosts(source.url);
          const pending = source.lastPostId
            ? posts.filter((post) => post.id > source.lastPostId)
            : posts.length ? [posts.at(-1)] : [];
          for (const post of pending) {
            try {
              await relayPost(post, targetChatId);
            } catch (error) {
              log.warn?.(`Post ${post.channel}/${post.id} skipped`, error.message);
            } finally {
              // A broken/oversized post must never block every newer post.
              source.lastPostId = Math.max(Number(source.lastPostId) || 0, post.id);
              saveSources(sources);
            }
          }
        } catch (error) {
          log.warn?.(`Source ${source.url} skipped this cycle`, error.message);
        }
      }
    } catch (error) {
      saveError(error);
    } finally {
      sourcePolling = false;
    }
  }

  async function loadLatestPosts(count) {
    if (sourcePolling) throw new Error('Сейчас уже обрабатывается другая публикация. Повтори команду чуть позже.');
    const sourceUrl = db.getSetting('web_relay_source_url');
    const targetChatId = db.getSetting('web_relay_target_chat_id');
    if (!sourceUrl || !targetChatId) throw new Error('Сначала задай источник командой /source и Telegram-канал назначения командой /target.');
    sourcePolling = true;
    try {
      const posts = await fetchPublicChannelHistory(sourceUrl, count);
      let loaded = 0;
      for (const post of posts) {
        try {
          await relayPost(post, targetChatId);
          loaded += 1;
        } catch (error) {
          log.warn?.(`History post ${post.channel}/${post.id} skipped`, error.message);
        }
        await delay(1_200);
      }
      return loaded;
    } catch (error) {
      saveError(error);
      throw error;
    } finally {
      sourcePolling = false;
    }
  }

  function scheduleSource(delayMs = pollIntervalMs) {
    clearTimeout(sourceTimer);
    if (stopped) return;
    sourceTimer = setTimeout(async () => {
      await relayOnce();
      scheduleSource(pollIntervalMs);
    }, delayMs);
  }

  const statusText = () => [
    'Пересылка публичного Telegram-канала',
    '',
    `Источники (${getSources().length}): ${getSources().map((item) => item.url).join(', ') || 'не заданы'}`,
    `Канал назначения: ${db.getSetting('web_relay_target_title') ?? db.getSetting('web_relay_target_chat_id') ?? 'не задан'}`,
    `Состояние: ${db.getSetting('web_relay_enabled') === 'true' ? 'включена' : 'выключена'}`,
    `Последний пост: ${db.getSetting('web_relay_last_post_id') ?? 'ещё не копировался'}`,
    db.getSetting('web_relay_last_error') ? `Последняя ошибка: ${db.getSetting('web_relay_last_error')}` : ''
  ].filter(Boolean).join('\n');

  const helpText = [
    'Команды веб-пересылки:',
    '',
    '/bind КОД — привязать владельца',
    '/source add ССЫЛКА — добавить публичный канал',
    '/source remove ССЫЛКА — удалить канал',
    '/source list — показать все источники',
    '/relay on — включить пересылку',
    '/relay off — выключить',
    '/load ЧИСЛО — выгрузить последние публикации (от 1 до 100)',
    '/status — показать состояние',
    '',
    'Чтобы выбрать закрытый канал назначения, добавь этого бота туда администратором и опубликуй в канале: /target КОД'
  ].join('\n');

  async function handleCommandUpdate(update) {
    const message = update.message ?? update.channel_post;
    if (!message?.chat) return;
    const { command, argument } = commandParts(message.text);
    if (!command) return;
    const chatId = message.chat.id;
    const isPrivate = message.chat.type === 'private';
    const userId = message.from?.id ? String(message.from.id) : '';
    const ownerId = db.getSetting('web_relay_owner_id');

    if (command === 'target') {
      if (!['channel', 'supergroup', 'group'].includes(message.chat.type)) {
        await telegram.sendBotText(chatId, 'Эту команду нужно опубликовать внутри закрытого канала назначения.');
        return;
      }
      if (argument !== pairingCode) {
        await telegram.sendBotText(chatId, 'Неверный код привязки.');
        return;
      }
      db.setSetting('web_relay_target_chat_id', chatId);
      db.setSetting('web_relay_target_title', message.chat.title || String(chatId));
      await telegram.sendBotText(chatId, 'Этот канал назначен для копий публикаций. Команду можно удалить.');
      scheduleSource(0);
      return;
    }

    if (!isPrivate) return;
    if (command === 'start' || command === 'help') {
      await telegram.sendBotText(chatId, helpText);
      return;
    }
    if (command === 'bind') {
      if (argument !== pairingCode) {
        await telegram.sendBotText(chatId, 'Неверный код привязки.');
      } else if (ownerId && ownerId !== userId) {
        await telegram.sendBotText(chatId, 'Этот бот уже привязан к другому владельцу.');
      } else {
        db.setSetting('web_relay_owner_id', userId);
        await telegram.sendBotText(chatId, 'Готово. Теперь задай источник командой /source https://t.me/varlamov_news');
      }
      return;
    }
    if (!ownerId || ownerId !== userId) {
      await telegram.sendBotText(chatId, 'Сначала привяжи владельца: /bind КОД');
      return;
    }
    if (command === 'source') {
      try {
        const [actionRaw, ...valueParts] = argument.split(/\s+/).filter(Boolean);
        const action = ['add', 'remove', 'list'].includes(actionRaw?.toLowerCase()) ? actionRaw.toLowerCase() : 'add';
        const rawUrl = action === 'add' && actionRaw?.toLowerCase() !== 'add' ? argument : valueParts.join(' ');
        const sources = getSources();
        if (action === 'list') {
          await telegram.sendBotText(chatId, sources.length
            ? `Источники:\n${sources.map((item, index) => `${index + 1}. ${item.url}`).join('\n')}`
            : 'Источники пока не добавлены.');
          return;
        }
        const sourceUrl = normalizePublicChannelUrl(rawUrl);
        if (action === 'remove') {
          const next = sources.filter((item) => item.url !== sourceUrl);
          saveSources(next);
          await telegram.sendBotText(chatId, next.length === sources.length ? 'Такого источника нет.' : `Источник удалён: ${sourceUrl}`);
          return;
        }
        if (!sources.some((item) => item.url === sourceUrl)) sources.push({ url: sourceUrl, lastPostId: 0 });
        saveSources(sources);
        clearError();
        await telegram.sendBotText(chatId, `Источник добавлен: ${sourceUrl}\nВсего источников: ${sources.length}. При первом запуске будет скопирован только самый свежий пост.`);
        scheduleSource(0);
      } catch (error) {
        await telegram.sendBotText(chatId, error.message);
      }
      return;
    }
    if (command === 'relay') {
      const action = argument.toLowerCase();
      if (!['on', 'off'].includes(action)) {
        await telegram.sendBotText(chatId, 'Напиши /relay on или /relay off');
        return;
      }
      if (action === 'on' && (!db.getSetting('web_relay_source_url') || !db.getSetting('web_relay_target_chat_id'))) {
        await telegram.sendBotText(chatId, 'Сначала задай источник командой /source и канал назначения командой /target.');
        return;
      }
      db.setSetting('web_relay_enabled', action === 'on' ? 'true' : 'false');
      await telegram.sendBotText(chatId, action === 'on' ? 'Пересылка включена.' : 'Пересылка выключена.');
      if (action === 'on') scheduleSource(0);
      return;
    }
    if (command === 'status') {
      await telegram.sendBotText(chatId, statusText(), { disable_web_page_preview: true });
      return;
    }
    if (command === 'load') {
      const count = Number(argument);
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        await telegram.sendBotText(chatId, 'Напиши целое число от 1 до 100. Например: /load 20');
        return;
      }
      await telegram.sendBotText(chatId, `Начинаю выгрузку последних ${count} публикаций. Медиа могут обрабатываться несколько минут.`);
      try {
        const loaded = await loadLatestPosts(count);
        await telegram.sendBotText(chatId, `Готово. Выгружено публикаций: ${loaded}.`);
      } catch (error) {
        await telegram.sendBotText(chatId, `Не удалось выгрузить публикации: ${error.message}`);
      }
      return;
    }
    await telegram.sendBotText(chatId, 'Неизвестная команда. Отправь /help.');
  }

  async function commandLoop() {
    while (!stopped) {
      try {
        const updates = await telegram.getUpdates(commandOffset, ['message', 'channel_post']);
        for (const update of updates) {
          commandOffset = update.update_id + 1;
          db.setSetting('web_relay_update_offset', commandOffset);
          try {
            await handleCommandUpdate(update);
          } catch (error) {
            log.warn?.('Web relay command failed', error.message);
          }
        }
      } catch (error) {
        if (!stopped) {
          log.warn?.('Web relay Telegram polling failed', error.message);
          await delay(2_000);
        }
      }
    }
  }

  commandLoop();
  scheduleSource(1_000);
  return {
    stop() {
      stopped = true;
      clearTimeout(sourceTimer);
    },
    relayOnce,
    loadLatestPosts,
    status: statusText
  };
}
