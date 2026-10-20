import { estimateTransferTime, formatEta } from './network-monitor.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function commandParts(text) {
  const match = String(text ?? '').trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return [match?.[1] ?? '', match?.[2]?.trim() ?? ''];
}

function censorStatus(db) {
  const enabled = db.getSetting('censor_enabled') === 'true';
  const terms = db.getCensorTerms?.() ?? [];
  return [
    `Цензура: ${enabled ? 'включена' : 'выключена'}.`,
    `Запрещённых слов и фраз: ${terms.length}.`,
    '',
    '/censor on — включить',
    '/censor off — выключить',
    '/censor add слово или фраза — добавить',
    '/censor del слово или фраза — удалить',
    '/censor list — показать список',
    '/censor clear — очистить список'
  ].join('\n');
}


async function sendPersonalMaxCode(telegram, chatId, lines, maxCode) {
  const command = `/bind ${maxCode}`;
  const options = {
    reply_markup: {
      inline_keyboard: [[{
        text: '📋 Скопировать команду для MAX',
        copy_text: { text: command }
      }]]
    }
  };
  try {
    await telegram.sendBotText(chatId, [...lines, '', `В MAX отправь этому же боту: ${command}`, '', 'Нажми кнопку ниже, чтобы скопировать команду без ошибок.'].join('\n'), options);
  } catch {
    await telegram.sendBotText(chatId, [...lines, '', `В MAX отправь этому же боту: ${command}`, '', 'Нажми и удерживай команду выше, чтобы скопировать её.'].join('\n'));
  }
}

function tgkStatusText(channelRelay) {
  const status = channelRelay?.status?.() ?? { enabled: false, slots: [] };
  const slots = status.slots?.length ? status.slots : [1, 2, 3].map((slot) => ({ slot }));
  return [
    `TGK: ${status.enabled ? 'включён' : 'выключен'}.`,
    '',
    ...slots.map((item) => {
      if (!item.url) return `TGK ${item.slot}: не настроен`;
      const target = item.targetMaxTitle || item.targetMaxChatId || 'личный чат с MAX-ботом';
      const state = item.lastError ? `ОШИБКА: ${item.lastError}` : (item.lastSuccessAt ? 'работает' : 'ожидает первой проверки');
      return `TGK ${item.slot}: ${item.url}\n→ ${target}\n→ ${state}`;
    }),
    '',
    '/tgk add https://t.me/channel_name — добавить в следующий свободный слот',
    '/tgk 1 https://t.me/channel_name',
    '/tgk 2 https://t.me/second_channel',
    '/tgk 3 https://t.me/third_channel',
    '/tgk 1 load 1 — переслать последний пост',
    '/tgk 1 test — проверить ссылку',
    '/tgk 1 off — удалить слот',
    '/tgk on | /tgk off'
  ].join('\n');
}

