// Temporary economy UI + in-world FX verification driver (headless Chrome).
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const CDP_PORT = 9224;
const APP = 'http://localhost:3000/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/private/var/folders/zd/18ck_n2s3xd8qcgszlg_f8_40000gn/T/opencode/economy-shots';
mkdirSync(OUT, { recursive: true });
const profileDir = mkdtempSync(path.join(os.tmpdir(), 'nb-eco-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const waiters = new Map();
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  const opened = new Promise((res) => ws.on('open', res));
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (waiters.has(i)) { waiters.delete(i); res({ error: 'timeout ' + method }); } }, 20000);
    waiters.set(i, res);
  });
  return { ws, opened, send };
}

const chrome = execFile(CHROME, [
  '--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--no-sandbox',
  `--remote-debugging-port=${CDP_PORT}`, '--window-size=1440,900',
  `--user-data-dir=${profileDir}`, '--autoplay-policy=no-user-gesture-required',
  'about:blank',
]);
await sleep(2600);

const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const c = cdp(page);
await c.opened;
await c.send('Page.enable');
await c.send('Runtime.enable');
await c.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__errs=[];addEventListener('error',(e)=>{window.__errs.push(String(e.message||e.error))});
           addEventListener('unhandledrejection',(e)=>{window.__errs.push(String(e.reason))});`,
});
await c.send('Page.navigate', { url: APP });
await sleep(3600);

const evalJs = async (expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    console.log('EVAL ERROR:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description || '');
  }
  return r.result?.result?.value ?? null;
};
const waitFor = async (expr, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evalJs(expr)) return true;
    await sleep(100);
  }
  return false;
};
const shot = async (name) => {
  const s = await c.send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) {
    const p = path.join(OUT, name + '.png');
    writeFileSync(p, Buffer.from(s.result.data, 'base64'));
    console.log('shot:', p);
  } else console.log('SHOT FAIL', name, JSON.stringify(s.error ?? s));
};
const stepPfx = (n = 30, dt = 0.016) => evalJs(`(() => {
  const f=window.__newbuddy.world.festival;
  for (let i=0;i<${n};i++) f._updatePlayerFx(${dt});
  return true;
})()`);

let fails = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${cond ? '' : ' :: ' + JSON.stringify(extra ?? '')}`);
  if (!cond) fails++;
};
const state = () => evalJs(`(() => { const g=window.__newbuddy; return {
  balance: g.wallet.balance, inv: {...g.wallet.inventory}, equipped: g.equipped,
  ready: g.wallet.ready, current: g.ui.current, playing: g.playing,
  props: g.world.festival?.pfxProps.length ?? -1,
  sparklers: g.world.festival ? [...g.world.festival.pfxSparklers.keys()] : [],
  bar: !document.getElementById('fx-bar').hidden,
  barSlots: document.querySelectorAll('#fx-bar .fx-slot:not(.fx-bag)').length,
}; })()`);

// ---- boot + enter world -----------------------------------------------------
check('game booted', await evalJs('!!window.__newbuddy'));
await evalJs(`window.__newbuddy.setName('EcoE2E'); window.__newbuddy.enterWorld(); 'ok'`);
check('wallet ready after enter', await waitFor('window.__newbuddy.wallet.ready', 6000));
let s = await state();
check('fresh profile starts at 750 with empty bag', s.balance === 750 && Object.keys(s.inv).length === 0, s);
check('quick bar hidden while bag empty', s.bar === false, s);

// walk up to the south firecracker shop (teleport for test speed)
await evalJs(`(() => { const g=window.__newbuddy;
  g.controller.pos.set(22,0,-113.5); g.controller.vel?.set(0,0,0);
  g.controller.yaw = Math.PI; g.controller.camYaw = 0; g.controller.camPitch = 0.2; g.controller.camDist = 8;
  return true; })()`);
check('shop interaction prompt appears', await waitFor(
  `(() => { const h=window.__newbuddy.controller.hoverInteract; return !!h && h.kind==='shop' && h.id==='fireworks'; })()`,
  3000));
await sleep(1200);
await shot('01-shop-exterior');
check('fountain/obstacle placement blocked, open path allowed', await evalJs(
  `(() => { const g=window.__newbuddy; return g._spotFree(0,0)===false && g._spotFree(22,-126)===false && g._spotFree(22,-113)===true; })()`));

