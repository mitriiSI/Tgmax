import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

function now() {
  return Date.now();
}

function blankAccountData() {
  return {
    settings: {},
    messageLinks: [],
    telegramChats: {},
    messages: []
  };
}

function blankState() {
  return {
    schemaVersion: 2,
    defaultAccountId: null,
    globalSettings: {},
    globalData: blankAccountData(),
    accounts: {}
  };
}

const GLOBAL_SETTING_KEYS = new Set(['telegram_update_offset', 'max_update_marker', 'network_speed_snapshot']);

function normalizeAccountData(value) {
  return {
    settings: value?.settings && typeof value.settings === 'object' ? value.settings : {},
    messageLinks: Array.isArray(value?.messageLinks) ? value.messageLinks : [],
    telegramChats: value?.telegramChats && typeof value.telegramChats === 'object' ? value.telegramChats : {},
    messages: Array.isArray(value?.messages) ? value.messages : []
  };
}

function generateLinkCode() {
  return randomBytes(8).toString('hex').toUpperCase();
}

function chatKey(telegramBusinessConnectionId, telegramChatId) {
  return `${telegramBusinessConnectionId}:${telegramChatId}`;
}

function normalizeChat(row) {
  if (!row) return undefined;
  const displayName = row.displayName || 'Неизвестный контакт';
  const customName = row.customName || null;
  return {
    telegramBusinessConnectionId: row.telegramBusinessConnectionId,
    telegramChatId: String(row.telegramChatId),
    displayName,
    customName,
    effectiveName: customName || displayName,
    username: row.username || null,
    avatar: row.avatar && typeof row.avatar === 'object' ? { ...row.avatar } : null,
    wallpaper: row.wallpaper && typeof row.wallpaper === 'object' ? { ...row.wallpaper } : null,
    lastMessageAt: row.lastMessageAt || 0,
    muted: row.muted ? 1 : 0
  };
}

export class BridgeDatabase {
  constructor(databasePath) {
    this.databasePath = databasePath;
    this.accountContext = new AsyncLocalStorage();
    mkdirSync(dirname(databasePath), { recursive: true });
    this.root = this.#load();
    if (this.root.defaultAccountId && this.root.accounts[this.root.defaultAccountId]) {
      this.runAsAccount(this.root.defaultAccountId, () => {
        this.setChatHistoryLimit(Number(this.getSetting('chat_history_limit')) || 5000);
      });
    }
  }

  get state() {
    const accountId = this.currentAccountId() || this.root.defaultAccountId;
    return accountId && this.root.accounts[accountId]
      ? this.root.accounts[accountId].data
      : this.root.globalData;
  }

  #load() {
    const backupPath = `${this.databasePath}.bak`;
    if (!existsSync(this.databasePath)) {
      if (!existsSync(backupPath)) return blankState();
      try {
        const backupText = readFileSync(backupPath, 'utf8');
        const root = this.#normalizeRoot(JSON.parse(backupText));
        writeFileSync(this.databasePath, backupText, 'utf8');
        return root;
      } catch (error) {
        throw new Error(`Database backup is damaged: ${backupPath}`, { cause: error });
      }
    }

