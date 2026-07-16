const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tchat', {
  getServerStatus: () => ipcRenderer.invoke('app:get-server-status'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  checkUpdates: () => ipcRenderer.invoke('app:check-updates'),
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
  updateDonationAlerts: (payload) => ipcRenderer.invoke('donationalerts:update', payload),
  getDonationAlertsState: () => ipcRenderer.invoke('donationalerts:get-state'),
  getDonationAlertsAuthUrl: (payload) => ipcRenderer.invoke('donationalerts:get-auth-url', payload),
  getDonationAlertsCredentials: () => ipcRenderer.invoke('donationalerts:get-credentials'),
  removeDonationAlert: (payload) => ipcRenderer.invoke('donationalerts:remove-donation', payload),
  getAlertSettings: () => ipcRenderer.invoke('alerts:get-settings'),
  saveAlertSettings: (payload) => ipcRenderer.invoke('alerts:save-settings', payload),
  getAlertQueue: () => ipcRenderer.invoke('alerts:get-queue'),
  pickAlertAsset: (payload) => ipcRenderer.invoke('alerts:pick-asset', payload),
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