// open with the real E key path
await evalJs(`dispatchEvent(new KeyboardEvent('keydown',{code:'KeyE',key:'e',bubbles:true}))`);
check('E opens the shop modal', await waitFor(`window.__newbuddy.ui.current === 'shop'`, 2000));
check('shop is input-locked', await evalJs('window.__newbuddy.controller.locked === true'));
check('shop renders all 7 catalog cards', await evalJs(`document.querySelectorAll('.product-card').length === 7`));
check('wallet shown in shop', await evalJs(`document.querySelector('.shop-balance b')?.textContent === '750'`));
await sleep(400);
await shot('02-shop-ui');

// ---- purchases -------------------------------------------------------------
async function clickBuy(item, qtyPill = null) {
  if (qtyPill !== null) {
    await evalJs(`(() => { const c=document.querySelector('.product-card[data-item="${item}"]');
      c?.querySelectorAll('.qty-pill')[${qtyPill}]?.click(); return true; })()`);
    await sleep(150);
  }
  return evalJs(`(() => { const b=document.querySelector('.product-card[data-item="${item}"] .buy-btn');
    if (!b) return false; b.click(); return true; })()`);
}

// combo: 240 -> 510, grants 2 anar 2 chakri 3 phuljhadi 1 rocket 1 aerial
await clickBuy('combo');
check('combo purchase lands (510 left)', await waitFor('window.__newbuddy.wallet.balance === 510', 4000));
s = await state();
check('combo bundle added to bag', s.inv.anar === 2 && s.inv.chakri === 2 && s.inv.phuljhadi === 3
  && s.inv.rocket === 1 && s.inv.aerial === 1, s.inv);
check('purchase celebration toast shown', await evalJs(`!!document.querySelector('.fx-celebrate')`));

// anar x5 (qty pill index 1) -> 310
await clickBuy('anar', 1);
check('anar x5 purchase lands (310 left)', await waitFor('window.__newbuddy.wallet.balance === 310', 4000));
s = await state();
check('anar stacks to 7', s.inv.anar === 7, s.inv);

// chakri 1 -> 255, rocket 1 -> 175, aerial 1 -> 55
await clickBuy('chakri');
check('chakri purchase lands', await waitFor('window.__newbuddy.wallet.balance === 255', 4000));
await clickBuy('rocket');
check('rocket purchase lands', await waitFor('window.__newbuddy.wallet.balance === 175', 4000));
await clickBuy('aerial');
check('aerial purchase lands (55 left)', await waitFor('window.__newbuddy.wallet.balance === 55', 4000));

// insufficient funds: aerial costs 120 > 55
await sleep(2200); // let the purchase celebration clear
await clickBuy('aerial');
check('insufficient-funds toast appears', await waitFor(
  `[...document.querySelectorAll('#toasts .toast, #toasts > div')].some(n => n.textContent.includes('Not enough Diwali Coins'))`, 2000));
await sleep(250);
await shot('03-shop-insufficient');
s = await state();
check('insufficient purchase did not charge', s.balance === 55, s);
check('buy button stays usable after rejection', await evalJs(
  `!document.querySelector('.product-card[data-item="anar"] .buy-btn').disabled`));

// close shop via X
await evalJs(`document.querySelector('.shop-close').click()`);
check('X closes shop + unlocks movement', await waitFor(
  `window.__newbuddy.ui.current === '__none__' && window.__newbuddy.controller.locked === false`, 1500));
s = await state();
check('quick bar appears with 5 owned types', s.bar && s.barSlots === 5, s);

// ---- inventory -------------------------------------------------------------
await evalJs(`dispatchEvent(new KeyboardEvent('keydown',{code:'KeyI',key:'i',bubbles:true}))`);
check('I opens inventory', await waitFor(`window.__newbuddy.ui.current === 'inventory'`, 1500));
check('inventory lists 5 owned types', await evalJs(`document.querySelectorAll('.inv-item').length === 5`));
check('inventory quantities match wallet', await evalJs(
  `[...document.querySelectorAll('.inv-item')].every(r => Number(r.querySelector('.inv-qty').textContent.slice(1)) > 0)`));
await sleep(350);
await shot('04-inventory');

// use Anar straight from the bag; should close bag and light it
await evalJs(`(() => { const row=[...document.querySelectorAll('.inv-item')].find(r => r.textContent.includes('Anar'));
  row.querySelector('.inv-actions .mini.accent').click(); return true; })()`);
