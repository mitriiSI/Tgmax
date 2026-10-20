const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function maxMessageFromUpdate(update) {
  return update?.message
    ?? update?.message_created?.message
    ?? update?.message_created
    ?? update?.data?.message
    ?? update?.payload?.message;
}

export function startMaxPolling({ maxBot, db, onMessage, onCallback, onChatUpdate, log }) {
  let stopped = false;
  let marker = db.getSetting('max_update_marker') || undefined;

  const stop = () => {
    stopped = true;
  };

  const promise = (async () => {
    while (!stopped) {
      try {
        const response = await maxBot.api.getUpdates([
          'message_created',
          'message_callback',
          'bot_added',
          'bot_removed',
          'chat_title_changed'
        ], {
          marker: marker ? Number(marker) : undefined,
          timeout: 90,
          limit: 100
        });

        for (const update of response.updates ?? []) {
          if (stopped) break;
          try {
            if (update?.update_type === 'message_created') {
              const message = maxMessageFromUpdate(update);
              if (!message) {
                log.warn('MAX message update is not ready; skipping it', Object.keys(update ?? {}).join(', ') || 'empty update');
                continue;
              }
              await onMessage(message);
            } else if (update?.update_type === 'message_callback' && onCallback) {
              await onCallback(update.callback, maxMessageFromUpdate(update));
            } else if (
              ['bot_added', 'bot_removed', 'chat_title_changed'].includes(update?.update_type)
              && onChatUpdate
            ) {
              await onChatUpdate(update);
            }
          } catch (error) {
            log.error(`MAX update processing error (${update?.update_type ?? 'unknown'})`, error);
          }
        }

        if (response.marker !== undefined && response.marker !== null) {
          marker = String(response.marker);
          db.setSetting('max_update_marker', marker);
        }
      } catch (error) {
        log.error('MAX polling error', error);
        await delay(10_000);
      }
    }
  })();

  return { stop, promise };
}