async function handleTgkTelegramCommand({ argument, channelRelay, telegram, chatId }) {
  if (!channelRelay) {
    await telegram.sendBotText(chatId, 'Модуль TGK недоступен в этой сборке.');
    return;
  }
  const parts = String(argument || '').trim().split(/\s+/).filter(Boolean);
  const first = String(parts[0] || '').toLowerCase();
  try {
    if (!first || first === 'status' || first === 'list') {
      await telegram.sendBotText(chatId, tgkStatusText(channelRelay), { disable_web_page_preview: true });
      return;
    }
    if (first === 'on' || first === 'off') {
      channelRelay.setEnabled(first === 'on');
      await telegram.sendBotText(chatId, first === 'on' ? 'TGK включён.' : 'TGK выключен.');
      return;
    }
    if (first === 'add' || first === 'new') {
      const url = parts.slice(1).join(' ');
      if (!url) throw new Error('После /tgk add вставь ссылку, например: /tgk add https://t.me/channel_name');
      const result = await channelRelay.configureNextSlot(url);
      const slot = result.slot.slot;
      if (result.existing) {
        await telegram.sendBotText(chatId, `Этот канал уже зарегистрирован как TGK ${slot}: ${result.slot.url}`, { disable_web_page_preview: true });
      } else if (result.verified) {
        await telegram.sendBotText(chatId, [
          `TGK ${slot} добавлен: ${result.slot.url}`,
          `Текущий последний пост №${result.latestPostId} отмечен как просмотренный; новые посты пойдут автоматически.`,
          `Для проверки: /tgk ${slot} load 1`
        ].join('\n'), { disable_web_page_preview: true });
      } else {
        await telegram.sendBotText(chatId, [
          `TGK ${slot} сохранён: ${result.slot.url}`,
          `Но сейчас ссылка не прочиталась: ${result.error}`,
          `После исправления сети проверь: /tgk ${slot} test`
        ].join('\n'), { disable_web_page_preview: true });
      }
      return;
    }
    const slot = Number(first);
    if (![1, 2, 3].includes(slot)) throw new Error('После /tgk укажи номер 1, 2 или 3');
    const action = String(parts[1] || '').toLowerCase();
    if (!action) {
      const item = channelRelay.getSlot(slot);
      await telegram.sendBotText(chatId, item.url
        ? `TGK ${slot}: ${item.url}\nНазначение: ${item.targetMaxTitle || item.targetMaxChatId || 'личный чат с MAX-ботом'}${item.lastError ? `\nОшибка: ${item.lastError}` : ''}`
        : `TGK ${slot} не настроен. Напиши: /tgk ${slot} https://t.me/channel_name`, { disable_web_page_preview: true });
      return;
    }
    if (['off', 'remove', 'delete', 'del'].includes(action)) {
      const result = channelRelay.removeSlot(slot);
      await telegram.sendBotText(chatId, result.removed ? `TGK ${slot} удалён.` : `TGK ${slot} и так пуст.`);
      return;
    }
    if (action === 'test') {
      await telegram.sendBotText(chatId, `Проверяю TGK ${slot} по публичной ссылке…`);
      const probe = await channelRelay.probeSlot(slot);
      await telegram.sendBotText(chatId, `TGK ${slot} работает. Найдено публикаций на странице: ${probe.posts}. Последний ID: ${probe.latestPostId}.`);
      return;
    }
    if (action === 'load') {
      const count = Number(parts[2] || 1);
      await telegram.sendBotText(chatId, `TGK ${slot}: загружаю последние ${count} публикаций…`);
      const loaded = await channelRelay.loadLatest(slot, count);
      await telegram.sendBotText(chatId, `TGK ${slot}: передано публикаций — ${loaded}.`);
      return;
    }
    const url = parts.slice(1).join(' ');
    const result = await channelRelay.configureSlot(slot, url);
    if (result.verified) {
      await telegram.sendBotText(chatId, [
        `TGK ${slot} настроен: ${result.slot.url}`,
        'Отдельный бот и права администратора чужого канала не нужны.',
        'Сервер читает публичную страницу по ссылке.',
        `Текущий последний пост №${result.latestPostId} отмечен как уже просмотренный; новые посты будут идти автоматически.`,
        `Для проверки прямо сейчас: /tgk ${slot} load 1`
      ].join('\n'), { disable_web_page_preview: true });
    } else {
      await telegram.sendBotText(chatId, [
        `TGK ${slot} сохранён: ${result.slot.url}`,
        `Но сейчас ссылка не прочиталась: ${result.error}`,
        `После исправления сети проверь: /tgk ${slot} test`
      ].join('\n'), { disable_web_page_preview: true });
    }
  } catch (error) {
    await telegram.sendBotText(chatId, `Ошибка TGK: ${error.message}`);
  }
}

function speedStatusText(snapshot = {}) {
  if (!(Number(snapshot.downloadMbps) > 0) || !(Number(snapshot.uploadMbps) > 0)) {
    return 'Скорость ещё не измерена. Запусти /speed test.';
  }
  return [
    'Скорость интернета сервера:',
    `↓ ${snapshot.downloadMbps} Мбит/с`,
    `↑ ${snapshot.uploadMbps} Мбит/с`,
    snapshot.latencyMs ? `Задержка: ${snapshot.latencyMs} мс` : '',
    snapshot.measuredAt ? `Замер: ${new Date(snapshot.measuredAt).toLocaleString('ru-RU')}` : '',
    `Источник: ${snapshot.source === 'real-transfer' ? 'реальные передачи файлов' : 'параллельный тест'}`
  ].filter(Boolean).join('\n');
}



