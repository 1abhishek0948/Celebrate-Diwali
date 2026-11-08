// Client regressions run against the real methods with a small DOM/clock stub.
// The existing integration tests cover the authoritative gameplay server.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import * as THREE from "three";
import * as constants from "../shared/constants.js";
import { FrameLoop } from "../client/js/frame-loop.js";

class ClientEvent extends Event {
  constructor(type, options = {}) {
    super(type, options);
    this.detail = options.detail;
    this.changedTouches = options.changedTouches || [];
  }
}

class Element extends EventTarget {
  constructor() {
    super();
    this.style = {};
    this.hidden = true;
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    };
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 128, height: 128 }; }
  append() {}
}

function dom() {
  const nodes = new Map();
  const document = new EventTarget();
  document.getElementById = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  document.createElement = () => new Element();
  document.createTextNode = (text) => ({ text });
  document.hidden = false;
  const window = new EventTarget();
  window.innerWidth = 844;
  window.innerHeight = 390;
  return { window, document, node: document.getElementById };
}

function client(file, names, environment = {}) {
  let source = fs.readFileSync(new URL(`../client/js/${file}`, import.meta.url), "utf8")
    .replace(/import[\s\S]*?from\s+["'][^"']+["'];/g, "")
    .replace(/export (class|function)/g, "$1");
  if (file === "main.js") source = source.slice(0, source.lastIndexOf("try {\n  window.__DiwalyMeetUp"));
  const context = {
    ...constants, THREE, UI: class {}, EventTarget, CustomEvent: ClientEvent, crypto: webcrypto,
    setTimeout, clearTimeout, setInterval, clearInterval,
    isMobileDevice: () => true,
    ...environment,
  };
  vm.runInNewContext(`${source}\nglobalThis.api = { ${names.join(", ")} };`, context);
  return context.api;
}

function clock(refresh = 120) {
  let time = 0, serial = 0;
  const pending = new Map();
  const schedule = (kind, fn, delay) => {
    const id = ++serial;
    pending.set(id, { kind, fn, at: time + delay });
    return id;
  };
  return {
    pending,
    now: () => time,
    requestFrame: (fn) => schedule("raf", fn, 1000 / refresh),
    cancelFrame: (id) => pending.delete(id),
    setTimer: (fn, delay) => schedule("timer", fn, delay),
    clearTimer: (id) => pending.delete(id),
    advance(end) {
      for (let i = 0; i < 10000; i++) {
        const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) { time = end; return; }
        pending.delete(next[0]);
        time = next[1].at;
        next[1].fn(time);
      }
      throw new Error("Frame scheduler is spinning");
    },
    spend(ms) { time += ms; },
  };
}

for (const refresh of [60, 120]) {
  test(`60 fps loop survives skipped frames on a ${refresh} Hz display`, () => {
    const timing = clock(refresh);
    let frames = 0;
    const loop = new FrameLoop({ ...timing, interval: () => 1000 / 60,
      useTimer: () => false, onFrame: () => frames++ });
    loop.start();
    timing.advance(2000);
    assert.ok(frames >= 118 && frames <= 121, `${frames} frames`);
    assert.equal(timing.pending.size, 1);
    loop.stop();
    assert.equal(timing.pending.size, 0);
  });
}

test("low tier uses only timers, accounts for rendering time, and stays capped", () => {
  const timing = clock();
  let frames = 0;
  const loop = new FrameLoop({ ...timing, interval: () => 1000 / 30,
    useTimer: () => true, onFrame: () => { frames++; timing.spend(5); } });
  loop.start();
  timing.advance(2000);
  assert.ok(frames >= 59 && frames <= 61, `${frames} frames`);
  assert.equal([...timing.pending.values()][0].kind, "timer");
  loop.stop();
});

test("repeated resume and live quality switches never create duplicate loops", () => {
  const timing = clock();
  let low = false, frames = 0;
  const loop = new FrameLoop({ ...timing, interval: () => 1000 / (low ? 30 : 60),
    useTimer: () => low, onFrame: () => frames++ });
  loop.start();
  loop.start();
  timing.advance(500);
  low = true;
  timing.advance(1000);
  assert.equal(timing.pending.size, 1);
  assert.equal([...timing.pending.values()][0].kind, "timer");
  loop.stop();
  const beforePause = frames;
  timing.advance(5000);
  assert.equal(frames, beforePause);
  loop.start();
  timing.advance(5500);
  assert.ok(frames > beforePause + 13);
  assert.equal(timing.pending.size, 1);
  loop.stop();
});

test("a frame error is reported and stops scheduling instead of silently spinning", () => {
  const timing = clock();
  let reported;
  const loop = new FrameLoop({ ...timing, interval: () => 1000 / 60,
    useTimer: () => false, onFrame: () => { throw new Error("bad frame"); },
    onError: (error) => { reported = error; } });
  loop.start();
  timing.advance(100);
  assert.equal(reported.message, "bad frame");
  assert.equal(timing.pending.size, 0);
  assert.equal(loop.running, false);
});

