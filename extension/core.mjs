export const HOST = 'com.local.edge_multi_download';
export const DEFAULTS = {enabled: false, minMB: 0, excludedHosts: ''};
export const ACTIVE = new Set(['preparing', 'queued', 'sending', 'downloading', 'uncertain', 'cancel_failed', 'resume_failed']);

export function httpUrl(value) {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
  } catch { return false; }
}

export function safeName(filename, url) {
  let value = (filename || '').split(/[\\/]/).pop();
  if (!value) {
    try { value = decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch { /* fallback */ }
  }
  value = String(value || 'download').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(value)) value = '_' + value;
  return (value || 'download').slice(0, 160).replace(/[. ]+$/g, '') || 'download';
}

export function excluded(url, list) {
  const host = new URL(url).hostname.toLowerCase();
  return list.split(/[\s,，]+/).filter(Boolean).some(x => {
    x = x.toLowerCase().replace(/^\*\./, '');
    return host === x || host.endsWith('.' + x);
  });
}

function blocked(code, message) { return {eligible:false, code, message}; }

// These checks apply even when a user explicitly sends an existing download.
export function downloadDecision(item) {
  if (!item) return blocked('missing', 'Edge 下载记录已不存在。');
  const url = item.finalUrl || item.url;
  if (item.incognito) return blocked('incognito', '无痕下载继续由 Edge 处理。');
  if (item.byExtensionId) return blocked('other_extension', '其他扩展发起的下载继续由 Edge 处理。');
  if (!httpUrl(url)) return blocked('unsupported_url', '此下载不是公开 HTTP/HTTPS 链接，独立下载器无法接收。');
  if (!['safe', 'accepted', 'deepScannedSafe'].includes(item.danger)) return blocked('danger', 'Edge 正在检查或已提示此文件有风险，暂不交接。');
  if (item.state !== 'in_progress') return blocked('finished', '此下载已完成或已中断，可复制链接；不会重复创建下载。');
  if (item.paused) return blocked('paused', '此下载已暂停；如需手动交接，请先在 Edge 中继续下载。');
  return {eligible:true, code:'ready', message:'可以交接此下载链接。'};
}

// Missing request evidence leaves Edge in control, with a visible explanation.
export function handoffDecision(item, settings, requests, now = Date.now()) {
  if (!settings.enabled) return blocked('disabled', '自动接管未开启，请先检测本机下载器并启用接管。');
  const basic = downloadDecision(item);
  if (!basic.eligible) return basic;
  const url = item.finalUrl || item.url;
  if (excluded(url, settings.excludedHosts || '')) return blocked('excluded', '此网站在不接管名单中。');
  const min = Number(settings.minMB) * 1024 * 1024;
  if (min > 0 && !(item.totalBytes >= min)) return blocked('size', item.totalBytes < 0 ? '文件大小暂未知，尚不能判断是否达到接管门槛。' : '文件小于设置的接管门槛。');
  const matches = requests.filter(r => r.url === url && now - r.at >= 0 && now - r.at < 120000);
  if (!matches.length) return blocked('unobserved', '已从 Edge 获取下载链接，但未观察到对应网络请求。可复制链接，或确认是公开直链后手动交接。');
  if (matches.some(r => r.method !== 'GET')) return blocked('method', '此下载涉及表单或非 GET 请求，继续由 Edge 处理。');
  if (matches.some(r => r.sensitive)) return blocked('credentials', '此请求携带 Cookie 或登录信息；链接已获取，自动下载继续由 Edge 处理。');
  if (matches.some(r => !r.inspected)) return blocked('headers', '已获取下载链接，正在等待请求信息。');
  if (matches.some(r => r.status < 200 || r.status >= 300)) return blocked('response', '已获取下载链接，尚未观察到成功的文件响应。');
  return {eligible:true, code:'ready', message:'已获取最终下载链接，准备交给独立下载器。'};
}

export function eligible(item, settings, requests, now = Date.now()) {
  return handoffDecision(item, settings, requests, now).eligible;
}

export function nativeCall(api, message, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    let port, done = false;
    const timer = setTimeout(() => finish(new Error('本机连接超时，请检查独立下载任务。')), timeoutMs);
    function finish(error, response) {
      if (done) return;
      done = true; clearTimeout(timer);
      try { port?.disconnect(); } catch { /* already closed */ }
      error ? reject(error) : resolve(response);
    }
    try {
      port = api.runtime.connectNative(HOST);
      port.onMessage.addListener(response => {
        if (response.requestId === message.requestId) finish(null, response);
      });
      port.onDisconnect.addListener(() => {
        const text = api.runtime.lastError?.message || '本机连接程序已退出。';
        finish(new Error(text));
      });
      port.postMessage({...message, deadlineUtcMs: Date.now() + timeoutMs - 2000});
    } catch (error) { finish(error); }
  });
}

// The native host distinguishes failures before Enter from uncertain results after Enter.
export async function settle(api, job, response, save) {
  if (response?.status === 'submitted') {
    if (job.downloadId != null) {
      try { await api.downloads.cancel(job.downloadId); }
      catch {
        await save({...job, state: 'cancel_failed', message: '独立下载已启动，但 Edge 任务未能取消；请检查是否重复下载。', outputPath: response.outputPath, nativeJobId:response.jobId || job.nativeJobId});
        return;
      }
    }
    await save({...job, state: 'downloading', message: '独立下载任务已启动。', outputPath: response.outputPath, nativeJobId:response.jobId || job.nativeJobId});
  } else if (response?.status === 'failed' && response.safeToResume === true) {
    if (job.downloadId != null) {
      try { await api.downloads.resume(job.downloadId); }
      catch {
        await save({...job, state: 'resume_failed', message: '独立下载未启动，Edge 自动恢复失败，请到下载列表手动继续。'});
        return;
      }
    }
    await save({...job, state: 'failed', message: response.message || '独立下载未启动；原 Edge 任务已继续。'});
  } else {
    await save({...job, state: 'uncertain', message: response?.message || '无法确认独立下载是否开始。请检查输出目录后选择保留任务或恢复 Edge。', outputPath: response?.outputPath, nativeJobId:response?.jobId || job.nativeJobId});
  }
}
