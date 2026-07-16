// Browser shim for window.tchat — the same API the Electron preload exposes,
// but implemented over socket.io against the headless web-bridge.
// Loaded before the page's own scripts, so window.tchat is ready in time.
(function () {
  var role = window.__TCHAT_ROLE === 'chat' ? 'chat' : 'backoffice';
  var socket = io();
  var listeners = Object.create(null); // channel -> [callback]

  socket.on('connect', function () {
    socket.emit('tchat:join', { role: role });
  });

  socket.on('tchat:event', function (msg) {
    if (!msg || !msg.channel) return;
    var cbs = listeners[msg.channel];
    if (!cbs) return;
    cbs.slice().forEach(function (cb) {
      try {
        cb(msg.payload);
      } catch (e) {
        console.error('tchat listener error', msg.channel, e);
      }
    });
  });

  function invoke(channel, arg) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('tchat invoke timeout: ' + channel));
      }, 20000);
      socket.emit('tchat:invoke', { channel: channel, arg: arg }, function (res) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (res && res.ok) resolve(res.value);
        else reject(new Error((res && res.error) || 'tchat invoke failed: ' + channel));
      });
    });
  }

  function on(channel, callback) {
    (listeners[channel] || (listeners[channel] = [])).push(callback);
    return function off() {
      var cbs = listeners[channel];
      if (!cbs) return;
      var i = cbs.indexOf(callback);
      if (i >= 0) cbs.splice(i, 1);
    };
  }

  function openWindow(url) {
    try {
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      /* ignore */
    }
    return Promise.resolve();
  }

  window.tchat = {
    // app / windows — handled client-side (a server has no desktop windows)
    getServerStatus: function () {
      return invoke('app:get-server-status');
    },
    openExternal: function (url) {
      return openWindow(url);
    },
    openChatWindow: function () {
      return openWindow('/chat');
    },
    openBackoffice: function () {
      return openWindow('/backoffice');
    },

    // chat
    updateChatChannels: function (p) {
      return invoke('chat:update-channels', p);
    },
    getChatStatus: function () {
      return invoke('chat:get-status');
    },
    getChatHistory: function () {
      return invoke('chat:get-history');
    },
    getChatUiSettings: function () {
      return invoke('chat:get-ui-settings');
    },
    saveChatUiSettings: function (p) {
      return invoke('chat:save-ui-settings', p);
    },

    // youtube proxy
    getYoutubeProxy: function () {
      return invoke('youtube-proxy:get');
    },
    saveYoutubeProxy: function (p) {
      return invoke('youtube-proxy:save', p);
    },

    // donation alerts
    updateDonationAlerts: function (p) {
      return invoke('donationalerts:update', p);
    },
    getDonationAlertsState: function () {
      return invoke('donationalerts:get-state');
    },
    getDonationAlertsAuthUrl: function (p) {
      return invoke('donationalerts:get-auth-url', p);
    },
    getDonationAlertsCredentials: function () {
      return invoke('donationalerts:get-credentials');
    },
    removeDonationAlert: function (p) {
      return invoke('donationalerts:remove-donation', p);
    },

    // alerts
    getAlertSettings: function () {
      return invoke('alerts:get-settings');
    },
    saveAlertSettings: function (p) {
      return invoke('alerts:save-settings', p);
    },
    getAlertQueue: function () {
      return invoke('alerts:get-queue');
    },
    pickAlertAsset: function (p) {
      return invoke('alerts:pick-asset', p);
    },

    // announce
    getAnnounceSettings: function () {
      return invoke('announce:get-settings');
    },
    saveAnnounceSettings: function (p) {
      return invoke('announce:save-settings', p);
    },
    previewAnnounce: function () {
      return invoke('announce:preview');
    },
    sendAnnounce: function (p) {
      return invoke('announce:send', p);
    },

    // music
    getMusicQueue: function () {
      return invoke('music:get-queue');
    },
    addMusicUrl: function (p) {
      return invoke('music:add-url', p);
    },
    removeMusicItem: function (p) {
      return invoke('music:remove-item', p);
    },

    // goal
    getGoalState: function () {
      return invoke('goal:get-state');
    },
    updateGoal: function (p) {
      return invoke('goal:update', p);
    },

    // widgets
    getWidgetsState: function () {
      return invoke('widgets:get-state');
    },
    createWidget: function (p) {
      return invoke('widgets:create', p);
    },
    updateWidget: function (p) {
      return invoke('widgets:update', p);
    },
    deleteWidget: function (p) {
      return invoke('widgets:delete', p);
    },

    // poll
    startPoll: function (p) {
      return invoke('poll:start', p);
    },
    finishPoll: function () {
      return invoke('poll:finish');
    },
    hidePoll: function () {
      return invoke('poll:hide');
    },
    showPoll: function () {
      return invoke('poll:show');
    },
    clearPoll: function () {
      return invoke('poll:clear');
    },

    // countdown
    adjustCountdown: function (p) {
      return invoke('countdown:adjust', p);
    },
    setCountdown: function (p) {
      return invoke('countdown:set', p);
    },
    startCountdown: function (p) {
      return invoke('countdown:start', p);
    },
    pauseCountdown: function (p) {
      return invoke('countdown:pause', p);
    },
    resumeCountdown: function (p) {
      return invoke('countdown:resume', p);
    },
    resetCountdown: function (p) {
      return invoke('countdown:reset', p);
    },

    // demo / test buttons
    sendDemoChatMessage: function (p) {
      return invoke('demo:send-chat-message', p);
    },
    sendDemoDonationAlert: function (p) {
      return invoke('demo:send-donation-alert', p);
    },
    sendDemoSubscriberAlert: function (p) {
      return invoke('demo:send-subscriber-alert', p);
    },
    sendDemoRaidAlert: function (p) {
      return invoke('demo:send-raid-alert', p);
    },
    updateDemoGoal: function (p) {
      return invoke('demo:update-goal', p);
    },

    // event subscriptions
    onChatMessage: function (cb) {
      return on('chat:message', cb);
    },
    onChatStatus: function (cb) {
      return on('chat:status', cb);
    },
    onChatHistory: function (cb) {
      return on('chat:history', cb);
    },
    onChatUiSettings: function (cb) {
      return on('chat:ui-settings', cb);
    },
    onDonationAlertsState: function (cb) {
      return on('donationalerts:state', cb);
    },
    onAlertQueue: function (cb) {
      return on('alerts:queue', cb);
    },
    onChatDonationAlert: function (cb) {
      return on('chat:donation-alert', cb);
    },
    onChatMusicRequest: function (cb) {
      return on('chat:music-request', cb);
    },
    onMusicQueue: function (cb) {
      return on('music:queue', cb);
    },
    onGoalState: function (cb) {
      return on('goal:state', cb);
    },
    onWidgetsState: function (cb) {
      return on('widgets:state', cb);
    },
  };

  // --- Keep the phone screen awake while this page is open ----------------
  // Chrome/Android sleeps the display after a timeout; the Screen Wake Lock
  // API (needs HTTPS, which we have) prevents that. The lock drops when the
  // tab is hidden, so we re-acquire it whenever the page becomes visible or
  // the user touches it.
  (function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    var lock = null;
    var acquiring = false;
    function acquire() {
      if (document.visibilityState !== 'visible') return;
      if (lock || acquiring) return;
      acquiring = true;
      navigator.wakeLock
        .request('screen')
        .then(function (l) {
          lock = l;
          acquiring = false;
          l.addEventListener('release', function () {
            lock = null;
            // The system can drop the lock on its own; grab it again.
            setTimeout(acquire, 500);
          });
        })
        .catch(function () {
          lock = null;
          acquiring = false; // heartbeat / next interaction will retry
        });
    }
    document.addEventListener('visibilitychange', acquire);
    document.addEventListener('fullscreenchange', acquire);
    document.addEventListener('click', acquire);
    document.addEventListener('touchend', acquire);
    // Heartbeat: if the lock ever dropped while the page is visible, re-grab it.
    setInterval(acquire, 10000);
    acquire();
  })();

  // --- Immersive fullscreen on the chat page (like F11 on PC) -------------
  // Browsers require a user gesture to go fullscreen, so we enter on the
  // first tap/click. Once fullscreen, further taps are ignored; if the user
  // leaves fullscreen, the next tap restores it.
  if (role === 'chat') {
    (function fullscreenOnTap() {
      var el = document.documentElement;
      var request =
        el.requestFullscreen ||
        el.webkitRequestFullscreen ||
        el.mozRequestFullScreen ||
        el.msRequestFullscreen;
      var isFs = function () {
        return (
          document.fullscreenElement ||
          document.webkitFullscreenElement ||
          document.mozFullScreenElement ||
          document.msFullscreenElement
        );
      };
      if (!request) return;
      function enter() {
        if (isFs()) return;
        try {
          var p = request.call(el, { navigationUI: 'hide' });
          if (p && p.catch) p.catch(function () {});
        } catch (e) {
          /* ignore */
        }
      }
      document.addEventListener('click', enter);
      document.addEventListener('touchend', enter);
    })();

    // Hide broken emote/badge images (cached URLs that don't resolve when the
    // page is opened remotely) so they don't show as empty placeholders.
    // 'error' doesn't bubble, so listen in the capture phase.
    document.addEventListener(
      'error',
      function (e) {
        var t = e.target;
        if (t && t.tagName === 'IMG') t.style.display = 'none';
      },
      true,
    );

    // Force the mobile-friendly layout from here (not just chat-window.html),
    // so it applies even if the phone cached an old copy of the page: pin the
    // app to the viewport height and let the feed scroll internally. Messages
    // are inserted at the DOM top (newest first), so keeping the feed pinned to
    // scrollTop 0 shows the newest message at the top.
    var style = document.createElement('style');
    style.textContent =
      'html,body{height:100vh!important;height:100dvh!important;margin:0!important;overflow:hidden!important;}' +
      '.chat-app{height:100vh!important;height:100dvh!important;display:flex!important;flex-direction:column!important;}' +
      '.statusbar,.pinned-donations{flex:0 0 auto!important;}' +
      '.feed{flex:1 1 auto!important;min-height:0!important;overflow-y:auto!important;}';
    (document.head || document.documentElement).appendChild(style);

    function pinFeedToTop() {
      var feed = document.querySelector('#feed');
      if (!feed) {
        setTimeout(pinFeedToTop, 500);
        return;
      }
      var observer = new MutationObserver(function () {
        // If the user is near the top (reading newest), keep newest in view.
        if (feed.scrollTop <= 120) feed.scrollTop = 0;
      });
      observer.observe(feed, { childList: true });
      feed.scrollTop = 0;
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', pinFeedToTop);
    } else {
      pinFeedToTop();
    }
  }
})();