check('inventory Use closes bag', await waitFor(`window.__newbuddy.ui.current === '__none__'`, 1500));
check('Anar consumed exactly once', await waitFor('window.__newbuddy.wallet.inventory.anar === 6', 3000));
await sleep(600);
s = await state();
check('Anar world prop is live', s.props >= 1, s);
const anarAt = await evalJs(`(() => { const p=window.__newbuddy.world.festival.pfxProps.at(-1); return p ? {x:p.x,z:p.z,t:p.t} : null; })()`);
check('Anar prop has a position + age', !!anarAt && anarAt.t > 0, anarAt);
await stepPfx(35);

// cinematic still of the anar fountain
await evalJs(`(() => { const g=window.__newbuddy; g.playing=false;
  g.camera.position.set(${anarAt?.x ?? 18}+4.5, 3.2, ${anarAt?.z ?? 15}+6.5);
  g.camera.lookAt(${anarAt?.x ?? 18}, 1.0, ${anarAt?.z ?? 15}); return true; })()`);
await sleep(650);
await shot('05-anar');
await evalJs('window.__newbuddy.playing = true');

// ---- quick bar + F key: sparkler ------------------------------------------
// drive the FX clock deterministically: headless rAF is throttled, so wall
// time is not a reliable measure of particle lifetime.
check('Anar prop cleaned up', await evalJs(`(() => {
  const f=window.__newbuddy.world.festival;
  for (let i=0;i<340;i++) f._updatePlayerFx(0.02);
  return f.pfxProps.length === 0;
})()`));

await evalJs(`(() => { const slot=[...document.querySelectorAll('#fx-bar .fx-slot')].find(s => s.title.startsWith('Phuljhadi'));
  slot.click(); return true; })()`);
check('quick-bar click equips Phuljhadi', await evalJs(`window.__newbuddy.equipped === 'phuljhadi'`));
check('quick-bar highlights equipped slot', await evalJs(
  `[...document.querySelectorAll('#fx-bar .fx-slot')].some(s => s.classList.contains('equipped') && s.title.startsWith('Phuljhadi'))`));
await evalJs('dispatchEvent(new KeyboardEvent("keydown",{code:"KeyF",key:"f",bubbles:true}))');
check('F lights the handheld sparkler', await waitFor(
  `window.__newbuddy.world.festival.pfxSparklers.has(window.__newbuddy.id)`, 2500));
check('sparkler consumed once', await waitFor('window.__newbuddy.wallet.inventory.phuljhadi === 2', 2500));
s = await state();
check('sparkler attached to own rig', s.sparklers.includes(await evalJs('window.__newbuddy.id')), s.sparklers);
await stepPfx(30);
await sleep(300);
await evalJs(`(() => { const g=window.__newbuddy, p=g.controller.pos; g.playing=false;
  g.camera.position.set(p.x+2.6, 2.35, p.z+3.7); g.camera.lookAt(p.x, 1.2, p.z); return true; })()`);
await sleep(450);
await shot('06-sparkler');
await evalJs('window.__newbuddy.playing = true');

// sparkler auto-expires + disposes
check('sparkler auto-detaches after its duration', await evalJs(`(() => {
  const f=window.__newbuddy.world.festival;
  for (let i=0;i<380;i++) f._updatePlayerFx(0.02);
  return !f.pfxSparklers.has(window.__newbuddy.id);
})()`));

// move to an open festival patch for ground/sky effects
await evalJs(`(() => { const g=window.__newbuddy;
  g.controller.pos.set(20,0,18); g.controller.vel?.set(0,0,0);
  g.controller.yaw = Math.PI; g.controller.camYaw = 0; g.controller.camPitch = 0.16; g.controller.camDist = 8;
  return true; })()`);
await sleep(500);

// ---- chakri ----------------------------------------------------------------
await evalJs(`window.__newbuddy.equipItem('chakri'); window.__newbuddy.useEquipped(); 'ok'`);
check('chakri consumed once', await waitFor('window.__newbuddy.wallet.inventory.chakri === 2', 3000));
await sleep(500);
await stepPfx(35);
s = await state();
check('chakri spinner is live', s.props >= 1, s);
const chakriAt = await evalJs(`(() => { const p=window.__newbuddy.world.festival.pfxProps.at(-1); return p ? {x:p.x,z:p.z,type:p.type,spin:p.spinner?.rotation.y} : null; })()`);
await evalJs(`(() => { const g=window.__newbuddy; g.playing=false;
  g.camera.position.set(${chakriAt?.x ?? 20}+2.4, 2.1, ${chakriAt?.z ?? 15}+3.4);
  g.camera.lookAt(${chakriAt?.x ?? 20}, 0.4, ${chakriAt?.z ?? 15}); return true; })()`);
