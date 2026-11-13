const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createArena,level}=require('../src/arena');
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
