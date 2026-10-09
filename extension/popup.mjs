import {DEFAULTS, ACTIVE, downloadDecision, httpUrl, safeName} from './core.mjs';
import {RUNNING, RECOVERY, TERMINAL, taskControls, progress} from './tasks.mjs';
const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; $('status').hidden = !text; };
const notice = new URL(location.href).searchParams.has('notice');
const pending = new Set();
let page = 'downloads', renderVersion = 0, pollPending = false, historySignature = '';
$('extid').textContent = chrome.runtime.id;
$('version').textContent = chrome.runtime.getManifest().version;
$('close').hidden = !notice;
$('close').onclick = () => window.close();
document.body.classList.toggle('notice', notice);

async function navigate(next) {
  page = next;
  for (const name of ['downloads','settings','history']) $('page-' + name).hidden = name !== page;
  $('heading').textContent = {downloads:'下载',settings:'设置',history:'下载历史'}[page];
  $('back').hidden = page === 'downloads';
  $('menu').hidden = true; $('menu-toggle').setAttribute('aria-expanded','false');
  status('');
  if (page === 'history') { historySignature = ''; await renderHistory(); }
  await render();
}
for (const button of document.querySelectorAll('[data-page]')) button.onclick = () => navigate(button.dataset.page).catch(e => status(e.message));
$('back').onclick = () => navigate('downloads').catch(e => status(e.message));
$('menu-toggle').onclick = () => {
  $('menu').hidden = !$('menu').hidden;
  $('menu-toggle').setAttribute('aria-expanded',String(!$('menu').hidden));
};
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('menu').hidden = true; $('menu-toggle').setAttribute('aria-expanded','false'); } });
document.addEventListener('click', event => {
  if (!event.target.closest('#menu, #menu-toggle')) { $('menu').hidden = true; $('menu-toggle').setAttribute('aria-expanded','false'); }
});

function element(tag, text, className) {
  const item = document.createElement(tag); if (text != null) item.textContent = text;
  if (className) item.className = className; return item;
}
function jobCard(job) {
  const card = element('article',null,'job' + (RECOVERY.has(job.state) ? ' warn' : ''));
  card.dataset.job = job.key;
  card.append(element('strong',job.filename), element('p',job.message));
  if (RUNNING.has(job.state) || job.state === 'completed') {
    const info = progress(job), bar = element('progress'); bar.max = 100;
    if (info.percent != null) bar.value = info.percent;
    bar.setAttribute('aria-label',job.filename + ' 下载进度');
    card.append(bar, element('p',info.label,'progress-label'));
  }
  if (job.outputPath) card.append(element('p',job.outputPath,'path'));
  const actions = RECOVERY.has(job.state) ? (job.downloadId != null ? [['edge','恢复 Edge'],['native','保留独立下载']] : [['native','检查独立任务']]) : taskControls(job);
  if (actions.length) {
    const buttons = element('div',null,'buttons');
    for (const [command,label] of actions) {
      const button = element('button',label); button.dataset.command = command; button.disabled = pending.has(job.key);
      button.onclick = async () => {
        if (pending.has(job.key)) return;
        pending.add(job.key); for (const b of buttons.children) b.disabled = true;
        try {
          const result = await chrome.runtime.sendMessage(RECOVERY.has(job.state) ? {action:'resolve',key:job.key,choice:command} : {action:'controlJob',key:job.key,command});
          status(result.ok ? '' : result.message || '操作失败，请稍后重试。');
        } catch(e) { status(e.message); }
        finally { pending.delete(job.key); await render(); void poll(); }
      }; buttons.append(button);
    } card.append(buttons);
  }
  return card;
}
async function render() {
  const version = ++renderVersion;
  const all = await chrome.storage.local.get(null);
  if (version !== renderVersion) return;
  const jobs = Object.entries(all).filter(([key]) => key.startsWith('job:')).map(([,value]) => value).sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const active = jobs.filter(job => ACTIVE.has(job.state));
  const shown = notice ? [...active,...jobs.filter(job => TERMINAL.has(job.state) && Date.now() - job.updatedAt < 600000).slice(0,3)] : active;
  const focused = document.activeElement?.closest('[data-job]');
  const focusKey = focused?.dataset.job, focusCommand = document.activeElement?.dataset.command;
  $('jobs').replaceChildren(...shown.map(jobCard));
  if (!shown.length) $('jobs').append(element('p','暂无正在下载的任务。点击右上角菜单查看历史或设置。','empty'));
  if (focusKey && focusCommand) for (const card of $('jobs').children) {
    if (card.dataset.job === focusKey) for (const button of card.querySelectorAll('button')) if (button.dataset.command === focusCommand) button.focus({preventScroll:true});
  }
  $('task-count').textContent = active.length ? '当前任务 · ' + active.length : '当前任务';
  $('empty-setup').hidden = active.length > 0 || all.enabled === true;
  $('subtitle').textContent = all.enabled ? '自动接管已开启' : '自动接管未开启';
  // Progress events must not replace an expanded URL or interrupt settings edits.
  const signature = JSON.stringify(jobs.filter(job => !ACTIVE.has(job.state)));
  if (signature !== historySignature) {
    historySignature = signature;
    const history = jobs.filter(job => !ACTIVE.has(job.state));
    $('history').replaceChildren(...history.map(jobCard));
    if (!history.length) $('history').append(element('p','还没有已结束的独立下载。','empty'));
  }
}

