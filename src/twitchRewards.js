const WebSocket = require('ws');
const { twitchReward } = require('./rewardRules');
const TYPE = 'channel.channel_points_custom_reward_redemption.add';

// Credentials stay in the main process. No token is sent to OBS or socket.io.
class TwitchRewards {
  constructor({ onReward, onStatus, fetchImpl = fetch, Socket = WebSocket }) {
    Object.assign(this, { onReward, onStatus, fetch: fetchImpl, Socket });
    this.generation = 0;
    this.sockets = new Set();
    this.seen = new Set();
    this.status = 'Не подключено';
  }

  report(status) { this.status = status; this.onStatus(status); }

  stop() {
    this.generation += 1;
    clearTimeout(this.retry);
    clearInterval(this.validation);
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    this.token = '';
  }

  async validate(token) {
    const response = await this.fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Токен Twitch недействителен или истёк. Подключите заново.');
    const info = await response.json();
    if (!info.user_id || !info.scopes?.some((scope) => ['channel:read:redemptions', 'channel:manage:redemptions'].includes(scope))) {
      throw new Error('Нужен токен владельца канала с правом channel:read:redemptions.');
    }
    return info;
  }

  async start(value) {
    this.stop();
    const generation = this.generation;
    const token = String(value || '').trim().replace(/^oauth:/i, '');
    this.report('Проверка доступа…');
    try {
      const info = await this.validate(token);
      if (generation !== this.generation) return;
      this.token = token;
      this.info = info;
      this.report(`Подключение наград ${info.login}…`);
      this.open(generation);
      this.validation = setInterval(async () => {
        try { await this.validate(token); }
        catch (error) {
          if (generation !== this.generation) return;
          this.stop();
          this.report(error.message);
        }
      }, 60 * 60 * 1000);
    } catch (error) {
      if (generation === this.generation) this.report(error.message);
    }
  }

  open(generation, url = 'wss://eventsub.wss.twitch.tv/ws', previous = null) {
    if (generation !== this.generation) return;
    const socket = new this.Socket(url);
    this.sockets.add(socket);
    let retired = false;
    let timeoutSeconds = 10;
    let watchdog;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => socket.terminate(), (timeoutSeconds + 5) * 1000);
    };
    arm();
    socket.on('error', () => {}); // close schedules a reconnect, without leaking credentials.
    socket.on('close', () => {
      clearTimeout(watchdog);
      this.sockets.delete(socket);
      if (retired || generation !== this.generation || this.sockets.size) return;
      this.report('Связь с Twitch потеряна, повтор через 5 секунд…');
      this.retry = setTimeout(() => this.open(generation), 5000);
    });
    socket.on('message', async (raw) => {
      if (generation !== this.generation) return;
      try {
        const message = JSON.parse(String(raw));
        const type = message.metadata?.message_type;
        const payload = message.payload || {};
        arm();
        if (type === 'session_welcome') {
          timeoutSeconds = payload.session.keepalive_timeout_seconds || 10;
          arm();
          if (previous) {
            previous.retire();
          } else {
            const response = await this.fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
              method: 'POST', signal: AbortSignal.timeout(8000),
              headers: { Authorization: `Bearer ${this.token}`, 'Client-Id': this.info.client_id, 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: TYPE, version: '1', condition: { broadcaster_user_id: this.info.user_id },
                transport: { method: 'websocket', session_id: payload.session.id } }),
            });
            if (generation !== this.generation) return;
            if (!response.ok) throw new Error(`Не удалось подключить награды Twitch (HTTP ${response.status}). Подключите заново.`);
          }
          this.report(`Подключено: ${this.info.login}`);
        } else if (type === 'session_reconnect') {
          const next = new URL(payload.session.reconnect_url);
          if (next.protocol !== 'wss:' || next.hostname !== 'eventsub.wss.twitch.tv') throw new Error('Некорректный адрес переподключения Twitch');
          this.open(generation, next.href, { retire: () => { retired = true; socket.close(); } });
        } else if (type === 'revocation') {
          throw new Error('Twitch отозвал доступ к наградам. Подключите заново.');
        } else if (type === 'notification' && payload.subscription?.type === TYPE) {
          const event = twitchReward(payload.event);
          if (!event || this.seen.has(event.id)) return;
          this.seen.add(event.id);
          if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
          this.onReward(event);
        }
      } catch (error) {
        if (generation !== this.generation) return;
        this.stop();
        this.report(error.message);
      }
    });
  }
}

module.exports = { TwitchRewards };
