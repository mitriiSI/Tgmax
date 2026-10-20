import { fetchPublicChannelHistory, fetchPublicChannelPosts, isAdvertisingPost, normalizePublicChannelUrl } from './web-channel-relay.js';
import { prepareWebPostMedia } from './web-media.js';

const SLOT_COUNT = 3;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertSlot(value) {
  const slot = Number(value);
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) {
    throw new Error('Номер TGK должен быть 1, 2 или 3');
  }
  return slot;
}

function usernameFromSourceUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return String(parts[0]?.toLowerCase() === 's' ? parts[1] : parts[0] || '').toLowerCase();
  } catch {
    return '';
  }
}

function normalizeSlot(item, slot) {
  if (!item?.url) return { slot };
  return {
    slot,
    url: normalizePublicChannelUrl(item.url),
    username: item.username || usernameFromSourceUrl(item.url),
    title: item.title || undefined,
    mode: item.mode || 'web',
    chatId: item.chatId ? String(item.chatId) : undefined,
    lastPostId: Number(item.lastPostId) || 0,
    lastError: item.lastError || undefined,
    lastCheckedAt: item.lastCheckedAt || undefined,
    lastSuccessAt: item.lastSuccessAt || undefined,
    targetMaxChatId: item.targetMaxChatId ? String(item.targetMaxChatId) : undefined,
    targetMaxTitle: item.targetMaxTitle || undefined,
    targetMaxType: item.targetMaxType || undefined
  };
}

function directPostFromMessages(messages, slot) {
  const ordered = [...messages].sort((a, b) => Number(a.message_id) - Number(b.message_id));
  const first = ordered[0];
  const textMessage = ordered.find((item) => item.text || item.caption) || first;
  const channel = first?.chat?.username || String(first?.chat?.id || 'channel');
  return {
    id: Math.max(...ordered.map((item) => Number(item.message_id) || 0)),
    channel,
    title: first?.chat?.title || channel,
    text: textMessage?.text || textMessage?.caption || '',
    link: first?.chat?.username ? `https://t.me/${first.chat.username}/${first.message_id}` : '',
    media: [],
    tgkSlot: slot
  };
}

export class ChannelRelayManager {
  constructor({
    db,
    log,
    onPost,
    dataDir,
    pollIntervalMs = 60_000,
    mediaTargetBytes = 49 * 1024 * 1024,
    mediaTransferTimeoutMs = 30 * 60 * 1000,
    fetchPosts = fetchPublicChannelPosts,
    fetchHistory = fetchPublicChannelHistory
  } = {}) {
    this.db = db;
    this.log = log;
    this.onPost = onPost;
    this.dataDir = dataDir;
    this.pollIntervalMs = Math.max(15_000, pollIntervalMs);
    this.mediaTargetBytes = mediaTargetBytes;
    this.mediaTransferTimeoutMs = mediaTransferTimeoutMs;
    this.fetchPosts = fetchPosts;
    this.fetchHistory = fetchHistory;
    this.timer = null;
    this.running = false;
    this.stopped = false;
    this.directAlbums = new Map();
  }

