import {DEFAULTS, downloadDecision, httpUrl, safeName} from './core.mjs';
const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
$('extid').textContent = chrome.runtime.id;
let renderVersion=0;
async function render() {
  const version=++renderVersion;
  const [all,downloads] = await Promise.all([
    chrome.storage.local.get(null),
    chrome.downloads.search({limit:5,orderBy:['-startTime']})
  ]);
  if (version!==renderVersion) return;
  const cfg = {...DEFAULTS,...all};
  if (document.activeElement === document.body) {
    $('enabled').checked=cfg.enabled; $('minMB').value=cfg.minMB; $('excludedHosts').value=cfg.excludedHosts;
  }
  $('jobs').replaceChildren();
  const jobs = Object.entries(all).filter(([k])=>k.startsWith('job:')).map(([,v])=>v).sort((a,b)=>b.updatedAt-a.updatedAt);
  const unresolved = jobs.filter(j=>['uncertain','cancel_failed','resume_failed'].includes(j.state));
  const shown = [...unresolved,...jobs.filter(j=>!unresolved.includes(j)).slice(0,6)];
  if (!shown.length) $('jobs').textContent='还没有接管过下载。';
  for (const job of shown) {
    const card=document.createElement('div'); card.className='job';
    const title=document.createElement('strong');title.textContent=job.filename;card.append(title);
    const desc=document.createElement('p');desc.textContent=job.message;card.append(desc);
    if(job.outputPath){const path=document.createElement('p');path.className='path';path.textContent=job.outputPath;card.append(path);}
    if(unresolved.includes(job)) {
      card.classList.add('warn');const buttons=document.createElement('div');buttons.className='buttons';
      for(const [choice,label] of [['edge','恢复 Edge'],['native','保留独立下载']]){
        const btn=document.createElement('button');btn.textContent=label;
        btn.onclick=async()=>{
          btn.disabled=true;
          try { const result=await chrome.runtime.sendMessage({action:'resolve',key:job.key,choice});status(result.ok?'已处理。':result.message); }
          catch(e){status(e.message);}finally{btn.disabled=false;await render();}
        };buttons.append(btn);
      }card.append(buttons);
    }$('jobs').append(card);
  }
  $('decision').textContent=all.lastDecision ? all.lastDecision.filename+'：'+all.lastDecision.message : '点击下载后，可在这里查看最终链接与未接管原因。';
  $('downloads').replaceChildren();
  const recent=downloads.filter(item=>!item.incognito);
  if(!recent.length) $('downloads').textContent='Edge 暂无下载记录。';
  for(const item of recent){
    const url=item.finalUrl || item.url;
    const card=document.createElement('div');card.className='job';
    const title=document.createElement('strong');title.textContent=safeName(item.filename,url);card.append(title);
    const desc=document.createElement('p');
    const job=all['job:'+item.id];
    desc.textContent=job ? job.message : all.lastDecision?.downloadId===item.id ? all.lastDecision.message : downloadDecision(item).message;
    card.append(desc);
    const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='查看最终下载链接';details.append(summary);
    const link=document.createElement('textarea');link.readOnly=true;link.rows=2;link.value=url || '';link.setAttribute('aria-label','最终下载链接');details.append(link);card.append(details);
    const buttons=document.createElement('div');buttons.className='buttons';
    const copy=document.createElement('button');copy.textContent='复制链接';copy.disabled=!url;
    copy.onclick=async()=>{
      try { await navigator.clipboard.writeText(url);status('已复制 Edge 的最终下载链接。'); }
      catch { details.open=true;link.focus();link.select();status('请按 Ctrl+C 复制选中的下载链接。'); }
    };buttons.append(copy);
    const send=document.createElement('button');send.textContent='尝试独立下载';send.disabled=!!job || !downloadDecision(item).eligible || !httpUrl(url);
    send.onclick=async()=>{
      if(!confirm('独立下载器只接收链接，不携带 Edge 的 Cookie、登录信息或表单内容。请确认这是无需登录的公开直链。是否暂停 Edge 下载并交给独立下载器？'))return;
      send.disabled=true;
      try { const result=await chrome.runtime.sendMessage({action:'sendDownload',downloadId:item.id,confirmed:true});status(result.message || '正在交给独立下载器。'); }
      catch(e){status(e.message);}finally{await render();}
    };buttons.append(send);card.append(buttons);$('downloads').append(card);
  }
}
$('test').onclick=async()=>{
  $('test').disabled=true;status('正在检查本机独立下载器……');
  try {
    const r=await chrome.runtime.sendMessage({action:'test'});
    if(r.ok && r.downloadFolder){
      await chrome.storage.local.set({enabled:true});$('enabled').checked=true;
      status('检测通过，已启用自动接管。保存到：'+r.downloadFolder+'；最多 '+r.connections+' 个分段。');
    }
    else if(r.ok){
      await chrome.storage.local.set({enabled:false});$('enabled').checked=false;
      status('连接程序版本不匹配，请运行新安装包里的 Update.cmd。');
    }
    else status(r.message||'检测失败，请检查本机连接程序。');
  }catch(e){status(e.message);}finally{$('test').disabled=false;}
};
$('enabled').onchange=async()=>{await chrome.storage.local.set({enabled:$('enabled').checked});status($('enabled').checked?'已开启自动接管。':'已关闭自动接管。');};
$('save').onclick=async()=>{
  const minMB=Number($('minMB').value);
  if(!Number.isFinite(minMB)||minMB<0||minMB>100000){status('请填写有效的文件大小。');return;}
  await chrome.storage.local.set({minMB,excludedHosts:$('excludedHosts').value.trim()});status('设置已保存。');
};
$('refresh').onclick=()=>render().catch(e=>status(e.message));
chrome.storage.onChanged.addListener(render);
await render();
