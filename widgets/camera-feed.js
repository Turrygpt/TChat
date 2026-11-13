(() => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
  const image = document.querySelector('#snapCameraFeed');
  let run;

  function clear() {
    run = undefined;
    image.hidden = true;
    image.removeAttribute('src');
  }

  image.addEventListener('load', () => { image.hidden = false; });
  image.addEventListener('error', clear);

  async function update() {
    try {
      const response = await fetch('/api/camera/state', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
      if (response.status === 404 || response.status === 403) {
        clear();
        return;
      }
      const state = await response.json();
      if (!state.live) {
        if (run !== undefined) clear();
      } else if (run !== state.run) {
        image.hidden = true;
        run = state.run;
        image.src = `/api/camera/stream?run=${encodeURIComponent(run)}`;
      }
    } catch {
      clear();
    }
    setTimeout(update, 750);
  }

  update();
})();