  listSlots() {
    let parsed;
    try {
      parsed = JSON.parse(this.db.getSetting('tgk_slots') || 'null');
    } catch {}

    const slots = Array.from({ length: SLOT_COUNT }, (_, index) => ({ slot: index + 1 }));
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const slot = Number(item?.slot);
        if (Number.isInteger(slot) && slot >= 1 && slot <= SLOT_COUNT) slots[slot - 1] = normalizeSlot(item, slot);
      }
      return slots;
    }

    // Migration from the older unlimited /channel list. The first three sources
    // become TGK 1–3 and inherit the old common MAX destination.
    try {
      const legacy = JSON.parse(this.db.getSetting('web_relay_sources') || '[]');
      const targetMaxChatId = this.db.getSetting('web_relay_max_chat_id');
      const targetMaxTitle = this.db.getSetting('web_relay_max_chat_title');
      const targetMaxType = this.db.getSetting('web_relay_max_chat_type');
      if (Array.isArray(legacy)) {
        legacy.slice(0, SLOT_COUNT).forEach((item, index) => {
          slots[index] = normalizeSlot({ ...item, targetMaxChatId, targetMaxTitle, targetMaxType }, index + 1);
        });
      }
    } catch {}
    this.saveSlots(slots);
    return slots;
  }

  saveSlots(slots) {
    const clean = Array.from({ length: SLOT_COUNT }, (_, index) => normalizeSlot(slots[index], index + 1));
    this.db.setSetting('tgk_slots', JSON.stringify(clean));
    // Keep a compatibility mirror for old Console/API code and easy rollback.
    const active = clean.filter((item) => item.url);
    this.db.setSetting('web_relay_sources', JSON.stringify(active));
    this.db.setSetting('web_relay_source_url', active[0]?.url || '');
    this.db.setSetting('web_relay_last_post_id', active[0]?.lastPostId ? String(active[0].lastPostId) : '');
  }

  listSources() {
    return this.listSlots().filter((item) => item.url);
  }

  getSlot(value) {
    const slot = assertSlot(value);
    return this.listSlots()[slot - 1];
  }

  setSlot(value, input) {
    const slot = assertSlot(value);
    const url = normalizePublicChannelUrl(input);
    const slots = this.listSlots();
    const previous = slots[slot - 1] || { slot };
    slots[slot - 1] = normalizeSlot({
      slot,
      url,
      username: usernameFromSourceUrl(url),
      targetMaxChatId: previous.targetMaxChatId,
      targetMaxTitle: previous.targetMaxTitle,
      targetMaxType: previous.targetMaxType,
      lastPostId: 0
    }, slot);
    this.saveSlots(slots);
    this.db.setSetting('tgk_enabled', 'true');
    this.db.setSetting('web_relay_enabled', 'true');
    return slots[slot - 1];
  }

  async configureSlot(value, input) {
    const entry = this.setSlot(value, input);
    const slots = this.listSlots();
    const current = slots[entry.slot - 1];
    try {
      const posts = await this.fetchPosts(current.url);
      const latest = posts.at(-1);
      current.title = latest?.title || current.title;
      // Mark the current latest post as seen. This prevents a flood immediately
      // after setup. /tgk SLOT load N can be used to copy old posts explicitly.
      current.lastPostId = Number(latest?.id) || 0;
      current.lastError = '';
      current.lastCheckedAt = new Date().toISOString();
      current.lastSuccessAt = current.lastCheckedAt;
      this.saveSlots(slots);
      this.schedule(0);
      return { slot: current, verified: true, latestPostId: current.lastPostId };
    } catch (error) {
      current.lastError = String(error?.message || error).slice(0, 500);
      current.lastCheckedAt = new Date().toISOString();
      this.saveSlots(slots);
      this.schedule(0);
      return { slot: current, verified: false, error: current.lastError };
    }
  }

  async configureNextSlot(input) {
    const url = normalizePublicChannelUrl(input);
    const slots = this.listSlots();
    const existing = slots.find((item) => item.url === url);
    if (existing) {
      return {
        slot: existing,
        verified: !existing.lastError,
        latestPostId: Number(existing.lastPostId) || 0,
        existing: true
      };
    }
    const freeSlot = slots.find((item) => !item.url)?.slot;
    if (!freeSlot) {
      throw new Error('Все три TGK уже заняты. Удали ненужный слот командой /tgk НОМЕР off или замени его вручную.');
    }
    return this.configureSlot(freeSlot, url);
  }

  removeSlot(value) {
    const slot = assertSlot(value);
    const slots = this.listSlots();
    const previous = slots[slot - 1];
    slots[slot - 1] = { slot };
    this.saveSlots(slots);
    return { removed: Boolean(previous?.url), slot, previous };
  }

  setSlotTarget(value, { maxChatId, title = '', type = '' } = {}) {
    const slot = assertSlot(value);
    const chatId = maxChatId === undefined || maxChatId === null || maxChatId === '' ? '' : String(maxChatId);
    if (chatId && this.db.maxChatAvailableForCurrentAccount && !this.db.maxChatAvailableForCurrentAccount(chatId)) return false;
    const slots = this.listSlots();
    const current = slots[slot - 1] || { slot };
    current.targetMaxChatId = chatId || undefined;
    current.targetMaxTitle = chatId ? title : undefined;
    current.targetMaxType = chatId ? type : undefined;
    slots[slot - 1] = current;
    this.saveSlots(slots);
    return true;
  }

  clearTargetsByChatId(maxChatId) {
    const value = String(maxChatId);
    const slots = this.listSlots();
    const changed = [];
    for (const item of slots) {
      if (String(item.targetMaxChatId || '') !== value) continue;
      item.targetMaxChatId = undefined;
      item.targetMaxTitle = undefined;
      item.targetMaxType = undefined;
      changed.push(item.slot);
    }
    if (changed.length) this.saveSlots(slots);
    return changed;
  }

  renameTarget(maxChatId, title) {
    const value = String(maxChatId);
    const slots = this.listSlots();
    let changed = false;
    for (const item of slots) {
      if (String(item.targetMaxChatId || '') !== value) continue;
      item.targetMaxTitle = title || item.targetMaxTitle;
      changed = true;
    }
    if (changed) this.saveSlots(slots);
    return changed;
  }

  setEnabled(enabled) {
    this.db.setSetting('tgk_enabled', enabled ? 'true' : 'false');
    this.db.setSetting('web_relay_enabled', enabled ? 'true' : 'false');
    if (enabled) this.schedule(0);
    return enabled;
  }

  enabled() {
    const explicit = this.db.getSetting('tgk_enabled');
    return explicit !== undefined ? explicit === 'true' : this.db.getSetting('web_relay_enabled') === 'true';
  }

  status() {
    const slots = this.listSlots();
    return {
      enabled: this.enabled(),
      slots,
      sources: slots.filter((item) => item.url),
      lastError: slots.find((item) => item.lastError)?.lastError || null
    };
  }

  async probeSlot(value) {
    const slot = assertSlot(value);
    const slots = this.listSlots();
    const source = slots[slot - 1];
    if (!source?.url) throw new Error(`TGK ${slot} не настроен`);
    try {
      const posts = await this.fetchPosts(source.url);
      const latest = posts.at(-1);
      source.title = latest?.title || source.title;
      source.lastError = '';
      source.lastCheckedAt = new Date().toISOString();
      source.lastSuccessAt = source.lastCheckedAt;
      this.saveSlots(slots);
      return { slot, posts: posts.length, latestPostId: latest?.id || 0, title: source.title };
    } catch (error) {
      source.lastError = String(error?.message || error).slice(0, 500);
      source.lastCheckedAt = new Date().toISOString();
      this.saveSlots(slots);
      throw error;
    }
  }

  async #relayPost(post, source, extra = {}) {
    if (isAdvertisingPost(post)) {
      this.log?.info?.(`TGK ${source.slot}: advertising post ${post.channel}/${post.id} skipped`);
      return { advance: true, relayed: false };
    }
    let prepared;
    try {
      if (!extra.telegramMessages) {
        prepared = await prepareWebPostMedia({
          post,
          dataDir: this.dataDir,
          targetBytes: this.mediaTargetBytes,
          timeoutMs: this.mediaTransferTimeoutMs,
          sourceLimitBytes: Math.max(this.mediaTargetBytes + 1024 * 1024, 300 * 1024 * 1024),
          log: this.log
        });
      }
      const delivered = await this.onPost?.({
        post: { ...post, tgkSlot: source.slot },
        tgkSlot: source.slot,
        tgkTarget: source.targetMaxChatId ? {
          maxChatId: source.targetMaxChatId,
          title: source.targetMaxTitle,
          type: source.targetMaxType
        } : null,
        preparedMedia: prepared?.items || [],
        mediaFailures: prepared?.failures || [],
        telegramMessages: extra.telegramMessages || []
      });
      if (delivered === false) return { advance: false, relayed: false };
      return { advance: true, relayed: true };
    } finally {
      await prepared?.cleanup?.().catch(() => {});
    }
  }

  async #relayDirectMessagesForCurrentAccount(messages) {
    if (!this.enabled()) return false;
    const first = messages[0];
    if (!first?.chat) return false;
    const username = String(first.chat.username || '').toLowerCase();
    if (!username) return false;
    const slots = this.listSlots();
    const source = slots.find((item) => item.url && String(item.username || usernameFromSourceUrl(item.url)).toLowerCase() === username);
    if (!source) return false;
    const post = directPostFromMessages(messages, source.slot);
    const result = await this.#relayPost(post, source, { telegramMessages: messages });
    if (!result.advance) return false;
    source.title = first.chat.title || source.title;
    source.mode = 'bot-api';
    source.chatId = String(first.chat.id);
    source.lastPostId = Math.max(Number(source.lastPostId) || 0, Number(post.id) || 0);
    source.lastError = '';
    source.lastCheckedAt = new Date().toISOString();
    source.lastSuccessAt = source.lastCheckedAt;
    this.saveSlots(slots);
    return true;
  }

  async #relayDirectMessages(messages) {
    let delivered = false;
    for (const account of this.db.listAccounts()) {
      const current = await this.db.runAsAccount(account.id, () => this.#relayDirectMessagesForCurrentAccount(messages));
      delivered = delivered || Boolean(current);
    }
    return delivered;
  }

  async handleTelegramChannelPost(message) {
    if (!message?.chat || message.chat.type !== 'channel') return false;
    if (!message.media_group_id) return this.#relayDirectMessages([message]);
    const key = `${message.chat.id}:${message.media_group_id}`;
    const entry = this.directAlbums.get(key) || { messages: [], timer: null };
    entry.messages.push(message);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.directAlbums.delete(key);
      this.#relayDirectMessages(entry.messages).catch((error) => this.log?.warn?.('TGK direct album failed', error.message));
    }, 900);
    entry.timer.unref?.();
    this.directAlbums.set(key, entry);
    return true;
  }

  async relayCurrentAccountOnce() {
    if (!this.enabled()) return 0;
    const slots = this.listSlots();
    let relayed = 0;
    for (const source of slots.filter((item) => item.url)) {
      try {
        const posts = await this.fetchPosts(source.url);
        source.lastCheckedAt = new Date().toISOString();
        if (!source.lastPostId) {
          // First successful check only establishes the starting point.
          source.lastPostId = Number(posts.at(-1)?.id) || 0;
          source.title = posts.at(-1)?.title || source.title;
          source.lastError = '';
          source.lastSuccessAt = source.lastCheckedAt;
          this.saveSlots(slots);
          continue;
        }
        const pending = posts.filter((post) => Number(post.id) > Number(source.lastPostId));
        for (const post of pending) {
          const result = await this.#relayPost(post, source);
          if (result.relayed) relayed += 1;
          if (result.advance) source.lastPostId = Math.max(Number(source.lastPostId) || 0, Number(post.id) || 0);
          this.saveSlots(slots);
          await delay(800);
        }
        source.title = posts.at(-1)?.title || source.title;
        source.lastError = '';
        source.lastSuccessAt = source.lastCheckedAt;
        this.saveSlots(slots);
      } catch (error) {
        source.lastCheckedAt = new Date().toISOString();
        source.lastError = String(error?.message || error).slice(0, 500);
        this.saveSlots(slots);
        this.log?.warn?.(`TGK ${source.slot} source ${source.url} failed`, error.message);
      }
    }
    return relayed;
  }

  async relayOnce() {
    if (this.running || this.stopped) return 0;
    this.running = true;
    let total = 0;
    try {
      for (const account of this.db.listAccounts()) {
        total += await this.db.runAsAccount(account.id, () => this.relayCurrentAccountOnce());
      }
      return total;
    } finally {
      this.running = false;
    }
  }

  async loadLatest(value, count = 1) {
    const slot = assertSlot(value);
    const amount = Number(count);
    if (!Number.isInteger(amount) || amount < 1 || amount > 20) throw new Error('Количество должно быть от 1 до 20');
    if (this.running) throw new Error('TGK уже обрабатывает публикацию. Повтори позже.');
    const slots = this.listSlots();
    const source = slots[slot - 1];
    if (!source?.url) throw new Error(`Сначала настрой TGK ${slot}: /tgk ${slot} https://t.me/channel_name`);
    this.running = true;
    let loaded = 0;
    try {
      const posts = await this.fetchHistory(source.url, amount);
      for (const post of posts) {
        const result = await this.#relayPost(post, source);
        if (result.relayed) loaded += 1;
        if (result.advance) source.lastPostId = Math.max(Number(source.lastPostId) || 0, Number(post.id) || 0);
        this.saveSlots(slots);
        await delay(800);
      }
      source.lastError = '';
      source.lastCheckedAt = new Date().toISOString();
      source.lastSuccessAt = source.lastCheckedAt;
      this.saveSlots(slots);
      return loaded;
    } catch (error) {
      source.lastError = String(error?.message || error).slice(0, 500);
      source.lastCheckedAt = new Date().toISOString();
      this.saveSlots(slots);
      throw error;
    } finally {
      this.running = false;
    }
  }

  // Compatibility wrappers for old API clients.
  addSource(input) {
    const url = normalizePublicChannelUrl(input);
    const existing = this.listSlots().find((item) => item.url === url);
    if (existing) return { url, slot: existing.slot, sources: this.listSources() };
    const slot = this.listSlots().find((item) => !item.url)?.slot;
    if (!slot) throw new Error('Все три TGK уже заняты. Используй /tgk 1, /tgk 2 или /tgk 3 для замены.');
    const result = this.setSlot(slot, url);
    this.schedule(0);
    return { url: result.url, slot, sources: this.listSources() };
  }

  removeSource(input) {
    const url = normalizePublicChannelUrl(input);
    const current = this.listSlots().find((item) => item.url === url);
    if (!current) return { url, removed: false, sources: this.listSources() };
    this.removeSlot(current.slot);
    return { url, removed: true, sources: this.listSources() };
  }

  schedule(delayMs = this.pollIntervalMs) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      await this.relayOnce().catch((error) => this.log?.warn?.('TGK relay cycle failed', error.message));
      this.schedule(this.pollIntervalMs);
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  start() {
    this.stopped = false;
    this.schedule(1_500);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const entry of this.directAlbums.values()) clearTimeout(entry.timer);
    this.directAlbums.clear();
  }
}
