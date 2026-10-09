const WIDGET_TYPES = new Set([
  'alerts', 'chat', 'music', 'goal', 'subscriber-goal', 'poll', 'giveaway',
  'donation-giveaway', 'countdown', 'texts', 'tasks', 'sticker', 'video-overlay', 'custom',
]);

function resolveWidgetType(widget = {}) {
  // Generated IDs keep the original type even after an older normalizer has
  // replaced an unsupported type with "goal" and discarded its settings.
  const match = String(widget.id || '').match(/^(.+)-\d{13}-[0-9a-f]+$/i);
  const originalType = match?.[1];
  if ((widget.type === 'goal' || !WIDGET_TYPES.has(widget.type)) && WIDGET_TYPES.has(originalType)) {
    return originalType;
  }
  return WIDGET_TYPES.has(widget.type) ? widget.type : 'goal';
}

module.exports = { resolveWidgetType };