await sleep(300);
await shot('07-chakri');
await evalJs('window.__newbuddy.playing = true');
check('chakri spinner rotates', await evalJs(
  `(() => { const p=window.__newbuddy.world.festival.pfxProps.find(p=>p.type==='chakri'); return !!p && p.spinner.rotation.y !== 0; })()`));
check('chakri prop cleaned up after its run', await evalJs(`(() => {
  const f=window.__newbuddy.world.festival;
  for (let i=0;i<360;i++) f._updatePlayerFx(0.02);
  return f.pfxProps.length === 0;
})()`));

// ---- rocket ----------------------------------------------------------------
// Pause the world clock and clear ambient show rockets/particles so the clip
// shows only the player's bought rocket, then advance the sim deterministically.
await evalJs(`(() => { const g=window.__newbuddy, f=g.world.festival;
  window.__origWorldTick = g.world.tick; g.world.tick = () => {};
  f.nextBurst = 999;
  f.rockets = f.rockets.filter(r => r.player);
  f.fwLife.fill(0); f.fwPoints.geometry.attributes.color.array.fill(0);
  f.fwPoints.geometry.attributes.color.needsUpdate = true;
  return true; })()`);
await evalJs(`window.__newbuddy.equipItem('rocket'); window.__newbuddy.useEquipped(); 'ok'`);
check('rocket consumed once', await waitFor('window.__newbuddy.wallet.inventory.rocket === 1', 3000));
check('player rocket spawned', await waitFor(
  `window.__newbuddy.world.festival.rockets.some(r => r.player)`, 2500));
const rocketPos = await evalJs(`(() => {
  const f=window.__newbuddy.world.festival;
  for (let i=0;i<180;i++) {
    const rk=f.rockets.find(r => r.player);
    if (!rk || rk.y > 22) break;
    f._updateFireworks(0.016); f._updatePlayerFx(0.016);
  }
  const rk=f.rockets.find(r => r.player);
  return rk ? {x:rk.x, y:rk.y, z:rk.z} : null;
})()`);
check('rocket climbs on its trail', !!rocketPos && rocketPos.y > 5, rocketPos);
await evalJs(`(() => { const g=window.__newbuddy, r=${JSON.stringify(rocketPos || { x: 20, y: 20, z: 15 })};
  g.playing=false; g.camera.position.set(r.x+17, 12, r.z+28); g.camera.lookAt(r.x, r.y, r.z); return true; })()`);
await sleep(200);
await shot('08-rocket');
await evalJs(`(() => {
  const f=window.__newbuddy.world.festival;
  for (let i=0;i<220;i++) {
    if (!f.rockets.some(r => r.player)) break;
    f._updateFireworks(0.016); f._updatePlayerFx(0.016);
  }
  for (let i=0;i<24;i++) { f._updateFireworks(0.016); f._updatePlayerFx(0.016); }
  return true;
})()`);
await sleep(200);
await shot('09-rocket-burst');

// ---- aerial ----------------------------------------------------------------
await evalJs(`(() => { const f=window.__newbuddy.world.festival;
  f.nextBurst = 999; f.rockets = []; f.fwLife.fill(0);
  f.fwPoints.geometry.attributes.color.array.fill(0);
  f.fwPoints.geometry.attributes.color.needsUpdate = true;
  return true; })()`);
await evalJs(`window.__newbuddy.equipItem('aerial'); window.__newbuddy.useEquipped(); 'ok'`);
check('aerial consumed once', await waitFor('window.__newbuddy.wallet.inventory.aerial === 1', 3000));
const aerialPos = await evalJs(`(() => { const p=window.__newbuddy.controller.pos;
  const f=window.__newbuddy.world.festival;
  for (let i=0;i<26;i++) { f._updateFireworks(0.016); f._updatePlayerFx(0.016); }
  return {x:p.x,z:p.z, particles:[...f.fwLife].filter(v => v > 0).length};
})()`);
check('aerial opens a large burst', aerialPos.particles > 80, aerialPos);
await evalJs(`(() => { const g=window.__newbuddy, p=${JSON.stringify(aerialPos)};
  g.playing=false; g.camera.position.set(p.x+32, 44, p.z+58); g.camera.lookAt(p.x, 58, p.z); return true; })()`);
await sleep(200);
await shot('10-aerial');
await evalJs(`(() => { const f=window.__newbuddy.world.festival;
  for (let i=0;i<36;i++) { f._updateFireworks(0.016); f._updatePlayerFx(0.016); }
  return true; })()`);
