import {DEFAULTS, ACTIVE, handoffDecision, downloadDecision, httpUrl, safeName, nativeCall, settle} from './core.mjs';

let settings = {...DEFAULTS};
const ready = chrome.storage.local.get(DEFAULTS).then(value => { settings = value; });
const requests = new Map();
const working = new Set();
const checking = new Set();
const recheck = new Set();
const candidates = new Map();
let chain = Promise.resolve();
const menuId = 'send-to-pcl';

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') for (const name of Object.keys(DEFAULTS)) {
    if (changes[name]) settings[name] = changes[name].newValue ?? DEFAULTS[name];
  }
});

function trimRequests() {
  const now = Date.now();
  for (const [id, item] of requests) if (now - item.at > 120000) requests.delete(id);
  while (requests.size > 512) requests.delete(requests.keys().next().value);
}
chrome.webRequest.onBeforeRequest.addListener(details => {
  trimRequests();
  const previous = requests.get(details.requestId);
  requests.set(details.requestId, {url: details.url, method: details.method, at: Date.now(), sensitive: !!previous && (previous.sensitive || previous.method !== 'GET'), inspected: false, status: 0});
}, {urls: ['http://*/*', 'https://*/*']});
chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.inspected = true;
  // Keep only a boolean; never retain or transmit Cookie/Authorization values.
  r.sensitive ||= (details.requestHeaders || []).some(h => /^(cookie|authorization|proxy-authorization)$/i.test(h.name) && (h.value || h.binaryValue?.length));
}, {urls: ['http://*/*', 'https://*/*']}, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onHeadersReceived.addListener(details => {
  const r = requests.get(details.requestId);
  if (r) {
    r.status = details.statusCode; r.at = Date.now();
    // Response metadata may arrive after downloads.onCreated.
    for (const [id, candidate] of candidates) {
      if (Date.now()-candidate.at > 120000) { candidates.delete(id); continue; }
      if (candidate.url === details.url || candidate.finalUrl === details.url) inspect({id});
    }
  }
}, {urls: ['http://*/*', 'https://*/*']});

async function save(job) {
  job = {...job, updatedAt: Date.now()};
  await chrome.storage.local.set({['job:' + job.key]: job});
  await chrome.action.setBadgeText({text: ['uncertain','cancel_failed','resume_failed'].includes(job.state) ? '!' : ''});
  if (['failed','uncertain','cancel_failed','resume_failed'].includes(job.state)) {
    await chrome.notifications.create('pcl:' + job.key, {type: 'basic', iconUrl: 'icons/icon128.png', title: 'PCL 下载助手', message: job.message}).catch(() => {});
  }
}
async function cleanup() {
  const data = await chrome.storage.local.get(null);
  const jobs = Object.entries(data).filter(([k,v]) => k.startsWith('job:') && !ACTIVE.has(v.state)).sort((a,b) => b[1].updatedAt-a[1].updatedAt);
  if (jobs.length > 30) await chrome.storage.local.remove(jobs.slice(30).map(([k]) => k));
}
async function run(job) {
  const latest = (await chrome.storage.local.get('job:' + job.key))['job:' + job.key];
  if (!latest || latest.state !== 'queued') return;
  // Respect a user who has resumed or canceled Edge while waiting in the queue.
  if (job.downloadId != null) {
    const [item] = await chrome.downloads.search({id: job.downloadId});
    if (!item || item.state !== 'in_progress' || !item.paused) {
      await save({...job, state:'skipped', message:'Edge 任务已改变，取消本次交接。'}); return;
    }
  }
  await save({...job, state:'sending', message:'正在打开 PCL 百宝箱……'});
  let response;
  try {
    response = await nativeCall(chrome, {action:'download', requestId:job.key, url:job.url, filename:job.filename});
  } catch (e) {
    response = {status:'uncertain', message:'本机连接失败：' + e.message + ' 请检查 PCL，再选择如何处理原任务。'};
  }
  await settle(chrome, job, response, save);
  await cleanup();
}
function enqueue(job) {
  chain = chain.then(() => run(job)).catch(async error => {
    await save({...job, state:'uncertain', message:'交接中断：' + error.message + '。请检查 PCL 和 Edge 下载列表。'});
  }).finally(() => working.delete(job.key));
}

async function recordDecision(item, decision) {
  if (item.incognito) return;
  const previous = (await chrome.storage.local.get('lastDecision')).lastDecision;
  if (previous?.downloadId === item.id && previous.code === decision.code) return;
  // No request headers or URL tokens are persisted for skipped downloads.
  await chrome.storage.local.set({lastDecision:{downloadId:item.id, filename:safeName(item.filename,item.finalUrl || item.url), code:decision.code, message:decision.message, at:Date.now()}});
}

