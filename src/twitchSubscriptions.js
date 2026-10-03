// USERNOTICE events are separate from ordinary Twitch chat messages.
function registerTwitchSubscriptions(client, { publish, subscriberAlert, renewalAlert }) {
  function emit(kind, username, text, tags = {}, extra = {}) {
    const event = {
      id: tags.id ? `twitch:subscription:${tags.id}` : `twitch:${kind}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      platform: 'twitch',
      username,
      message: text,
      tier: tags['msg-param-sub-plan'] || '',
      ...extra,
    };
    // Publishing must not depend on whether the optional alert rule is enabled.
    publish({
      id: event.id,
      platform: 'twitch',
      user: username,
      text,
      parts: [{ type: 'text', text }],
      badges: [],
      color: '',
      highlighted: false,
      systemEvent: 'twitch-subscription',
      subscriptionType: kind,
      createdAt: new Date().toISOString(),
    });
    return event;
  }

  const name = (username, tags = {}) => tags['display-name'] || username || 'Зритель';
  const tier = (methods = {}) => ({ Prime: 'Prime', 1000: 'Tier 1', 2000: 'Tier 2', 3000: 'Tier 3' }[methods.plan]);
  const plan = (methods) => tier(methods) ? ` (${tier(methods)})` : '';
  const comment = (message) => message ? ` — ${message}` : '';

  client.on('subscription', (_channel, username, methods, message, tags = {}) => {
    subscriberAlert(emit('sub', name(username, tags), `оформил подписку${plan(methods)}${comment(message)}`, tags));
  });
  client.on('resub', (_channel, username, months, message, tags = {}, methods) => {
    const total = Number(tags['msg-param-cumulative-months']) || Number(months) || 0;
    renewalAlert(emit('resub', name(username, tags), `продлил подписку${plan(methods)} · всего месяцев: ${total}${comment(message)}`, tags, { months: total }));
  });
  client.on('subgift', (_channel, username, _months, recipient, methods, tags = {}) => {
    const donor = name(username, tags);
    const event = emit('subgift', donor, `подарил подписку${plan(methods)} зрителю ${recipient || 'Зритель'}`, tags);
    subscriberAlert({ ...event, username: recipient || 'Зритель', message: `получил подарочную подписку от ${donor}` });
  });
  client.on('anonsubgift', (_channel, _months, recipient, methods, tags = {}) => {
    const event = emit('anonsubgift', 'Аноним', `подарил подписку${plan(methods)} зрителю ${recipient || 'Зритель'}`, tags);
    subscriberAlert({ ...event, username: recipient || 'Зритель', message: 'получил подарочную подписку от анонимного зрителя' });
  });
  // Twitch also sends individual subgift events for these recipients; only
  // publish the summary here so that alerts are not queued twice.
  client.on('submysterygift', (_channel, username, count, methods, tags = {}) => {
    emit('submysterygift', name(username, tags), `подарил подписки${plan(methods)} · количество: ${Number(count) || 0}`, tags);
  });
  client.on('anonsubmysterygift', (_channel, count, methods, tags = {}) => {
    emit('anonsubmysterygift', 'Аноним', `подарил подписки${plan(methods)} · количество: ${Number(count) || 0}`, tags);
  });
}

module.exports = { registerTwitchSubscriptions };