    try {
      return this.#normalizeRoot(JSON.parse(readFileSync(this.databasePath, 'utf8')));
    } catch (primaryError) {
      if (existsSync(backupPath)) {
        try {
          const backupText = readFileSync(backupPath, 'utf8');
          const root = this.#normalizeRoot(JSON.parse(backupText));
          writeFileSync(this.databasePath, backupText, 'utf8');
          return root;
        } catch (backupError) {
          throw new Error(`Database and backup are damaged: ${this.databasePath}`, {
            cause: new AggregateError([primaryError, backupError])
          });
        }
      }
      throw new Error(`Database is damaged and was not overwritten: ${this.databasePath}`, { cause: primaryError });
    }
  }

  #normalizeRoot(parsed) {
    if (parsed?.schemaVersion === 2 && parsed.accounts && typeof parsed.accounts === 'object') {
      const root = blankState();
      root.defaultAccountId = parsed.defaultAccountId || null;
      root.globalSettings = parsed.globalSettings && typeof parsed.globalSettings === 'object' ? parsed.globalSettings : {};
      root.globalData = normalizeAccountData(parsed.globalData);
      for (const [accountId, account] of Object.entries(parsed.accounts)) {
        root.accounts[accountId] = {
          id: accountId,
          createdAt: Number(account?.createdAt) || now(),
          lastIp: account?.lastIp || null,
          data: normalizeAccountData(account?.data)
        };
      }
      if (!root.defaultAccountId || !root.accounts[root.defaultAccountId]) {
        root.defaultAccountId = Object.keys(root.accounts)[0] || null;
      }
      return root;
    }

    const legacy = normalizeAccountData(parsed);
    const root = blankState();
    const hasLegacyData = Object.keys(legacy.settings).length || legacy.messageLinks.length || Object.keys(legacy.telegramChats).length || legacy.messages.length;
    if (hasLegacyData) {
      const ownerId = legacy.settings.telegram_owner_id || 'legacy';
      const accountId = `tg-${ownerId}`;
      root.defaultAccountId = accountId;
      root.accounts[accountId] = { id: accountId, createdAt: now(), lastIp: null, data: legacy };
      for (const key of GLOBAL_SETTING_KEYS) {
        if (legacy.settings[key] !== undefined) {
          root.globalSettings[key] = legacy.settings[key];
          delete legacy.settings[key];
        }
      }
      if (!legacy.settings.max_pairing_code) legacy.settings.max_pairing_code = generateLinkCode();
    }
    return root;
  }

  #save() {
    const tempPath = `${this.databasePath}.tmp`;
    const backupPath = `${this.databasePath}.bak`;
    writeFileSync(tempPath, JSON.stringify(this.root, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      if (existsSync(this.databasePath)) copyFileSync(this.databasePath, backupPath);
      renameSync(tempPath, this.databasePath);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
  }

  close() {
    this.#save();
  }

  currentAccountId() {
    return this.accountContext.getStore()?.accountId || null;
  }

  runAsAccount(accountId, callback) {
    if (!accountId || !this.root.accounts[String(accountId)]) return callback();
    return this.accountContext.run({ accountId: String(accountId) }, callback);
  }

  accountExists(accountId) {
    return Boolean(accountId && this.root.accounts[String(accountId)]);
  }

  defaultAccountId() {
    return this.root.defaultAccountId || undefined;
  }

  listAccounts() {
    return Object.values(this.root.accounts).map((account) => {
      const settings = account.data.settings;
      return {
        id: account.id,
        telegramOwnerId: settings.telegram_owner_id || null,
        telegramBusinessConnectionId: settings.telegram_business_connection_id || null,
        maxOwnerId: settings.max_owner_id || null,
        maxPairingCode: settings.max_pairing_code || null,
        createdAt: account.createdAt,
        lastIp: account.lastIp || null,
        chats: Object.keys(account.data.telegramChats).length,
        messages: account.data.messages.length
      };
    }).sort((a, b) => a.createdAt - b.createdAt);
  }

  findAccountByTelegramOwner(userId) {
    const value = String(userId);
    return Object.values(this.root.accounts).find((account) => account.data.settings.telegram_owner_id === value)?.id;
  }

  findAccountByBusinessConnection(connectionId) {
    const value = String(connectionId);
    return Object.values(this.root.accounts).find((account) => account.data.settings.telegram_business_connection_id === value)?.id;
  }

  findAccountByMaxOwner(userId) {
    const value = String(userId);
    return Object.values(this.root.accounts).find((account) => account.data.settings.max_owner_id === value)?.id;
  }

  findAccountByMaxPairingCode(code) {
    const value = String(code || '').trim().toUpperCase();
    return Object.values(this.root.accounts).find((account) => (
      !account.data.settings.max_owner_id && String(account.data.settings.max_pairing_code || '').toUpperCase() === value
    ))?.id;
  }

  findOnlyAccountWithoutBusinessConnection() {
    const accounts = Object.values(this.root.accounts).filter((account) => (
      account.data.settings.telegram_owner_id && !account.data.settings.telegram_business_connection_id
    ));
    return accounts.length === 1 ? accounts[0].id : undefined;
  }

  findAccountByMaxChat(maxChatId) {
    const value = String(maxChatId);
    return Object.values(this.root.accounts).find((account) => {
      return this.#accountUsesMaxChat(account, value);
    })?.id;
  }

  #accountUsesMaxChat(account, maxChatId) {
    const value = String(maxChatId);
    const settings = account?.data?.settings ?? {};
    if (settings.max_unknown_inbox_chat_id === value || settings.web_relay_max_chat_id === value) return true;
    try {
      const slots = JSON.parse(settings.tgk_slots || '[]');
      if (Array.isArray(slots) && slots.some((item) => String(item?.targetMaxChatId || '') === value)) return true;
    } catch {}
    try {
      const bindings = JSON.parse(settings.max_group_bindings || '{}');
      return Object.hasOwn(bindings, value);
    } catch {
      return false;
    }
  }

  maxChatAvailableForCurrentAccount(maxChatId) {
    const value = String(maxChatId);
    const accountId = this.currentAccountId() || this.root.defaultAccountId;
    if (!accountId || !this.root.accounts[accountId]) return Object.keys(this.root.accounts).length === 0;
    return !Object.values(this.root.accounts).some((account) => (
      account.id !== accountId && this.#accountUsesMaxChat(account, value)
    ));
  }

  registerTelegramOwner(userId) {
    const ownerId = String(userId);
    const existing = this.findAccountByTelegramOwner(ownerId);
    if (existing) return existing;
    const accountId = `tg-${ownerId}`;
    const data = blankAccountData();
    data.settings.telegram_owner_id = ownerId;
    let pairingCode;
    do {
      pairingCode = generateLinkCode();
    } while (Object.values(this.root.accounts).some((account) => account.data.settings.max_pairing_code === pairingCode));
    data.settings.max_pairing_code = pairingCode;
    data.settings.chat_history_limit = '5000';
    data.settings.telegram_mirror_mode = 'all';
    this.root.accounts[accountId] = { id: accountId, createdAt: now(), lastIp: null, data };
    if (!this.root.defaultAccountId) this.root.defaultAccountId = accountId;
    this.#save();
    return accountId;
  }

  bindMaxOwner(accountId, userId) {
    const account = this.root.accounts[String(accountId)];
    if (!account) return false;
    const existing = this.findAccountByMaxOwner(userId);
    if (existing && existing !== String(accountId)) return false;
    account.data.settings.max_owner_id = String(userId);
    this.#save();
    return true;
  }

  bindBusinessConnection(accountId, connectionId) {
    const accountKey = String(accountId);
    const value = String(connectionId);
    const account = this.root.accounts[accountKey];
    if (!account || !value) return false;
    const existing = this.findAccountByBusinessConnection(value);
    if (existing && existing !== accountKey) return false;
    account.data.settings.telegram_business_connection_id = value;
    this.#save();
    return true;
  }

  recordAccountIp(accountId, ip) {
    const account = this.root.accounts[String(accountId)];
    const value = String(ip || '').trim();
    if (!account || !value) return false;
    account.lastIp = value;
    this.#save();
    return true;
  }

  getSetting(key) {
    const source = GLOBAL_SETTING_KEYS.has(key) ? this.root.globalSettings : this.state.settings;
    const value = source[key];
    return value === undefined || value === null ? undefined : String(value);
  }

  setSetting(key, value) {
    const source = GLOBAL_SETTING_KEYS.has(key) ? this.root.globalSettings : this.state.settings;
    if (value === undefined || value === null || value === '') {
      delete source[key];
    } else {
      source[key] = String(value);
    }
    this.#save();
  }

  getMaxGroupBindings() {
    try {
      const parsed = JSON.parse(this.getSetting('max_group_bindings') || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed)
        .filter(([maxChatId, telegramChatId]) => /^-?\d+$/.test(String(maxChatId)) && /^-?\d+$/.test(String(telegramChatId)))
        .map(([maxChatId, telegramChatId]) => [String(maxChatId), String(telegramChatId)]));
    } catch {
      return {};
    }
  }

  bindMaxGroup(maxChatId, telegramChatId) {
    const groupId = String(maxChatId);
    const contactId = String(telegramChatId);
    if (!this.maxChatAvailableForCurrentAccount(groupId)) return undefined;
    const bindings = this.getMaxGroupBindings();
    for (const [existingGroupId, existingContactId] of Object.entries(bindings)) {
      if (existingGroupId === groupId || existingContactId === contactId) delete bindings[existingGroupId];
    }
    bindings[groupId] = contactId;
    this.setSetting('max_group_bindings', JSON.stringify(bindings));
    if (this.getSetting('max_unknown_inbox_chat_id') === groupId) this.setSetting('max_unknown_inbox_chat_id', '');
    return { maxChatId: groupId, telegramChatId: contactId };
  }

  unbindMaxGroup(maxChatId) {
    const groupId = String(maxChatId);
    const bindings = this.getMaxGroupBindings();
    const telegramChatId = bindings[groupId];
    if (!telegramChatId) return undefined;
    delete bindings[groupId];
    this.setSetting('max_group_bindings', JSON.stringify(bindings));
    return { maxChatId: groupId, telegramChatId };
  }

  findTelegramChatIdForMaxGroup(maxChatId) {
    return this.getMaxGroupBindings()[String(maxChatId)];
  }

  findMaxGroupForTelegramChat(telegramChatId) {
    const contactId = String(telegramChatId);
    const entry = Object.entries(this.getMaxGroupBindings())
      .find(([, value]) => value === contactId);
    return entry ? { maxChatId: entry[0], telegramChatId: entry[1] } : undefined;
  }

  setUnknownInboxMaxChatId(maxChatId) {
    const groupId = maxChatId === undefined || maxChatId === null ? '' : String(maxChatId);
    if (groupId && !this.maxChatAvailableForCurrentAccount(groupId)) return false;
    if (groupId) this.unbindMaxGroup(groupId);
    this.setSetting('max_unknown_inbox_chat_id', groupId);
    return groupId || undefined;
  }

  getUnknownInboxMaxChatId() {
    return this.getSetting('max_unknown_inbox_chat_id');
  }

  setWebRelayMaxChat({ maxChatId, title = '', type = '' } = {}) {
    const chatId = maxChatId === undefined || maxChatId === null ? '' : String(maxChatId);
    if (chatId && !this.maxChatAvailableForCurrentAccount(chatId)) return false;
    this.setSetting('web_relay_max_chat_id', chatId);
    this.setSetting('web_relay_max_chat_title', chatId ? title : '');
    this.setSetting('web_relay_max_chat_type', chatId ? type : '');
    return true;
  }

  getCensorTerms() {
    try {
      const parsed = JSON.parse(this.getSetting('censor_terms') || '[]');
      if (!Array.isArray(parsed)) return [];
      const seen = new Set();
      return parsed
        .map((term) => String(term).trim())
        .filter((term) => term && !seen.has(term.toLocaleLowerCase('ru-RU')) && seen.add(term.toLocaleLowerCase('ru-RU')));
    } catch {
      return [];
    }
  }

  addCensorTerm(term) {
    const value = String(term ?? '').trim();
    if (!value) return false;
    const terms = this.getCensorTerms();
    const normalized = value.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
    if (terms.some((item) => item.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е') === normalized)) return false;
    terms.push(value);
    this.setSetting('censor_terms', JSON.stringify(terms));
    return true;
  }

  deleteCensorTerm(term) {
    const normalized = String(term ?? '').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
    const terms = this.getCensorTerms();
    const next = terms.filter((item) => item.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е') !== normalized);
    if (next.length === terms.length) return false;
    this.setSetting('censor_terms', JSON.stringify(next));
    return true;
  }

  clearCensorTerms() {
    const count = this.getCensorTerms().length;
    this.setSetting('censor_terms', '[]');
    return count;
  }

  insertMessageLink(link) {
    const next = {
      telegramBusinessConnectionId: link.telegramBusinessConnectionId,
      telegramChatId: String(link.telegramChatId),
      telegramMessageId: Number(link.telegramMessageId),
      maxMessageId: String(link.maxMessageId),
      createdAt: now()
    };

    const exists = this.state.messageLinks.some((item) => (
      item.telegramBusinessConnectionId === next.telegramBusinessConnectionId &&
      item.telegramChatId === next.telegramChatId &&
      item.telegramMessageId === next.telegramMessageId &&
      item.maxMessageId === next.maxMessageId
    ));
    if (exists) return false;

    this.state.messageLinks.push(next);
    this.#save();
    return true;
  }

  hasTelegramSource({ telegramBusinessConnectionId, telegramChatId, telegramMessageId }) {
    return this.state.messageLinks.some((item) => (
      item.telegramBusinessConnectionId === telegramBusinessConnectionId &&
      item.telegramChatId === String(telegramChatId) &&
      item.telegramMessageId === Number(telegramMessageId)
    ));
  }

  findTelegramTarget(maxMessageId) {
    const item = this.state.messageLinks.find((link) => link.maxMessageId === String(maxMessageId));
    if (!item) return undefined;
    return {
      telegramBusinessConnectionId: item.telegramBusinessConnectionId,
      telegramChatId: item.telegramChatId,
      telegramMessageId: item.telegramMessageId
    };
  }

  rememberTelegramChat({ telegramBusinessConnectionId, telegramChatId, displayName, username }) {
    const key = chatKey(telegramBusinessConnectionId, String(telegramChatId));
    const current = this.state.telegramChats[key] || {};
    this.state.telegramChats[key] = {
      telegramBusinessConnectionId,
      telegramChatId: String(telegramChatId),
      displayName,
      customName: current.customName || null,
      username: username || null,
      avatar: current.avatar || null,
      wallpaper: current.wallpaper || null,
      lastMessageAt: now(),
      muted: current.muted ? 1 : 0
    };
    this.#save();
  }

  listTelegramChats(limit = 20) {
    return Object.values(this.state.telegramChats)
      .map(normalizeChat)
      .map((chat) => {
        const lastMessage = this.state.messages
          .filter((message) => message.telegramChatId === chat.telegramChatId && !message.deletedAt)
          .slice(-1)[0];
        return { ...chat, lastMessage: lastMessage ? { ...lastMessage } : null };
      })
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      .slice(0, limit);
  }

  findTelegramChat(telegramChatId) {
    const id = String(telegramChatId);
    const row = Object.values(this.state.telegramChats)
      .filter((chat) => String(chat.telegramChatId) === id)
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))[0];
    return normalizeChat(row);
  }

  setTelegramChatCustomName(telegramChatId, customName) {
    const chat = this.findTelegramChat(telegramChatId);
    if (!chat) return false;

    const key = chatKey(chat.telegramBusinessConnectionId, chat.telegramChatId);
    this.state.telegramChats[key] = {
      ...this.state.telegramChats[key],
      customName: customName.trim() || null
    };
    this.#save();
    return true;
  }

  setTelegramChatMuted(telegramChatId, muted) {
    const chat = this.findTelegramChat(telegramChatId);
    if (!chat) return false;

    const key = chatKey(chat.telegramBusinessConnectionId, chat.telegramChatId);
    this.state.telegramChats[key] = {
      ...this.state.telegramChats[key],
      muted: muted ? 1 : 0
    };
    this.#save();
    return true;
  }

  setTelegramChatAvatar(telegramChatId, avatar) {
    const chat = this.findTelegramChat(telegramChatId);
    if (!chat) return false;
    const key = chatKey(chat.telegramBusinessConnectionId, chat.telegramChatId);
    this.state.telegramChats[key] = {
      ...this.state.telegramChats[key],
      avatar: avatar && typeof avatar === 'object' ? { ...avatar } : null
    };
    this.#save();
    return true;
  }

  setTelegramChatWallpaper(telegramChatId, wallpaper) {
    const chat = this.findTelegramChat(telegramChatId);
    if (!chat) return false;
    const key = chatKey(chat.telegramBusinessConnectionId, chat.telegramChatId);
    this.state.telegramChats[key] = {
      ...this.state.telegramChats[key],
      wallpaper: wallpaper && typeof wallpaper === 'object' ? { ...wallpaper } : null
    };
    this.#save();
    return true;
  }

  isTelegramChatMuted(telegramChatId) {
    return Boolean(this.findTelegramChat(telegramChatId)?.muted);
  }

  insertChatMessage({ telegramChatId, direction, text, type = 'Текст', telegramMessageId, media = null, mediaGroupId = null, replyToMessageId = null, forwardedFrom = null }) {
    const message = {
      id: `${now()}-${Math.random().toString(36).slice(2, 9)}`,
      telegramChatId: String(telegramChatId),
      telegramMessageId: telegramMessageId === undefined ? null : Number(telegramMessageId),
      direction: direction === 'out' ? 'out' : 'in',
      text: String(text ?? ''),
      type: String(type || 'Текст'),
      media: media && typeof media === 'object' ? { ...media } : null,
      mediaGroupId: mediaGroupId ? String(mediaGroupId) : null,
      replyToMessageId: replyToMessageId === undefined || replyToMessageId === null ? null : Number(replyToMessageId),
      forwardedFrom: forwardedFrom ? String(forwardedFrom) : null,
      editedAt: null,
      deletedAt: null,
      createdAt: now()
    };
    this.state.messages.push(message);
    this.pruneChatMessages(telegramChatId, Number(this.getSetting('chat_history_limit')) || 5000, false);
    this.#save();
    return message;
  }

  pruneChatMessages(telegramChatId, limit = 5000, save = true) {
    const id = String(telegramChatId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 5000, 10000));
    const indexes = this.state.messages
      .map((message, index) => message.telegramChatId === id ? index : -1)
      .filter((index) => index >= 0);
    const remove = new Set(indexes.slice(0, Math.max(0, indexes.length - safeLimit)));
    if (remove.size) this.state.messages = this.state.messages.filter((_message, index) => !remove.has(index));
    if (save && remove.size) this.#save();
    return remove.size;
  }

  setChatHistoryLimit(limit) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 5000, 10000));
    this.setSetting('chat_history_limit', safeLimit);
    for (const chat of Object.values(this.state.telegramChats)) this.pruneChatMessages(chat.telegramChatId, safeLimit, false);
    this.#save();
    return safeLimit;
  }

  upsertIncomingChatMessage({ telegramChatId, telegramMessageId, text, type = 'Текст', media = null, edited = false, mediaGroupId = null, replyToMessageId = null }) {
    return this.upsertChatMessage({ telegramChatId, telegramMessageId, direction: 'in', text, type, media, edited, mediaGroupId, replyToMessageId });
  }

  upsertChatMessage({ telegramChatId, telegramMessageId, direction = 'in', text, type = 'Текст', media = null, edited = false, mediaGroupId = null, replyToMessageId = null, forwardedFrom = null }) {
    const chatId = String(telegramChatId);
    const messageId = Number(telegramMessageId);
    const existing = this.state.messages.find((message) => (
      message.direction === direction &&
      message.telegramChatId === chatId &&
      message.telegramMessageId === messageId
    ));
    if (!existing) {
      return this.insertChatMessage({
        telegramChatId: chatId,
        telegramMessageId: messageId,
        direction,
        text,
        type,
        media,
        mediaGroupId,
        replyToMessageId,
        forwardedFrom
      });
    }
    existing.text = String(text ?? '');
    existing.type = String(type || 'Текст');
    existing.media = media && typeof media === 'object' ? { ...media } : existing.media;
    existing.mediaGroupId = mediaGroupId ? String(mediaGroupId) : existing.mediaGroupId ?? null;
    existing.replyToMessageId = replyToMessageId === undefined || replyToMessageId === null ? existing.replyToMessageId ?? null : Number(replyToMessageId);
    existing.forwardedFrom = forwardedFrom ? String(forwardedFrom) : existing.forwardedFrom ?? null;
    existing.editedAt = edited ? now() : existing.editedAt;
    existing.deletedAt = null;
    this.#save();
    return { ...existing };
  }

  markIncomingMessagesDeleted(telegramChatId, telegramMessageIds) {
    const chatId = String(telegramChatId);
    const ids = new Set(telegramMessageIds.map(Number));
    let changed = 0;
    for (const message of this.state.messages) {
      if (message.direction === 'in' && message.telegramChatId === chatId && ids.has(message.telegramMessageId)) {
        message.deletedAt = now();
        changed += 1;
      }
    }
    if (changed) this.#save();
    return changed;
  }

  listChatMessages(telegramChatId, limit = 100, before = Infinity) {
    const id = String(telegramChatId);
    return this.state.messages
      .filter((message) => message.telegramChatId === id && (message.createdAt || 0) < before)
      .slice(-Math.max(1, Math.min(Number(limit) || 100, 5000)));
  }

  clearChatMessages(telegramChatId) {
    const id = String(telegramChatId);
    const before = this.state.messages.length;
    this.state.messages = this.state.messages.filter((message) => message.telegramChatId !== id);
    const removed = before - this.state.messages.length;
    if (removed) this.#save();
    return removed;
  }

  findMedia(mediaId) {
    for (let index = this.state.messages.length - 1; index >= 0; index -= 1) {
      const media = this.state.messages[index]?.media;
      if (media?.id === String(mediaId)) return { ...media };
    }
    for (const chat of Object.values(this.state.telegramChats)) {
      if (chat.avatar?.id === String(mediaId)) return { ...chat.avatar };
      if (chat.wallpaper?.id === String(mediaId)) return { ...chat.wallpaper };
    }
    return undefined;
  }

  findChatMessage(messageId) {
    const message = this.state.messages.find((item) => item.id === String(messageId));
    return message ? { ...message, media: message.media ? { ...message.media } : null } : undefined;
  }

  updateChatMessage(messageId, changes) {
    const message = this.state.messages.find((item) => item.id === String(messageId));
    if (!message) return undefined;
    if (typeof changes.text === 'string') message.text = changes.text;
    if (typeof changes.pinned === 'boolean') message.pinned = changes.pinned;
    if (typeof changes.reaction === 'string') message.reaction = changes.reaction;
    if (changes.edited) message.editedAt = now();
    if (changes.deleted) message.deletedAt = now();
    this.#save();
    return { ...message };
  }

  findMaxMessageIdsForTelegramSource({ telegramBusinessConnectionId, telegramChatId, telegramMessageId }) {
    return this.state.messageLinks
      .filter((item) => (
        item.telegramBusinessConnectionId === telegramBusinessConnectionId &&
        item.telegramChatId === String(telegramChatId) &&
        item.telegramMessageId === Number(telegramMessageId)
      ))
      .map((item) => item.maxMessageId);
  }

  deleteMessageLinksForTelegramSource({ telegramBusinessConnectionId, telegramChatId, telegramMessageId }) {
    const before = this.state.messageLinks.length;
    this.state.messageLinks = this.state.messageLinks.filter((item) => !(
      item.telegramBusinessConnectionId === telegramBusinessConnectionId &&
      item.telegramChatId === String(telegramChatId) &&
      item.telegramMessageId === Number(telegramMessageId)
    ));
    const removed = before - this.state.messageLinks.length;
    if (removed) this.#save();
    return removed;
  }

  pruneMessageLinks(olderThanMs) {
    const before = this.state.messageLinks.length;
    this.state.messageLinks = this.state.messageLinks.filter((link) => (link.createdAt || 0) >= olderThanMs);
    const removed = before - this.state.messageLinks.length;
    if (removed) this.#save();
    return removed;
  }
}
