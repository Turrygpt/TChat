const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tchat', {
  getServerStatus: () => ipcRenderer.invoke('app:get-server-status'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  checkUpdates: () => ipcRenderer.invoke('app:check-updates'),
  installUpdate: (payload) => ipcRenderer.invoke('app:install-update', payload),
  getPatchnotes: () => ipcRenderer.invoke('app:get-patchnotes'),
  getDataSummary: () => ipcRenderer.invoke('app:get-data-summary'),
  getSetupState: () => ipcRenderer.invoke('app:get-setup-state'),
  getOauthInfo: () => ipcRenderer.invoke('app:get-oauth-info'),
  completeSetup: () => ipcRenderer.invoke('app:complete-setup'),
  getRestreamState: () => ipcRenderer.invoke('restream:get-state'),
  startRestream: () => ipcRenderer.invoke('restream:start'),
  stopRestream: () => ipcRenderer.invoke('restream:stop'),
  saveRestreamConfig: (payload) => ipcRenderer.invoke('restream:save-config', payload),
  onRestreamStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('restream:status', listener);
    return () => ipcRenderer.removeListener('restream:status', listener);
  },
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  getProfile: (id) => ipcRenderer.invoke('profiles:get', id),
  upsertProfile: (patch) => ipcRenderer.invoke('profiles:upsert', patch),
  ensureProfile: (payload) => ipcRenderer.invoke('profiles:ensure', payload),
  openProfile: (payload) => ipcRenderer.invoke('profiles:open', payload),
  removeProfile: (id) => ipcRenderer.invoke('profiles:remove', id),
  addProfileTimeline: (id, entry) => ipcRenderer.invoke('profiles:add-timeline', { id, entry }),
  removeProfileTimeline: (id, entryId) => ipcRenderer.invoke('profiles:remove-timeline', { id, entryId }),
  analyzeProfile: (id) => ipcRenderer.invoke('profiles:analyze', id),
  getProfileKeys: () => ipcRenderer.invoke('profiles:get-keys'),
  getProfilesAiSettings: () => ipcRenderer.invoke('profiles:get-ai-settings'),
  onProfileKeys: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('profiles:keys', listener);
    return () => ipcRenderer.removeListener('profiles:keys', listener);
  },
  onProfileChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('profiles:changed', listener);
    return () => ipcRenderer.removeListener('profiles:changed', listener);
  },
  onProfileFocus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('profiles:focus', listener);
    return () => ipcRenderer.removeListener('profiles:focus', listener);
  },
  getIncomingState: () => ipcRenderer.invoke('incoming:get-state'),
  addIncomingStream: (payload) => ipcRenderer.invoke('incoming:add', payload),
  updateIncomingStream: (id, patch) => ipcRenderer.invoke('incoming:update', { id, patch }),
  removeIncomingStream: (id) => ipcRenderer.invoke('incoming:remove', { id }),
  onIncomingStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('incoming:status', listener);
    return () => ipcRenderer.removeListener('incoming:status', listener);
  },
  exportConfig: () => ipcRenderer.invoke('config:export'),
  importConfig: () => ipcRenderer.invoke('config:import'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  openChatWindow: () => ipcRenderer.invoke('app:open-chat-window'),
  openBackoffice: () => ipcRenderer.invoke('app:open-backoffice'),
  updateChatChannels: (payload) => ipcRenderer.invoke('chat:update-channels', payload),
  getYoutubeProxy: () => ipcRenderer.invoke('youtube-proxy:get'),
  saveYoutubeProxy: (payload) => ipcRenderer.invoke('youtube-proxy:save', payload),
  getChatStatus: () => ipcRenderer.invoke('chat:get-status'),
  getChatHistory: () => ipcRenderer.invoke('chat:get-history'),
  getChatUiSettings: () => ipcRenderer.invoke('chat:get-ui-settings'),
  saveChatUiSettings: (payload) => ipcRenderer.invoke('chat:save-ui-settings', payload),
  updateChatFilters: (payload) => ipcRenderer.invoke('chat:update-filters', payload),
  updateDonationAlerts: (payload) => ipcRenderer.invoke('donationalerts:update', payload),
  getDonationAlertsState: () => ipcRenderer.invoke('donationalerts:get-state'),
  getDonationAlertsAuthUrl: (payload) => ipcRenderer.invoke('donationalerts:get-auth-url', payload),
  getDonationAlertsCredentials: () => ipcRenderer.invoke('donationalerts:get-credentials'),
  removeDonationAlert: (payload) => ipcRenderer.invoke('donationalerts:remove-donation', payload),
  getAlertSettings: () => ipcRenderer.invoke('alerts:get-settings'),
  saveAlertSettings: (payload) => ipcRenderer.invoke('alerts:save-settings', payload),
  getAlertQueue: () => ipcRenderer.invoke('alerts:get-queue'),
  pickAlertAsset: (payload) => ipcRenderer.invoke('alerts:pick-asset', payload),
  getStickerState: () => ipcRenderer.invoke('stickers:get-state'),
  saveStickerSettings: (payload) => ipcRenderer.invoke('stickers:save-settings', payload),
  pickStickerAsset: () => ipcRenderer.invoke('stickers:pick-asset'),
  testSticker: (payload) => ipcRenderer.invoke('stickers:test', payload),
  clearStickers: () => ipcRenderer.invoke('stickers:clear'),
  onStickerState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('stickers:state', listener);
    return () => ipcRenderer.removeListener('stickers:state', listener);
  },
  getAnnounceSettings: () => ipcRenderer.invoke('announce:get-settings'),
  saveAnnounceSettings: (payload) => ipcRenderer.invoke('announce:save-settings', payload),
  previewAnnounce: () => ipcRenderer.invoke('announce:preview'),
  sendAnnounce: (payload) => ipcRenderer.invoke('announce:send', payload),
  getMusicQueue: () => ipcRenderer.invoke('music:get-queue'),
  addMusicUrl: (payload) => ipcRenderer.invoke('music:add-url', payload),
  removeMusicItem: (payload) => ipcRenderer.invoke('music:remove-item', payload),
  getGoalState: () => ipcRenderer.invoke('goal:get-state'),
  updateGoal: (payload) => ipcRenderer.invoke('goal:update', payload),
  getWidgetsState: () => ipcRenderer.invoke('widgets:get-state'),
  createWidget: (payload) => ipcRenderer.invoke('widgets:create', payload),
  updateWidget: (payload) => ipcRenderer.invoke('widgets:update', payload),
  deleteWidget: (payload) => ipcRenderer.invoke('widgets:delete', payload),
  startPoll: (payload) => ipcRenderer.invoke('poll:start', payload),
  finishPoll: () => ipcRenderer.invoke('poll:finish'),
  hidePoll: () => ipcRenderer.invoke('poll:hide'),
  showPoll: () => ipcRenderer.invoke('poll:show'),
  clearPoll: () => ipcRenderer.invoke('poll:clear'),
  adjustCountdown: (payload) => ipcRenderer.invoke('countdown:adjust', payload),
  setCountdown: (payload) => ipcRenderer.invoke('countdown:set', payload),
  startCountdown: (payload) => ipcRenderer.invoke('countdown:start', payload),
  pauseCountdown: (payload) => ipcRenderer.invoke('countdown:pause', payload),
  resumeCountdown: (payload) => ipcRenderer.invoke('countdown:resume', payload),
  resetCountdown: (payload) => ipcRenderer.invoke('countdown:reset', payload),
  sendDemoChatMessage: (payload) => ipcRenderer.invoke('demo:send-chat-message', payload),
  sendDemoDonationAlert: (payload) => ipcRenderer.invoke('demo:send-donation-alert', payload),
  sendDemoSubscriberAlert: (payload) => ipcRenderer.invoke('demo:send-subscriber-alert', payload),
  sendDemoRaidAlert: (payload) => ipcRenderer.invoke('demo:send-raid-alert', payload),
  updateDemoGoal: (payload) => ipcRenderer.invoke('demo:update-goal', payload),
  onUpdaterStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
  onGhostMode: (callback) => {
    const listener = (_event, enabled) => callback(enabled);
    ipcRenderer.on('ghost:state', listener);
    return () => ipcRenderer.removeListener('ghost:state', listener);
  },
  onChatMessage: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:message', listener);
    return () => ipcRenderer.removeListener('chat:message', listener);
  },
  onChatStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:status', listener);
    return () => ipcRenderer.removeListener('chat:status', listener);
  },
  onChatHistory: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:history', listener);
    return () => ipcRenderer.removeListener('chat:history', listener);
  },
  onChatUiSettings: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:ui-settings', listener);
    return () => ipcRenderer.removeListener('chat:ui-settings', listener);
  },
  onDonationAlertsState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('donationalerts:state', listener);
    return () => ipcRenderer.removeListener('donationalerts:state', listener);
  },
  onAlertQueue: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('alerts:queue', listener);
    return () => ipcRenderer.removeListener('alerts:queue', listener);
  },
  onChatDonationAlert: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:donation-alert', listener);
    return () => ipcRenderer.removeListener('chat:donation-alert', listener);
  },
  onChatMusicRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:music-request', listener);
    return () => ipcRenderer.removeListener('chat:music-request', listener);
  },
  onMusicQueue: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('music:queue', listener);
    return () => ipcRenderer.removeListener('music:queue', listener);
  },
  onGoalState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('goal:state', listener);
    return () => ipcRenderer.removeListener('goal:state', listener);
  },
  onWidgetsState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('widgets:state', listener);
    return () => ipcRenderer.removeListener('widgets:state', listener);
  },
});