async function accept(snapshot, {manual=false}={}) {
  const itemId = snapshot.id;
  const key = String(itemId);
  if (checking.has(key)) {
    if (!manual) recheck.add(itemId);
    return {ok:false,message:'正在检查此下载，请稍后重试。'};
  }
  checking.add(key);
  try {
    await ready; await recovered;
    if (working.has(key)) return {ok:false,message:'此下载正在交接，请稍候。'};
    // Always use the browser's latest final URL, state and filename.
    const [item] = await chrome.downloads.search({id:itemId});
    if (!item) return {ok:false,message:'Edge 下载记录已不存在。'};
    if (candidates.has(itemId)) candidates.set(itemId,{...candidates.get(itemId),url:item.url,finalUrl:item.finalUrl});
    const old = (await chrome.storage.local.get('job:' + key))['job:' + key];
    if (old) return {ok:false,message:'此下载已有交接记录，请先检查最近任务中的处理结果。'};
    const decision = manual ? downloadDecision(item) : handoffDecision(item,settings,[...requests.values()]);
    await recordDecision(item,decision);
    if (!decision.eligible) return {ok:false,message:decision.message};
    working.add(key);
    let job = {key, downloadId:item.id, url:item.finalUrl || item.url, filename:safeName(item.filename,item.finalUrl || item.url), manual, state:'preparing', message:'准备交接……'};
    // Persist before pause so a worker restart never loses the recovery entry.
    await save(job);
    try { await chrome.downloads.pause(item.id); }
    catch {
      await save({...job,state:'skipped',message:'此下载已结束或无法暂停，保留在 Edge。'}); working.delete(key); return {ok:false,message:'此下载已结束或无法暂停，保留在 Edge。'};
    }
    const [current] = await chrome.downloads.search({id:item.id});
    if (!current || current.state !== 'in_progress' || !current.paused) {
      await save({...job,state:'skipped',message:'Edge 任务已改变，取消交接。'}); working.delete(key); return {ok:false,message:'Edge 任务已改变，取消交接。'};
    }
    // A redirect or browser decision may change while pause() is pending.
    const afterPause = manual ? downloadDecision({...current,paused:false}) : handoffDecision({...current,paused:false},settings,[...requests.values()]);
    if (!afterPause.eligible || (manual && (current.finalUrl || current.url) !== job.url)) {
      const message = afterPause.eligible ? '下载链接在准备期间发生变化，请重新检查后再发送。' : afterPause.message;
      await settle(chrome,job,{status:'failed',safeToResume:true,message},save);
      working.delete(key); return {ok:false,message};
    }
    job = {...job, url:current.finalUrl || current.url, filename:safeName(current.filename || item.filename,current.finalUrl || current.url), state:'queued',message:'等待交给 PCL……'};
    await save(job); enqueue(job);
    return {ok:true,message:'已读取 Edge 最终下载链接，正在交给 PCL。'};
  } catch (error) {
    working.delete(key);
    const job = (await chrome.storage.local.get('job:' + key))['job:' + key];
    if (job && ['preparing','queued'].includes(job.state)) {
      await save({...job,state:'uncertain',message:'交接准备中断。请检查 Edge 下载列表；如仍暂停，可在此恢复。'});
    }
    throw error;
  } finally {
    checking.delete(key);
    if (recheck.delete(itemId) && candidates.has(itemId)) inspect({id:itemId});
  }
}
function inspect(item) { accept(item).catch(e => {
  console.warn('PCL handoff failed', e.message);
}); }
chrome.downloads.onCreated.addListener(item => {
  const now = Date.now();
  for (const [id,candidate] of candidates) if (now-candidate.at > 120000) candidates.delete(id);
  while (candidates.size >= 128) candidates.delete(candidates.keys().next().value);
  candidates.set(item.id,{at:now,url:item.url,finalUrl:item.finalUrl});
  inspect(item);
});
chrome.downloads.onChanged.addListener(delta => {
  const candidate = candidates.get(delta.id);
  if (!candidate) return;
  if (Date.now()-candidate.at > 120000) { candidates.delete(delta.id); return; }
  // A filename, redirect, size, state or danger update can make a task eligible.
  if (['filename','finalUrl','url','totalBytes','state','danger'].some(name => name in delta)) inspect({id:delta.id});
});

chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId !== menuId || !httpUrl(info.linkUrl)) return;
  const key = 'manual-' + crypto.randomUUID();
  const job = {key, url:info.linkUrl, filename:safeName('',info.linkUrl), state:'queued',message:'等待交给 PCL……'};
  working.add(key); save(job).then(() => enqueue(job));
});
chrome.runtime.onInstalled.addListener(async () => {
  await ready;
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({id:menuId,title:'使用 PCL 下载此直链',contexts:['link'],targetUrlPatterns:['http://*/*','https://*/*']});
});

// Service-worker/browser recovery never replays a potentially submitted task.
async function recover() {
  const data = await chrome.storage.local.get(null);
  for (const [key, job] of Object.entries(data)) {
    if (key.startsWith('job:') && ['preparing','queued','sending'].includes(job.state) && !working.has(job.key)) {
      await save({...job,state:'uncertain',message:'浏览器或扩展曾重启，请检查 PCL 后恢复 Edge 或保留 PCL。'});
    }
  }
}
const recovered = recover();

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    await ready; await recovered;
    if (message.action === 'sendDownload') {
      if (!Number.isSafeInteger(message.downloadId) || message.downloadId < 0 || message.confirmed !== true) throw new Error('请先确认发送此下载链接。');
      return await accept({id:message.downloadId},{manual:true});
    }
    if (message.action === 'test') {
      // Serialize all native UI operations with actual downloads.
      const task = chain.then(() => nativeCall(chrome,{action:'test',requestId:crypto.randomUUID()}));
      chain = task.catch(() => {});
      return await task;
    }
    if (message.action === 'resolve') {
      const key = 'job:' + String(message.key);
      const job = (await chrome.storage.local.get(key))[key];
      if (!job || !['uncertain','cancel_failed','resume_failed'].includes(job.state)) throw new Error('任务仍在处理中，请稍候。');
      if (job.downloadId != null) {
        if (message.choice === 'edge') await chrome.downloads.resume(job.downloadId);
        else if (message.choice === 'pcl') await chrome.downloads.cancel(job.downloadId);
        else throw new Error('无效选择');
      }
      await save({...job,state:'resolved',message:message.choice === 'edge' ? '已恢复 Edge，请确保 PCL 中没有重复任务。' : '已保留 PCL；原 Edge 任务已取消。'});
      return {ok:true};
    }
    throw new Error('不支持的操作');
  })().then(reply, e => reply({ok:false,message:e.message}));
  return true;
});
