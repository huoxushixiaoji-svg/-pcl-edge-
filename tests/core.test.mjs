import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eligible, safeName, httpUrl, excluded, settle, nativeCall} from '../extension/core.mjs';

const now=1800000000000;
const item={id:1,url:'https://example.com/a.zip',finalUrl:'https://example.com/a.zip',filename:'C:\\Downloads\\a.zip',state:'in_progress',paused:false,danger:'safe',totalBytes:10485760};
const cfg={enabled:true,minMB:0,excludedHosts:''};
const good={url:item.url,method:'GET',at:now-10,sensitive:false,inspected:true,status:200};
test('a public observed GET is eligible',()=>assert.equal(eligible(item,cfg,[good],now),true));
test('POST, credentialed, unknown and failed requests stay in Edge',()=>{
  for(const change of [{method:'POST'},{sensitive:true},{inspected:false},{status:403},{status:302},{at:now-120001}])assert.equal(eligible(item,cfg,[{...good,...change}],now),false);
  assert.equal(eligible(item,cfg,[],now),false);
});
test('ambiguity between POST and GET never cancels a browser download',()=>assert.equal(eligible(item,cfg,[good,{...good,method:'POST'}],now),false));
test('browser danger, incognito, other extensions and completed downloads are skipped',()=>{
  for(const change of [{danger:'unwanted'},{danger:'file'},{incognito:true},{byExtensionId:'other'},{state:'complete'},{paused:true}])assert.equal(eligible({...item,...change},cfg,[good],now),false);
});
test('disabled mode, sizes, and domain exclusions are honored',()=>{
  assert.equal(eligible(item,{...cfg,enabled:false},[good],now),false);
  assert.equal(eligible(item,{...cfg,minMB:11},[good],now),false);
  assert.equal(eligible({...item,totalBytes:-1},{...cfg,minMB:1},[good],now),false);
  assert.equal(eligible(item,{...cfg,excludedHosts:'example.com'},[good],now),false);
  assert.equal(excluded('https://cdn.example.com/a','*.example.com'),true);
  assert.equal(excluded('https://notexample.com/a','example.com'),false);
});
test('only HTTP(S) URLs without embedded credentials pass',()=>{
  for(const url of ['file:///a','blob:https://example.com/xyz','data:a','javascript:1','https://user:pw@example.com/a'])assert.equal(httpUrl(url),false);
  assert.equal(httpUrl('https://example.com/a?x=1&y=2'),true);
});
test('file names resist paths, device names and control characters',()=>{
  assert.equal(safeName('C:\\folder\\a.zip',item.url),'a.zip');
  assert.equal(safeName('CON.zip',item.url),'_CON.zip');
  assert.equal(safeName('aux.txt',item.url),'_aux.txt');
  assert.equal(safeName('bad\n?:. ',item.url),'bad___');
  assert.equal(safeName('', 'https://example.com/%E4%B8%AD%E6%96%87.zip'),'中文.zip');
  assert.equal(safeName('', 'https://example.com/'),'download');
});
function harness(fail={}) {
  const calls=[];let stored;
  const api={downloads:{cancel:async id=>{calls.push(['cancel',id]);if(fail.cancel)throw Error('cancel');},resume:async id=>{calls.push(['resume',id]);if(fail.resume)throw Error('resume');}}};
  return {api,calls,save:async value=>{stored=value;},get stored(){return stored;}};
}
const job={key:'1',downloadId:1,filename:'a.zip'};
test('Edge is canceled only on a confirmed PCL task',async()=>{
  const h=harness();await settle(h.api,job,{status:'submitted',outputPath:'D:\\a.zip'},h.save);
  assert.deepEqual(h.calls,[['cancel',1]]);assert.equal(h.stored.state,'submitted');
});
test('a provably pre-submission failure resumes Edge',async()=>{
  const h=harness();await settle(h.api,job,{status:'failed',safeToResume:true},h.save);
  assert.deepEqual(h.calls,[['resume',1]]);assert.equal(h.stored.state,'failed');
});
test('timeout, missing receipt and post-submit failures leave the original task recoverable',async()=>{
  for(const response of [null,{status:'uncertain'},{status:'failed',safeToResume:false},{status:'garbage'}]){
    const h=harness();await settle(h.api,job,response,h.save);assert.deepEqual(h.calls,[]);assert.equal(h.stored.state,'uncertain');
  }
});
test('cancel and resume errors retain visible recovery actions',async()=>{
  const h=harness({cancel:true});await settle(h.api,job,{status:'submitted'},h.save);assert.equal(h.stored.state,'cancel_failed');
  const h2=harness({resume:true});await settle(h2.api,job,{status:'failed',safeToResume:true},h2.save);assert.equal(h2.stored.state,'resume_failed');
});
test('manual link handoff never touches browser downloads',async()=>{
  const h=harness();await settle(h.api,{key:'manual'}, {status:'submitted'},h.save);assert.deepEqual(h.calls,[]);assert.equal(h.stored.state,'submitted');
});
function fakePort(){
  const listeners={};return {listeners, onMessage:{addListener:f=>listeners.message=f},onDisconnect:{addListener:f=>listeners.disconnect=f},postMessage:m=>{listeners.sent=m;},disconnect:()=>{listeners.closed=true;}};
}
test('native messaging correlates the request and ignores unrelated replies',async()=>{
  const port=fakePort();const api={runtime:{connectNative:()=>port}};const promise=nativeCall(api,{requestId:'request'},1000);
  port.listeners.message({requestId:'different',status:'submitted'});assert.equal(port.listeners.closed,undefined);
  port.listeners.message({requestId:'request',status:'submitted'});assert.equal((await promise).status,'submitted');assert.equal(port.listeners.closed,true);
});
test('native disconnection rejects instead of claiming success',async()=>{
  const port=fakePort();const api={runtime:{connectNative:()=>port,lastError:{message:'Host not found'}}};const promise=nativeCall(api,{requestId:'request'},1000);
  port.listeners.disconnect();await assert.rejects(promise,/Host not found/);
});
test('native timeout closes the connection',async()=>{
  const port=fakePort();const promise=nativeCall({runtime:{connectNative:()=>port}},{requestId:'request'},5);
  await assert.rejects(promise,/超时/);assert.equal(port.listeners.closed,true);
});