async function renderHistory() {
  const [all,downloads] = await Promise.all([chrome.storage.local.get(null),chrome.downloads.search({limit:10,orderBy:['-startTime']})]);
  $('decision').textContent = all.lastDecision ? all.lastDecision.filename + '：' + all.lastDecision.message : '可查看 Edge 最终下载链接及未接管原因。';
  $('downloads').replaceChildren();
  const recent = downloads.filter(item => !item.incognito);
  if (!recent.length) $('downloads').append(element('p','Edge 暂无下载记录。','empty'));
  for (const item of recent) {
    const url = item.finalUrl || item.url, job = all['job:' + item.id];
    const card = element('article',null,'job');
    card.append(element('strong',safeName(item.filename,url)),element('p',job ? job.message : all.lastDecision?.downloadId === item.id ? all.lastDecision.message : downloadDecision(item).message));
    const details = element('details'); details.append(element('summary','查看最终下载链接'));
    const link = element('textarea'); link.readOnly = true; link.rows = 2; link.value = url || ''; link.setAttribute('aria-label','最终下载链接'); details.append(link); card.append(details);
    const buttons = element('div',null,'buttons');
    const copy = element('button','复制链接'); copy.disabled = !url;
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(url); status('已复制 Edge 的最终下载链接。'); }
      catch { details.open = true; link.focus(); link.select(); status('请按 Ctrl+C 复制选中的下载链接。'); }
    }; buttons.append(copy);
    const send = element('button','尝试独立下载'); send.disabled = !!job || !downloadDecision(item).eligible || !httpUrl(url);
    send.onclick = async () => {
      if (!confirm('请确认这是无需登录的公开直链。是否暂停 Edge 下载并交给独立下载器？')) return;
      send.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({action:'sendDownload',downloadId:item.id,confirmed:true});
        if (result.ok) await navigate('downloads'); else status(result.message);
      } catch(e) { status(e.message); }
      finally { if (page === 'history') await renderHistory(); }
    }; buttons.append(send); card.append(buttons); $('downloads').append(card);
  }
}

$('test').onclick = async () => {
  $('test').disabled = true; status('正在检查本机独立下载器……');
  try {
    const result = await chrome.runtime.sendMessage({action:'test'});
    if (result.ok && result.downloadFolder && result.hostVersion === chrome.runtime.getManifest().version) {
      await chrome.storage.local.set({enabled:true}); $('enabled').checked = true;
      status('检测通过，已启用接管。保存到：' + result.downloadFolder + '；最多 ' + result.connections + ' 个分段。');
    } else if (result.ok) {
      await chrome.storage.local.set({enabled:false}); $('enabled').checked = false;
      status('本机下载器版本不匹配，请运行新版 Update.cmd 后重新加载扩展。');
    } else status(result.message || '检测失败，请检查本机连接程序。');
  } catch(e) { status(e.message); } finally { $('test').disabled = false; }
};
$('enabled').onchange = async () => {
  await chrome.storage.local.set({enabled:$('enabled').checked});
  status($('enabled').checked ? '已开启自动接管。' : '已关闭自动接管。');
};
$('save').onclick = async () => {
  const minMB = Number($('minMB').value);
  if (!Number.isFinite(minMB) || minMB < 0 || minMB > 100000) { status('请填写有效的文件大小。'); return; }
  await chrome.storage.local.set({minMB,excludedHosts:$('excludedHosts').value.trim(),showStartNotice:$('showStartNotice').checked}); status('设置已保存。');
};
$('refresh').onclick = () => renderHistory().catch(e => status(e.message));
async function poll() {
  if (pollPending) return;
  pollPending = true;
  try { await chrome.runtime.sendMessage({action:'refreshJobs'}); await render(); }
  catch(e) { status(e.message); } finally { pollPending = false; }
}
$('refresh-jobs').onclick = poll;
const cfg = {...DEFAULTS,...await chrome.storage.local.get(DEFAULTS)};
$('enabled').checked = cfg.enabled; $('minMB').value = cfg.minMB; $('excludedHosts').value = cfg.excludedHosts; $('showStartNotice').checked = cfg.showStartNotice;
const onChanged = (changes,area) => { if (area === 'local') { if (changes.enabled) $('enabled').checked = !!changes.enabled.newValue; void render().catch(e => status(e.message)); } };
chrome.storage.onChanged.addListener(onChanged);
const timer = setInterval(poll,1000);
window.addEventListener('pagehide',() => { clearInterval(timer); chrome.storage.onChanged.removeListener(onChanged); });
await render(); void poll();
