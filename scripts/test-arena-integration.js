// Isolated full-runtime test: never connects to the user's app or settings.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const net=require('node:net');
(async()=>{
 const storage=fs.mkdtempSync(path.join(os.tmpdir(),'tchat-arena-'));
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 Object.assign(process.env,{TCHAT_USER_DATA:storage,TCHAT_PORT:String(port),TCHAT_HOST:'127.0.0.1'});
 require('./serve-full');const url=`http://127.0.0.1:${port}`;
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(url+'/arena/state')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
 const invoke=(channel,arg)=>global.__tchatShim.ipcHandlers.get(channel)({},arg);
 await invoke('arena:save',{enabled:true});
 for(const user of ['First','Second']){const r=await fetch(url+'/demo/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({platform:'twitch',user,text:'!бой слесарь'})});assert.ok(r.ok);}
 const state=await (await fetch(url+'/arena/state')).json();assert.equal(state.fighters.length,2);assert.ok(state.fighters.every(f=>f.character==='mechanic'));
 await invoke('arena:save',{paused:true});const frozen=await(await fetch(url+'/arena/state')).json();await new Promise(r=>setTimeout(r,250));assert.deepEqual((await(await fetch(url+'/arena/state')).json()).fighters,frozen.fighters);
 assert.ok((await(await fetch(url+'/widgets/stream.html')).text()).includes('./arena.js'));
 assert.ok((await(await fetch(url+'/headless/tchat-web-shim.js')).text()).includes('getArenaState'));
 await invoke('arena:clear');assert.equal((await invoke('arena:state')).fighters.length,0);
 await invoke('arena:save',{enabled:false});assert.ok(fs.existsSync(path.join(storage,'settings/arena.json')));
 console.log('PASS arena integration: real chat route, IPC controls, shared overlay, web bridge, persistence');
 if(process.env.ARENA_SMOKE){const Module=require('node:module'),filename=path.join(__dirname,'smoke-test.js');process.env.TCHAT_URL=url;const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(__dirname);const source=fs.readFileSync(filename,'utf8');m._compile(source.slice(0,source.lastIndexOf('run().catch'))+'module.exports=run;',filename);await m.exports();}
 fs.rmSync(storage,{recursive:true,force:true});process.exit(process.exitCode||0);
})().catch(e=>{console.error(e);process.exit(1);});
