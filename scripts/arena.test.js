const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createArena,level,statsForLevel,rollDamage}=require('../src/arena');
function setup(){let time=100000;const arena=createArena({now:()=>time,random:()=>.5,autoStart:false});arena.save({enabled:true});return {arena,advance(n){time+=n;arena.tick();}};}
const msg=(user,text='!бой',id)=>({platform:'twitch',user,text,id});
test('spawn, duplicate protection, platform isolation and cap',()=>{const {arena}=setup();arena.save({maxPlayers:2});assert.equal(arena.command(msg('A','!бой бабка','1')),true);assert.equal(arena.command(msg('A','!бой','1')),false);assert.equal(arena.command({...msg('A'),platform:'vk'}),true);assert.equal(arena.command(msg('B')),false);assert.equal(arena.state().fighters.length,2);assert.equal(arena.state().fighters[0].character,'granny');});
test('combat, death, cooldown and preserved experience',()=>{const {arena,advance}=setup();arena.command(msg('A'));arena.command(msg('B'));for(let i=0;i<300;i++)advance(100);const survivor=arena.state().fighters.find(f=>f.hp>0);assert.ok(survivor);assert.ok(survivor.xp>0);const dead=survivor.name==='A'?'B':'A';assert.equal(arena.command(msg(dead)),false);advance(31000);assert.equal(arena.command(msg(dead)),true);});
test('pause freezes combat and disable clears arena',()=>{const {arena,advance}=setup();arena.command(msg('A'));arena.command(msg('B'));arena.save({paused:true});const before=arena.state().fighters;advance(10000);assert.deepEqual(arena.state().fighters,before);arena.save({enabled:false});assert.equal(arena.state().fighters.length,0);assert.equal(arena.command(msg('C')),false);});
test('progress survives restart without respawning fighters',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arena-test-'));const file=path.join(dir,'arena.json');try{const a=createArena({file,autoStart:false});a.save({enabled:true});a.command(msg('A','!перс офис'));a.close();const b=createArena({file,autoStart:false});assert.equal(b.command(msg('A')),false); // command cooldown is persisted
assert.equal(b.state().fighters.length,0);assert.equal(JSON.parse(fs.readFileSync(file)).profiles['twitch:a'].character,'office');b.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('level thresholds',()=>{assert.equal(level(0),1);assert.equal(level(480),5);assert.equal(level(2430),10);assert.equal(level(1e9),30);});
test('leaving cannot bypass respawn cooldown',()=>{const {arena,advance}=setup();arena.command(msg('A'));advance(2000);arena.command(msg('A','!выход'));advance(2000);assert.equal(arena.command(msg('A')),false);advance(30000);assert.equal(arena.command(msg('A')),true);});
test('combat experience is written and restored',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arena-xp-'));const file=path.join(dir,'arena.json');let time=100000;try{const a=createArena({file,now:()=>time,random:()=>.5,autoStart:false});a.save({enabled:true});a.command(msg('A'));a.command(msg('B'));for(let i=0;i<300;i++){time+=100;a.tick();}const winner=a.state().fighters.find(f=>f.hp>0);assert.ok(winner.xp>0);a.close();time+=31000;const b=createArena({file,now:()=>time,autoStart:false});assert.equal(b.command(msg(winner.name)),true);assert.equal(b.state().fighters[0].xp,winner.xp);b.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}});

for (const order of [['алкоголик','бабка'],['бабка','алкоголик']]) {
 test(`both fighters finish their windups: ${order.join(' vs ')}`,()=>{
  const {arena,advance}=setup();
  arena.command(msg('A','!бой '+order[0]));arena.command(msg('B','!бой '+order[1]));
  for(let n=0;n<22;n++)advance(100);
  const state=arena.state();
  assert.equal(state.fighters.length,2);
  assert.ok(state.fighters.every(f=>f.hp<100 && f.xp>0),'both fighters must land a hit, regardless of insertion order');
  assert.deepEqual(new Set(state.effects.map(e=>e.attackerId)),new Set(['twitch:a','twitch:b']));
  assert.ok(state.effects.every(e=>e.damage>0 && !e.knockout));
  const ids=state.effects.map(e=>e.id);assert.equal(new Set(ids).size,ids.length);
  arena.clear();assert.deepEqual(arena.state().effects,[]);
 });
}
test('combat effects expire and knockout is emitted only once',()=>{
 const {arena,advance}=setup();arena.command(msg('A'));arena.command(msg('B'));
 const knockouts=new Set();
 for(let n=0;n<300;n++){advance(100);for(const e of arena.state().effects)if(e.knockout)knockouts.add(e.id);}
 assert.equal(knockouts.size,1);advance(1100);assert.deepEqual(arena.state().effects,[]);
});

test('one viewer keeps one fighter despite repeated joins, new message IDs and renamed display names',()=>{
 const {arena,advance}=setup();
 arena.command({...msg('Viewer','!бой бабка','1'),userId:'42'});
 arena.command({...msg('Opponent','!бой бабка','2'),userId:'43'});
 advance(1000);advance(700);advance(300);
 const before=arena.state().fighters.find(f=>f.id==='twitch:42');
 assert.ok(before.hp<before.maxHp);
 for(const text of ['!бой','!бой слесарь','!fight','!перс офис']){
  assert.equal(arena.command({platform:'TWITCH',userId:'42',user:'Renamed',text,id:text}),false);
 }
 assert.equal(arena.state().fighters.length,2,'different viewers may choose the same character');
 assert.deepEqual(arena.state().fighters.find(f=>f.id==='twitch:42'),before,'rejoining must not heal, reset or change the fighter');
});

test('levels improve max HP, strength and attack rate throughout progression',()=>{
 let previous=statsForLevel(1);
 assert.deepEqual(previous,{maxHp:100,strength:12,attackIntervalMs:1000});
 for(let rank=2;rank<=30;rank++){
  const current=statsForLevel(rank);
  assert.ok(current.maxHp>previous.maxHp && current.strength>previous.strength && current.attackIntervalMs<previous.attackIntervalMs);
  previous=current;
 }
});
test('damage has broad variance and a separate critical chance',()=>{
 const roll=(spread,crit)=>{const values=[spread,crit];return rollDamage(12,()=>values.shift());};
 assert.deepEqual(roll(0,.9),{damage:6,critical:false});
 assert.deepEqual(roll(.999,.9),{damage:19,critical:false});
 assert.deepEqual(roll(.999,.1),{damage:35,critical:true});
});
test('a kill heals 25 percent of max HP, capped, and never auto-respawns the victim',()=>{
 const {arena,advance}=setup();arena.command(msg('A'));arena.command(msg('B'));
 let death;
 for(let n=0;n<300&&!death;n++){
  const before=arena.state();advance(100);const after=arena.state();
  const hit=after.effects.find(e=>e.knockout);
  if(!hit)continue;
  const killer=after.fighters.find(f=>f.id===hit.attackerId),prior=before.fighters.find(f=>f.id===hit.attackerId);
  const hpBeforeHeal=prior.hp+(killer.maxHp-prior.maxHp);
  assert.equal(hit.heal,Math.min(killer.maxHp-hpBeforeHeal,Math.ceil(killer.maxHp*.25)));
  assert.equal(killer.hp,hpBeforeHeal+hit.heal);assert.ok(killer.hp<=killer.maxHp && hit.heal>0);
  death=hit;
 }
 assert.ok(death);advance(61000);
 assert.equal(arena.state().fighters.some(f=>f.id===death.targetId),false);
 assert.equal(arena.state().fighters.length,1);
 assert.equal(arena.command(msg(death.targetId.split(':')[1],'!бой бабка')),true);
 assert.equal(arena.state().fighters.length,2);
});
test('equal-level duels can be won by either fighter under seeded randomness',()=>{
 const winners=new Set();
 for(let seed=1;seed<=60;seed++){
  let time=100000,value=seed,spawning=true;
  const arena=createArena({autoStart:false,now:()=>time,random:()=>{if(spawning)return .5;value=(Math.imul(value,1664525)+1013904223)>>>0;return value/4294967296;}});
  arena.save({enabled:true});arena.command(msg('A','!бой бабка'));arena.command(msg('B','!бой алкоголик'));spawning=false;
  for(let n=0;n<600;n++){
   time+=100;arena.tick();const hit=arena.state().effects.find(e=>e.knockout);
   if(hit){winners.add(hit.attackerId);break;}
  }
  arena.close();
 }
 assert.deepEqual(winners,new Set(['twitch:a','twitch:b']));
});
test('level-up updates a living fighter immediately and faster levels schedule shorter windups',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arena-stats-'));const file=path.join(dir,'arena.json');
 let time=100000;
 try{
  fs.writeFileSync(file,JSON.stringify({settings:{enabled:true},profiles:{'twitch:a':{xp:29,wins:0,deaths:0,character:'granny',readyAt:0,lastCommand:0},'twitch:b':{xp:2430,wins:0,deaths:0,character:'pirate',readyAt:0,lastCommand:0}}}));
  const arena=createArena({file,autoStart:false,now:()=>time,random:()=>.5});arena.command(msg('A'));arena.command(msg('B'));
  time+=1000;arena.tick();const winding=arena.state().fighters;
  assert.ok(winding[1].next<winding[0].next,'higher level must attack sooner');
  for(let n=0;n<10;n++){time+=100;arena.tick();}
  const fighter=arena.state().fighters.find(f=>f.id==='twitch:a');assert.equal(fighter.level,2);
  const stats=statsForLevel(2);assert.equal(fighter.maxHp,stats.maxHp);assert.equal(fighter.strength,stats.strength);assert.equal(fighter.attackIntervalMs,stats.attackIntervalMs);assert.ok(fighter.hp<=fighter.maxHp);
  arena.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
