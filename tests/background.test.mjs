import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

function event(){const callbacks=[];return {addListener:f=>callbacks.push(f),emit:(...args)=>callbacks.forEach(f=>f(...args))};}
async function boot(initial={}) {
  const db={enabled:true,minMB:0,excludedHosts:'',...initial};const downloads=new Map();const calls=[];const ports=[];
  const chrome={
    storage:{onChanged:event(),local:{
      get:async keys=>keys===null?structuredClone(db):typeof keys==='string'?{[keys]:structuredClone(db[keys])}:Object.fromEntries(Object.entries(keys).map(([k,v])=>[k,db[k]??v])),
      set:async values=>{Object.assign(db,structuredClone(values));},remove:async keys=>keys.forEach(k=>delete db[k])}},
    downloads:{onCreated:event(),onChanged:event(),pause:async id=>{calls.push(['pause',id]);downloads.get(id).paused=true;},resume:async id=>{calls.push(['resume',id]);downloads.get(id).paused=false;},cancel:async id=>{calls.push(['cancel',id]);downloads.get(id).state='interrupted';},search:async ({id})=>downloads.has(id)?[structuredClone(downloads.get(id))]:[]},
    webRequest:{onBeforeRequest:event(),onBeforeSendHeaders:event(),onHeadersReceived:event()},
    action:{setBadgeText:async()=>{}},notifications:{create:async()=>{}},alarms:{create:()=>{},onAlarm:event()},
    contextMenus:{onClicked:event(),removeAll:async()=>{},create:()=>{}},
    runtime:{id:'test-extension',onInstalled:event(),onMessage:event(),connectNative:()=>{
      const port={onMessage:event(),onDisconnect:event(),disconnect:()=>{},postMessage:message=>{port.sent=message;calls.push(['send',message.requestId]);if(message.action==='cancel')queueMicrotask(()=>port.onMessage.emit({requestId:message.requestId,status:'ready'}));}};
      ports.push(port);return port;
    }}
  };
  globalThis.chrome=chrome;
  await import('../extension/background.mjs?test='+Math.random());
  await delay(0);
  function request(id,{method='GET',headers=[],url='https://example.com/'+id+'.zip'}={}){
    chrome.webRequest.onBeforeRequest.emit({requestId:String(id),url,method});
    chrome.webRequest.onBeforeSendHeaders.emit({requestId:String(id),requestHeaders:headers});
    chrome.webRequest.onHeadersReceived.emit({requestId:String(id),url,statusCode:200});return url;
  }
  function download(id,url,overrides={}){
    const item={id,url,finalUrl:url,filename:`C:\\Downloads\\${id}.zip`,state:'in_progress',paused:false,danger:'safe',totalBytes:10000,...overrides};
    downloads.set(id,item);chrome.downloads.onCreated.emit(structuredClone(item));
  }
  async function waitFor(predicate){for(let i=0;i<100;i++){if(predicate())return;await delay(2);}throw Error('Timed out waiting for test condition');}
  function message(value){return new Promise(resolve=>chrome.runtime.onMessage.emit(value,{id:chrome.runtime.id},resolve));}
  function submitted(index=0){ports[index].onMessage.emit({requestId:ports[index].sent.requestId,status:'submitted',jobId:ports[index].sent.jobId,outputPath:'D:\\file.zip'});}
  return {chrome,db,downloads,calls,ports,request,download,waitFor,message,submitted};
}
test('two downloads are handed to the native downloader strictly one at a time',async()=>{
  const h=await boot();h.download(1,h.request(1));h.download(2,h.request(2));
  await h.waitFor(()=>h.ports.length===1 && h.db['job:2']?.state==='queued');
  assert.equal(h.downloads.get(1).paused,true);assert.equal(h.downloads.get(2).paused,true);
  assert.equal(h.calls.some(x=>x[0]==='cancel'),false);
  h.ports[0].onMessage.emit({requestId:'1',status:'submitted',outputPath:'D:\\1.zip'});
  await h.waitFor(()=>h.ports.length===2);
  assert.equal(h.db['job:1'].state,'downloading');assert.equal(h.downloads.get(1).state,'interrupted');
  h.ports[1].onMessage.emit({requestId:'2',status:'failed',safeToResume:true,message:'native host failed'});
  await h.waitFor(()=>h.db['job:2'].state==='failed');assert.equal(h.downloads.get(2).paused,false);
});
test('redirecting a POST to a GET remains excluded',async()=>{
  const h=await boot();h.request(3,{method:'POST',url:'https://example.com/form'});
  const url=h.request(3,{method:'GET',url:'https://example.com/export.zip'});h.download(3,url);
  await delay(20);assert.deepEqual(h.calls,[]);assert.equal(h.db['job:3'],undefined);
});
test('a cookie-bearing request stays with Edge',async()=>{
  const h=await boot();h.download(4,h.request(4,{headers:[{name:'Cookie',value:'session=secret'}]}));
  await delay(20);assert.deepEqual(h.calls,[]);assert.equal(JSON.stringify(h.db).includes('secret'),false);
});
test('a restarted worker never replays an in-flight native task',async()=>{
  const h=await boot({'job:5':{key:'5',downloadId:5,state:'sending',filename:'5.zip',url:'https://example.com/5.zip'}});
  assert.equal(h.db['job:5'].state,'uncertain');assert.equal(h.ports.length,0);assert.deepEqual(h.calls,[]);
});
test('disconnect after send preserves a recovery entry and does not cancel Edge',async()=>{
  const h=await boot();h.download(6,h.request(6));await h.waitFor(()=>h.ports.length===1);
  h.ports[0].onDisconnect.emit();await h.waitFor(()=>h.db['job:6'].state==='uncertain');
  assert.equal(h.downloads.get(6).paused,true);assert.equal(h.calls.some(x=>x[0]==='cancel'||x[0]==='resume'),false);
});

