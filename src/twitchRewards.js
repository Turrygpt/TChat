const { TwitchEventSub } = require('./twitchEventSub');
const { twitchReward } = require('./rewardRules');

class TwitchRewards extends TwitchEventSub {
  constructor({ onReward, ...options }) {
    super({ ...options, onEvent: onReward, label: 'награды' });
  }

  async validate(token) {
    const info = await super.validate(token);
    if (!info.scopes?.some((scope) => ['channel:read:redemptions', 'channel:manage:redemptions'].includes(scope))) {
      throw new Error('Нужен токен владельца канала с правом channel:read:redemptions.');
    }
    return info;
  }

  subscription() {
    return { type: 'channel.channel_points_custom_reward_redemption.add', version: '1',
      condition: { broadcaster_user_id: this.info.user_id } };
  }

  normalizeEvent(event) { return twitchReward(event); }
}

module.exports = { TwitchRewards };
