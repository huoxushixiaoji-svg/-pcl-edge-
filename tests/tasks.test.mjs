import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeUpdate,taskControls,progress} from '../extension/tasks.mjs';
const job = {key:'1',nativeJobId:'id',state:'downloading'};
test('worker confirmation controls pause/resume and pending controls cannot be repeated',()=>{
  assert.deepEqual(taskControls(job).map(([key])=>key),['pause','cancel']);
  const paused=nativeUpdate(job,{ok:true,jobState:'paused',downloadedBytes:1024,totalBytes:4096,bytesPerSecond:1024});
  assert.equal(paused.bytesPerSecond,0);assert.deepEqual(taskControls(paused).map(([key])=>key),['resume','cancel']);
  for(const state of ['pausing','resuming','canceling','completed','failed'])assert.deepEqual(taskControls({...job,state}),[]);
  assert.equal(nativeUpdate({...job,state:'pausing'},{ok:true,jobState:'downloading'}).state,'pausing');
  assert.equal(nativeUpdate({...job,state:'resuming'},{ok:true,jobState:'paused'}).state,'resuming');
  assert.equal(nativeUpdate({...job,state:'canceling'},{ok:true,jobState:'downloading'}).state,'canceling');
  assert.equal(nativeUpdate({...job,state:'canceling'},{ok:true,jobState:'canceled'}).state,'canceled');
});
test('progress supports known/unknown totals and caps stale byte counts',()=>{
  assert.equal(progress({downloadedBytes:1024,totalBytes:4096}).percent,25);
  assert.match(progress({state:'downloading',downloadedBytes:1024,totalBytes:4096,bytesPerSecond:2048}).label,/2.0 KB\/s/);
  assert.equal(progress({downloadedBytes:99,totalBytes:-1}).percent,null);
  assert.equal(progress({downloadedBytes:99,totalBytes:0}).percent,null);
  assert.equal(progress({downloadedBytes:8192,totalBytes:4096}).percent,100);
  assert.match(progress({state:'paused',downloadedBytes:1024,totalBytes:4096}).label,/已暂停/);
});
test('missing, unsuccessful and unrecognized native responses never complete a task',()=>{
  for(const result of [null,{ok:false,jobState:'completed'},{ok:true,jobState:'missing'},{ok:true,jobState:'unexpected'}])assert.equal(nativeUpdate(job,result),null);
});