test('response metadata arriving after onCreated retries automatic handoff',async()=>{
  const h=await boot();const url='https://example.com/late.zip';
  h.chrome.webRequest.onBeforeRequest.emit({requestId:'late',url,method:'GET'});
  h.chrome.webRequest.onBeforeSendHeaders.emit({requestId:'late',requestHeaders:[]});
  h.download(7,url);await h.waitFor(()=>h.db.lastDecision?.code==='response');
  assert.equal(h.ports.length,0);
  h.chrome.webRequest.onHeadersReceived.emit({requestId:'late',url,statusCode:200});
  await h.waitFor(()=>h.ports.length===1);assert.equal(h.ports[0].sent.url,url);
  h.submitted();await h.waitFor(()=>h.db['job:7'].state==='downloading');
});

test('a changed finalUrl uses the actual redirected file URL',async()=>{
  const h=await boot();const original='https://example.com/start';const final=h.request(8);
  h.download(8,original);await h.waitFor(()=>h.db.lastDecision?.code==='unobserved');
  h.downloads.get(8).finalUrl=final;
  h.chrome.downloads.onChanged.emit({id:8,finalUrl:{previous:original,current:final}});
  await h.waitFor(()=>h.ports.length===1);assert.equal(h.ports[0].sent.url,final);
  h.submitted();await h.waitFor(()=>h.db['job:8'].state==='downloading');
});

test('unknown file size is rechecked when it meets the configured threshold',async()=>{
  const h=await boot({minMB:1});h.download(9,h.request(9),{totalBytes:-1});
  await h.waitFor(()=>h.db.lastDecision?.code==='size');
  h.downloads.get(9).totalBytes=2*1024*1024;
  h.chrome.downloads.onChanged.emit({id:9,totalBytes:{previous:-1,current:2*1024*1024}});
  await h.waitFor(()=>h.ports.length===1);h.submitted();await h.waitFor(()=>h.db['job:9'].state==='downloading');
});

test('overlapping download events produce only one pause and one native task',async()=>{
  const h=await boot();h.download(10,h.request(10));
  for(let i=0;i<5;i++)h.chrome.downloads.onChanged.emit({id:10,filename:{current:'a.zip'}});
  await h.waitFor(()=>h.ports.length===1);await delay(10);
  assert.equal(h.calls.filter(c=>c[0]==='pause').length,1);
  assert.equal(h.calls.filter(c=>c[0]==='send').length,1);
  h.submitted();await h.waitFor(()=>h.db['job:10'].state==='downloading');
});

test('unobserved download URLs have a diagnostic without pausing or persisting the URL',async()=>{
  const h=await boot();h.download(11,'https://example.com/file?token=download-token');
  await h.waitFor(()=>h.db.lastDecision?.code==='unobserved');
  assert.deepEqual(h.calls,[]);assert.equal(h.db['job:11'],undefined);
  assert.equal(JSON.stringify(h.db).includes('download-token'),false);
});

