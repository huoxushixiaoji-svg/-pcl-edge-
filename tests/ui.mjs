// Optional browser checks: install playwright-core, then run node tests/ui.mjs.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
const {chromium} = await import(process.env.EDGE_PLAYWRIGHT_MODULE || 'playwright-core');
const root = resolve(import.meta.dirname,'../extension');
const server = createServer(async (request,response) => {
  try {
    const path = resolve(root,'.' + new URL(request.url,'http://localhost').pathname);
    if (!path.startsWith(root + sep)) throw Error('Invalid path');
    response.setHeader('Content-Type',path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.png') ? 'image/png' : 'text/html');
    response.end(await readFile(path));
  } catch { response.writeHead(404);response.end(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser = await chromium.launch({executablePath:process.env.EDGE_CHROMIUM || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const context = await browser.newContext({viewport:{width:388,height:600}});
  const errors=[],calls=[];
  await context.exposeBinding('__record',(_source,value) => calls.push(value));
  await context.addInitScript(() => {
    const db={enabled:true,minMB:0,excludedHosts:'',showStartNotice:true,
      'job:one':{key:'one',nativeJobId:'id',filename:'示例下载.zip',state:'downloading',message:'正在下载。',downloadedBytes:2*1024*1024,totalBytes:8*1024*1024,bytesPerSecond:512*1024,updatedAt:Date.now()},
      'job:old':{key:'old',filename:'已完成.zip',state:'completed',message:'下载完成。',downloadedBytes:1024,totalBytes:1024,updatedAt:Date.now()-60000}};
    const callbacks=[];
    const emit=values=>callbacks.forEach(fn=>fn(Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{newValue:value}])),'local'));
    window.chrome={
      storage:{local:{get:async keys=>keys===null?structuredClone(db):Object.fromEntries(Object.entries(keys).map(([key,value])=>[key,db[key]??value])),set:async values=>{Object.assign(db,values);emit(values);}},onChanged:{addListener:fn=>callbacks.push(fn),removeListener:fn=>callbacks.splice(callbacks.indexOf(fn),1)}},
      downloads:{search:async()=>[{id:10,url:'https://example.com/record.zip',filename:'record.zip',state:'complete',danger:'safe'}]},
      runtime:{id:'test-id',getManifest:()=>({version:'0.3.0'}),sendMessage:async message=>{
        await window.__record(message);
        if(message.action==='controlJob') {
          const job=db['job:'+message.key];job.state={pause:'paused',resume:'downloading',cancel:'canceled'}[message.command];job.message={pause:'已暂停。',resume:'正在下载。',cancel:'已取消。'}[message.command];emit({['job:'+message.key]:job});
        }
        return {ok:true};
      }}
    };
    window.updateJob=value=>{Object.assign(db['job:one'],value);emit({'job:one':db['job:one']});};
  });
  const page = await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const url = 'http://127.0.0.1:' + server.address().port + '/popup.html';
  await page.goto(url);
  await page.getByRole('button',{name:'暂停',exact:true}).waitFor();
  assert.equal(await page.locator('#page-settings').isVisible(),false);
  assert.equal(await page.locator('#page-history').isVisible(),false);
  assert.equal(await page.locator('#jobs progress').getAttribute('value'),'25');
  await page.getByRole('button',{name:'暂停',exact:true}).click();
  await page.getByRole('button',{name:'继续',exact:true}).waitFor();
  await page.getByRole('button',{name:'继续',exact:true}).click();
  await page.getByRole('button',{name:'暂停',exact:true}).waitFor();
  await page.evaluate(()=>window.updateJob({totalBytes:-1}));
  await page.waitForFunction(()=>document.querySelector('#jobs progress')?.hasAttribute('value')===false);
  await page.getByRole('button',{name:'更多菜单',exact:true}).click();
  await page.locator('#menu [data-page=settings]').click();
  await page.locator('#minMB').fill('12');
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#minMB').inputValue(),'12');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.getByRole('button',{name:'← 返回下载',exact:true}).click();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#jobs [data-job="one"]'));
  await page.getByRole('button',{name:'更多菜单',exact:true}).click();
  await page.locator('#menu [data-page=history]').click();
  assert.equal(await page.locator('#history .job').count(),2);
  await page.getByText('查看最终下载链接',{exact:true}).click();
  await page.locator('#downloads textarea').focus();
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#downloads details').getAttribute('open'),'');
  assert.equal(await page.locator('#downloads textarea').inputValue(),'https://example.com/record.zip');
  const popupEvent = context.waitForEvent('page');
  await page.evaluate(url=>window.open(url+'?notice=1','download-notice','popup,width=410,height=530'),url);
  const notice = await popupEvent;notice.on('pageerror',e=>errors.push(e.message));
  await notice.getByRole('button',{name:'关闭下载提示',exact:true}).waitFor();
  const cancelBefore = calls.filter(value=>value.command==='cancel').length;
  const closed = notice.waitForEvent('close');
  await notice.getByRole('button',{name:'关闭下载提示',exact:true}).click({noWaitAfter:true}).catch(error=>{if(!notice.isClosed())throw error;});await closed;
  assert.equal(calls.filter(value=>value.command==='cancel').length,cancelBefore);
  assert.deepEqual(errors,[]);
  console.log('PASS browser secondary menus, controls, known/unknown progress, settings edits, history links, closable notice');
  if (process.env.EDGE_UI_SCREENSHOT) {
    await page.goto(url);await page.getByRole('button',{name:'暂停',exact:true}).waitFor();
    await page.screenshot({path:process.env.EDGE_UI_SCREENSHOT});
  }
} finally { if(browser)await browser.close();await new Promise(resolve=>server.close(resolve)); }
