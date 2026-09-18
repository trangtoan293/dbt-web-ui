// Local fixture-only layout regression; never starts real runs or schedules.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
require(root + '/node_modules/dotenv').config({path:root + '/../.env',quiet:true});
const assert = require('node:assert/strict');
const base = process.env.EXPLORE_TEST_URL || 'http://127.0.0.1:3000';
assert(['localhost','127.0.0.1'].includes(new URL(base).hostname));
(async () => {
  const { encode } = await import(root + '/node_modules/next-auth/jwt.js');
  const token = await encode({secret:process.env.AUTH_SECRET,salt:'authjs.session-token',token:{sub:'local-user',userId:'layout-test',email:'local@dbt-craft.local',name:'Local User'},maxAge:600});
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});
  try {
    const context = await browser.newContext({viewport:{width:1440,height:900}});
    await context.addCookies([{name:'authjs.session-token',value:token,url:base,httpOnly:true,sameSite:'Lax'}]);
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    let generates=0;
    const project={id:'sales',name:'Sales analytics',description:'Sales project'};
    await context.route('**/api/**',async route=>{
      const url=new URL(route.request().url());
      const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      if(url.pathname==='/api/auth/session') return send({user:{id:'layout-test',name:'Local User',email:'local@dbt-craft.local'},accessToken:'local-no-auth',expires:'2099-01-01T00:00:00Z'});
      if(url.pathname==='/api/projects') return send([project]);
      if(url.pathname.startsWith('/api/dbt-docs/view/')) return route.fulfill({contentType:'text/html',body:'<h1>Project documentation</h1>'});
      if(url.pathname.includes('/docs/generate')) {generates++;return send({success:true});}
      if(url.pathname.includes('/intellisense/')) return send({success:true,status:'ready',catalog_available:true,models:[{name:'orders',unique_id:'model.sales.orders',path:'models/orders.sql',columns:[{name:'amount',data_type:'DECIMAL'}]}],sources:[]});
      if(url.pathname.includes('/files/')) return send({results:[]});
      if(url.pathname.includes('/environment')) return send({default:'dev',targets:[{name:'dev',database:'analytics',schema:'public'}]});
      if(url.pathname==='/api/runs') return send({items:[{id:'run-1',projectId:'sales',project,status:'success',command:'run',startedAt:'2026-09-18T00:00:00Z',durationMs:2000,modelsSuccess:2,modelsError:0,modelsTotal:2}],pagination:{page:1,pageSize:25,total:1,totalPages:1},summary:{total:1,success:1,error:0,cancelled:0,running:0,pending:0,averageDurationMs:2000},facets:{projects:[project]}});
      if(url.pathname==='/api/schedules') return send([{id:'schedule-1',name:'Daily orders',projectId:'sales',project,command:'run',cron:'0 1 * * *',isActive:true,nextRunAt:'2026-09-19T01:00:00Z',lastRunAt:null,lastStatus:null}]);
      return send([]);
    });
    await page.goto(base+'/explore');
    await page.locator('.monaco-editor:visible').waitFor();
    const editorTop=(await page.locator('.monaco-editor:visible').boundingBox()).y;
    assert(editorTop<220,`SQL starts too low: ${editorTop}px`);
    assert.equal(await page.locator('main').getByRole('link',{name:'Develop',exact:true}).count(),0);
    await page.screenshot({path:'/tmp/density-explore.png',fullPage:true});
    await page.getByRole('button',{name:'Docs',exact:true}).click();
    await page.getByRole('button',{name:'Docs actions',exact:true}).click();
    await page.getByRole('menuitem',{name:'Refresh documentation',exact:true}).click();
    await page.locator('iframe').waitFor();
    const docsTop=(await page.locator('iframe').boundingBox()).y;
    assert(docsTop<150,`Docs starts too low: ${docsTop}px`);
    assert.equal(await page.getByRole('button',{name:'Generate Docs',exact:true}).count(),0);
    await page.getByRole('button',{name:'Docs actions',exact:true}).click();
    await page.getByRole('menuitem',{name:'Generate Docs',exact:true}).click();
    await page.waitForFunction(()=>!!document.querySelector('iframe'));
    assert.equal(generates,1);
    await page.screenshot({path:'/tmp/density-docs.png',fullPage:true});
    await page.getByRole('button',{name:'Dashboards',exact:true}).click();
    await page.getByRole('button',{name:'Validate',exact:true}).waitFor();
    assert.equal(await page.locator('main').getByRole('link',{name:/Develop/}).count(),0);
    await page.goto(base+'/orchestrate');
    await page.getByRole('button',{name:'Inspect run run-1'}).waitFor();
    const runsTop=(await page.getByRole('table').boundingBox()).y;
    assert(runsTop<280,`Run table starts too low: ${runsTop}px`);
    await page.getByLabel('Filter by run status').selectOption('success');
    await page.getByRole('button',{name:'Refresh runs'}).click();
    await page.screenshot({path:'/tmp/density-runs.png',fullPage:true});
    await page.getByRole('tab',{name:'Schedules',exact:true}).click();
    await page.getByText('Daily orders',{exact:true}).waitFor();
    assert((await page.getByText('Daily orders',{exact:true}).boundingBox()).y<210);
    await page.getByRole('button',{name:'New schedule',exact:true}).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.screenshot({path:'/tmp/density-schedules.png',fullPage:true});
    for(const url of ['/explore','/orchestrate','/orchestrate?tab=schedules']) {
      await page.setViewportSize({width:390,height:844});
      await page.goto(base+url);
      await page.getByRole('main').waitFor();
      await page.waitForFunction(()=>document.querySelector('aside').getBoundingClientRect().right<=0);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
      if(url==='/explore') {
        await page.locator('.monaco-editor:visible').waitFor();
        assert((await page.locator('.monaco-editor:visible').boundingBox()).y<370);
        await page.getByRole('button',{name:'Docs',exact:true}).click();
        await page.getByRole('button',{name:'Docs actions',exact:true}).click();
        await page.getByRole('menuitem',{name:'Generate Docs',exact:true}).waitFor();
        await page.keyboard.press('Escape');
      }
      await page.screenshot({path:`/tmp/density-mobile-${url.includes('schedules')?'schedules':url.slice(1)}.png`,fullPage:true});
    }
    assert.deepEqual(errors,[]);
    console.log(`PASS: compact SQL ${editorTop}px, Docs ${docsTop}px, runs ${runsTop}px; actions, tabs, mobile and no runtime errors.`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
