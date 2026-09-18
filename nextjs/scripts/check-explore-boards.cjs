// Local browser regression. File storage is in memory; renderer is the actual local dct engine.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const runner = path.resolve(root, '../dbt-runner');
require(root + '/node_modules/dotenv').config({path:root + '/../.env',quiet:true});
const base = process.env.EXPLORE_TEST_URL || 'http://127.0.0.1:3000';
assert(['localhost','127.0.0.1'].includes(new URL(base).hostname));
function engine(action, payload) {
  const code = [
    'import sys,json,asyncio',
    'from app.services.boards import validate_board,render_board,compose_board,add_chart,preview_query,preview_sql',
    'from app.services.chart_reference import reference',
    'p=json.loads(sys.argv[2])',
    'async def query(sql):',
    " return {'success':True,'columns':['month','revenue'],'data':[{'month':'Jan','revenue':20}]}",
    'a=sys.argv[1]',
    "if a=='compose': r=compose_board(p['yaml'],p['chart_yaml'],p['sql'],p['columns'])",
    "elif a=='validate': r=asyncio.run(validate_board(p['yaml']))",
    "elif a=='chart': r=add_chart(p['yaml'],p.get('chart',{}),p.get('columns',[]))",
    "elif a=='query': r=asyncio.run(preview_query(p['yaml'],p.get('variables',{}),p.get('name',''),query))",
    "elif a=='sql': r=asyncio.run(preview_sql(p.get('sql',''),query))",
    "elif a=='reference': r=reference()",
    "else: r=asyncio.run(render_board(p['yaml'],p.get('variables',{}),query))",
    'print(json.dumps(r))',
  ].join('\n');
  return JSON.parse(execFileSync(runner+'/.venv/bin/python',['-c',code,action,JSON.stringify(payload||{})],{cwd:runner,maxBuffer:32*1024*1024}).toString());
}
(async()=>{
  const { encode } = await import(root + '/node_modules/next-auth/jwt.js');
  const token=await encode({secret:process.env.AUTH_SECRET,salt:'authjs.session-token',token:{sub:'local-user',email:'local@dbt-craft.local',name:'Local User'},maxAge:600});
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:900}});
    await context.addCookies([{name:'authjs.session-token',value:token,url:base,httpOnly:true,sameSite:'Lax'}]);
    const page=await context.newPage(); const errors=[]; const files={};
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/api/**',async route=>{
      const url=new URL(route.request().url()); const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      if(url.pathname==='/api/auth/session') return send({user:{email:'local@dbt-craft.local',name:'Local User'},accessToken:'fixture',expires:'2099-01-01'});
      if(url.pathname==='/api/projects') return send([{id:'sales',name:'Sales analytics'}]);
      if(url.pathname.includes('/intellisense/')) return send({success:true,models:[],sources:[]});
      if(url.pathname.includes('/dbt-docs')) return send({},404);
      if(url.pathname.includes('/environment')) return send({default:'dev',targets:[{name:'dev',type:'postgres',database:'analytics',schema:'public'}]});
      if(url.pathname.includes('/files/')) {
        const body=route.request().postDataJSON(); const file=url.searchParams.get('path') || body?.path;
        if(url.pathname.endsWith('/search')) return send({results:Object.keys(files).map(path=>({path,type:'file'}))});
        if(route.request().method()==='POST' || route.request().method()==='PUT') {files[file]=body.content;return send({success:true,path:file});}
        return send({content:files[file],path:file});
      }
      if(url.pathname.endsWith('/charts/reference')) return send(engine('reference'));
      if(url.pathname.includes('/board/')) {
        try {return send(engine(url.pathname.split('/').pop(),route.request().postDataJSON()));} catch(error) {return send({detail:error.message},422);}
      }
      return send([]);
    });
    await page.goto(base+'/explore');
    await page.getByRole('button',{name:'Close query Query 1',exact:true}).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('button',{name:'Close query Query 1',exact:true}).click();
    page.once('dialog',dialog=>dialog.accept('reusable-query'));
    await page.getByRole('button',{name:'Save and close',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    assert(files['analyses/explore/reusable-query.sql']);
    await page.getByRole('button',{name:'Saved queries',exact:true}).click();
    await page.getByRole('button',{name:'reusable-query.sql',exact:true}).click();
    await page.getByRole('button',{name:'Close query reusable-query',exact:true}).click();
    assert(files['analyses/explore/reusable-query.sql']);
    for(let i=0;i<12;i++) await page.getByRole('button',{name:'New query',exact:true}).click();
    await page.getByRole('button',{name:'Query actions',exact:true}).click();
    await page.getByRole('menuitem',{name:'Close other tabs',exact:true}).click();
    await page.getByRole('menu').waitFor({state:'hidden'});
    await page.getByRole('button',{name:/^Close query /}).first().waitFor();
    assert.equal(await page.getByRole('button',{name:/^Close query /}).count(),1);
    await page.getByRole('button',{name:'Dashboards',exact:true}).click();
    await page.getByText('This dashboard is empty.').waitFor();
    // A chart is built from data: SQL in, real columns back, query and chart written for you.
    await page.getByRole('button',{name:'Add chart',exact:true}).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByLabel('Chart SQL').fill("select month, sum(amount) as revenue from {{ ref('orders') }} group by 1");
    await page.getByRole('button',{name:'Run and preview data',exact:true}).click();
    await page.getByLabel('Category',{exact:true}).waitFor();
    assert.deepEqual(await page.getByLabel('Category',{exact:true}).locator('option').allTextContents(),['Select a column','month','revenue']);
    assert((await page.getByLabel('Number format',{exact:true}).locator('option').allTextContents()).includes('currency'));
    await page.getByRole('button',{name:'Add to dashboard',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.getByText(/Added chart chart_1 and query query_1/).waitFor();
    // Saving names the file in a dialog, not a native prompt.
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('dialog').waitFor();
    await page.getByLabel('Dashboard name').fill('sales-overview');
    await page.getByRole('button',{name:'Save dashboard',exact:true}).click();
    await page.getByText('Saved charts/sales-overview.yml',{exact:false}).waitFor();
    const saved=files['charts/sales-overview.yml'];
    assert(saved.includes('query_1: |') && saved.includes('type: bar') && saved.includes('chart_1:'),saved);
    await page.getByRole('button',{name:'Preview',exact:true}).click();
    await page.getByTitle('Dashboard preview').waitFor();
    await page.frameLocator('iframe[title="Dashboard preview"]').locator('svg').first().waitFor();
    // Engine diagnostics reach the author with the authored line, not a bare message.
    await page.getByRole('alert').getByText(/Line \d+/).first().waitFor();
    const rect=await page.getByTitle('Dashboard preview').boundingBox();
    assert(rect.height>600 && rect.width>600,JSON.stringify(rect));
    // The editor stays beside the preview; hiding YAML still gives the full canvas.
    await page.getByRole('region',{name:'Dashboard workspace'}).locator('.monaco-editor').first().waitFor();
    await page.getByRole('button',{name:'YAML',exact:true}).click();
    const wide=await page.getByTitle('Dashboard preview').boundingBox();
    assert(wide.width>900 && wide.width>rect.width,JSON.stringify(wide));
    await page.getByRole('button',{name:'YAML',exact:true}).click();
    // Board samples come from the installed engine and open in the editor.
    await page.getByRole('button',{name:'More dashboard actions',exact:true}).click();
    await page.getByRole('menuitem',{name:'Samples and guide',exact:true}).click();
    await page.getByRole('menu').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Board samples',exact:true}).click();
    await page.getByText('Revenue Overview',{exact:true}).waitFor();
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'Use this board',exact:true}).first().click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Preview',exact:true}).click();
    await page.frameLocator('iframe[title="Dashboard preview"]').locator('svg').first().waitFor();
    await page.screenshot({path:'/tmp/explore-dashboard-full.png',fullPage:true});
    await page.getByRole('button',{name:'SQL',exact:true}).click();
    await page.getByRole('button',{name:'Dashboards',exact:true}).click();
    await page.getByTitle('Dashboard preview').waitFor();
    await page.reload();
    await page.getByRole('button',{name:'Dashboards',exact:true}).click();
    page.once('dialog',dialog=>dialog.accept());
    await page.getByLabel('Open a saved dashboard').selectOption('charts/sales-overview.yml');
    await page.getByText('charts/sales-overview.yml',{exact:false}).first().waitFor();
    await page.getByRole('button',{name:'Preview',exact:true}).click();
    await page.getByTitle('Dashboard preview').waitFor();
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    await page.screenshot({path:'/tmp/explore-dashboard-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS: query save/close/reopen, 12 tabs, dashboard validate/save/reopen, real multi-chart render, line-numbered diagnostics, chart builder over returned columns, bundled sample render, full canvas, tab preservation and mobile.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
