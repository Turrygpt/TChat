'use strict';

// Node 22+ provides a browser-style WebSocket without terminate()/TCP keep-alive.
// tmi.js captures the global constructor at load time, so explicitly use ws and
// restore the global immediately for every other integration.
const nativeWebSocket = globalThis.WebSocket;
let tmi;
try {
  globalThis.WebSocket = require('ws');
  tmi = require('tmi.js');
} finally {
  globalThis.WebSocket = nativeWebSocket;
}

// Share an in-flight poll instead of accumulating requests during a network stall.
function singleFlight(task) {
  let pending = null;
  return (...args) => {
    if (!pending) {
      pending = Promise.resolve().then(() => task(...args)).finally(() => { pending = null; });
    }
    return pending;
  };
}

function watchTwitchConnection(client, {
  now = Date.now,
  pingIntervalMs = 20000,
  timeoutMs = 10000,
  connectTimeoutMs = 20000,
  checkIntervalMs = 1000,
  onTimeout = () => {},
} = {}) {
  let socket = null;
  let socketSince = now();
  let connected = false;
  let lastPing = now();
  let pendingPing = null;

  const onConnected = () => {
    connected = true;
    lastPing = now();
    pendingPing = null;
    client.ws?._socket?.setKeepAlive(true, 15000);
  };
  const onDisconnected = () => { connected = false; pendingPing = null; };
  const onPong = () => { pendingPing = null; };
  client.on('connected', onConnected);
  client.on('disconnected', onDisconnected);
  client.on('pong', onPong);

  const tick = () => {
    if (socket !== client.ws) {
      socket = client.ws;
      socketSince = now();
      pendingPing = null;
    }
    if (!socket || socket.readyState === 3) return;

    const fail = (reason) => {
      onTimeout(reason);
      pendingPing = null;
      connected = false;
      // close() waits for a close handshake which can also stall behind Zapret.
      // terminate() makes tmi.js run its normal automatic reconnect immediately.
      client.wasCloseCalled = false;
      socket.terminate();
    };
    if ((!connected || socket.readyState !== 1) && now() - socketSince >= connectTimeoutMs) {
      fail('таймаут подключения');
    } else if (pendingPing !== null && now() - pendingPing >= timeoutMs) {
      fail('нет ответа на PING');
    } else if (connected && socket.readyState === 1 && pendingPing === null && now() - lastPing >= pingIntervalMs) {
      lastPing = now();
      pendingPing = now();
      client.latency = new Date();
      try { socket.send('PING'); } catch { fail('ошибка отправки PING'); }
    }
  };
  const timer = setInterval(tick, checkIntervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    client.removeListener('connected', onConnected);
    client.removeListener('disconnected', onDisconnected);
    client.removeListener('pong', onPong);
  };
}

function retireTwitchClient(client) {
  if (!client) return;
  client.reconnect = false;
  // tmi.js does not expose its scheduled reconnect timer. A retired client must
  // also ignore a retry already queued before a channel change or shutdown.
  client.connect = async () => [];
  clearInterval(client.pingLoop);
  clearTimeout(client.pingTimeout);
  clearTimeout(client._updateEmotesetsTimer);
  client.ws?.terminate();
}

module.exports = { tmi, singleFlight, watchTwitchConnection, retireTwitchClient };
