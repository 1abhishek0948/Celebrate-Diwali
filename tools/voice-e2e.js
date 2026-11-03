// ---------------------------------------------------------------------------
// Voice E2E: two real headless Chrome instances with fake microphone devices.
// Verifies the whole pipeline end-to-end:
//   getUserMedia -> vsig relay -> ICE -> P2P audio -> distance volume
// and the two regressions that used to break voice:
//   * a peer that enables the mic LATE is still heard (no renegotiation)
//   * muting your own mic does NOT silence your speakers
//
// Run: node tools/voice-e2e.js   (needs Chrome; starts its own server on 3111)
// ---------------------------------------------------------------------------
import { execFile, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import WebSocket from "ws";

const SERVER_PORT = 3111;
const APP = `http://localhost:${SERVER_PORT}/`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const check = (name, cond, extra) => {
  console.log(
    `${cond ? "PASS" : "FAIL"} - ${name}${cond ? "" : " :: " + JSON.stringify(extra ?? "")}`,
  );
  if (!cond) fails++;
};

// ---- dedicated server (teleport on so both players can stand together) -----
const server = spawn(process.execPath, ["server/index.js"], {
  env: {
    ...process.env,
    PORT: String(SERVER_PORT),
    DiwaliMeetUp_ALLOW_TELEPORT: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
await new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error("server start timeout")), 8000);
  server.stdout.on("data", (d) => {
    if (String(d).includes("http+ws on")) {
      clearTimeout(to);
      res();
    }
  });
});

// ---- CDP plumbing ----------------------------------------------------------
async function attach(debugPort, name) {
  const list = await (
    await fetch(`http://localhost:${debugPort}/json/list`)
  ).json();
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let id = 0;
  const waiters = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && waiters.has(m.id)) {
      waiters.get(m.id)(m);
      waiters.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      waiters.set(i, res);
      setTimeout(() => {
        if (waiters.has(i)) {
          waiters.delete(i);
          res({ error: "timeout " + method });
        }
      }, 20000);
    });
  await send("Page.enable");
  await send("Runtime.enable");
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.error) throw new Error(`${name} eval: ${r.error}`);
    if (r.result?.exceptionDetails)
      throw new Error(`${name} eval threw: ${r.result.exceptionDetails.text}`);
    return r.result?.result?.value ?? null;
  };
  return { ws, send, evalJs, name };
}

const launches = [];
function launchChrome(debugPort, dir) {
  rmSync(dir, { recursive: true, force: true });
  const proc = execFile(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--use-angle=swiftshader",
    "--no-sandbox",
    `--remote-debugging-port=${debugPort}`,
    "--window-size=1000,700",
    `--user-data-dir=${dir}`,
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "about:blank",
  ]);
  launches.push(proc);
  return proc;
}

launchChrome(9331, "/tmp/nb-voice-a");
launchChrome(9332, "/tmp/nb-voice-b");
await sleep(3000);

const A = await attach(9331, "A");
const B = await attach(9332, "B");

async function enterWorld(pg, name) {
  await pg.send("Page.navigate", { url: APP });
  await sleep(3000);
  await pg.evalJs(
    `window.__Diwali Meet Up.setName(${JSON.stringify(name)}); window.__Diwali Meet Up.enterWorld(); 'ok'`,
  );
  await sleep(2200);
  return pg.evalJs(
    `({ id: window.__Diwali Meet Up.id, welcomed: window.__Diwali Meet Up.net.welcomed })`,
  );
}
const aInfo = await enterWorld(A, "VoiceAlice");
const bInfo = await enterWorld(B, "VoiceBob");
check("both clients connected", !!(aInfo?.welcomed && bInfo?.welcomed), {
  aInfo,
  bInfo,
});

// park both players next to each other (4 m apart, well inside VOICE_RADIUS)
async function park(pg, x, z) {
  await pg.evalJs(`(() => {
    const g = window.__Diwali Meet Up;
    g.controller.pos.set(${x}, 0, ${z});
    g.net.send({ t: 'st', seq: 999, x: ${x}, y: 0, z: ${z}, ry: 0, mode: 0, debugPos: { x: ${x}, z: ${z} } });
    return true;
  })()`);
}
await park(A, 2, 8);
await park(B, -2, 8);
await sleep(1200);
const closeEnough = await A.evalJs(`(() => {
  const g = window.__Diwali Meet Up;
  const rp = [...g.remotePlayers.values()][0];
  return rp ? Math.hypot(rp.rig.root.position.x - g.controller.pos.x, rp.rig.root.position.z - g.controller.pos.z) : null;
})()`);
check("players within voice range", closeEnough !== null && closeEnough < 45, {
  dist: closeEnough,
});

