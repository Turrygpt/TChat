const fs = require('node:fs');
const CATALOG = [ ['granny','Бабка','бабка'], ['paddler','Девушка с веслом','весло'], ['pirate','Алкоголик','алкоголик'], ['office','Офисный работник','офис'], ['mechanic','Слесарь','слесарь'] ].map(([id,name,command]) => ({id,name,command}));
const level = xp => Math.min(30, 1 + Math.floor(Math.sqrt(xp / 30)));
function createArena({file, emit = () => {}, now = Date.now, random = Math.random, autoStart = true} = {}) {
  let settings = {enabled:false,paused:false,maxPlayers:24,size:130};
  let profiles = Object.create(null);
  const fighters = new Map(), seen = new Set();
  let dirty = false;
  let effectId = 0;
  let effects = [];
  if (file) try { const saved=JSON.parse(fs.readFileSync(file,'utf8')); Object.assign(settings,saved.settings); profiles=Object.assign(Object.create(null),saved.profiles); } catch(error) { if(error.code !== 'ENOENT') console.warn('Arena: cannot load progress',error.message); }
  function flush() { if (!file || !dirty) return; try {fs.writeFileSync(file+'.tmp',JSON.stringify({settings,profiles}));fs.renameSync(file+'.tmp',file);dirty=false;} catch(error){console.warn('Arena: cannot save progress',error.message);} }
  function state(){return {effects:effects.filter(e=>now()-e.at<1000).map(e=>({...e})),settings:{...settings},catalog:CATALOG,fighters:[...fighters.values()].map(f=>({...f,pose:f.hp>0 && f.hurtUntil>now() && f.pose===0?3:f.pose,level:level(profiles[f.id].xp),xp:profiles[f.id].xp})),time:now()};}
  function publish(){emit('arena:state',state());}
  function save(input={}){for(const k of ['enabled','paused']) if(typeof input[k]==='boolean') settings[k]=input[k]; for(const [k,min,max] of [['maxPlayers',2,50],['size',70,200]]) if(Number.isFinite(Number(input[k]))) settings[k]=Math.min(max,Math.max(min,Math.round(Number(input[k])))); if(!settings.enabled) {fighters.clear();effects=[];}dirty=true;flush();publish();return state();}
  function clear(){fighters.clear();effects=[];publish();return state();}
  function command(m={}){
    if(!settings.enabled || settings.paused || m.systemEvent) return false;
    const parts=String(m.text||'').trim().toLowerCase().split(/\s+/), cmd=parts[0];
    if(!['!бой','!fight','!перс','!выход'].includes(cmd))return false;
    const user=String(m.userId || m.user || m.username || '').trim(); if(!user || !m.platform)return false;
    const key=String(m.platform)+':'+user.toLowerCase();
    const eventId=m.id && String(m.platform)+':'+m.id; if(eventId && seen.has(eventId))return false;
    if(eventId){seen.add(eventId);if(seen.size>2000)seen.delete(seen.values().next().value);}
    let p=profiles[key];
    if(!p) {if(Object.keys(profiles).length>=20000)return false; p=profiles[key]={xp:0,wins:0,deaths:0,character:CATALOG[Math.floor(random()*CATALOG.length)].id,readyAt:0,lastCommand:0};}
    if(now()-p.lastCommand<1500)return false; p.lastCommand=now();dirty=true;
    if(cmd==='!выход'){if(fighters.has(key))p.readyAt=Math.max(p.readyAt,now()+30000);fighters.delete(key);publish();return true;}
    const character=CATALOG.find(c=>c.command===parts[1] || c.id===parts[1]);
    if(fighters.has(key))return false;
    if(cmd==='!перс'){if(!character)return false;p.character=character.id;flush();return true;}
    if(now()<p.readyAt || fighters.size>=settings.maxPlayers)return false;
    if(character)p.character=character.id;
    const hp=100+(level(p.xp)-1)*5;
    fighters.set(key,{id:key,name:String(m.username||m.user||user).slice(0,40),character:p.character,hp,maxHp:hp,x:0.08+random()*.84,lane:Math.floor(random()*3),pose:0,face:1,next:now()+1000,lastActive:now(),target:null});publish();return true;
  }
  function tick(){
    if(!settings.enabled || settings.paused)return;
    const t=now();
    for(const f of fighters.values()){
      if(f.hp<=0){if(t>=f.next)fighters.delete(f.id);continue;}
      if(t-f.lastActive>900000){fighters.delete(f.id);continue;}
      if(f.next>t)continue;
      const p=profiles[f.id];
      if(f.pose===1){
        const target=fighters.get(f.target);f.pose=2;f.next=t+300;
        if(!target || target.hp<=0 || Math.abs(target.x-f.x)>.075)continue;
        const damage=8+Math.floor(random()*7)+Math.min(12,level(p.xp)-1);
        target.hp=Math.max(0,target.hp-damage);
        // A hit reaction is visual: it must never cancel the victim's scheduled
        // windup, otherwise the first attacker can stun-lock every opponent.
        target.hurtUntil=t+220;
        if(!target.hp){target.pose=4;target.next=t+3000;}
        target.lastActive=t;f.lastActive=t;
        effects.push({id:++effectId,at:t,attackerId:f.id,targetId:target.id,character:f.character,x:target.x,damage,knockout:target.hp===0,face:f.face});
        effects=effects.filter(e=>t-e.at<1000).slice(-60);
        p.xp+=3;dirty=true;
        if(!target.hp){const victim=profiles[target.id];victim.deaths++;victim.readyAt=t+30000;p.xp+=30;p.wins++;}
        continue;
      }
      f.pose=0;
      const opponents=[...fighters.values()].filter(other=>other.id!==f.id&&other.hp>0);
      opponents.sort((a,b)=>Math.abs(a.x-f.x)-Math.abs(b.x-f.x));
      const target=opponents[0];if(!target){f.next=t+300;continue;}
      f.face=target.x>=f.x?1:-1;f.lane=target.lane;
      if(Math.abs(target.x-f.x)>.065){f.x=Math.max(.06,Math.min(.94,f.x+f.face*.012));f.next=t+100;}
      else {f.target=target.id;f.pose=1;f.next=t+450+Math.floor(random()*250);}
    }
    if(fighters.size)publish();else if(tick.hadFighters)publish();tick.hadFighters=fighters.size>0;
  }
  const timer=autoStart?setInterval(tick,100):null;timer?.unref();
  const saver=autoStart?setInterval(flush,5000):null;saver?.unref();
  return {state,save,clear,command,tick,flush,close(){clearInterval(timer);clearInterval(saver);flush();}};
}
module.exports={createArena,level};
