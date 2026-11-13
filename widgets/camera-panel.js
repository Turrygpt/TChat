(() => {
  const api = window.tchat;
  const device = document.querySelector('#cameraDevice');
  const effect = document.querySelector('#cameraEffect');
  const mirror = document.querySelector('#cameraMirror');
  const start = document.querySelector('#cameraStart');
  const stop = document.querySelector('#cameraStop');
  const refresh = document.querySelector('#cameraRefresh');
  const status = document.querySelector('#cameraStatus');
  const preview = document.querySelector('#cameraPreview');
  const overlayUrl = document.querySelector('#cameraOverlayUrl');
  const openOverlay = document.querySelector('#cameraOpenOverlay');
  if (!api?.getCameraState) {
    status.textContent = 'Камера SnapLite доступна в приложении TChat для Windows.';
    return;
  }

  const messages = {
    idle: 'Камера выключена.',
    starting: 'Подключаем камеру…',
    live: 'Камера в общем оверлее.',
    stopping: 'Выключаем камеру…',
  };
  let state = { phase: 'idle' };
  let busy = false;
  let visible = false;
  let loadedDevices = false;
  let timer;
  let origin;
  let notice = '';

  function render() {
    const running = ['starting', 'live', 'stopping'].includes(state.phase);
    start.disabled = busy || running || !device.value;
    stop.disabled = busy || !['starting', 'live'].includes(state.phase);
    for (const control of [refresh, device, effect, mirror]) control.disabled = busy || running;
    status.textContent = notice || state.error || messages[state.phase];

    const src = visible && state.phase === 'live' && origin ? `${origin}/widgets/camera-preview.html` : '';
    if (src && preview.getAttribute('src') !== src) preview.src = src;
    if (!src) preview.removeAttribute('src');
    preview.hidden = !src;
  }

  async function command(action) {
    busy = true;
    notice = '';
    render();
    try {
      await action();
    } catch (error) {
      notice = error.message;
    } finally {
      busy = false;
      render();
    }
  }

  function loadDevices() {
    loadedDevices = true;
    return command(async () => {
      const selected = device.value;
      const devices = await api.listCameraDevices();
      device.replaceChildren(...devices.map(({ name, id }) => new Option(name, id)));
      const preferred = devices.find(({ name }) => !/virtual|snap camera|vtubestudio|broadcast/i.test(name));
      if (devices.some(({ id }) => String(id) === selected)) device.value = selected;
      else if (preferred) device.value = preferred.id;
      if (!devices.length) notice = 'Камеры не найдены. Подключите камеру и обновите список.';
    });
  }

  async function updateState() {
    if (busy) return;
    try {
      const current = await api.getCameraState();
      if (!busy) state = current;
    } catch (error) {
      notice = error.message;
    }
    render();
  }

  window.TChatCameraPanel = {
    setVisible(show) {
      if (visible === show) return;
      visible = show;
      clearInterval(timer);
      render();
      if (!show) return;
      if (!loadedDevices) loadDevices();
      else updateState();
      timer = setInterval(updateState, 750);
    },
  };

  refresh.addEventListener('click', loadDevices);
  start.addEventListener('click', () => command(async () => {
    state = await api.startCamera({ camera: Number(device.value), effect: effect.value, mirror: mirror.checked });
  }));
  stop.addEventListener('click', () => command(async () => { state = await api.stopCamera(); }));
  openOverlay.addEventListener('click', () => api.openExternal(overlayUrl.textContent));
  api.getServerStatus().then(({ url }) => {
    origin = url;
    overlayUrl.textContent = `${url}/widgets/stream.html`;
    openOverlay.disabled = false;
    render();
  }).catch(error => { status.textContent = error.message; });
})();