export async function handleTelegramUpdate(options) {
  const { update, telegram, db, pairingCode, log, channelRelay } = options;
  if (typeof db.runAsAccount !== 'function') return handleTelegramUpdateScoped(options);

  const channelPost = update.channel_post ?? update.edited_channel_post;
  if (channelPost) {
    if (!channelRelay) {
      log.warn('Ignored Telegram channel post because channel relay is unavailable');
      return;
    }
    const matched = await channelRelay.handleTelegramChannelPost(channelPost);
    if (!matched) {
      log.info(`Direct channel_post ignored for @${channelPost.chat?.username || channelPost.chat?.id}; TGK public-link polling remains active`);
    }
    return;
  }

  const privateMessage = update.message?.chat?.type === 'private' ? update.message : null;
  const userId = privateMessage?.from?.id ? String(privateMessage.from.id) : null;
  if (privateMessage && userId) {
    const [command, argument] = commandParts(privateMessage.text ?? '');
    if (command === '/help' || command === '/start') {
      await telegram.sendBotText(privateMessage.chat.id, [
        'Команды Telegram-моста:',
        '',
        '/whoami — показать твой Telegram ID',
        '/bind КОД_СЕРВЕРА — зарегистрировать аккаунт',
        '/mirror — настроить копирование сообщений',
        '/censor — настроить цензуру слов и фраз',
        '/code — показать и скопировать личный код MAX',
        '/tgk — до трёх публичных Telegram-каналов по ссылке',
        '/speed — скорость интернета сервера',
        '/eta 1600 — оценить время для файла 1600 МБ',
        '/help — эта справка',
        '',
        'После /bind бот выдаст отдельный личный код для привязки того же MAX-бота.'
      ].join('\n'));
      return;
    }
    if (command === '/whoami') {
      await telegram.sendBotText(privateMessage.chat.id, `Твой Telegram ID: ${userId}`);
      return;
    }
    if (command === '/bind') {
      if (argument !== pairingCode) {
        await telegram.sendBotText(privateMessage.chat.id, 'Неверный код регистрации сервера.');
        return;
      }
      const accountId = db.registerTelegramOwner(userId);
      await db.runAsAccount(accountId, async () => {
        const maxOwnerId = db.getSetting('max_owner_id');
        const businessConnectionId = db.getSetting('telegram_business_connection_id');
        const lines = ['Telegram-профиль зарегистрирован.'];

        if (maxOwnerId) {
          lines.push('MAX-аккаунт уже привязан к этому профилю.');
        } else {
          const maxCode = db.getSetting('max_pairing_code');
          lines.push('', `В MAX отправь этому же боту: /bind ${maxCode}`, '', 'Этот личный код относится только к твоему профилю. Не пересылай его другим людям.');
        }

        if (businessConnectionId) {
          lines.push('Telegram Business уже подключён. Профиль готов к работе.');
        } else {
          lines.push('Подключи этого Telegram-бота как бизнес-бота в настройках Telegram и разреши ему отвечать в нужных личных чатах.');
        }

        if (maxOwnerId) {
          await telegram.sendBotText(privateMessage.chat.id, lines.join('\n'));
        } else {
          await sendPersonalMaxCode(telegram, privateMessage.chat.id, lines.filter((line) => !String(line).startsWith('В MAX отправь этому же боту:')), db.getSetting('max_pairing_code'));
        }
      });
      log.event?.({ level: 'info', category: 'account', event: 'telegram_account_registered', message: 'Зарегистрирован новый Telegram-профиль', accountId, stage: 'onboarding', status: 'completed', progress: 100, details: { telegramOwnerId: userId } });
      log.info('Telegram account registered', accountId);
      return;
    }
  }

  let accountId;
  if (update.callback_query?.from?.id) {
    accountId = db.findAccountByTelegramOwner(String(update.callback_query.from.id));
  } else if (privateMessage?.from?.id) {
    accountId = db.findAccountByTelegramOwner(String(privateMessage.from.id));
  } else if (update.business_connection?.user?.id) {
    accountId = db.findAccountByTelegramOwner(String(update.business_connection.user.id));
  } else {
    const connectionId = update.business_message?.business_connection_id
      ?? update.edited_business_message?.business_connection_id
      ?? update.deleted_business_messages?.business_connection_id;
    if (connectionId) {
      accountId = db.findAccountByBusinessConnection(String(connectionId));
      if (!accountId) {
        accountId = db.findOnlyAccountWithoutBusinessConnection();
        if (accountId && !db.bindBusinessConnection(accountId, String(connectionId))) accountId = undefined;
      }
    }
  }

  if (!accountId) {
    if (privateMessage) {
      await telegram.sendBotText(privateMessage.chat.id, 'Сначала зарегистрируй аккаунт командой /bind КОД_СЕРВЕРА.');
    } else {
      log.warn('Ignored Telegram update because no registered account matched it');
    }
    return;
  }

  return db.runAsAccount(accountId, () => handleTelegramUpdateScoped(options));
}

