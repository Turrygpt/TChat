(() => {
  const layer=document.createElement('div');layer.id='arenaLayer';document.body.append(layer);
  const style=document.createElement('style');style.textContent=`#arenaLayer{position:fixed;inset:0;pointer-events:none;overflow:hidden;background:transparent;z-index:8}.arena-fighter{position:absolute;bottom:0;transition:left .1s linear;transform:translateX(-50%);text-align:center}.arena-name{display:block;color:white;font:700 14px/18px Arial;text-shadow:0 1px 3px black,1px 0 3px black;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.arena-hp{height:4px;background:#222b;border-radius:4px;margin:3px auto;width:70px;overflow:hidden}.arena-hp i{display:block;height:100%;background:#71eaa3}.arena-sprite{background-repeat:no-repeat;background-size:500% 300%;width:100%;height:100%;filter:drop-shadow(0 2px 2px #0005)}`;document.head.append(style);
  const nodes=new Map();
  let atlas=null,lastState=null;
  fetch('/assets/arena/frames.json').then(r=>r.json()).then(value=>{atlas=value;if(lastState)render(lastState);}).catch(console.warn);
  function render(state){
    lastState=state;if(!atlas)return;
    const visible=state.settings.enabled?state.fighters:[], ids=new Set(visible.map(f=>f.id));
    for(const [id,node] of nodes)if(!ids.has(id)){node.remove();nodes.delete(id);}
    for(const f of visible){
      let node=nodes.get(f.id);if(!node){node=document.createElement('div');node.className='arena-fighter';node.innerHTML='<span class="arena-name"></span><div class="arena-hp"><i></i></div><div class="arena-art"><div class="arena-sprite"></div></div>';layer.append(node);nodes.set(f.id,node);}
      const size=state.settings.size;
      node.style.width=size+'px';node.style.left=(6+f.x*88)+'%';node.style.bottom=(f.lane*18)+'px';node.style.zIndex=3-f.lane;
      node.querySelector('.arena-name').textContent=f.name+' · '+f.level;
      node.querySelector('.arena-hp i').style.width=(100*f.hp/f.maxHp)+'%';
      const sheet=atlas[f.character];if(!sheet)continue;
      const tier=f.level>=10?2:f.level>=5?1:0;
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
  }
  const socket=io();socket.on('arena:state',render);
  socket.on('connect',()=>fetch('/arena/state').then(r=>r.json()).then(render).catch(console.warn));
  socket.on('disconnect',()=>{layer.replaceChildren();nodes.clear();});
})();
