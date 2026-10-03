const integer = (v, fallback = 0) => Number.isFinite(Number(v)) ? Math.min(100000000, Math.max(0, Math.floor(Number(v)))) : fallback;
function normalizeSubscriberGoal(widget) {
  return { current: integer(widget.current), target: Math.max(1, integer(widget.target, 50)),
    reward: String(widget.reward || 'Разыграю коврик!').slice(0, 300),
    platform: ['twitch', 'vk', 'all'].includes(widget.platform) ? widget.platform : 'all',
    motivationEnabled: widget.motivationEnabled !== false && widget.motivationEnabled !== 'false',
    motivationIntervalSeconds: Math.min(3600, Math.max(15, integer(widget.motivationIntervalSeconds, 300))),
    sound: widget.sound !== false && widget.sound !== 'false',
    recentSubscriberIds: Array.isArray(widget.recentSubscriberIds) ? widget.recentSubscriberIds.filter(x => typeof x === 'string').slice(-500) : [] };
}
function advanceSubscriberGoals(items, subscriber) {
  if (subscriber.isTest || !subscriber.id || !subscriber.platform || subscriber.platform === 'demo') return [];
  const changed = [];
  for (const widget of items) {
    if (widget.type !== 'subscriber-goal' || (widget.platform !== 'all' && widget.platform !== subscriber.platform)) continue;
    if (widget.recentSubscriberIds.includes(subscriber.id)) continue;
    const before = widget.current;
    widget.current = integer(before + 1);
    widget.recentSubscriberIds = [...widget.recentSubscriberIds, subscriber.id].slice(-500);
    changed.push({ id: widget.id, username: subscriber.username, current: widget.current, reached: before < widget.target && widget.current >= widget.target });
  }
  return changed;
}
module.exports = { normalizeSubscriberGoal, advanceSubscriberGoals };
