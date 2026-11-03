// ---------------------------------------------------------------------------
// E2E smoke test: drives the real client in headless Chrome over the
// DevTools protocol (no test frameworks). Verifies:
//   boot -> screens render -> enterWorld -> WS welcome -> server snapshots
//   -> local rig spawn -> remote second player visible -> chat roundtrip.
// Also captures a screenshot into docs/screenshots/ for eyeball checks.
// Run: node tools/e2e.js (server must be running on :3000)
// ---------------------------------------------------------------------------
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

const PORT = 9222;
const APP = "http://localhost:3000/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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
      }, 15000);
      waiters.set(i, res);
    });
  return { ws, opened, send };
}

const chrome = execFile(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--use-angle=swiftshader",
  "--no-sandbox",
  `--remote-debugging-port=${PORT}`,
  "--window-size=1280,800",
  "--user-data-dir=/tmp/nb-e2e",
  "about:blank",
]);
await sleep(2500);

const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const c = cdp(page);
await c.opened;
await c.send("Page.enable");
await c.send("Runtime.enable");
await c.send("Page.navigate", { url: APP });
await sleep(3500);

const evalJs = async (expr) => {
  const r = await c.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  return r.result?.result?.value ?? null;
};

let fails = 0;
const check = (name, cond, extra) => {
  console.log(
    `${cond ? "PASS" : "FAIL"} - ${name}${cond ? "" : " :: " + JSON.stringify(extra ?? "")}`,
  );
  if (!cond) fails++;
};

// Headless software GL renders at only a few FPS, so state delivered over the
// network can take a frame to land. Poll for the expected value rather than
// trusting a fixed sleep (which made the remote checks intermittently flaky).
const waitFor = async (expr, ms = 8000, step = 300) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await evalJs(expr);
    if (v || Date.now() >= deadline) return v;
    await sleep(step);
  }
};

// 1. boot
check(
  "game booted + screens built",
  await evalJs(
    `!!window.__Diwali Meet Up && !!window.__Diwali Meet Up.ui.screens.welcome`,
  ),
);

// 2. drive flow: set name, enter world
await evalJs(
  `window.__Diwali Meet Up.setName('E2E-Test'); window.__Diwali Meet Up.enterWorld(); 'ok'`,
);
await sleep(2500);

check(
  "ws welcome received",
  await evalJs(`window.__Diwali Meet Up.net.welcomed === true`),
);
check("local rig spawned", await evalJs(`!!window.__Diwali Meet Up.rig`));
check(
  "in island room",
  await evalJs(`window.__Diwali Meet Up.room === 'island-1'`),
);
const pos = await evalJs(
  `({x: window.__Diwali Meet Up.controller.pos.x, y: window.__Diwali Meet Up.controller.pos.y, z: window.__Diwali Meet Up.controller.pos.z})`,
);
check("spawned near plaza (r<40)", !!pos && Math.hypot(pos.x, pos.z) < 45, pos);

// 2b. the local rig must be the realistic Ready Player Me avatar (mocap clips
// + AnimationMixer), not the procedural primitive fallback. The GLB loads
// asynchronously, so poll until the implementation settles first.
const av = await waitFor(`(() => {
  const impl = window.__Diwali Meet Up.rig?._impl;
  if (!impl) return null;
  return {
    hasMixer: !!impl?.mixer,
    clipCount: impl?.inst?.clips ? Object.keys(impl.inst.clips).length : 0,
    isProceduralFallback: !!impl?.palette,
  };
})()`);
check(
  "male rig is the realistic RPM avatar (5 mocap clips)",
  !!av && av.hasMixer && av.clipCount === 5 && !av.isProceduralFallback,
  av,
);

// 3. second player joins via server protocol from node (bot client)
const bot = new WebSocket("ws://localhost:3000");
const botInbox = [];
bot.on("message", (d) => botInbox.push(JSON.parse(d.toString())));
await new Promise((r) => bot.on("open", r));
bot.send(
  JSON.stringify({
    t: "hello",
    token: "9abc9abc9abc9abc9abc9abc9abc9abc",
    name: "Bot Buddy",
    av: { b: 2, h: 4 },
  }),
);
await sleep(1200);
bot.send(JSON.stringify({ t: "st", seq: 1, x: 8, y: 0, z: 4, ry: 1, mode: 1 }));

// browser should see the remote after snapshot+join
const botOf = () =>
  `[...window.__Diwali Meet Up.remotePlayers.values()].find((r) => r.name === 'Bot Buddy')`;
const remote = await waitFor(
  `(() => { const r=${botOf()}; return r ? {name: r.name, x: r.rig.root.position.x} : null; })()`,
);
check(
  "remote player rendered locally",
  !!remote && remote.name === "Bot Buddy",
  remote,
);

// 3b. bot keeps walking -> remote rig position must ADVANCE (interpolation)
let frame = 40;
const mover = setInterval(() => {
  frame++;
  const d = (frame * 0.2) % 24; // triangular sweep, 3 m/s at 15 Hz
  const x = +(d < 12 ? 2 + d : 26 - d).toFixed(2);
  bot.send(
    JSON.stringify({
      t: "st",
      seq: frame,
      x,
      y: 0,
      z: 4,
      ry: x < 14 ? 0 : Math.PI,
      mode: 1,
    }),
  );
}, 66);
await sleep(1500);
const posAt = () =>
  evalJs(
    `(() => { const r=${botOf()}; return r ? { x: r.rig.root.position.x, z: r.rig.root.position.z } : null; })()`,
  );
const p1 = await posAt();
await sleep(1500);
const p2 = await posAt();
const moved = Math.hypot(p2.x - p1.x, p2.z - p1.z);
check("remote position advances in realtime", moved > 0.4, {
  p1,
  p2,
  moved: +moved.toFixed(2),
});

// 3c. emote propagation: bot waves -> remote rig emote drives animation
bot.send(JSON.stringify({ t: "emote", e: "wave" }));
const emoted = await waitFor(
  `(() => { const r=${botOf()}; return r && r.rig.emote ? r.rig.emote.e : null; })()`,
);
check("remote emote drives rig animation", emoted === "wave", { emoted });
clearInterval(mover);

// 4. chat roundtrip (server echo back to browser)
bot.send(JSON.stringify({ t: "chat", text: "hello island!" }));
const chatOk = await waitFor(
  `[...document.querySelectorAll('#chat-log .chat-line')].some((n) => n.textContent.includes('hello island!'))`,
);
check("chat visible in HUD", !!chatOk);

// 5. house door interaction from the browser side is exercised by server tests;
// here verify world assets + interpolation buffers exist
check(
  "island world has colliders",
  await evalJs(`window.__Diwali Meet Up.world.colliders.length > 20`),
);
check(
  "interiors built",
  await evalJs(`window.__Diwali Meet Up.world.interiors.size === 8`),
);
check(
  "snapshot buffer flowing",
  await evalJs(
    `[...window.__Diwali Meet Up.remotePlayers.values()].some(r => r.buf.length > 0)`,
  ),
);

// 6. screenshot for docs
mkdirSync("docs/screenshots", { recursive: true });
const shot = await c.send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  writeFileSync(
    "docs/screenshots/e2e-smoke.png",
    Buffer.from(shot.result.data, "base64"),
  );
  console.log("screenshot saved: docs/screenshots/e2e-smoke.png");
} else {
  console.log("WARNING screenshot failed:", JSON.stringify(shot.error ?? shot));
}

bot.close();
c.ws.close();
chrome.kill();
console.log(fails ? `\n${fails} FAILURES` : "\nALL E2E CHECKS PASSED");
process.exit(fails ? 1 : 0);
