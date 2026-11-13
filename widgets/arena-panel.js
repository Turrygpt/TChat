(() => {
 const api=window.tchat;if(!api?.getArenaState)return;
 const host=document.getElementById('chibisSection');if(!host)return;
 const panel=document.createElement('article');panel.className='panel';panel.style.marginBottom='20px';
 panel.innerHTML=`<h2>Арена зрителей</h2><p class="muted">Бои внизу общего оверлея. Команда !бой вызывает бойца, дальше он сражается сам.</p><p>!бой бабка · !бой весло · !бой алкоголик · !бой офис · !бой слесарь<br>!перс слесарь — сменить образ вне боя. !выход — покинуть арену.</p><div class="form-grid"><label class="checkbox"><input id="arenaEnabled" type="checkbox"> Включить арену</label><label class="checkbox"><input id="arenaPaused" type="checkbox"> Пауза</label><label class="field">Лимит бойцов<input id="arenaMax" type="number" min="2" max="50"></label><label class="field">Размер персонажей<input id="arenaSize" type="number" min="70" max="200"></label></div><p class="muted">Облик меняется на 5-м и 10-м уровнях. После смерти повторный вход через 30 секунд. Опыт сохраняется между запусками TChat.</p><button class="button" id="arenaSave">Сохранить</button> <button class="button button--ghost" id="arenaClear">Очистить арену</button><p id="arenaStatus" role="status"></p>`;
 host.prepend(panel);const $=id=>document.getElementById(id);
 function render(s){$('arenaEnabled').checked=s.settings.enabled;$('arenaPaused').checked=s.settings.paused;$('arenaMax').value=s.settings.maxPlayers;$('arenaSize').value=s.settings.size;}
 async function run(fn){try{render(await fn());$('arenaStatus').textContent='Готово. Арена включается в общем OBS-оверлее.';}catch(e){$('arenaStatus').textContent=e.message;}}
 $('arenaSave').onclick=()=>run(()=>api.saveArena({enabled:$('arenaEnabled').checked,paused:$('arenaPaused').checked,maxPlayers:Number($('arenaMax').value),size:Number($('arenaSize').value)}));
 $('arenaClear').onclick=()=>run(()=>api.clearArena());run(()=>api.getArenaState());
})();
