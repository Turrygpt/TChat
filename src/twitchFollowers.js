const { TwitchEventSub } = require('./twitchEventSub');

function twitchFollower(event = {}, broadcasterId) {
  if (!event.user_id || !event.followed_at || event.broadcaster_user_id !== broadcasterId
    || !Number.isFinite(Date.parse(event.followed_at))) return null;
  return {
    id: `twitch:follow:${broadcasterId}:${event.user_id}:${event.followed_at}`,
    platform: 'twitch',
    username: event.user_name || event.user_login || 'Зритель',
    message: 'теперь отслеживает канал',
    createdAt: event.followed_at,
  };
}

function publishTwitchFollower(event, { publish, subscriberAlert }) {
  publish({
    id: event.id, platform: 'twitch', user: event.username, text: event.message,
    parts: [{ type: 'text', text: event.message }], badges: [], color: '',
    highlighted: false, systemEvent: 'twitch-follow', createdAt: event.createdAt,
  });
  subscriberAlert(event);
}

class TwitchFollowers extends TwitchEventSub {
  constructor({ getChannel, publish, subscriberAlert, ...options }) {
    super({ ...options, label: 'фолловеры',
      onEvent: (event) => publishTwitchFollower(event, { publish, subscriberAlert }) });
    this.getChannel = getChannel;
  }

  async validate(token) {
    const channel = this.getChannel();
    if (!channel) throw new Error('Сначала укажите и подключите канал Twitch.');
    const info = await super.validate(token);
    if (!info.scopes?.includes('moderator:read:followers')) {
      throw new Error('Нужен токен владельца канала с правом moderator:read:followers.');
    }
    if (String(info.login || '').toLowerCase() !== channel) {
      throw new Error(`Нужен токен владельца канала ${channel}. Токен другого канала не подходит.`);
    }
    // The channel may have changed while token validation was in flight.
    if (this.getChannel() !== channel) throw new Error('Канал Twitch изменён. Подключите фолловеров заново.');
    return info;
  }

  subscription() {
    return { type: 'channel.follow', version: '2',
      condition: { broadcaster_user_id: this.info.user_id, moderator_user_id: this.info.user_id } };
  }

  normalizeEvent(event) {
    if (this.getChannel() !== this.info.login.toLowerCase()) return null;
    return twitchFollower(event, this.info.user_id);
  }
}

module.exports = { TwitchFollowers, twitchFollower, publishTwitchFollower };
