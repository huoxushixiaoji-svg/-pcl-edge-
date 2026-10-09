import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

function event(){const listeners=[];return {addListener:f=>listeners.push(f),emit:(...args)=>listeners.forEach(f=>f(...args))};}
async function boot(settings={}){
  const db={enabled:false,...settings},ports=[],windows=new Map(),notices=[],session={};
  const chrome={
    storage:{onChanged:event(),local:{get:async keys=>keys===null?structuredClone(db):typeof keys==='string'?{[keys]:structuredClone(db[keys])}:Object.fromEntries(Object.entries(keys).map(([k,v])=>[k,db[k]??v])),set:async values=>Object.assign(db,structuredClone(values)),remove:async keys=>keys.forEach(k=>delete db[k])},session:{get:async()=>({...session}),set:async values=>Object.assign(session,values)}},
    downloads:{onCreated:event(),onChanged:event(),search:async()=>[]},webRequest:{onBeforeRequest:event(),onBeforeSendHeaders:event(),onHeadersReceived:event()},
    action:{setBadgeText:async()=>{}},notifications:{create:async()=>{}},alarms:{create:()=>{},onAlarm:event()},contextMenus:{onClicked:event(),removeAll:async()=>{},create:()=>{}},
    windows:{get:async id=>{if(!windows.has(id))throw Error('closed');return windows.get(id);},create:async options=>{const win={id:notices.length+1,...options};notices.push(win);windows.set(win.id,win);return win;}},
    runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path,onInstalled:event(),onMessage:event(),connectNative:()=>{const port={onMessage:event(),onDisconnect:event(),disconnect:()=>{},postMessage:value=>{port.sent=value;}};ports.push(port);return port;}}
  };
  globalThis.chrome=chrome;await import('../extension/background.mjs?tasks='+Math.random());await delay(0);
  const message=value=>new Promise(resolve=>chrome.runtime.onMessage.emit(value,{id:'test'},resolve));
  async function waitFor(check){for(let i=0;i<150;i++){if(check())return;await delay(2);}throw Error('test timed out');}
  function respond(index,value){const port=ports[index];port.onMessage.emit({requestId:port.sent.requestId,status:'ready',ok:true,...value});}
  async function start(){const index=ports.length;chrome.contextMenus.onClicked.emit({menuItemId:'send-to-independent-downloader',linkUrl:'https://example.com/file.zip'});await waitFor(()=>ports.length===index+1);respond(index,{status:'submitted',jobId:ports[index].sent.jobId,outputPath:'D:\\file.zip'});const key=ports[index].sent.requestId;await waitFor(()=>db['job:'+key]?.state==='downloading');await delay(5);return key;}
  return {chrome,db,ports,windows,notices,message,waitFor,respond,start};
}

test('native progress and pause/resume/cancel confirmations persist across polling',async()=>{
  const h=await boot();const key=await h.start();
  let polling=h.message({action:'refreshJobs'});await h.waitFor(()=>h.ports.length===2);
  h.respond(1,{jobState:'downloading',downloadedBytes:1024,totalBytes:4096,bytesPerSecond:512});await polling;
  assert.equal(h.db['job:'+key].downloadedBytes,1024);assert.equal(h.db['job:'+key].bytesPerSecond,512);
  for(const [command,pending,confirmed] of [['pause','pausing','paused'],['resume','resuming','downloading'],['cancel','canceling','canceled']]){
    const index=h.ports.length;const control=h.message({action:'controlJob',key,command});
    await h.waitFor(()=>h.ports.length===index+1);assert.equal(h.ports[index].sent.action,command);
    assert.equal((await h.message({action:'controlJob',key,command})).ok,false);
    h.respond(index,{jobState:pending});assert.equal((await control).ok,true);assert.equal(h.db['job:'+key].state,pending);
    polling=h.message({action:'refreshJobs'});await h.waitFor(()=>h.ports.length===index+2);
    h.respond(index+1,{jobState:confirmed,downloadedBytes:1024,totalBytes:4096,bytesPerSecond:0});await polling;
    assert.equal(h.db['job:'+key].state,confirmed);
  }
  const count=h.ports.length;await h.message({action:'refreshJobs'});assert.equal(h.ports.length,count);
});

test('a delayed status response cannot overwrite a newer pause command',async()=>{
  const h=await boot();const key=await h.start();
  const polling=h.message({action:'refreshJobs'});await h.waitFor(()=>h.ports.length===2);
  const control=h.message({action:'controlJob',key,command:'pause'});await h.waitFor(()=>h.ports.length===3);
  h.respond(2,{jobState:'pausing'});await control;
  h.respond(1,{jobState:'downloading',downloadedBytes:99,totalBytes:100});await polling;
  assert.equal(h.db['job:'+key].state,'pausing');
});

test('an unsupported or failed command leaves the task intact',async()=>{
  const h=await boot();const key=await h.start();
  assert.equal((await h.message({action:'controlJob',key,command:'erase'})).ok,false);assert.equal(h.ports.length,1);
  const control=h.message({action:'controlJob',key,command:'pause'});await h.waitFor(()=>h.ports.length===2);
  h.respond(1,{ok:false,message:'old host'});assert.equal((await control).ok,false);assert.equal(h.db['job:'+key].state,'downloading');
});

test('start notices share one window, closing it preserves downloads, and a new task reopens it',async()=>{
  const h=await boot();const first=await h.start(),second=await h.start();
  assert.equal(h.notices.length,1);assert.equal(h.notices[0].focused,false);
  h.windows.clear();assert.equal(h.db['job:'+first].state,'downloading');assert.equal(h.db['job:'+second].state,'downloading');
  await h.start();assert.equal(h.notices.length,2);assert.equal(h.ports.filter(p=>p.sent.action==='cancel').length,0);
});

test('disabled start notices do not open a window',async()=>{
  const h=await boot({showStartNotice:false});await h.start();assert.equal(h.windows.size,0);
});

test('Edge recovery waits for native cancellation confirmation',async()=>{
  const h=await boot();let resumed=false;
  h.db['job:29']={key:'29',nativeJobId:'native-id',downloadId:29,state:'uncertain',filename:'29.zip'};
  h.chrome.downloads.resume=async()=>{resumed=true;};
  let recovery=h.message({action:'resolve',key:'29',choice:'edge'});await h.waitFor(()=>h.ports.length===1);
  h.respond(0,{jobState:'paused'});await h.waitFor(()=>h.ports.length===2);h.respond(1,{jobState:'canceling'});
  assert.equal((await recovery).ok,false);assert.equal(resumed,false);
  recovery=h.message({action:'resolve',key:'29',choice:'edge'});await h.waitFor(()=>h.ports.length===3);h.respond(2,{jobState:'canceled'});
  assert.equal((await recovery).ok,true);assert.equal(resumed,true);
});

test('recovering a manual task restores its actual paused state instead of dropping controls',async()=>{
  const h=await boot();h.db['job:manual']={key:'manual',nativeJobId:'id',state:'uncertain',filename:'manual.zip'};
  const recovery=h.message({action:'resolve',key:'manual',choice:'native'});await h.waitFor(()=>h.ports.length===1);
  h.respond(0,{jobState:'paused',downloadedBytes:1024,totalBytes:4096});
  assert.equal((await recovery).ok,true);assert.equal(h.db['job:manual'].state,'paused');
});