test("a slow low-tier frame does not create a timer backlog", () => {
  const timing = clock();
  let frames = 0;
  const loop = new FrameLoop({ ...timing, interval: () => 1000 / 30,
    useTimer: () => true, onFrame: () => { frames++; timing.spend(80); } });
  loop.start();
  timing.advance(1000);
  assert.ok(frames < 15);
  assert.equal(timing.pending.size, 1);
  loop.stop();
});

function touch(target, type, touches) {
  target.dispatchEvent(new ClientEvent(type, { changedTouches: touches, cancelable: true }));
}

function controls() {
  const environment = dom();
  const { Controller } = client("controller.js", ["Controller"], {
    ...environment, addEventListener: environment.window.addEventListener.bind(environment.window),
  });
  const controller = new Controller({ canvas: environment.node("gl"),
    world: { colliders: [], interactables: [] }, camera: new THREE.PerspectiveCamera(), net: {} });
  const { Game } = client("main.js", ["Game"], environment);
  const game = Object.create(Game.prototype);
  Object.assign(game, { controller, playing: true, roomType: "island", equipped: null });
  game._wireTouch();
  return { ...environment, game, controller };
}

test("mobile Use calls the Game instance, with interaction fallback indoors", () => {
  const { game, controller, node } = controls();
  let uses = 0, activations = 0;
  game.equipped = "phuljhadi";
  game.useEquipped = () => uses++;
  controller.hoverInteract = { kind: "door" };
  controller.activate = () => activations++;
  touch(node("btn-use"), "touchstart", [{ identifier: 1 }]);
  assert.equal(uses, 1);
  assert.equal(activations, 0);
  game.roomType = "house";
  touch(node("btn-use"), "touchstart", [{ identifier: 1 }]);
  assert.equal(uses, 1);
  assert.equal(activations, 1);
  controller.locked = true;
  touch(node("btn-use"), "touchstart", [{ identifier: 1 }]);
  assert.equal(activations, 1);
});

test("joystick and camera keep their own touch IDs while jump is pressed", () => {
  const { controller, node } = controls();
  touch(node("joystick"), "touchstart", [{ identifier: 1, clientX: 100, clientY: 64 }]);
  touch(node("btn-jump"), "touchstart", [{ identifier: 3 }]);
  touch(node("joystick"), "touchmove", [{ identifier: 1, clientX: 110, clientY: 64 }]);
  assert.equal(controller.joy.jump, true, "moving the joystick must not erase a pending jump");
  touch(node("cam-touch"), "touchstart", [{ identifier: 2, clientX: 500, clientY: 100 }]);
  touch(node("cam-touch"), "touchstart", [{ identifier: 4, clientX: 800, clientY: 100 }]);
  touch(node("cam-touch"), "touchmove", [{ identifier: 4, clientX: 900, clientY: 100 }]);
  assert.equal(controller.camYaw, 0);
  touch(node("cam-touch"), "touchmove", [{ identifier: 2, clientX: 510, clientY: 100 }]);
  assert.ok(controller.camYaw < 0);
  assert.equal(controller.joy.active, true);
  touch(node("btn-jump"), "touchcancel", [{ identifier: 3 }]);
  assert.equal(controller.joy.jump, false);
});

test("blur/modal reset clears stale controls and allows a new joystick finger", () => {
  const { controller, node, window } = controls();
  touch(node("joystick"), "touchstart", [{ identifier: 1, clientX: 110, clientY: 64 }]);
  touch(node("btn-jump"), "touchstart", [{ identifier: 3 }]);
  window.dispatchEvent(new Event("blur"));
  assert.equal(controller.joy.active, false);
  assert.equal(controller.joy.jump, false);
  assert.equal(node("btn-jump").classList.contains("pressed"), false);
  touch(node("joystick"), "touchstart", [{ identifier: 5, clientX: 100, clientY: 64 }]);
  assert.equal(controller.joy.active, true);
  controller.setLocked(true);
  assert.equal(controller.joy.active, false);
});

test("equipping away from interactables reveals Use immediately, not after walking", () => {
  const environment = dom();
  const { UI } = client("screens.js", ["UI"], environment);
  const ui = Object.create(UI.prototype);
  ui.game = { equipped: "phuljhadi", roomType: "island", controller: { locked: false } };
  ui._wallet = () => ({ inventory: {} });
  ui.renderQuickBar();
  assert.equal(environment.node("btn-use").hidden, false);
  ui.game.equipped = null;
  ui.renderQuickBar();
  assert.equal(environment.node("btn-use").hidden, true);
});

test("opening Settings resets movement and closing it unlocks gameplay", () => {
  const { game, controller, node, window, document } = controls();
  const { UI } = client("screens.js", ["UI"], { window, document });
  const ui = Object.create(UI.prototype);
  ui.game = game;
  ui.screens = {};
  touch(node("joystick"), "touchstart", [{ identifier: 1, clientX: 100, clientY: 64 }]);
  ui.show("settings");
  assert.equal(controller.locked, true);
  assert.equal(controller.joy.active, false);
  ui.hideScreens();
  assert.equal(controller.locked, false);
});

