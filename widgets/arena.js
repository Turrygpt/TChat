(() => {
  const layer=document.createElement('div');layer.id='arenaLayer';document.body.append(layer);
  const commands=document.createElement('aside');commands.id='arenaCommands';commands.hidden=true;
  commands.innerHTML='<div class="arena-command-row"><strong class="arena-command-title">АРЕНА ЗРИТЕЛЕЙ</strong><span><b>!бой + персонаж</b> — начать или возродиться</span></div><div class="arena-command-row arena-character-list"><b>!бой бабка</b><b>!бой весло</b><b>!бой алкоголик</b><b>!бой офис</b><b>!бой слесарь</b></div><div class="arena-command-row arena-command-note">После смерти — новая команда через 30 с. Автовозрождения нет.</div>';
  document.body.append(commands);
  const fitArena=()=>{layer.style.bottom=commands.hidden?'0px':Math.ceil(commands.getBoundingClientRect().height+8)+'px';};
  new ResizeObserver(fitArena).observe(commands);
  const style=document.createElement('style');
  style.textContent=`
    #arenaLayer{position:fixed;inset:0;pointer-events:none;overflow:hidden;background:transparent;z-index:8}
    #arenaCommands{position:fixed;bottom:4px;left:50%;transform:translateX(-50%);z-index:9;max-width:calc(100% - 24px);width:max-content;box-sizing:border-box;padding:6px 14px;border:1px solid #86bbd94d;border-radius:9px;background:rgba(9,15,25,.92);box-shadow:0 2px 12px #0008;color:#f3f6ff;font:500 clamp(14px,.9vw,20px)/1.4 Arial;pointer-events:none;text-align:center}
    #arenaCommands[hidden]{display:none}
    .arena-command-row{display:flex;justify-content:center;align-items:center;flex-wrap:wrap;gap:3px 16px}
    .arena-command-row b{color:#ffe08a;font-weight:800}
    .arena-command-title{font-size:.8em;letter-spacing:.08em;color:#82e8f0}
    .arena-command-note{color:#c7d3e2;font-size:.85em}
    .arena-character-list{color:#bac9dd;font-size:.9em}
    .arena-fighter{position:absolute;bottom:0;transition:left .1s linear;transform:translateX(-50%);text-align:center}
    .arena-labels{display:flex;align-items:center;flex-direction:column;gap:3px;margin-bottom:5px}
    .arena-name,.arena-rank{box-sizing:border-box;background:rgba(10,15,25,.93);border:1px solid rgba(255,255,255,.35);box-shadow:0 2px 5px #0009;border-radius:6px;text-shadow:0 1px 2px #000}
    .arena-name{display:block;max-width:220px;min-width:64px;width:max-content;padding:3px 9px;color:#fff;font:700 var(--arena-label-font,18px)/1.2 Arial;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .arena-rank{display:flex;align-items:center;justify-content:center;gap:6px;padding:2px 7px;font:700 12px/16px Arial;white-space:nowrap;color:#f8fafc}
    .arena-stars{display:flex;gap:2px;font-size:14px;color:#788397}
    .arena-star.is-earned{color:#ffd56a;text-shadow:0 0 4px #d98a0070}
    .arena-hp{height:4px;background:#222e;border:1px solid #ffffff50;border-radius:4px;margin:0 auto 3px;width:70px;overflow:hidden}
    .arena-hp i{display:block;height:100%;background:#71eaa3}
    .arena-art::before{content:'';position:absolute;bottom:0;left:15%;width:70%;height:9px;border-radius:50%;background:radial-gradient(ellipse,var(--fighter-color,#ffd166),transparent 70%);opacity:.4}
    .arena-hp i{transition:width .2s ease,background-color .2s ease}
    .arena-impact{position:absolute;width:0;height:0;z-index:12;pointer-events:none}
    .arena-hit-glow,.arena-hit-ring,.arena-hit-star,.arena-hit-slash{position:absolute;display:block;left:-40px;top:-40px;width:80px;height:80px}
    .arena-hit-glow{background:radial-gradient(circle,#fff8 0%,var(--hit-color) 15%,transparent 65%);animation:arena-burst .4s ease-out both}
    .arena-hit-ring{border:3px solid var(--hit-color);border-radius:50%;box-shadow:0 0 14px var(--hit-color);animation:arena-ring .45s ease-out both}
    .arena-hit-star{background:#fff3b0;clip-path:polygon(50% 0,58% 32%,85% 12%,68% 42%,100% 50%,68% 58%,85% 88%,58% 68%,50% 100%,42% 68%,15% 88%,32% 58%,0 50%,32% 42%,15% 12%,42% 32%);animation:arena-burst .3s ease-out both}
    .arena-hit-slash{width:100px;height:45px;left:-55px;top:-25px;border-top:5px solid #fff;border-radius:50%;filter:drop-shadow(0 0 6px var(--hit-color));animation:arena-slash .3s ease-out both}
    .arena-spark{position:absolute;width:5px;height:5px;border-radius:2px;background:var(--hit-color);box-shadow:0 0 6px var(--hit-color);animation:arena-spark .5s ease-out both}
    .arena-damage{position:absolute;left:-35px;top:-35px;width:70px;text-align:center;color:#fff4bd;font:900 27px/1 Arial;-webkit-text-stroke:1px #492416;text-shadow:0 2px 0 #1b0e16,0 0 10px #ff743d;animation:arena-damage 1s ease-out both}
    .arena-ko{position:absolute;left:-70px;top:-75px;width:140px;text-align:center;font:900 22px/1.2 Arial;color:#ffd166;-webkit-text-stroke:1px #75301d;text-shadow:0 3px 0 #1b0e16,0 0 14px #ff7a32;animation:arena-damage 1s ease-out both}
    .arena-heal{position:absolute;z-index:13;color:#8effbc;font:900 22px/1.2 Arial;text-shadow:0 2px 2px #073524,0 0 9px #42ffab;animation:arena-damage 1s ease-out both;pointer-events:none}
    .is-critical .arena-damage{width:140px;left:-70px;color:#ffe278;font-size:30px}
    .is-critical .arena-hit-star{background:#fff5ba;filter:drop-shadow(0 0 12px #ff7045)}
    .is-ko .arena-hit-ring{border-width:5px;width:110px;height:110px;left:-55px;top:-55px}
    @keyframes arena-burst{0%{opacity:1;transform:scale(.3) rotate(-20deg)}60%{opacity:.9}100%{opacity:0;transform:scale(1.3) rotate(25deg)}}
    @keyframes arena-ring{from{opacity:1;transform:scale(.2)}to{opacity:0;transform:scale(1.6)}}
    @keyframes arena-slash{from{opacity:1;transform:scaleX(var(--hit-direction)) rotate(-45deg) scale(.5)}to{opacity:0;transform:scaleX(var(--hit-direction)) rotate(25deg) scale(1.3)}}
    @keyframes arena-spark{from{opacity:1;transform:translate(0,0) scale(1.5)}to{opacity:0;transform:translate(var(--spark-x),var(--spark-y)) scale(.3)}}
    @keyframes arena-damage{0%{opacity:0;transform:translateY(0) scale(.7)}15%{opacity:1;transform:translateY(-10px) scale(1.2)}65%{opacity:1}100%{opacity:0;transform:translateY(-65px) scale(.95)}}
    @media(prefers-reduced-motion:reduce){.arena-hit-glow,.arena-hit-ring,.arena-hit-star,.arena-hit-slash,.arena-spark{display:none}.arena-damage,.arena-ko{animation:none}.arena-fighter{transition:none}}
    .arena-sprite{background-repeat:no-repeat;width:100%;height:100%;filter:drop-shadow(0 2px 2px #0005)}
  `;
  document.head.append(style);
  const nodes=new Map();
  const seenEffects=new Set();
  const colors={granny:'#ffd166',paddler:'#51dcff',pirate:'#ff9666',office:'#c2a0ff',mechanic:'#6affe0'};
  const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
  function showHit(effect,state){
    if(seenEffects.has(effect.id))return;
    seenEffects.add(effect.id);if(seenEffects.size>500)seenEffects.delete(seenEffects.values().next().value);
    if(state.time-effect.at>800 || state.settings.paused || !state.settings.enabled)return;
    const target=nodes.get(effect.targetId),attacker=nodes.get(effect.attackerId);
    if(!reducedMotion){
      attacker?.querySelector('.arena-art').animate([{transform:'translateX(0)'},{transform:`translateX(${effect.face*12}px)`,offset:.3},{transform:'translateX(0)'}],{duration:260});
      target?.querySelector('.arena-art').animate([{filter:'brightness(1)',transform:'translateX(0)'},{filter:'brightness(2.2) drop-shadow(0 0 8px #ffb16b)',transform:`translateX(${effect.face*7}px)`},{filter:'brightness(1)',transform:'translateX(0)'}],{duration:300});
    }
    const fx=document.createElement('div');fx.className='arena-impact'+(effect.knockout?' is-ko':'')+(effect.critical?' is-critical':'');
    fx.style.left=(6+effect.x*88)+'%';fx.style.bottom=(state.settings.size*.55)+'px';
    fx.style.setProperty('--hit-color',colors[effect.character]||'#ffd166');
    fx.style.setProperty('--hit-direction',effect.face);
    fx.innerHTML='<i class="arena-hit-glow"></i><i class="arena-hit-ring"></i><i class="arena-hit-slash"></i><i class="arena-hit-star"></i><strong class="arena-damage"></strong>';
    fx.querySelector('.arena-damage').textContent=(effect.critical?'КРИТ! −':'−')+effect.damage;
    for(let i=0;i<7;i++){
      const spark=document.createElement('i');spark.className='arena-spark';
      const angle=i*Math.PI*2/7;
      spark.style.setProperty('--spark-x',Math.cos(angle)*55+'px');spark.style.setProperty('--spark-y',Math.sin(angle)*45+'px');fx.append(spark);
    }
    if(effect.knockout){const ko=document.createElement('b');ko.className='arena-ko';ko.textContent='НОКАУТ!';fx.append(ko);}
    layer.append(fx);
    if(effect.heal>0){
      const heal=document.createElement('strong');heal.className='arena-heal';heal.textContent='+'+effect.heal+' HP';
      heal.style.left=(6+effect.healX*88)+'%';heal.style.bottom=(state.settings.size*.8)+'px';layer.append(heal);
      setTimeout(()=>heal.remove(),1100);
    }
    const active=layer.querySelectorAll('.arena-impact');if(active.length>40)active[0].remove();
    setTimeout(()=>fx.remove(),1100);
  }
  let atlas=null,lastState=null;
  fetch('/assets/arena/frames.json').then(r=>r.json()).then(value=>{atlas=value;if(lastState)render(lastState);}).catch(console.warn);
  function render(state){
    lastState=state;commands.hidden=!state.settings.enabled;
    commands.querySelector('.arena-command-title').textContent=state.settings.paused?'АРЕНА · ПАУЗА':'АРЕНА ЗРИТЕЛЕЙ';
    fitArena();if(!atlas)return;
    const visible=state.settings.enabled?state.fighters:[], ids=new Set(visible.map(f=>f.id));
    for(const [id,node] of nodes)if(!ids.has(id)){node.remove();nodes.delete(id);}
    for(const f of visible){
      let node=nodes.get(f.id);if(!node){node=document.createElement('div');node.className='arena-fighter';node.innerHTML='<div class="arena-labels"><span class="arena-name"></span><span class="arena-rank"><span class="arena-stars" aria-hidden="true"><span class="arena-star">★</span><span class="arena-star">★</span><span class="arena-star">★</span></span><span class="arena-level"></span></span></div><div class="arena-hp"><i></i></div><div class="arena-art"><div class="arena-sprite"></div></div>';layer.append(node);nodes.set(f.id,node);}
      const size=state.settings.size;
      node.style.width=size+'px';node.style.left=(6+f.x*88)+'%';node.style.bottom='0px';node.style.zIndex=3-f.lane;
      node.style.setProperty('--fighter-color',colors[f.character]||'#ffd166');
      node.style.setProperty('--arena-label-font',Math.max(16,Math.min(22,Math.round(size*.14)))+'px');
      node.querySelector('.arena-name').textContent=f.name;
      node.querySelector('.arena-name').title=f.name;
      node.querySelector('.arena-level').textContent='Ур. '+f.level;
      node.querySelector('.arena-rank').title=`HP ${f.hp}/${f.maxHp} · Сила ${f.strength||12} · Удар каждые ${((f.attackIntervalMs||1000)/1000).toFixed(2)} с`;
      node.querySelector('.arena-hp i').style.width=(100*f.hp/f.maxHp)+'%';
      node.querySelector('.arena-hp i').style.backgroundColor=f.hp/f.maxHp<.3?'#ff6379':f.hp/f.maxHp<.6?'#ffd166':'#71eaa3';
      const sheet=atlas[f.character];if(!sheet)continue;
      const tier=f.level>=10?2:f.level>=5?1:0;
      node.querySelectorAll('.arena-star').forEach((star,index)=>star.classList.toggle('is-earned',index<=tier));
      node.querySelector('.arena-rank').setAttribute('aria-label',`Уровень ${f.level}, ступень ${tier+1} из 3`);
      const [x,y,w,h]=sheet.frames[tier*5+f.pose];
      const scale=size/Math.max(...sheet.frames.slice(tier*5,tier*5+4).map(b=>b[3]));
      const art=node.querySelector('.arena-art');art.style.height=size+'px';art.style.position='relative';
      const sprite=node.querySelector('.arena-sprite');
      sprite.style.position='absolute';sprite.style.bottom='0';sprite.style.left=(size-w*scale)/2+'px';
      sprite.style.width=w*scale+'px';sprite.style.height=h*scale+'px';
      sprite.style.backgroundImage=`url('/assets/arena/${f.character}.png')`;
      sprite.style.backgroundSize=`${sheet.width*scale}px ${sheet.height*scale}px`;
      sprite.style.backgroundPosition=`${-x*scale}px ${-y*scale}px`;
      sprite.style.transform=`scaleX(${f.face})`;
    }
    if(!state.settings.enabled)layer.querySelectorAll('.arena-impact,.arena-heal').forEach(node=>node.remove());
    for(const effect of state.effects||[])showHit(effect,state);
  }
  const socket=io();socket.on('arena:state',render);
  socket.on('connect',()=>{seenEffects.clear();return fetch('/arena/state').then(r=>r.json()).then(render).catch(console.warn);});
  socket.on('disconnect',()=>{layer.replaceChildren();nodes.clear();commands.hidden=true;fitArena();});
})();
