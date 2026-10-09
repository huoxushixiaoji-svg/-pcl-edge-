export const RUNNING = new Set(['downloading', 'paused', 'pausing', 'resuming', 'canceling']);
export const RECOVERY = new Set(['uncertain', 'cancel_failed', 'resume_failed']);
export const TERMINAL = new Set(['completed', 'failed', 'canceled', 'skipped', 'resolved']);
const NATIVE_STATES = new Set(['queued', 'downloading', 'paused', 'completed', 'failed', 'canceled']);
export function nativeUpdate(job, result) {
  if (!result?.ok || !NATIVE_STATES.has(result.jobState)) return null;
  let state = result.jobState === 'queued' ? 'downloading' : result.jobState;
  // Keep a command pending until the worker confirms it; never offer duplicate controls.
  if (job.state === 'canceling' && !TERMINAL.has(state)) state = 'canceling';
  if (job.state === 'pausing' && state === 'downloading') state = 'pausing';
  if (job.state === 'resuming' && state === 'paused') state = 'resuming';
  return {...job, state, message:result.message || job.message, outputPath:result.outputPath || job.outputPath,
    downloadedBytes:Math.max(0, Number(result.downloadedBytes) || 0),
    totalBytes:Number.isFinite(result.totalBytes) ? result.totalBytes : -1,
    bytesPerSecond:state === 'paused' ? 0 : Math.max(0, Number(result.bytesPerSecond) || 0)};
}
export function taskControls(job) {
  if (!job.nativeJobId) return [];
  if (job.state === 'downloading') return [['pause', '暂停'], ['cancel', '取消']];
  if (job.state === 'paused') return [['resume', '继续'], ['cancel', '取消']];
  return [];
}
export function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return value.toFixed(unit ? 1 : 0) + ' ' + units[unit];
}
export function progress(job) {
  const downloaded = Math.max(0, Number(job.downloadedBytes) || 0);
  const total = job.totalBytes;
  const known = Number.isFinite(total) && total > 0;
  const percent = known ? Math.min(100, downloaded / total * 100) : null;
  const speed = Math.max(0, Number(job.bytesPerSecond) || 0);
  let label = bytes(downloaded) + (known ? ' / ' + bytes(total) + ' · ' + Math.floor(percent) + '%' : ' · 大小未知');
  if (job.state === 'paused') label += ' · 已暂停';
  else if (speed > 0 && job.state === 'downloading') label += ' · ' + bytes(speed) + '/s';
  return {percent, label};
}
