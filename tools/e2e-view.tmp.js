// Temporary: judge bought-firework visibility from the normal third-person camera.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const CDP_PORT = 9225;
const APP = "http://localhost:3000/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT =
  "/private/var/folders/zd/18ck_n2s3xd8qcgszlg_f8_40000gn/T/opencode/economy-shots";
const profileDir = mkdtempSync(path.join(os.tmpdir(), "nb-view-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const waiters = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && waiters.has(m.id)) {
      waiters.get(m.id)(m);
      waiters.delete(m.id);
    }
  });
  const opened = new Promise((res) => ws.on("open", res));
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => {
        if (waiters.has(i)) {
          waiters.delete(i);
          res({ error: "timeout " + method });
        }
      }, 20000);
      waiters.set(i, res);
    });
  return { ws, opened, send };
}

const chrome = execFile(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--use-angle=swiftshader",
  "--no-sandbox",
  `--remote-debugging-port=${CDP_PORT}`,
  "--window-size=1440,900",
  `--user-data-dir=${profileDir}`,
  "about:blank",
]);
await sleep(2600);
const list = await (
  await fetch(`http://localhost:${CDP_PORT}/json/list`)
).json();
const page = list.find((t) => t.type === "page");
const c = cdp(page);
await c.opened;
await c.send("Page.enable");
await c.send("Runtime.enable");
await c.send("Page.navigate", { url: APP });
await sleep(3600);

const evalJs = async (expr) => {
  const r = await c.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails)
    console.log("EVAL ERROR:", r.result.exceptionDetails.text);
  return r.result?.result?.value ?? null;
};
const shot = async (name) => {
  const s = await c.send("Page.captureScreenshot", { format: "png" });
  if (s.result?.data) {
    const p = path.join(OUT, name + ".png");
    writeFileSync(p, Buffer.from(s.result.data, "base64"));
    console.log("shot:", p);
  }
};

await evalJs(
  `window.__Diwali Meet Up.setName('ViewTest'); window.__Diwali Meet Up.enterWorld(); 'ok'`,
);
await sleep(2500);
await evalJs(`(() => { const g=window.__Diwali Meet Up, f=g.world.festival;
  g.controller.pos.set(20,0,18); g.controller.vel?.set(0,0,0);
  g.controller.yaw = Math.PI; g.controller.camYaw = 0; g.controller.camPitch = 0.16; g.controller.camDist = 8;
  f.nextBurst = 1e9; f.rockets = []; f.fwLife.fill(0);
  window.__origWorldTick = g.world.tick; g.world.tick = () => {};
  return true; })()`);
await sleep(700);

// step the controller + fx deterministically (headless rAF is throttled)
const step = (n) =>
  evalJs(`(() => { const g=window.__Diwali Meet Up, f=g.world.festival;
  for (let i=0;i<${n};i++) { g.controller.update(0.016); f._updateFireworks(0.016); f._updatePlayerFx(0.016); }
  return { lift: g.controller._lookLift, pitch: g.controller.camPitch,
    playerBurst: f.lastPlayerBurst, rockets: f.rockets.length,
    particles: [...f.fwLife].filter(v => v > 0).length }; })()`);

// --- rocket, normal view + glance ------------------------------------------
await evalJs(`(() => { const g=window.__Diwali Meet Up, f=g.world.festival;
  f.playFirework('rocket', g.controller.pos.x, g.controller.pos.z, Math.PI, 1234, true);
  g.controller.skyGlance(3.0);
  return true; })()`);
let st = await step(30);
console.log("rocket mid", JSON.stringify(st));
await sleep(120);
await shot("21-rocket-normal-mid");
// stop right as the shell opens so the burst is captured fresh, not faded
for (
  let i = 0;
  i < 6 &&
  (await evalJs(
    `window.__Diwali Meet Up.world.festival.rockets.some(r => r.player)`,
  ));
  i++
) {
  await evalJs(`(() => { const g=window.__Diwali Meet Up, f=g.world.festival;
    for (let j=0;j<10;j++) { g.controller.update(0.016); f._updateFireworks(0.016); f._updatePlayerFx(0.016); }
    return true; })()`);
}
// re-arm the glance for the still (real wall-clock elapsed during eval RTTs)
st = await evalJs(`(() => { const g=window.__Diwali Meet Up, f=g.world.festival;
  g.controller.skyGlance(3.0);
  for (let j=0;j<16;j++) { g.controller.update(0.016); f._updatePlayerFx(0.016); }
  return { lift: g.controller._lookLift, flashes: f.pfxFlashes.length,
    playerBurst: f.lastPlayerBurst, particles: [...f.fwLife].filter(v => v > 0).length }; })()`);
console.log("rocket burst", JSON.stringify(st));
await sleep(120);
await shot("22-rocket-normal-burst");
st = await step(18);
await sleep(120);
await shot("23-rocket-normal-after");

// cancel check: any look input hands control straight back
console.log(
  "glance cancel",
  JSON.stringify(
    await evalJs(`(() => { const g=window.__Diwali Meet Up;
  g.controller._look(20, 0);
  return { dur: g.controller._glance.dur }; })()`),
  ),
);
st = await step(40);
console.log("lift after cancel", JSON.stringify(st));

// --- aerial, normal view + glance ------------------------------------------
await evalJs(`(() => { const f=window.__Diwali Meet Up.world.festival;
  f.rockets = []; f.fwLife.fill(0); f.fwPoints.geometry.attributes.color.array.fill(0);
  f.fwPoints.geometry.attributes.color.needsUpdate = true;
  f.playFirework('aerial', 20, 18, Math.PI, 9876, true);
  window.__Diwali Meet Up.controller.skyGlance(3.4);
  return true; })()`);
st = await step(18);
console.log("aerial", JSON.stringify(st));
await sleep(120);
await shot("24-aerial-normal");
st = await step(24);
await sleep(120);
await shot("25-aerial-normal-late");

// isolated close-up of the burst + flash, to judge the sprite itself
await evalJs(`(() => { const g=window.__Diwali Meet Up, f=g.world.festival;
  g.playing = false;
  f.rockets = []; f.fwLife.fill(0);
  f.fwPoints.geometry.attributes.color.array.fill(0); f.fwPoints.geometry.attributes.color.needsUpdate = true;
  f._fwBurst(20, 22, -29, [1.0, 0.55, 0.2], 'chrysanthemum');
  f._burstFlash(20, 22, -29, [1.0, 0.55, 0.2]);
  for (let i=0;i<8;i++) f._updateFireworks(0.016);
  for (let i=0;i<10;i++) f._updatePfxFlashes(0.016);
  g.camera.position.set(18, 20, 1);
  g.camera.lookAt(20, 22, -29);
  return { flashes: f.pfxFlashes.length, particles: [...f.fwLife].filter(v => v > 0).length }; })()`);
await sleep(300);
await shot("26-burst-close");
c.ws.close();
chrome.kill();
await sleep(300);
try {
  rmSync(profileDir, { recursive: true, force: true });
} catch {
  /* best effort */
}
process.exit(0);