test("emote taps before the server welcome do not throw on a missing rig", () => {
  const { controller } = controls();
  assert.doesNotThrow(() => controller.playEmote("wave"));
  assert.equal(controller.emote, null);
});

test("context restoration keeps the existing world/controller and resumes once", () => {
  const { game, controller, document, window, node } = controls();
  const timing = clock();
  let frames = 0;
  game.frameLoop = new FrameLoop({ ...timing, interval: () => 1000 / 30,
    useTimer: () => true, onFrame: () => frames++ });
  game._contextLost = false;
  game.ui = { toast() {} };
  game.world = {};
  const world = game.world;
  game._initLifecycle();
  game._resumeLoop();
  timing.advance(100);
  const before = frames;
  node("gl").dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  timing.advance(1000);
  assert.equal(frames, before);
  document.hidden = true;
  node("gl").dispatchEvent(new Event("webglcontextrestored"));
  assert.equal(timing.pending.size, 0);
  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("pageshow"));
  timing.advance(1500);
  assert.ok(frames > before);
  assert.equal(timing.pending.size, 1);
  assert.equal(game.world, world);
  assert.equal(game.controller, controller);
  game.frameLoop.stop();
});

test("orientation guard follows the viewport even when the lock API is unsupported", () => {
  const environment = dom();
  const { Game } = client("main.js", ["Game"], { ...environment, screen: {} });
  const game = Object.create(Game.prototype);
  game.playing = true;
  game.controller = { resetInput() {} };
  environment.window.innerWidth = 390;
  environment.window.innerHeight = 844;
  game._initOrientation();
  assert.equal(environment.node("rotate-device").hidden, false);
  environment.window.innerWidth = 844;
  environment.window.innerHeight = 390;
  environment.window.dispatchEvent(new Event("resize"));
  assert.equal(environment.node("rotate-device").hidden, true);
});

test("Safari auto quality uses a local fallback without changing navigator", () => {
  const navigator = Object.freeze({ hardwareConcurrency: 6 });
  const { detectDeviceQuality } = client("main.js", ["detectDeviceQuality"], { navigator });
  assert.equal(detectDeviceQuality(), "low");
  assert.equal(navigator.deviceMemory, undefined);
});

function network(environment = {}) {
  const timing = clock();
  const sockets = [];
  class Socket {
    constructor() { sockets.push(this); this.readyState = 0; this.sent = []; }
    send(msg) { this.sent.push(JSON.parse(msg)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  const storage = new Map();
  const api = client("net.js", ["Net", "deviceToken", "loadProfile", "saveProfile"], {
    WebSocket: Socket, location: { protocol: "https:", host: "example.test" },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setTimeout: timing.setTimer, clearTimeout: timing.clearTimer,
    setInterval: () => 0, clearInterval() {}, ...environment,
  });
  return { ...api, timing, sockets };
}

test("blocked storage still permits onboarding and a stable session token", () => {
  const { deviceToken, loadProfile, saveProfile } = network({
    localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } },
  });
  saveProfile({ name: "Mobile buddy" });
  assert.equal(loadProfile().name, "Mobile buddy");
  assert.match(deviceToken(), /^[a-f0-9]{32}$/);
  assert.equal(deviceToken(), deviceToken());
});

test("null/corrupted saved profiles do not crash bootFlow", () => {
  for (const value of ["null", "[]", "123", "broken"]) {
    const { loadProfile } = network({ localStorage: { getItem: () => value } });
    assert.equal(loadProfile().name, undefined);
  }
});

test("failed first connection retries; hung handshakes have a deadline", () => {
  const { Net, sockets, timing } = network();
  const net = new Net();
  net.connect({ name: "Mobile buddy" });
  sockets[0].close();
  timing.advance(500);
  assert.equal(sockets.length, 2);
  timing.advance(10500);
  assert.equal(sockets[1].readyState, 3);
  assert.equal(net.status, "reconnecting");
  net.resetSession();
});

test("manual retry ignores late callbacks from the replaced socket", () => {
  const { Net, sockets, timing } = network();
  const net = new Net();
  net.connect({ name: "Mobile buddy" });
  const old = sockets[0];
  net.connect();
  old.onclose();
  old.onopen();
  assert.equal(net.ws, sockets[1]);
  assert.equal(net.status, "connecting");
  assert.equal(timing.pending.size, 1, "only current handshake timeout remains");
  sockets[1].open();
  sockets[1].message({ t: "welcome" });
  assert.equal(timing.pending.size, 0);
  net.resetSession();
});

test("a replaced session stops reconnecting, including a pending retry", () => {
  const { Net, sockets, timing } = network();
  const net = new Net();
  net.connect({ name: "Mobile buddy" });
  sockets[0].close();
  net.resetSession();
  timing.advance(30000);
  assert.equal(sockets.length, 1);
  assert.equal(timing.pending.size, 0);
});