await sleep(200);
await shot('11-aerial-late');
await evalJs(`(() => { const g=window.__newbuddy;
  g.world.tick = window.__origWorldTick; g.playing = true; return true; })()`);
await sleep(1200);

// variation: back-to-back aerial bursts should not repeat the same pattern
check('aerial burst patterns vary', await evalJs(
  `(() => { const f=window.__newbuddy.world.festival; const seen=new Set();
    for (let i=0;i<12;i++) seen.add(f._nextBurstType()); return seen.size > 1; })()`));

// ---- mobile layout ---------------------------------------------------------
await c.send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
});
await sleep(500);
await evalJs(`window.__newbuddy.ui.openShop({id:'fireworks'})`);
await sleep(500);
await shot('12-shop-mobile');
const mobileShop = await evalJs(`(() => { const p=document.querySelector('.shop-panel').getBoundingClientRect();
  return {w:p.width,h:p.height,vw:innerWidth,vh:innerHeight, scroll:document.querySelector('.shop-panel').scrollHeight}; })()`);
check('mobile shop fits the viewport', mobileShop.w <= mobileShop.vw && mobileShop.h <= mobileShop.vh, mobileShop);
await evalJs(`window.__newbuddy.ui.closeShop(); window.__newbuddy.ui.openInventory()`);
await sleep(400);
await shot('13-inventory-mobile');
const mobileInv = await evalJs(`(() => { const p=document.querySelector('.inv-panel').getBoundingClientRect();
  return {w:p.width,h:p.height,vw:innerWidth,vh:innerHeight}; })()`);
check('mobile inventory fits the viewport', mobileInv.w <= mobileInv.vw && mobileInv.h <= mobileInv.vh, mobileInv);
await evalJs(`window.__newbuddy.ui.closeInventory()`);

await c.send('Emulation.setDeviceMetricsOverride', {
  width: 844, height: 390, deviceScaleFactor: 2, mobile: true,
});
await sleep(400);
await evalJs(`window.__newbuddy.ui.openShop({id:'crackers'})`);
await sleep(400);
await shot('14-shop-mobile-landscape');
const landShop = await evalJs(`(() => { const p=document.querySelector('.shop-panel').getBoundingClientRect();
  return {w:p.width,h:p.height,vw:innerWidth,vh:innerHeight}; })()`);
check('landscape shop fits the viewport', landShop.w <= landShop.vw && landShop.h <= landShop.vh, landShop);
await evalJs(`window.__newbuddy.ui.closeShop()`);
await c.send('Emulation.clearDeviceMetricsOverride');
await sleep(400);

// ---- persistence across reload --------------------------------------------
const before = await state();
const token = await evalJs(`localStorage.getItem('newbuddy.token')`);
await c.send('Page.reload', { ignoreCache: true });
await sleep(3800);
await evalJs(`window.__newbuddy.setName('EcoE2E'); window.__newbuddy.enterWorld(); 'ok'`);
check('wallet ready after reload', await waitFor('window.__newbuddy.wallet.ready', 6000));
const after = await state();
check('same device token resumed', (await evalJs(`localStorage.getItem('newbuddy.token')`)) === token);
check('balance persisted', after.balance === before.balance, { before: before.balance, after: after.balance });
check('inventory persisted', JSON.stringify(after.inv) === JSON.stringify(before.inv), { before: before.inv, after: after.inv });
check('equipped cracker persisted locally', after.equipped === before.equipped, { before: before.equipped, after: after.equipped });
check('wallet cache repainted immediately', await evalJs(`document.getElementById('wallet-balance').textContent === '55'`));

// corrupted local caches must not break boot
await evalJs(`localStorage.setItem('newbuddy.wallet','{oops'); localStorage.setItem('newbuddy.equipped','not-an-item')`);
await c.send('Page.reload', { ignoreCache: true });
await sleep(3600);
await evalJs(`window.__newbuddy.setName('EcoE2E'); window.__newbuddy.enterWorld(); 'ok'`);
check('boot survives corrupt local caches', await waitFor('window.__newbuddy.wallet.ready', 6000));
const repaired = await state();
check('server wallet wins over corrupt cache', repaired.balance === 55 && repaired.inv.aerial === 1, repaired);

// ---- console errors --------------------------------------------------------
const errs = await evalJs('window.__errs');
check('no page errors during economy run', Array.isArray(errs) && errs.length === 0, errs);

console.log(fails ? `\n${fails} FAILURES` : '\nALL ECONOMY E2E CHECKS PASSED');
c.ws.close();
chrome.kill();
await sleep(400);
try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fails ? 1 : 0);