// A enables the mic first; B stays silent for a while (B is not listening yet,
// so A's first offer is ignored -> the retry path must recover).
const aMic = await A.evalJs(`window.__Diwali Meet Up.voice.enableMic()`);
check("A microphone enabled (fake device)", aMic === true, { aMic });
await sleep(2500);

const bMic = await B.evalJs(`window.__Diwali Meet Up.voice.enableMic()`);
check("B microphone enabled late (fake device)", bMic === true, { bMic });

// wait for the retry to establish both directions
async function waitConnected(pg, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = await pg.evalJs(
      `[...window.__Diwali Meet Up.voice.peers.values()].some((p) => p.pc.connectionState === 'connected')`,
    );
    if (ok) return true;
    await sleep(700);
  }
  return false;
}
const aConn = await waitConnected(A, 25000);
const bConn = await waitConnected(B, 25000);
check("A peer connection established", aConn);
check("B peer connection established", bConn);

const peerStates = await A.evalJs(
  `[...window.__Diwali Meet Up.voice.peers.values()].map((p) => ({ state: p.pc.connectionState, ice: p.pc.iceConnectionState }))`,
);
check(
  "A sees a connected peer",
  peerStates.some((p) => p.state === "connected"),
  peerStates,
);

// audio actually flowing in BOTH directions (fake device emits a tone)
async function waitInbound(pg, ms) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    last = await pg.evalJs(`(async () => {
      const p = [...window.__Diwali Meet Up.voice.peers.values()][0];
      if (!p) return null;
      const stats = await p.pc.getStats();
      let bytes = 0, packets = 0;
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) {
          bytes += s.bytesReceived || 0; packets += s.packetsReceived || 0;
        }
      });
      return { bytes, packets, volume: p.audio.volume };
    })()`);
    if (last && last.bytes > 0) return last;
    await sleep(800);
  }
  return last;
}
const aIn = await waitInbound(A, 20000);
const bIn = await waitInbound(B, 20000);
check("A receives audio from B", !!(aIn && aIn.bytes > 0), aIn);
check("B receives audio from A", !!(bIn && bIn.bytes > 0), bIn);
check("incoming volume set from distance falloff", !!(aIn && aIn.volume > 0), {
  volume: aIn?.volume,
});

// mute regression: muting MY mic must not silence my speakers
await A.evalJs(`window.__Diwali Meet Up.voice.toggleMic()`);
await sleep(400);
const muteState = await A.evalJs(`(() => {
  const g = window.__Diwali Meet Up;
  const p = [...g.voice.peers.values()][0];
  return { micMuted: g.voice.micMuted, trackEnabled: g.voice.stream.getAudioTracks()[0].enabled, speakerVolume: p ? p.audio.volume : null };
})()`);
check(
  "mic mute disables the outgoing track",
  muteState.trackEnabled === false,
  muteState,
);
check(
  "mic mute does NOT silence incoming audio",
  muteState.speakerVolume > 0,
  muteState,
);

// listen-only mode: mic off, still connected and receiving
await A.evalJs(`window.__Diwali Meet Up.voice.disableMic()`);
await sleep(1200);
const listenState = await A.evalJs(`(() => {
  const g = window.__Diwali Meet Up;
  const p = [...g.voice.peers.values()][0];
  return { listening: g.voice.listening, status: g.voice.status, peers: g.voice.peers.size, state: p ? p.pc.connectionState : null };
})()`);
check(
  "listen-only keeps the peer connected",
  listenState.listening === true &&
    listenState.peers === 1 &&
    listenState.state === "connected",
  listenState,
);

launches.forEach((p) => {
  try {
    p.kill();
  } catch {}
});
server.kill("SIGINT");
console.log(fails ? `\n${fails} FAILURES` : "\nALL VOICE E2E CHECKS PASSED");
process.exit(fails ? 1 : 0);
