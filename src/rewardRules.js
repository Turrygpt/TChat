function findRewardRule(rules, event = {}) {
  const name = String(event.reward || '').trim().toLocaleLowerCase('ru');
  const candidates = rules.filter((rule) => rule.enabled !== false && rule.image
    && (!rule.platform || rule.platform === 'any' || rule.platform === event.platform)
    && (!(Number(rule.price) > 0) || Number(rule.price) === Number(event.price)));
  return candidates.find((rule) => rule.reward && rule.reward.trim().toLocaleLowerCase('ru') === name)
    || candidates.find((rule) => !rule.reward) || null;
}

function twitchReward(event = {}) {
  if (!event.id || !event.reward?.title) return null;
  return {
    id: `twitch:reward:${event.id}`, platform: 'twitch',
    username: event.user_name || event.user_login || 'Зритель',
    reward: event.reward.title, price: Number(event.reward.cost) || 0,
    message: event.user_input || '', createdAt: event.redeemed_at,
  };
}

module.exports = { findRewardRule, twitchReward };