async function handleTelegramUpdateScoped({
  update,
  telegram,
  db,
  pairingCode,
  onBusinessMessage,
  onEditedBusinessMessage,
  onDeletedBusinessMessages,
  channelRelay,
  networkMonitor,
  log
}) {
  if (update.callback_query?.data?.startsWith('censor:')) {
    const query = update.callback_query;
    const userId = String(query.from.id);
    if (db.getSetting('telegram_owner_id') !== userId) {
      await telegram.answerCallbackQuery(query.id, 'Эта кнопка доступна только владельцу.');
      return;
    }
    const action = query.data.slice('censor:'.length);
    if (action === 'on' || action === 'off') {
      db.setSetting('censor_enabled', action === 'on' ? 'true' : 'false');
      await telegram.answerCallbackQuery(query.id, action === 'on' ? 'Цензура включена' : 'Цензура выключена');
    }
    return;
  }

  if (update.callback_query?.data?.startsWith('mirror:')) {
    const query = update.callback_query;
    const userId = String(query.from.id);
    if (db.getSetting('telegram_owner_id') !== userId) {
      await telegram.answerCallbackQuery(query.id, 'Эта кнопка доступна только владельцу.');
      return;
    }
    const mode = query.data.slice('mirror:'.length);
    if (['all', 'mine', 'others', 'off'].includes(mode)) {
      db.setSetting('telegram_mirror_mode', mode);
      const labels = { all: 'Все сообщения', mine: 'Только мои', others: 'Только собеседников', off: 'Копирование выключено' };
      await telegram.answerCallbackQuery(query.id, labels[mode]);
    }
    return;
  }

  if (update.message?.chat?.type === 'private' && update.message.from) {
    const [command, argument] = commandParts(update.message.text ?? '');
    const userId = String(update.message.from.id);

    if (command === '/help' || command === '/start') {
      await telegram.sendBotText(update.message.chat.id, [
        'Команды Telegram-моста:',
        '',
        '/whoami — показать твой Telegram ID',
        '/bind КОД — привязать аккаунт',
        '/mirror — показать текущий режим',
        '/mirror all — копировать все сообщения',
        '/mirror mine — копировать только мои',
        '/mirror others — копировать только собеседников',
        '/mirror off — выключить копирование',
        '/censor — настроить цензуру слов и фраз',
        '/code — показать и скопировать личный код MAX',
        '/tgk — TGK 1, 2 и 3 по публичной ссылке',
        '/speed — скорость сервера',
        '/eta 1600 — время передачи файла 1600 МБ',
        '/help — эта справка'
      ].join('\n'));
      return;
    }

    if (command === '/whoami') {
      await telegram.sendBotText(update.message.chat.id, `Твой Telegram ID: ${userId}`);
      return;
    }

    if (command === '/bind') {
      const savedOwnerId = db.getSetting('telegram_owner_id');
      if (argument !== pairingCode) {
        await telegram.sendBotText(update.message.chat.id, 'Неверный код привязки.');
      } else if (savedOwnerId && savedOwnerId !== userId) {
        await telegram.sendBotText(update.message.chat.id, 'Этот мост уже привязан к другому Telegram-аккаунту.');
      } else {
        db.setSetting('telegram_owner_id', userId);
        await telegram.sendBotText(update.message.chat.id, 'Telegram-профиль зарегистрирован. Теперь подключи этого бота как бизнес-бота в настройках Telegram.');
      }
      return;
    }

    if (command === '/code') {
      if (db.getSetting('max_owner_id')) {
        await telegram.sendBotText(update.message.chat.id, 'MAX-аккаунт уже привязан. Новый код не требуется.');
      } else {
        const maxCode = db.getSetting('max_pairing_code');
        await sendPersonalMaxCode(telegram, update.message.chat.id, ['Твоя личная команда для MAX:'], maxCode);
      }
      return;
    }

    if (command === '/tgk' || command === '/channel' || command === '/channels') {
      await handleTgkTelegramCommand({ argument, channelRelay, telegram, chatId: update.message.chat.id });
      return;
    }

    if (command === '/speed') {
      if (!networkMonitor) {
        await telegram.sendBotText(update.message.chat.id, 'Измеритель скорости недоступен.');
        return;
      }
      if (String(argument).toLowerCase() === 'test') {
        await telegram.sendBotText(update.message.chat.id, 'Измеряю входящую и исходящую скорость. Это займёт до минуты.');
        try {
          const snapshot = await networkMonitor.test({ force: true });
          await telegram.sendBotText(update.message.chat.id, speedStatusText(snapshot));
        } catch (error) {
          await telegram.sendBotText(update.message.chat.id, `Не удалось измерить скорость: ${error.message}`);
        }
      } else {
        await telegram.sendBotText(update.message.chat.id, speedStatusText(networkMonitor.snapshot()));
      }
      return;
    }

    if (command === '/eta') {
      const sizeMb = Number(String(argument).replace(',', '.'));
      if (!Number.isFinite(sizeMb) || sizeMb <= 0 || sizeMb > 2000) {
        await telegram.sendBotText(update.message.chat.id, 'Напиши размер файла в МБ. Например: /eta 1600');
        return;
      }
      const estimate = estimateTransferTime(sizeMb * 1024 * 1024, networkMonitor?.snapshot?.() || {});
      if (!estimate.totalSeconds) {
        await telegram.sendBotText(update.message.chat.id, 'Сначала измерь скорость командой /speed test.');
        return;
      }
      await telegram.sendBotText(update.message.chat.id, [
        `Файл: ${sizeMb} МБ`,
        `Telegram → сервер: ${formatEta(estimate.downloadSeconds)}`,
        `Сервер → MAX: ${formatEta(estimate.uploadSeconds)}`,
        `Общий ориентир: ${formatEta(estimate.totalSeconds)}`,
        '',
        'После начала передачи консоль переключится на фактическую скорость и живое оставшееся время.'
      ].join('\n'));
      return;
    }

    if (command === '/mirror') {
      const savedOwnerId = db.getSetting('telegram_owner_id');
      if (savedOwnerId !== userId) {
        await telegram.sendBotText(update.message.chat.id, 'Сначала привяжи этот Telegram-аккаунт командой /bind.');
        return;
      }
      const aliases = {
        all: 'all', 'все': 'all',
        mine: 'mine', my: 'mine', 'мои': 'mine',
        others: 'others', other: 'others', 'чужие': 'others', 'собеседники': 'others',
        off: 'off', 'выкл': 'off'
      };
      const nextMode = aliases[(argument ?? '').toLowerCase()];
      if (nextMode) db.setSetting('telegram_mirror_mode', nextMode);
      const mode = nextMode ?? db.getSetting('telegram_mirror_mode') ?? 'all';
      const labels = {
        all: 'все сообщения',
        mine: 'только мои сообщения',
        others: 'только сообщения собеседников',
        off: 'зеркалирование выключено'
      };
      await telegram.sendBotText(update.message.chat.id, [
        `Сейчас: ${labels[mode]}.`,
        '',
        '/mirror all — все сообщения',
        '/mirror mine — только мои',
        '/mirror others — только собеседников',
        '/mirror off — выключить'
      ].join('\n'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Все сообщения', callback_data: 'mirror:all' }],
            [{ text: 'Только мои', callback_data: 'mirror:mine' }],
            [{ text: 'Только собеседников', callback_data: 'mirror:others' }],
            [{ text: 'Выключить', callback_data: 'mirror:off' }]
          ]
        }
      });
      return;
    }

    if (command === '/censor') {
      const savedOwnerId = db.getSetting('telegram_owner_id');
      if (savedOwnerId !== userId) {
        await telegram.sendBotText(update.message.chat.id, 'Сначала привяжи этот Telegram-аккаунт командой /bind.');
        return;
      }
      const match = argument.match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const action = (match?.[1] ?? '').toLowerCase();
      const value = (match?.[2] ?? '').trim();
      if (action === 'on' || action === 'off') {
        db.setSetting('censor_enabled', action === 'on' ? 'true' : 'false');
        await telegram.sendBotText(update.message.chat.id, censorStatus(db));
        return;
      }
      if (action === 'add') {
        if (!value) {
          await telegram.sendBotText(update.message.chat.id, 'Напиши слово или фразу после add. Например: /censor add запрещённая фраза');
          return;
        }
        const added = db.addCensorTerm(value);
        await telegram.sendBotText(update.message.chat.id, added ? `Добавлено: ${value}` : 'Такая фраза уже есть в списке.');
        return;
      }
      if (action === 'del' || action === 'delete' || action === 'remove') {
        if (!value) {
          await telegram.sendBotText(update.message.chat.id, 'Напиши слово или фразу, которую нужно удалить.');
          return;
        }
        const removed = db.deleteCensorTerm(value);
        await telegram.sendBotText(update.message.chat.id, removed ? `Удалено: ${value}` : 'Такой фразы нет в списке.');
        return;
      }
      if (action === 'clear') {
        const count = db.clearCensorTerms();
        await telegram.sendBotText(update.message.chat.id, `Список очищен. Удалено записей: ${count}.`);
        return;
      }
      if (action === 'list') {
        const terms = db.getCensorTerms();
        await telegram.sendBotText(update.message.chat.id, terms.length
          ? `Запрещённые слова и фразы:\n${terms.map((term, index) => `${index + 1}. ${term}`).join('\n')}`
          : 'Список запрещённых слов и фраз пуст.');
        return;
      }
      await telegram.sendBotText(update.message.chat.id, censorStatus(db), {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Включить', callback_data: 'censor:on' }, { text: 'Выключить', callback_data: 'censor:off' }]
          ]
        }
      });
      return;
    }
  }

  if (update.business_connection) {
    const connection = update.business_connection;
    const telegramOwnerId = db.getSetting('telegram_owner_id');
    if (telegramOwnerId !== String(connection.user.id)) {
      log.warn('Ignored business connection from an unpaired Telegram account');
      return;
    }

    if (!connection.is_enabled) {
      db.setSetting('telegram_business_connection_id', '');
      log.info('Telegram Business connection disabled');
      return;
    }

    if (!connection.rights?.can_reply) {
      log.warn('Telegram Business connection was made without reply permission');
    }
    const currentAccountId = db.currentAccountId?.();
    const bound = currentAccountId && db.bindBusinessConnection
      ? db.bindBusinessConnection(currentAccountId, connection.id)
      : (db.setSetting('telegram_business_connection_id', connection.id), true);
    if (!bound) {
      log.warn('Ignored Telegram Business connection already assigned to another profile');
      return;
    }
    log.event?.({ level: 'info', category: 'account', event: 'business_connection_bound', message: 'Telegram Business Connection привязан к профилю', stage: 'onboarding', status: 'completed', progress: 100, details: { businessConnectionId: connection.id } });
    log.info('Telegram Business connection accepted');
    return;
  }

  const message = update.business_message ?? update.edited_business_message;
  const deleted = update.deleted_business_messages;
  if (!message && !deleted) return;

  const businessConnectionId = message?.business_connection_id ?? deleted?.business_connection_id;

  const expectedConnectionId = db.getSetting('telegram_business_connection_id');
  const telegramOwnerId = db.getSetting('telegram_owner_id');
  if (!telegramOwnerId) {
    log.warn('Ignored business message because Telegram account is not paired');
    return;
  }
  if (!expectedConnectionId && businessConnectionId) {
    const currentAccountId = db.currentAccountId?.();
    const bound = currentAccountId && db.bindBusinessConnection
      ? db.bindBusinessConnection(currentAccountId, businessConnectionId)
      : (db.setSetting('telegram_business_connection_id', businessConnectionId), true);
    if (!bound) {
      log.warn('Ignored business message because its Business Connection belongs to another profile');
      return;
    }
    log.event?.({ level: 'info', category: 'account', event: 'business_connection_auto_bound', message: 'Telegram Business Connection определён по первому сообщению', stage: 'onboarding', status: 'completed', progress: 100, details: { businessConnectionId } });
    log.info('Telegram Business connection accepted from first business message');
  } else if (businessConnectionId !== expectedConnectionId) {
    log.warn('Ignored business message from an unpaired connection');
    return;
  }
  if (deleted) {
    await onDeletedBusinessMessages?.(deleted);
    return;
  }
  if (message.from?.is_bot) return;

  if (update.edited_business_message) {
    await onEditedBusinessMessage?.(message);
  } else {
    await onBusinessMessage(message);
  }
}

export function startTelegramPolling(options) {
  let stopped = false;
  let offset = Number(options.db.getSetting('telegram_update_offset') ?? 0) || undefined;

  const stop = () => {
    stopped = true;
  };

  const promise = (async () => {
    while (!stopped) {
      try {
        const updates = await options.telegram.getUpdates(offset);
        for (const update of updates) {
          if (stopped) break;
          await handleTelegramUpdate({ ...options, update });
          offset = update.update_id + 1;
          options.db.setSetting('telegram_update_offset', offset);
        }
      } catch (error) {
        options.log.error('Telegram polling error', error);
        await delay(3_000);
      }
    }
  })();

  return { stop, promise };
}
