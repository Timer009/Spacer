const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium, webkit, firefox } = require(process.env.SPACER_TEST_PLAYWRIGHT || 'playwright');

const root = path.resolve(__dirname, '..');
const evidence = process.env.SPACER_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'spacer-hotfix-'));
const base = execFileSync('git', ['-C', root, 'show', 'a10a463:vector-lander/index.html']);
const release = execFileSync('git', ['-C', root, 'show', '5536ffc:vector-lander/index.html']);
const html = fs.readFileSync(path.join(root, 'vector-lander/index.html'));
const probe = fs.readFileSync(path.join(root, 'vector-lander/orientation-check.html'));
const profiles = [
  [320,568,568,320], [375,667,667,375], [390,844,844,390],
  [393,852,852,393], [430,932,932,430], [768,1024,1024,768], [900,1440,1440,900],
];
fs.mkdirSync(evidence, {recursive:true});

function serve() {
  const server = http.createServer((req, res) => {
    const iframe = '<iframe id="embedded" src="/fix?debug=1" allow="fullscreen \'none\'" sandbox="allow-scripts allow-same-origin" style="display:block;width:320px;height:568px;border:0"></iframe>';
    const body = {'/base':base, '/release':release, '/fix':html, '/orientation-check':probe, '/embedded':iframe}[new URL(req.url, 'http://localhost').pathname];
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store'});
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function instrument() {
  let rand = 123456789;
  Math.random = () => ((rand = (Math.imul(1664525, rand) + 1013904223) >>> 0) / 4294967296);
  const raf = window.requestAnimationFrame.bind(window);
  window.__frames = {pending:0, maxPending:0, times:[], frozen:false};
  window.requestAnimationFrame = callback => {
    if (callback.name !== 'frame') return raf(callback);
    const meter = window.__frames;
    meter.maxPending = Math.max(meter.maxPending, ++meter.pending);
    const run = time => {
      if (meter.frozen) { raf(run); return; }
      meter.pending--;
      meter.times.push(time);
      if (meter.times.length > 180) meter.times.shift();
      callback(time);
    };
    return raf(run);
  };
}
async function open(browser, host, url, w, h, mobile=true, init=instrument, frozen=false, initialStorage={}) {
  const page = await browser.newPage({viewport:{width:w,height:h},
    isMobile:mobile && browser.browserType().name() !== 'firefox', hasTouch:mobile, deviceScaleFactor:mobile ? 2 : 1});
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({content:'('+init.toString()+')();'+(frozen ? 'window.__frames.frozen=true;' : '')});
  if (url !== '/orientation-check') await page.addInitScript(storage => {
    if (sessionStorage.getItem('__spacer_test_seeded')) return;
    localStorage.clear();
    for (const [key,value] of Object.entries(storage)) localStorage.setItem(key,JSON.stringify(value));
    sessionStorage.setItem('__spacer_test_seeded','1');
  }, initialStorage);
  await page.goto(host + url);
  if (url !== '/orientation-check') await page.waitForFunction(() => window.game?.state === 'title');
  return [page, errors];
}
async function size(page, width, height) {
  await page.waitForFunction(([w,h]) => {
    const c = document.getElementById('cv');
    const b = c.getBoundingClientRect();
    return b.width === w && b.height === h &&
      c.width === Math.round(w * Math.min(2, devicePixelRatio)) &&
      c.height === Math.round(h * Math.min(2, devicePixelRatio));
  }, [width,height], {timeout:5000});
}
async function safeArea(page, values) {
  const [t,r,b,l] = values;
  const style = await page.addStyleTag({content: ':root{--safe-t:'+t+'px;--safe-r:'+r+'px;--safe-b:'+b+'px;--safe-l:'+l+'px}'});
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForFunction(args => JSON.stringify([safeTop,safeRight,safeBottom,safeLeft]) === JSON.stringify(args), values);
  return style;
}
async function visibleControlBoxes(page, width, height, safe) {
  const [top,right,bottom,left] = safe;
  const rects = [];
  for (const id of ['gear','pauseBtn','btnL','btnR','btnT']) {
    const button = page.locator('#'+id);
    await button.waitFor();
    const r = await button.boundingBox();
    assert.ok(r.width>=44 && r.height>=44, id+' target');
    assert.ok(r.x>=left && r.y>=top && r.x+r.width<=width-right && r.y+r.height<=height-bottom, id+' safe area');
    assert.ok(await button.getAttribute('aria-label'));
    const icon = await button.locator('svg').evaluate(el => [getComputedStyle(el).width,getComputedStyle(el).strokeWidth]);
    assert.deepEqual(icon, ['22px','1.8px']);
    for (const q of rects) assert.ok(r.x>=q.x+q.width || q.x>=r.x+r.width || r.y>=q.y+q.height || q.y>=r.y+r.height, id+' overlap');
    rects.push(r);
  }
  return rects;
}
const ship = () => [game.state,game.level,game.lives,game.score,game.ship.fuel,game.ship.x,game.ship.y,game.ship.vx,game.ship.vy,JSON.stringify(game.progress)];
const landscapeSafe = [0,47,21,47];
const portraitSafe = [47,0,34,0];

async function input(page, name, rects) {
  if (name === 'chromium' || name === 'edge') {
    const session = await page.context().newCDPSession(page);
    const points = [rects[2],rects[4]].map(({x,y,width,height},i) => ({x:x+width/2,y:y+height/2,id:i+1}));
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points});
    return () => session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }
  await page.evaluate(() => {
    for (const [n,id] of ['btnL','btnT'].entries()) document.getElementById(id).dispatchEvent(
      new PointerEvent('pointerdown',{button:0,pointerType:'touch',pointerId:10+n}));
  });
  return () => page.evaluate(() => {
    for (const [n,id] of ['btnL','btnT'].entries()) document.getElementById(id).dispatchEvent(
      new PointerEvent('pointerup',{button:0,pointerType:'touch',pointerId:10+n}));
  });
}
async function dynamic(browser, name, host, setup, representative) {
  const [pw,ph,lw,lh] = setup;
  const mobile = pw < 900;
  const [page,errors] = await open(browser,host,'/fix',pw,ph,mobile);
  try {
    const hint = page.locator('#rotateHint');
    if (mobile) assert.equal(await hint.isVisible(),true);
    const titleSafe = await safeArea(page, representative ? portraitSafe : [0,0,0,0]);
    await size(page,pw,ph);
    await page.setViewportSize({width:lw,height:lh});
    await size(page,lw,lh);
    assert.equal(await hint.isVisible(),false);
    await titleSafe.evaluate(el => el.remove());
    let insets = await safeArea(page,representative ? landscapeSafe : [0,0,0,0]);
    if (representative) await page.screenshot({path:path.join(evidence,name+'-title-landscape.png')});
    assert.equal(await page.evaluate(() => game.state),'title');
    await page.getByRole('button',{name:/太阳系战役/}).click();
    await page.waitForFunction(() => game.state === 'map');
    if (mobile) {
      const stats = page.locator('#statsBtn');
      const statsBox = await stats.boundingBox();
      assert.ok(statsBox.width >= 44 && statsBox.height >= 44);
      await stats.tap();
      if (representative) await page.screenshot({path:path.join(evidence,name+'-stats-landscape.png')});
      const selected = await page.evaluate(() => game.mapSel);
      await page.evaluate(() => document.activeElement.blur());
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => game.mapSel),selected);
      await page.mouse.click(lw/2,lh/2);
      assert.equal(await page.evaluate(() => game.state),'map');
    }
    const mapState = await page.evaluate(() => [game.mapSel,game.lives,game.score,JSON.stringify(game.progress)]);
    for (const [w,h] of [[pw,ph],[lw,lh],[pw,ph]]) {
      await page.setViewportSize({width:w,height:h});
      await size(page,w,h);
      assert.deepEqual(await page.evaluate(() => [game.mapSel,game.lives,game.score,JSON.stringify(game.progress)]),mapState);
      assert.equal(await hint.isVisible(),false);
    }
    await insets.evaluate(el => el.remove());
    insets = await safeArea(page,representative ? portraitSafe : [0,0,0,0]);
    if (representative) await page.screenshot({path:path.join(evidence,name+'-map-portrait.png')});
    const mapTap = await page.evaluate(() => mapNodePos(0));
    if (mobile) {
      await page.touchscreen.tap(mapTap.x,mapTap.y);
      assert.equal(await page.evaluate(() => game.state),'map');
      await page.touchscreen.tap(mapTap.x,mapTap.y);
    } else await page.mouse.click(mapTap.x,mapTap.y);
    await page.waitForFunction(() => game.state === 'levelIntro');
    if (representative) await page.screenshot({path:path.join(evidence,name+'-intro-portrait.png')});
    await page.waitForFunction(() => game.state === 'playing');
    const fuel = await page.evaluate(() => game.ship.fuel);
    let endTouch;
    if (mobile) {
      const rects = await visibleControlBoxes(page,pw,ph,representative ? portraitSafe : [0,0,0,0]);
      endTouch = await input(page,name,rects);
      await page.waitForFunction(() => document.querySelector('#btnL.active') && document.querySelector('#btnT.active'));
      await page.waitForFunction(f => game.ship.fuel < f, fuel);
    }
    const beforeFlight = await page.evaluate(ship);
    await page.setViewportSize({width:lw,height:lh});
    await size(page,lw,lh);
    await page.waitForFunction(() => !document.querySelector('.tbtn.active'));
    if (endTouch) await endTouch();
    const afterFlight = await page.evaluate(ship);
    assert.deepEqual(afterFlight.slice(0,4), beforeFlight.slice(0,4));
    assert.equal(afterFlight[9],beforeFlight[9]);
    assert.ok(Math.abs(afterFlight[5]-beforeFlight[5])<60 && Math.abs(afterFlight[6]-beforeFlight[6])<80);
    if (mobile) assert.ok(afterFlight[4] <= beforeFlight[4]);
    await insets.evaluate(el => el.remove());
    insets = await safeArea(page,representative ? landscapeSafe : [0,0,0,0]);
    if (mobile) {
      const rects = await visibleControlBoxes(page,lw,lh,representative ? landscapeSafe : [0,0,0,0]);
      const afterRotateTouch = await input(page,name,rects);
      await page.waitForFunction(f => game.ship.fuel < f, afterFlight[4]);
      await afterRotateTouch();
      await page.locator('#pauseBtn').tap();
    } else await page.keyboard.press('p');
    await page.waitForFunction(() => isPaused());
    const paused = await page.evaluate(ship);
    await page.setViewportSize({width:pw,height:ph});
    await size(page,pw,ph);
    assert.deepEqual(await page.evaluate(ship),paused);
    if (representative) await page.screenshot({path:path.join(evidence,name+'-pause-portrait.png')});
    await page.locator('#gear').click();
    await page.locator('#panel').waitFor();
    const contextBlocked = await page.locator('#cv').evaluate(el => !el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
    assert.ok(contextBlocked);
    if (representative) await page.screenshot({path:path.join(evidence,name+'-settings-portrait.png')});
    await page.locator('#btnClose').click();
    assert.ok(await page.evaluate(() => isPaused()));
    assert.deepEqual(await page.evaluate(ship),paused);
    if (mobile) await page.locator('#pauseBtn').tap();
    else await page.keyboard.press('p');
    await page.waitForFunction(() => !isPaused());
    assert.equal(await page.evaluate(() => __frames.maxPending),1);
    assert.equal(await page.locator('#viewportDebug').isVisible(),false);
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
}
async function launchLandscape(browser,name,host) {
  const [page,errors] = await open(browser,host,'/fix?debug=1',844,390);
  try {
    await page.setViewportSize({width:390,height:844});
    await size(page,390,844);
    assert.equal(await page.locator('#rotateHint').isVisible(),false);
    await page.locator('#viewportDebug summary').tap();
    await page.waitForFunction(() => document.getElementById('viewportDetails').value.includes('Game: portrait'));
    const report = await page.locator('#viewportDetails').inputValue();
    assert.match(report,/Context: top-level/);
    assert.match(report,/matchMedia: portrait/);
    assert.match(report,/Canvas: 780×1688 px/);
    assert.match(report,/window\.resize|matchMedia\.orientation|visualViewport\.resize/);
    await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{
      value:{writeText:async text => { window.__copiedDiagnostic = text; }},configurable:true,
    }));
    await page.locator('#copyViewport').tap();
    await page.waitForFunction(() => document.getElementById('copyViewportStatus').textContent === '已复制');
    assert.match(await page.evaluate(() => window.__copiedDiagnostic),/Game: portrait/);
    await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true}));
    await page.locator('#copyViewport').tap();
    assert.equal(await page.locator('#copyViewportStatus').textContent(),'请长按或使用系统复制');
    assert.ok(await page.locator('#viewportDetails').evaluate(el => el.selectionEnd>el.selectionStart));
    await page.screenshot({path:path.join(evidence,name+'-debug-portrait.png')});
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
}
async function viewportSources(browser,name,host) {
  for (const route of ['/base','/fix']) {
    const init = () => {
      const vv = new EventTarget();
      Object.assign(vv,{width:390,height:844,offsetLeft:0,offsetTop:0,scale:1});
      Object.defineProperty(window,'visualViewport',{configurable:true,value:vv});
    };
    const [page,errors] = await open(browser,host,route,390,844,true,init);
    try {
      await page.setViewportSize({width:844,height:390});
      if (route === '/base') await page.waitForFunction(() => document.querySelector('canvas').clientWidth===844);
      else await size(page,844,390);
      await page.setViewportSize({width:390,height:844});
      await page.waitForFunction(() => document.querySelector('canvas').clientWidth===390);
      await page.evaluate(() => {
        window.dispatchEvent(new Event('orientationchange'));
        Object.assign(visualViewport,{width:844,height:390});
        visualViewport.dispatchEvent(new Event('resize'));
      });
      if (route === '/base') {
        await page.waitForTimeout(450);
        assert.equal(await page.locator('#cv').evaluate(el => el.clientWidth),390);
      } else {
        await size(page,844,390);
        assert.equal(await page.locator('#rotateHint').isVisible(),false);
        await page.evaluate(() => {
          Object.assign(visualViewport,{height:352,offsetTop:18});
          visualViewport.dispatchEvent(new Event('resize'));
          visualViewport.dispatchEvent(new Event('scroll'));
        });
        await size(page,844,352);
        assert.equal(await page.locator('#cv').evaluate(el => el.getBoundingClientRect().top),18);
        await page.evaluate(() => {
          Object.assign(visualViewport,{height:390,offsetTop:0});
          visualViewport.dispatchEvent(new Event('resize'));
        });
        await size(page,844,390);
      }
      assert.deepEqual(errors,[]);
    } finally { await page.close(); }
  }
  const absent = () => {
    Object.defineProperty(window,'visualViewport',{value:undefined,configurable:true});
    Object.defineProperty(screen,'orientation',{value:undefined,configurable:true});
  };
  const [page,errors] = await open(browser,host,'/fix',390,844,true,absent);
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await size(page,390,844);
    assert.equal(await page.locator('#rotateHint').isVisible(),true);
    await page.locator('#rotateSkip').tap();
    assert.equal(await page.locator('#rotateHint').isVisible(),false);
    await page.setViewportSize({width:844,height:390});
    await size(page,844,390);
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
  const [check] = await open(browser,host,'/orientation-check',390,844);
  try {
    assert.match(await check.locator('#details').inputValue(),/Context: top-level/);
    await check.setViewportSize({width:844,height:390});
    await check.waitForFunction(() => document.getElementById('details').value.includes('matchMedia: landscape'));
  } finally { await check.close(); }
  console.log(name+' geometry: baseline follows native window rotation but stays 390px with VV-only change; hotfix follows both sources, address height/offset, no-API fallback and standalone probe PASS');
}
async function rotatedSettingsSwipe(browser,host,url) {
  const [page,errors] = await open(browser,host,url,320,568);
  try {
    await sizeVirtual(page,320,568);
    await page.locator('#gear').tap();
    const panel = page.locator('#panel');
    const b = await panel.boundingBox();
    const session = await page.context().newCDPSession(page);
    const x = b.x + 12, y = b.y + 10;
    const send = (type,xx) => session.send('Input.dispatchTouchEvent',{
      type,touchPoints:type==='touchEnd' ? [] : [{x:xx,y}],
    });
    for (let i=0;i<8;i++) {
      await send('touchStart',x);
      for (let step=1;step<=6;step++) await send('touchMove',x+(b.width-24)*step/6);
      await send('touchEnd');
    }
    assert.deepEqual(errors,[]);
    return await panel.evaluate(el => ({top:el.scrollTop,max:el.scrollHeight-el.clientHeight}));
  } finally { await page.close(); }
}
async function compatibleLandscape(browser,name,host) {
  const [page,errors] = await open(browser,host,'/fix?debug=1',390,844);
  const nativeCalls = () => window.__nativeCalls;
  try {
    await page.evaluate(() => {
      window.__nativeCalls = [];
      Object.defineProperty(document,'fullscreenEnabled',{configurable:true,value:true});
      document.documentElement.requestFullscreen = async () => {
        __nativeCalls.push('fullscreen');
        throw new DOMException('test rejection','NotAllowedError');
      };
      Object.defineProperty(screen,'orientation',{configurable:true,value:{
        type:'portrait-primary',angle:0,
        lock:async mode => { __nativeCalls.push(mode); throw new DOMException('test rejection','SecurityError'); },
      }});
    });
    const hint = page.locator('#rotateHint');
    if (await hint.isVisible()) await page.locator('#rotateTry').click();
    else {
      await page.locator('#gear').click();
      await page.locator('#nativeLandscape').click();
    }
    await page.waitForFunction(() => nativeStatus.includes('SecurityError'));
    assert.deepEqual(await page.evaluate(nativeCalls),['fullscreen','landscape']);
    await safeArea(page,[47,11,34,7]);
    if (await hint.isVisible()) await page.locator('#rotateCompat').click();
    else await page.locator('[data-direction="compatible"]').click();
    await page.waitForFunction(() => virtualLandscape && W === 844 && H === 390);
    assert.deepEqual(await page.evaluate(() => [safeTop,safeRight,safeBottom,safeLeft]),[11,34,7,47]);
    assert.deepEqual(await page.evaluate(() => [cvs.width,cvs.height]),[1688,780]);
    await sizeVirtual(page,390,844);
    if (await page.locator('#panel').isVisible()) await page.locator('#btnClose').click();
    await page.getByRole('button',{name:/太阳系战役/}).click();
    await page.waitForFunction(() => game.state === 'map');
    await page.screenshot({path:path.join(evidence,name+'-virtual-map.png')});
    // Both the inverse rotation and a scaled container must map to the first station.
    await page.locator('#viewportHost').evaluate(el => {
      el.style.transformOrigin='0 0';
      el.style.transform='scale(.9)';
    });
    const mapped = await page.evaluate(() => {
      const {x,y} = mapNodePos(0);
      const b = cvs.getBoundingClientRect();
      return {x:b.right-y*b.width/H,y:b.top+x*b.height/W};
    });
    if (name === 'firefox') await page.mouse.click(mapped.x,mapped.y);
    else {
      await page.touchscreen.tap(mapped.x,mapped.y);
      assert.equal(await page.evaluate(() => game.state),'map');
      await page.touchscreen.tap(mapped.x,mapped.y);
    }
    await page.waitForFunction(() => game.state === 'levelIntro');
    await page.locator('#viewportHost').evaluate(el => { el.style.transform=''; });
    await page.waitForFunction(() => game.state === 'playing');
    const rects = await visibleControlBoxes(page,390,844,[47,11,34,7]);
    for (const r of rects) {
      assert.ok(await page.evaluate(({x,y,width,height}) =>
        Boolean(document.elementFromPoint(x+width/2,y+height/2)?.closest('button.iconBtn')),r));
    }
    const before = await page.evaluate(() => game.ship.fuel);
    const end = await input(page,name,rects);
    await page.waitForFunction(() => document.querySelector('#btnL.active') && document.querySelector('#btnT.active'));
    await page.waitForFunction(fuel => game.ship.fuel < fuel,before);
    await page.screenshot({path:path.join(evidence,name+'-virtual-flight.png')});
    await page.setViewportSize({width:844,height:390});
    await size(page,844,390);
    await page.waitForFunction(() => !virtualLandscape && !document.querySelector('.tbtn.active'));
    await end();
    await page.locator('#pauseBtn').click();
    await page.waitForFunction(() => manualPaused);
    const paused = await page.evaluate(ship);
    await page.locator('#gear').click();
    await page.locator('[data-direction="portrait"]').click();
    await size(page,293,390);
    assert.equal(await page.locator('[data-direction="portrait"]').getAttribute('aria-pressed'),'true');
    await page.locator('[data-direction="auto"]').click();
    await size(page,844,390);
    assert.equal(await page.locator('[data-direction="auto"]').getAttribute('aria-pressed'),'true');
    await page.locator('#btnClose').click();
    assert.deepEqual(await page.evaluate(ship),paused);
    assert.deepEqual(await page.evaluate(nativeCalls),['fullscreen','landscape']);
    await page.locator('#viewportDebug summary').click();
    await page.waitForFunction(() => document.getElementById('viewportDetails').value.includes('SecurityError'));
    await page.screenshot({path:path.join(evidence,name+'-direction-debug.png')});
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
  console.log(name+' compatible: rejected native request, virtual canvas/DPR, rotated insets, scaled map, controls/dual touch, native transition and mode exit preserve state PASS');
}
async function sizeVirtual(page,width,height) {
  await page.waitForFunction(([w,h]) => {
    const r = cvs.getBoundingClientRect();
    return r.width===w && r.height===h && r.left===0 && r.top===0;
  }, [width,height]);
}
async function compatibilityLink(browser,name,host) {
  const init = () => {
    window.__fullscreenRequests = 0;
    document.documentElement?.addEventListener('fullscreenchange', () => { window.__fullscreenRequests++; });
    Element.prototype.requestFullscreen = async function() { window.__fullscreenRequests++; };
  };
  const [page,errors] = await open(browser,host,'/fix?compat=1&debug=1',390,844,false,init);
  try {
    await sizeVirtual(page,390,844);
    assert.deepEqual(await page.evaluate(() => [coarseQuery.matches,virtualLandscape,W,H,__fullscreenRequests]),[false,true,844,390,0]);
    await page.evaluate(() => { game.jump(0); });
    await page.locator('#pauseBtn').click();
    await page.waitForFunction(() => manualPaused);
    const before = await page.evaluate(ship);
    await page.locator('#gear').click();
    await page.getByRole('button',{name:'退出兼容'}).click();
    await size(page,390,844);
    await page.locator('#btnClose').click();
    assert.deepEqual(await page.evaluate(ship),before);
    assert.equal(new URL(page.url()).search,'?debug=1');
    await page.reload();
    await page.waitForFunction(() => directionMode==='auto' && !virtualLandscape);
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
  const [probePage,probeErrors] = await open(browser,host,'/orientation-check',390,844);
  try {
    await probePage.getByRole('button',{name:'记录竖放时'}).click();
    await probePage.setViewportSize({width:844,height:390});
    await probePage.waitForFunction(() => innerWidth===844 && innerHeight===390);
    await probePage.getByRole('button',{name:'记录横放后'}).click();
    const report = await probePage.locator('#details').inputValue();
    assert.match(report,/竖放时记录\nwindow 390×844/);
    assert.match(report,/横放后记录\nwindow 844×390/);
    assert.deepEqual(probeErrors,[]);
  } finally { await probePage.close(); }
  console.log(name+' closeout: explicit URL without coarse pointer or fullscreen, exit preserves paused flight and cleans URL, paired diagnostic captures PASS');
}
async function containerAndNative(browser,name,host) {
  const [page,errors] = await open(browser,host,'/fix?debug=1',390,844);
  try {
    await page.locator('#viewportHost').evaluate(el => { el.style.maxWidth='320px'; el.style.maxHeight='568px'; });
    await size(page,320,568);
    assert.deepEqual(await page.evaluate(() => [innerWidth,innerHeight,hostW,hostH]),[390,844,320,568]);
    await page.locator('#viewportHost').evaluate(el => { el.style.maxHeight='280px'; });
    await size(page,320,280);
    assert.equal(await page.locator('#rotateHint').isVisible(),false);
    await page.evaluate(() => {
      window.__nativeCalls=[];
      let full=null;
      Object.defineProperty(document,'fullscreenEnabled',{configurable:true,value:true});
      Object.defineProperty(document,'fullscreenElement',{configurable:true,get:()=>full});
      document.documentElement.requestFullscreen=async () => {
        __nativeCalls.push('fullscreen'); full=document.documentElement;
        document.dispatchEvent(new Event('fullscreenchange'));
      };
      document.exitFullscreen=async () => {
        __nativeCalls.push('exit'); full=null;
        document.dispatchEvent(new Event('fullscreenchange'));
      };
      Object.defineProperty(screen,'orientation',{configurable:true,value:{
        lock:async mode => { __nativeCalls.push(mode); },
        unlock:() => { __nativeCalls.push('unlock'); },
      }});
    });
    await page.locator('#gear').click();
    await page.locator('#nativeLandscape').click();
    await page.getByRole('button',{name:'退出原生全屏横屏'}).waitFor();
    await page.getByRole('button',{name:'退出原生全屏横屏'}).click();
    await page.getByRole('button',{name:'尝试原生全屏横屏'}).filter({visible:true}).waitFor();
    assert.deepEqual(await page.evaluate(() => __nativeCalls),['fullscreen','landscape','unlock','exit']);
    await page.evaluate(() => {
      Object.defineProperty(document,'fullscreenEnabled',{configurable:true,value:false});
      Object.defineProperty(screen,'orientation',{configurable:true,value:undefined});
    });
    await page.locator('#nativeLandscape').click();
    await page.waitForFunction(() => nativeStatus.includes('orientation.lock unavailable'));
    assert.deepEqual(await page.evaluate(() => __nativeCalls),['fullscreen','landscape','unlock','exit']);
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
  const embedded = await browser.newPage({viewport:{width:800,height:650}});
  try {
    await embedded.goto(host+'/embedded');
    const frame = embedded.frameLocator('#embedded');
    const canvas = frame.locator('#cv');
    assert.equal(await canvas.evaluate(el => el.clientWidth),320);
    if (name==='chromium' || name==='edge') assert.equal(await canvas.evaluate(() => document.fullscreenEnabled),false);
    await frame.locator('#viewportDebug summary').click();
    await embedded.waitForFunction(() =>
      document.querySelector('#embedded').contentDocument.getElementById('viewportDetails').value.includes('Context: embedded'));
    await embedded.locator('#embedded').evaluate(el => {
      el.style.width='568px'; el.style.height='320px';
    });
    await embedded.waitForFunction(() => document.querySelector('#embedded').contentDocument.querySelector('#cv').clientWidth === 568);
  } finally { await embedded.close(); }
  console.log(name+' container: ResizeObserver-only size changes, native success/exit capability stubs, iframe sizing/policy diagnostic PASS');
}
async function regression(browser,name,host) {
  const comparison = [];
  // A saved Starship choice must not alter the campaign's assigned ship.
  const runs = [['/release','classic'], ['/fix','starship']];
  for (const [route,modelId] of runs) {
    const [page,errors] = await open(browser,host,route,568,320,true,instrument,true,{vl_cfg:{skin:modelId}});
    try {
      const result = await page.evaluate(({isNew,modelId}) => {
        __frames.frozen = true;
        const require = (condition,message) => {if (!condition) throw new Error(message);};
        const snapshot = () => [game.state,game.ship.x,game.ship.y,game.ship.vx,game.ship.vy,game.ship.a,game.ship.fuel,game.lives,game.score];
        const flights = [];
        gotoMap();
        launch(1);
        require(game.state === 'map','locked station blocked');
        for (let i=0;i<10;i++) {
          gotoMap(); runFresh = true; launch(i); require(game.state === 'levelIntro','legal launch '+i);
          game.tick(1210); require(game.state === 'playing','intro '+i);
          if (isNew) require(ship.modelId === 'classic' && game.settings.skin === modelId && ship.fuelCapacity === levelDef.fuel,'assigned model and tank '+i);
          const fuel = game.ship.fuel;
          window.dispatchEvent(new KeyboardEvent('keydown',{code:'ArrowUp'}));
          game.tick(120);
          window.dispatchEvent(new KeyboardEvent('keyup',{code:'ArrowUp'}));
          game.tick(50);
          require(game.ship.fuel < fuel,'thrust consumes fuel '+i);
          const flight = snapshot();
          computePrediction();
          const forecast = JSON.stringify(pred);
          require(pred.pts.length > 1,'prediction '+i);
          require(JSON.stringify(flight) === JSON.stringify(snapshot()),'prediction leaves ship unchanged '+i);
          const target = game.P ? {cx:game.P.cx,y:game.P.cy-game.P.R} : game.padProbe().probes[0];
          game.teleport(target.cx,target.y-9.1,0,55,0);
          game.tick(25);
          require(game.state === 'crashed','hard collision '+i);
          for (let step=0; step<175 && game.state !== 'playing'; step++) game.tick(17);
          require(game.state === 'playing','respawn '+i+' ('+game.state+')');
          const soft = game.P ? {cx:game.P.cx,y:game.P.cy-game.P.R} : game.padProbe().probes[0];
          game.teleport(soft.cx,soft.y-9.1,0,6,0);
          game.tick(40);
          require(game.state === 'landed' && game.progress.stars[i] === 3,'soft landing '+i);
          flights.push({flight,forecast,result:snapshot()});
          if (landPad) {
            const offset = landOff;
            game.tick(120);
            require(Math.abs(ship.x - padCX(landPad,time) - offset) < 1e-7,'moving landing deck '+i);
            require(Math.abs(ship.y - padY(landPad,time) + 9) < 1e-7,'moving landing height '+i);
          }
        }
        require(game.progress.unlocked === 9 && game.stats.landings === 10 && game.stats.crashes === 10,'progress/stats');
        const storage = [localStorage.getItem('vl_progress'),localStorage.getItem('vl_stats')];
        require(JSON.parse(storage[0]).stars.every(n => n===3),'persisted stars');
        require(JSON.parse(storage[1]).landings===10,'persisted stats');
        return {flights,storage};
      }, {isNew:route==='/fix',modelId});
      comparison.push(result);
      if (route === '/fix') {
        await page.setViewportSize({width:320,height:568});
        await page.evaluate(() => { __frames.frozen = false; });
        await size(page,320,568);
        assert.equal(await page.evaluate(() => game.state),'landed');
        await page.screenshot({path:path.join(evidence,name+'-landed-portrait.png')});
        await page.setViewportSize({width:568,height:320});
        await size(page,568,320);
        await page.evaluate(() => { game.jump(4); game.ship.fuel=19; });
        const textPaint = await page.evaluate(() => {
          const all = [];
          const original = CanvasRenderingContext2D.prototype.fillText;
          CanvasRenderingContext2D.prototype.fillText = function(word,...args) {
            all.push([word,this.fillStyle]);
            original.call(this,word,...args);
          };
          const savedTime = time;
          try {
            time = Math.PI/12; game.draw();
            time = Math.PI/4; game.draw();
          } finally { time = savedTime; CanvasRenderingContext2D.prototype.fillText = original; }
          return all;
        });
        assert.deepEqual(textPaint.filter(([word]) => word==='LOW FUEL 低燃料').map(([,color])=>color), ['#ffb347','#ffd08d']);
        assert.ok(!textPaint.some(([word])=>word==='地球'));
        await page.screenshot({path:path.join(evidence,name+'-d5-568x320.png')});
        await page.evaluate(() => {
          const target = game.padProbe().probes[0];
          game.teleport(target.cx,target.y-9.1,0,57,0);
          game.tick(25);
        });
        await page.waitForFunction(() => game.state === 'crashed');
        const lives = await page.evaluate(() => game.lives);
        await page.setViewportSize({width:320,height:568});
        await size(page,320,568);
        assert.equal(await page.evaluate(() => game.state),'crashed');
        assert.equal(await page.evaluate(() => game.lives),lives);
        await page.screenshot({path:path.join(evidence,name+'-crash-portrait.png')});
      }
      assert.deepEqual(errors,[]);
    } finally { await page.close(); }
  }
  assert.deepEqual(comparison[1],comparison[0],'seeded flight states, prediction and landings unchanged from baseline');
  console.log(name+' campaign: 10 assigned-model starts, forecasts, collisions and assisted landings match Sprint 10 exactly; saved progression, moving decks and rotating settlement PASS');
}
async function vehicleControls(browser,name,host) {
  const [page,errors] = await open(browser,host,'/fix',568,320,true,instrument,true,{
    vl_cfg:{skin:'falcon9',thrust:47},
    vl_progress:{unlocked:2,stars:[3,1,0,0,0,0,0,0,0,0]},
    vl_stats:{landings:2,crashes:1,perfects:1},
  });
  try {
    await page.evaluate(() => { game.jump(0); game.ship.fuel -= 10; });
    const before = await page.evaluate(() => [ship.modelId,ship.fuel,ship.x,ship.y,S.thrust,game.progress.unlocked,game.stats.landings]);
    assert.deepEqual([before[0],before[4],before[5],before[6]],['falcon9',47,2,2]);
    await page.locator('#gear').click();
    await page.getByRole('button',{name:'星舰',exact:true}).click();
    await page.locator('#btnClose').click();
    assert.deepEqual(await page.evaluate(() => [ship.modelId,ship.fuel,ship.x,ship.y,S.thrust,game.progress.unlocked,game.stats.landings]),before);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('vl_cfg')).skin),'starship');
    await page.keyboard.press('r');
    assert.deepEqual(await page.evaluate(() => [ship.modelId,ship.spin,ship.fuel===ship.fuelCapacity]),['starship',0,true]);
    await page.reload();
    await page.waitForFunction(() => game.settings.skin === 'starship');
    assert.deepEqual(await page.evaluate(() => [game.settings.thrust,game.progress.unlocked,game.progress.stars[0],game.stats.landings]),[47,2,3,2]);
    const models = await page.evaluate(() => {
      const models = {};
      for (const id of MODEL_KEYS) {
        S.skin = id;
        game.jump(0);
        game.teleport(1300,200);
        const model = currentModel();
        const full = { ...ship }, light = { ...ship, fuel:ship.fuel/2 };
        const mass = vehicleMass(full,model), lightMass = vehicleMass(light,model);
        fireEngine(full,model,FIXED);
        fireEngine(light,model,FIXED);
        keys.right = true; keys.up = true;
        const before = JSON.stringify(ship);
        const gravity = Math.max(1,levelDef.g*S.gScale);
        const eta = Math.sqrt(2*gravity*Math.max(0,heightAt(ship.x)-ship.y))/gravity;
        const stride = Math.ceil(Math.ceil(clamp(eta+2,4,24)/FIXED)/64);
        computePrediction();
        if (JSON.stringify(ship)!==before || !pred.pts.length) throw Error(id+' prediction mutated ship or has no points');
        const target = pred.pts[0];
        game.tick(stride*1000/120);
        if (Math.hypot(ship.x-target.x,ship.y-target.y)>1e-10) throw Error(id+' live path differs from prediction');
        keys.right = false; keys.up = false;
        const spin = ship.spin;
        game.tick(1000/120);
        const remainingSpin = ship.spin;
        game.teleport(1300,200);
        ship.fuel = 0;
        keys.up = true;
        game.tick(1000/120);
        keys.up = false;
        if (ship.fuel!==0 || ship.thrusting || ship.vy<=0) throw Error(id+' empty-tank behavior');
        game.jump(9);
        game.teleport(2000,-350,15,2);
        keys.up = true; keys.right = true;
        const start = performance.now();
        for (let i=0;i<50;i++) computePrediction();
        const predictionMs = +( (performance.now()-start)/50 ).toFixed(2);
        keys.up = false; keys.right = false;
        models[id] = {mass,lightMass,fuel:full.fuelCapacity,burn:+((full.fuelCapacity-full.fuel)/FIXED).toFixed(2),
                      fullDv:+(-full.vy).toFixed(5), lightDv:+(-light.vy).toFixed(5), spin,remainingSpin,
                      hull:model.pts.map(([x,y])=>[x,y]),predictionMs};
      }
      return models;
    });
    const {classic,falcon9,starship} = models;
    assert.ok(classic.mass<falcon9.mass && falcon9.mass<starship.mass);
    assert.ok(classic.fuel<falcon9.fuel && falcon9.fuel<starship.fuel);
    assert.ok(classic.burn<falcon9.burn && falcon9.burn<starship.burn);
    assert.equal(classic.fullDv,classic.lightDv);
    for (const model of [falcon9,starship]) {
      assert.ok(model.lightMass<model.mass && model.fullDv<model.lightDv);
      assert.ok(model.spin>model.remainingSpin && model.remainingSpin>0);
    }
    assert.notEqual(falcon9.fullDv,starship.fullDv);
    assert.ok(falcon9.spin>starship.spin);
    assert.notDeepEqual(falcon9.hull,starship.hull);
    assert.notDeepEqual(classic.hull,falcon9.hull);
    assert.deepEqual(errors,[]);
    const timings = Object.fromEntries(Object.entries(models).map(([id,m])=>[id,m.predictionMs]));
    console.log(name+' vehicle controls: old saves, next-launch/reset model, distinct mass/thrust/tank/burn/inertia/hull and exact first live prediction sample PASS; D10 forecast ms '+JSON.stringify(timings));
  } finally { await page.close(); }
}
async function playModes(browser,name,host) {
  const [page,errors] = await open(browser,host,'/fix?compat=1',390,844,true,instrument,false,{
    vl_cfg:{skin:'starship'},
    vl_progress:{unlocked:1,stars:[3,0,0,0,0,0,0,0,0,0]},
    vl_stats:{landings:2,crashes:1,perfects:1},
    vl_best:1234,
  });
  try {
    await sizeVirtual(page,390,844);
    await page.getByRole('button',{name:/回收挑战/}).click();
    const recovery = page.locator('#recoveryScreen');
    await recovery.getByText('Falcon 9 · 即将开放').waitFor();
    await recovery.getByText('Super Heavy · 即将开放').waitFor();
    assert.equal(await recovery.getByRole('button').count(),1);
    await recovery.getByRole('button',{name:'返回玩法'}).click();
    await page.getByRole('button',{name:/自由飞行/}).click();
    await page.locator('#freeSetupScreen').waitFor();
    assert.equal(await page.locator('#freeScene option').count(),10);
    assert.equal(await page.locator('#freeModel').inputValue(),'starship');
    await page.locator('#freeScene').selectOption('5');
    assert.equal(await page.locator('#freeModel option[value="starship"]').evaluate(option => option.disabled),true);
    assert.equal(await page.locator('#freeModel').inputValue(),'classic');
    await page.locator('#freeModel').selectOption('falcon9');
    await page.getByRole('button',{name:'开始飞行'}).click();
    await page.waitForFunction(() => game.mode==='free' && game.state==='playing');
    assert.deepEqual(await page.evaluate(() => [game.level,game.ship.modelId]),[5,'falcon9']);
    await page.setViewportSize({width:844,height:390});
    await size(page,844,390);
    await page.locator('#gear').click();
    await page.getByRole('button',{name:'星舰',exact:true}).click();
    await page.getByRole('button',{name:'重试本场'}).click();
    await page.waitForFunction(() => game.state==='playing');
    assert.equal(await page.evaluate(() => game.ship.modelId),'falcon9');
    await page.evaluate(() => { crash('自动化验证'); game.tick(1750); });
    await page.getByRole('heading',{name:'自由飞行 · 飞行结束'}).waitFor();
    await page.getByRole('button',{name:'再飞一次'}).click();
    await page.waitForFunction(() => game.state==='playing');
    assert.deepEqual(await page.evaluate(() => [game.level,game.ship.modelId,game.lives]),[5,'falcon9',4]);
    await page.locator('#gear').click();
    await page.getByRole('button',{name:'返回本模式'}).click();
    await page.locator('#freeSetupScreen').getByRole('button',{name:'返回玩法'}).click();
    await page.getByRole('button',{name:/太阳系战役/}).click();
    await page.getByRole('button',{name:'返回玩法'}).waitFor();
    assert.deepEqual(await page.evaluate(() => [game.progress.unlocked,game.best,game.stats.landings,game.stats.crashes]),[1,1234,2,1]);
    await page.getByRole('button',{name:'返回玩法'}).click();
    await page.getByRole('button',{name:/太阳系战役/}).waitFor();
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }

  const [batch,batchErrors] = await open(browser,host,'/fix',568,320,true,instrument,true);
  try {
    const totals = await batch.evaluate(() => {
      const check = (ok,message) => { if (!ok) throw Error(message); };
      const campaign = () => JSON.stringify({
        score,lives,runFresh,best,progress,stats,
        storage:['vl_best','vl_progress','vl_stats','vl_cfg'].map(key => localStorage.getItem(key)),
      });
      gotoMap(); launch(0); game.tick(1210); crash('校验战役在途连续性'); gotoHome();
      const initial = campaign();
      let starts=0, landings=0, failures=0;
      for (const mission of FREE_MISSIONS) {
        for (const modelId of mission.models) {
          check(startMission(mission,modelId),'start '+mission.levelIndex+' '+modelId);
          check(game.mode==='free' && ship.modelId===modelId,'chosen model');
          starts++;
          game.tick(1210);
          const target = game.P ? {cx:game.P.cx,y:game.P.cy-game.P.R} : game.padProbe().probes[0];
          game.teleport(target.cx,target.y-9.1,0,55,0);
          game.tick(25);
          check(state==='crashed','hard collision '+mission.levelIndex);
          game.tick(1800);
          check(state==='freeResult' && !missionResult.landed && campaign()===initial,'failed flight isolation');
          failures++;
          retryFreeFlight(); game.tick(1210);
          const soft = game.P ? {cx:game.P.cx,y:game.P.cy-game.P.R} : game.padProbe().probes[0];
          game.teleport(soft.cx,soft.y-9.1,0,6,0);
          game.tick(40);
          check(state==='landed','assisted landing '+mission.levelIndex);
          game.tick(1850);
          check(state==='freeResult' && missionResult.landed && campaign()===initial,'successful flight isolation');
          landings++;
        }
      }
      gotoFreeSetup();
      check(!startMission(FREE_MISSIONS[5],'starship') && state==='freeSetup','compatibility enforced at launch');
      check(!startMission(RECOVERY_MISSIONS[0]) && state==='freeSetup','reserved challenge cannot launch');
      return {starts,failures,landings};
    });
    assert.deepEqual(totals,{starts:29,failures:29,landings:29});
    assert.deepEqual(batchErrors,[]);
  } finally { await batch.close(); }
  console.log(name+' modes: home/three menus, mobile rotation, 29 allowed free scene-model pairs, incompatible/reserved launch rejected, 29 crashes/retries and 29 assisted free landings isolate active campaign and storage PASS');
}
async function performanceSample(browser,name,host) {
  const values = [];
  for (const route of ['/release','/fix']) {
    const [page,errors] = await open(browser,host,route,844,390);
    try {
      await page.evaluate(() => { game.jump(9); __frames.times.length=0; });
      await page.waitForFunction(() => __frames.times.length >= 120, null, {timeout:12000});
      values.push(await page.evaluate(() => {
        const {times,maxPending} = __frames;
        const d = times.slice(1,120).map((t,i) => t-times[i]).sort((a,b)=>a-b);
        return {median:+d[Math.floor(d.length/2)].toFixed(1),p95:+d[Math.floor(d.length*0.95)].toFixed(1),maxPending};
      }));
      assert.deepEqual(errors,[]);
    } finally { await page.close(); }
  }
  assert.equal(values[0].maxPending,1);
  assert.equal(values[1].maxPending,1);
  console.log(name+' D10 RAF ms '+JSON.stringify({baseline:values[0],hotfix:values[1]}));
}
(async () => {
  const server = await serve();
  try {
    console.log('Screenshots: '+evidence);
    const host = 'http://127.0.0.1:'+server.address().port;
    const engines = [
      ['chromium',chromium,{executablePath:process.env.SPACER_TEST_CHROME}],
      ['webkit',webkit,{}],
      ['firefox',firefox,{}],
    ];
    if (process.env.SPACER_TEST_EDGE) engines.push(['edge',chromium,{executablePath:process.env.SPACER_TEST_EDGE}]);
    for (const [name,engine,options] of engines) {
      if (process.argv[2] && process.argv[2] !== name) continue;
      const browser = await engine.launch({headless:true,...options});
      try {
        console.log(name+' '+browser.version());
        if (name !== 'firefox') {
          await viewportSources(browser,name,host);
          const sizes = name === 'edge' ? profiles.filter(setup=>[320,390].includes(setup[0])) : profiles;
          for (const setup of sizes) {
            await dynamic(browser,name,host,setup,setup[0]===390);
            console.log(name+' dynamic '+setup[0]+'x'+setup[1]+' ↔ '+setup[2]+'x'+setup[3]+' PASS');
          }
          await launchLandscape(browser,name,host);
          console.log(name+' landscape-first and debug clipboard fallback PASS');
        }
        await containerAndNative(browser,name,host);
        if (name === 'chromium') {
          const scroll = await rotatedSettingsSwipe(browser,host,'/fix?compat=1');
          assert.ok(scroll.max>0 && Math.abs(scroll.max-scroll.top)<2,JSON.stringify(scroll));
          console.log('Rotated settings touch swipe reached bottom',scroll);
        }
        await compatibleLandscape(browser,name,host);
        await compatibilityLink(browser,name,host);
        await regression(browser,name,host);
        await vehicleControls(browser,name,host);
        await playModes(browser,name,host);
        if (name === 'chromium' || name === 'webkit') await performanceSample(browser,name,host);
      } finally { await browser.close(); }
    }
  } finally { server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
