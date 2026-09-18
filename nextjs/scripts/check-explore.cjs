// Local smoke test: all API responses are fixtures; no warehouse queries are sent.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
require(root + '/node_modules/dotenv').config({path:root + '/../.env',quiet:true});
const assert = require('node:assert/strict');
const base = process.env.EXPLORE_TEST_URL || 'http://127.0.0.1:3000';
assert(['localhost','127.0.0.1'].includes(new URL(base).hostname), 'Run only against a local test instance');
(async () => {
  const { encode } = await import(root + '/node_modules/next-auth/jwt.js');
  const token = await encode({secret:process.env.AUTH_SECRET,salt:'authjs.session-token',token:{sub:'local-user',userId:'explore-test',email:'local@dbt-craft.local',name:'Local User'},maxAge:600});
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});
  let page;
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addCookies([{name:'authjs.session-token',value:token,url:base,httpOnly:true,sameSite:'Lax'}]);
    page=await context.newPage();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    let failMetadata=false;
    await context.route('**/api/**', async route => {
      const url=new URL(route.request().url());
      const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      if(url.pathname==='/api/auth/session') return send({user:{id:'explore-test',name:'Local User',email:'local@dbt-craft.local'},accessToken:'local-no-auth',expires:'2099-01-01T00:00:00Z'});
      if(url.pathname==='/api/projects') return send([{id:'sales',name:'Sales analytics',description:'Orders and customer analytics'},{id:'finance',name:'Finance reporting'}]);
      if(url.pathname.startsWith('/api/dbt-docs')) return send({},404);
      if(url.pathname.includes('/intellisense/')) {
        if(failMetadata) return send({detail:'Metadata unavailable'},503);
        const sales=url.pathname.endsWith('/sales');
        return send({success:true,status:'ready',catalog_available:sales,generated_at:'2026-09-18T01:00:00Z',models:[{unique_id:`model.${sales?'sales.orders':'finance.payments'}`,name:sales?'orders':'payments',path:'models/marts/model.sql',description:sales?'One row per order. Revenue excludes refunds.':'Finance payment ledger',columns:sales?[{name:'order_id',data_type:'INTEGER',description:'Unique order identifier'},{name:'amount',data_type:'DECIMAL',description:'Net order revenue'},{name:'order_date',data_type:'DATE'}]:[{name:'payment_id',data_type:null}]}],sources:sales?[{unique_id:'source.sales.raw.customers',source_name:'raw',table_name:'customers',path:'models/sources.yml',columns:[{name:'customer_id',data_type:'INTEGER'}]}]:[]});
      }
      if(url.pathname.includes('/environment')) return send({default:'dev',targets:[{name:'dev',type:'postgres',database:'analytics',schema:'public'},{name:'prod',type:'postgres',database:'analytics',schema:'mart'}]});
      if(url.pathname.includes('/files/')) return send({results:[]});
      if(url.pathname==='/api/dbt-runner/dbt/query') return send({success:true,data:[{order_id:1,amount:120}],columns:['order_id','amount'],row_count:1,execution_time:0.1});
      return send([]);
    });
    await page.goto(base+'/explore');
    console.log('Explore loaded');
    await page.getByRole('button',{name:'orders 3',exact:true}).click();
    await page.getByText('DECIMAL',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Query this table',exact:true}).click();
    console.log('Sample query opened');
    const content=()=>page.locator('.monaco-editor:visible .view-lines').innerText();
    await page.waitForFunction(()=>document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes("ref('sales', 'orders')"));
    await page.getByRole('button',{name:'Query 1 •',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes('answer'));
    await page.getByRole('button',{name:'orders •',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes("ref('sales', 'orders')"));
    await page.getByRole('button',{name:'Run',exact:true}).click();
    await page.getByText('1 rows', {exact:false}).waitFor();
    await page.screenshot({path:'/tmp/explore-data-desktop.png',fullPage:true});
    console.log('Results displayed');
    await page.getByRole('button',{name:'Insert column amount',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes('adapter.quote'));
    await page.getByLabel('Project',{exact:true}).selectOption('finance');
    await page.getByRole('button',{name:'payments 1',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'orders 3',exact:true}).count(),0);
    await page.getByText('Type unavailable',{exact:true}).waitFor();
    await page.getByLabel('Project',{exact:true}).selectOption('sales');
    await page.waitForFunction(()=>document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes('adapter.quote'));
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes('adapter.quote'));
    await page.getByLabel('Search tables and columns').fill('customer_id');
    await page.getByRole('button',{name:'raw.customers 1',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'orders 3',exact:true}).count(),0);
    await page.getByLabel('Search tables and columns').fill('');
    await page.locator('.monaco-editor:visible .view-lines').click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('select * from ');
    console.log('Completion SQL:',await content());
    await page.keyboard.press('Control+Space');
    await page.locator('.suggest-widget').getByText('orders',{exact:true}).first().waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+a');
    await page.keyboard.insertText("select o.\nfrom {{ ref('sales', 'orders') }} o");
    // From the longer second line, Up lands at the end of the shorter first line.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Control+Space');
    console.log('Alias SQL:', await content());
    await page.locator('.suggest-widget').getByText('amount',{exact:true}).first().waitFor();
    await page.locator('.suggest-widget').getByText('amount',{exact:true}).first().click();
    await page.waitForFunction(()=>document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes('o.{{ adapter.quote("amount") }}'));
    await page.keyboard.press('Escape');
    failMetadata=true;
    await page.getByRole('button',{name:'Reload metadata',exact:true}).click();
    await page.getByRole('region',{name:'Project data browser',exact:true}).getByRole('alert').waitFor();
    failMetadata=false;
    await page.getByRole('button',{name:'Reload metadata',exact:true}).click();
    await page.getByRole('button',{name:'orders 3',exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>document.querySelector('aside').getBoundingClientRect().right<=0);
    await page.getByRole('button',{name:'Data browser',exact:true}).click();
    await page.getByLabel('Search tables and columns').fill('amount');
    await page.getByRole('button',{name:'Query this table',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes("ref('sales', 'orders')"));
    await page.screenshot({path:'/tmp/explore-data-mobile.png',fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    assert.deepEqual(errors,[]);
    console.log('PASS: metadata/types/search, cursor insertion, new drafts, restore/reload/project isolation, relation+alias completion, retry and mobile.');
  } catch(error) {
    if(page) { await page.screenshot({path:'/tmp/explore-data-failure.png',fullPage:true}); console.log((await page.locator('body').innerText()).slice(-3000)); }
    throw error;
  } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
