(() => {
  const api = window.tchat;
  const $ = id => document.getElementById(id);
  if (!api?.getChibiState || !$('chibiPanel')) return;
  const status = $('chibiStatus');
  function render({ settings, catalog }) {
    for (const key of ['reward','platform','position','seconds']) $('chibi' + key[0].toUpperCase() + key.slice(1)).value = settings[key];
    $('chibiEnabled').checked = settings.enabled; $('chibiHighlighted').checked = settings.highlighted;
    $('chibiCharacters').replaceChildren(...catalog.map(character => {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;padding:15px;border-radius:18px;background:#ffffff08;border:1px solid #ffffff20;cursor:pointer';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = character.id; input.checked = settings.characters.includes(character.id);
      const img = document.createElement('img'); img.src = `${location.protocol === 'file:' ? 'http://localhost:3000' : location.origin}${character.layers.body}`; img.alt = character.name; img.style.cssText = 'height:150px;width:100%;object-fit:contain';
      const title = document.createElement('strong'); title.textContent = character.name;
      const mark = () => { label.style.borderColor = input.checked ? character.color : '#ffffff20'; label.style.background = input.checked ? '#ffffff10' : '#ffffff04'; };
      input.addEventListener('change', mark); mark(); label.append(img, title, input); return label;
    }));
  }
  function read() {
    const characters = [...$('chibiCharacters').querySelectorAll('input:checked')].map(input => input.value);
    if (!characters.length) throw new Error('Выберите хотя бы одного чибика.');
    return { characters, reward: $('chibiReward').value, platform: $('chibiPlatform').value,
      position: $('chibiPosition').value, seconds: Number($('chibiSeconds').value), enabled: $('chibiEnabled').checked, highlighted: $('chibiHighlighted').checked };
  }
  async function run(action) { try { await action(); } catch (error) { status.textContent = error.message; } }
  $('chibiSave').addEventListener('click', () => run(async () => { render(await api.saveChibiSettings(read())); status.textContent = 'Настройки чибиков сохранены.'; }));
  $('chibiTest').addEventListener('click', () => run(async () => {
    render(await api.saveChibiSettings(read()));
    await api.testChibi({ username: 'TurryFan', message: $('chibiTestMessage').value });
    status.textContent = 'Настройки сохранены. Чибик отправлен в общий виджет стрима.';
  }));
  $('chibiClear').addEventListener('click', () => run(async () => { await api.clearChibis(); status.textContent = 'Экран и очередь очищены.'; }));
  run(async () => { render(await api.getChibiState()); status.textContent = 'Выберите гостей и настройте награду.'; });
})();