test('explicit manual handoff can use an unobserved final URL with automatic mode off',async()=>{
  const h=await boot({enabled:false});const url='https://example.com/public.zip';h.download(12,url);
  await h.waitFor(()=>h.db.lastDecision?.code==='disabled');
  const rejected=await h.message({action:'sendDownload',downloadId:12});assert.equal(rejected.ok,false);
  assert.equal(h.calls.length,0);
  const result=await h.message({action:'sendDownload',downloadId:12,confirmed:true});assert.equal(result.ok,true);
  await h.waitFor(()=>h.ports.length===1);assert.equal(h.ports[0].sent.url,url);
  assert.equal(h.calls.some(c=>c[0]==='cancel'),false);
  h.submitted();await h.waitFor(()=>h.db['job:12'].state==='downloading');
});

test('manual handoff rejects completed, dangerous and blob downloads',async()=>{
  const h=await boot();
  for(const [id,url,change] of [[13,'https://example.com/a',{state:'complete'}],[14,'https://example.com/b',{danger:'unwanted'}],[15,'blob:https://example.com/file',{}]]){
    h.download(id,url,change);await h.waitFor(()=>h.db.lastDecision?.downloadId===id);
    const result=await h.message({action:'sendDownload',downloadId:id,confirmed:true});assert.equal(result.ok,false);
  }
  assert.deepEqual(h.calls,[]);
});

test('a credentialed redirect during pause resumes Edge without sending the URL to the native downloader',async()=>{
  const h=await boot();const original=h.request(16);const credentialed=h.request(17,{headers:[{name:'Cookie',value:'login-value'}]});
  h.chrome.downloads.pause=async id=>{h.calls.push(['pause',id]);Object.assign(h.downloads.get(id),{paused:true,finalUrl:credentialed});};
  h.download(16,original);
  await h.waitFor(()=>h.db['job:16']?.state==='failed');
  assert.equal(h.ports.length,0);assert.equal(h.downloads.get(16).paused,false);
  assert.equal(h.calls.some(c=>c[0]==='resume'),true);
  assert.equal(JSON.stringify(h.db).includes('login-value'),false);
});

test('old downloads are not automatically replayed on unrelated onChanged events',async()=>{
  const h=await boot();const url=h.request(18);
  h.downloads.set(18,{id:18,url,finalUrl:url,filename:'old.zip',state:'in_progress',paused:false,danger:'safe',totalBytes:10000});
  h.chrome.downloads.onChanged.emit({id:18,totalBytes:{current:10000}});
  await delay(10);assert.deepEqual(h.calls,[]);
});

test('a preparation exception during manual handoff retains recovery and releases the lock',async()=>{
  const h=await boot({enabled:false});h.download(19,'https://example.com/public.zip');
  await h.waitFor(()=>h.db.lastDecision?.code==='disabled');
  const search=h.chrome.downloads.search;let paused=false;
  h.chrome.downloads.pause=async id=>{h.calls.push(['pause',id]);h.downloads.get(id).paused=true;paused=true;};
  h.chrome.downloads.search=async query=>{if(paused)throw Error('simulated search failure');return search(query);};
  const result=await h.message({action:'sendDownload',downloadId:19,confirmed:true});
  assert.equal(result.ok,false);assert.equal(h.db['job:19'].state,'uncertain');assert.equal(h.ports.length,0);
  h.chrome.downloads.search=search;
  const retry=await h.message({action:'sendDownload',downloadId:19,confirmed:true});
  assert.match(retry.message,/已有交接记录/);
  const resolved=await h.message({action:'resolve',key:'19',choice:'edge'});
  assert.equal(resolved.ok,true);assert.equal(h.downloads.get(19).paused,false);
});

test('binary Cookie headers remain in Edge without storing header bytes',async()=>{
  const h=await boot();h.download(20,h.request(20,{headers:[{name:'Cookie',binaryValue:[115,101,99,114,101,116]}]}));
  await h.waitFor(()=>h.db.lastDecision?.code==='credentials');
  assert.deepEqual(h.calls,[]);assert.equal(JSON.stringify(h.db).includes('binaryValue'),false);
});

test('native task completion is reflected by status polling',async()=>{
  const h=await boot();h.download(21,h.request(21));await h.waitFor(()=>h.ports.length===1);
  h.submitted();await h.waitFor(()=>h.db['job:21'].state==='downloading');
  h.chrome.alarms.onAlarm.emit({name:'refresh-native-downloads'});
  await h.waitFor(()=>h.ports.length===2);
  assert.equal(h.ports[1].sent.action,'status');
  h.ports[1].onMessage.emit({requestId:h.ports[1].sent.requestId,status:'ready',jobState:'completed',outputPath:'D:\\21.zip'});
  await h.waitFor(()=>h.db['job:21'].state==='completed');
  assert.equal(h.db['job:21'].outputPath,'D:\\21.zip');
});
