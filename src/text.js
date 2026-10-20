export function splitText(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let boundary = remaining.lastIndexOf('\n', maxLength);
    if (boundary < maxLength * 0.5) boundary = remaining.lastIndexOf(' ', maxLength);
    if (boundary < maxLength * 0.5) boundary = maxLength;

    chunks.push(remaining.slice(0, boundary).trimEnd());
    remaining = remaining.slice(boundary).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export function telegramAttachmentSummary(message) {
  const documentIsGif = message.document && (
    message.document.mime_type === 'image/gif' ||
    message.document.file_name?.toLowerCase().endsWith('.gif')
  );
  const attachmentTypes = [
    ['photo', 'Фото'],
    ['video', 'Видео'],
    ['video_note', 'Видеосообщение'],
    ['voice', 'Голосовое сообщение'],
    ['audio', 'Аудиофайл'],
    ['document', documentIsGif ? 'GIF' : 'Файл'],
    ['animation', 'GIF'],
    ['sticker', 'Стикер']
  ];

  const found = attachmentTypes
    .filter(([field]) => Boolean(message[field]) && !(field === 'document' && message.animation))
    .map(([, label]) => label);

  return found.length ? found.join(', ') : null;
}

export function telegramSenderName(message) {
  return [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || 'Неизвестный контакт';
}

export function telegramSenderUsername(message) {
  return message.from?.username || '';
}

export function telegramForwardSource(message) {
  const origin = message.forward_origin;
  if (origin?.type === 'channel' || origin?.type === 'chat') return origin.chat?.title || origin.chat?.username || 'Telegram-канал';
  if (origin?.type === 'user') return [origin.sender_user?.first_name, origin.sender_user?.last_name].filter(Boolean).join(' ') || 'Пользователь Telegram';
  if (origin?.type === 'hidden_user') return origin.sender_user_name || 'Скрытый отправитель';
  const legacyUser = [message.forward_from?.first_name, message.forward_from?.last_name].filter(Boolean).join(' ');
  return message.forward_from_chat?.title
    || message.forward_from_chat?.username
    || legacyUser
    || message.forward_sender_name
    || null;
}

export function telegramForwardSourceType(message) {
  const originType = message.forward_origin?.type;
  if (originType === 'channel') return 'channel';
  if (originType === 'chat') return 'chat';
  if (originType === 'user') return 'user';
  if (originType === 'hidden_user') return 'hidden_user';
  if (message.forward_from_chat) return message.forward_from_chat.type === 'channel' ? 'channel' : 'chat';
  if (message.forward_from) return 'user';
  if (message.forward_sender_name) return 'hidden_user';
  return null;
}

export function telegramSpecialAttachmentLabel(message) {
  const attachment = telegramAttachmentSummary(message);
  const documentIsGif = message.document && (
    message.document.mime_type === 'image/gif' ||
    message.document.file_name?.toLowerCase().endsWith('.gif')
  );
  const isSpecial = Boolean(message.video_note || message.animation || message.sticker || documentIsGif);
  return isSpecial ? attachment : null;
}

export function formatTelegramAlbumContentOnly(messages) {
  const body = messages.map((message) => message.caption ?? message.text ?? '').find(Boolean) ?? '';
  const specialLabels = [...new Set(messages.map(telegramSpecialAttachmentLabel).filter(Boolean))];
  const lines = [body, ...specialLabels].filter(Boolean);
  return lines.length ? lines.join('\n\n') : '\u2063';
}

export function formatTelegramForMax(message, options = {}) {
  const name = options.displayName || telegramSenderName(message);
  const body = message.text ?? message.caption ?? '';
  const attachment = telegramAttachmentSummary(message);
  const specialAttachment = telegramSpecialAttachmentLabel(message);

  if (options.contentOnly) {
    const lines = [body, specialAttachment].filter(Boolean);
    return lines.length ? lines.join('\n\n') : '\u2063';
  }

  const lines = [
    `ID: ${message.chat?.id ?? 'неизвестно'}`,
    `Имя: ${name}`
  ];

  if (options.includeUsername) {
    const username = telegramSenderUsername(message) || message.chat?.username;
    if (username) lines.push(`Username: @${username}`);
  }

  if (specialAttachment) lines.push(`Тип: ${attachment}`);
  if (body) lines.push('', body);
  if (!body && !attachment) lines.push('', '[Неподдерживаемый тип сообщения]');
  return lines.join('\n');
}


function escapeMaxHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function formatMaxForwardNote(text, forwardedFrom, destinationType, forwardedSourceType) {
  if (!forwardedFrom || destinationType === 'channel' || forwardedSourceType === 'channel') return { text, format: undefined };
  return {
    text: `${escapeMaxHtml(text)}\n\n<i>Переслано от: ${escapeMaxHtml(forwardedFrom)}</i>`,
    format: 'html'
  };
}
