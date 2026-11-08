// ---------------------------------------------------------------------------
// DiwalyMeetUp main client: three.js scene + game loop + net glue.
// ---------------------------------------------------------------------------
import * as THREE from "three";
import { CSS2DRenderer } from "/vendor/CSS2DRenderer.js";
import {
  TICK_MS,
  SNAPSHOT_BUFFER,
  CURRENCY,
  MAX_BUY_QTY,
  PLAY_RADIUS,
  FOUNTAIN,
  fireworkById,
} from "../shared/constants.js";
import { Net, loadProfile, saveProfile } from "./net.js";
import { World } from "./world.js";
import { CharacterRig } from "./actors.js";
import { Controller } from "./controller.js";
import { VoiceChat } from "./voice.js";
import { UI } from "./screens.js";
import { enterLandscape, isMobileDevice } from "./orientation.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Device quality tiers (heat control). Pixel ratio is the single biggest GPU
// cost; the frame cap keeps 90/120 Hz phones from rendering twice as often as
// they need to. Values are deliberately conservative on phones.
// ---------------------------------------------------------------------------
const QUALITY_PRESETS = {
  low: { dpr: 1, frameCap: 30, shadows: false },
  medium: { dpr: 1.5, frameCap: 60, shadows: true },
  high: { dpr: 2, frameCap: 60, shadows: true },
};

function detectDeviceQuality() {
  const mem = Number(navigator.deviceMemory) || 0;
  const cores = Number(navigator.hardwareConcurrency) || 0;
  if (isMobileDevice()) {
    if ((mem && mem <= 4) || (cores && cores <= 4)) return "low";
    return "medium";
  }
  // low-memory desktops still get a lighter profile
  if (mem && mem <= 4) return "medium";
  return "high";
}

// ---------------------------------------------------------------------------
// Wallet cache: lets the HUD paint the last-known balance instantly on reload.
// It is NEVER trusted for a transaction — the server prices and validates every
// buy/use, then replies with the authoritative wallet.
// ---------------------------------------------------------------------------
const WALLET_KEY = "DiwalyMeetUp.wallet";
const EQUIPPED_KEY = "DiwalyMeetUp.equipped";

// Horizontal compass tape: three repeated 360° cycles let the strip scroll
// smoothly through north without a visible jump.
const COMPASS_LABELS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const COMPASS_PPD = 3; // pixels per degree
const COMPASS_CYCLE = 360 * COMPASS_PPD;
const COMPASS_COPIES = 3;

function loadWalletCache() {
  try {
    const w = JSON.parse(localStorage.getItem(WALLET_KEY) || "null");
    if (!w || typeof w !== "object") return null;
    return {
      balance: Number.isFinite(w.balance) ? w.balance : null,
      inventory:
        w.inventory && typeof w.inventory === "object" ? w.inventory : {},
    };
  } catch {
    return null;
  }
}
function loadEquipped() {
  try {
    const id = localStorage.getItem(EQUIPPED_KEY);
    const f = id && fireworkById(id);
    return f && f.kind !== "pack" ? id : null;
  } catch {
    return null;
  }
}

class RemotePlayer {
  constructor(data, opts) {
    this.id = data.id;
    this.name = data.name;
    this.rig = new CharacterRig(
      data.av || { g: 1, b: 0, h: 1, y: 0, e: 0 },
      data.name,
      opts,
    );
    this.buf = []; // {t(ms local), x,y,z,ry,mode}
    this.room = opts.roomId;
    this.lastPos = null;
    this._emoteExpire = 0;
  }

  push(s) {
    this.buf.push(s);
    if (this.buf.length > 12) this.buf.shift();
  }

  emote(e) {
    // rig time domain: CharacterRig.tick() computes et = rig.t - started
    this.rig.emote = { e, started: this.rig.t };
    this._emoteExpire = performance.now() + 6500;
  }

  _expireEmote() {
    if (this._emoteExpire && performance.now() > this._emoteExpire) {
      this.rig.emote = null;
      this._emoteExpire = 0;
    }
  }

  // renderT: local ms. dt: seconds. Interpolates position AND drives the
  // walk/run/emote animation through the rig (mirrors the local controller).
  tick(renderT, dt) {
    // emotes expire in wall-clock; animation phases use rig time
    if (this._emoteExpire && performance.now() > this._emoteExpire) {
      this.rig.emote = null;
      this._emoteExpire = 0;
    }
    const buf = this.buf;
    if (!buf.length) {
      // no snapshots yet (e.g. outside interest radius): keep idle pose alive
      this.rig.tick(dt, 0, this.rig.emote, 0);
      return;
    }
    let a = buf[0],
      b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].t <= renderT && buf[i + 1].t >= renderT) {
        a = buf[i];
        b = buf[i + 1];
        break;
      }
    }
    let k = 0;
    if (b.t > a.t) k = Math.min(1, Math.max(0, (renderT - a.t) / (b.t - a.t)));
    if (renderT > buf[buf.length - 1].t) {
      a = b;
      k = 1;
    }
    const x = a.x + (b.x - a.x) * k;
    const y = a.y + (b.y - a.y) * k;
    const z = a.z + (b.z - a.z) * k;
    let dyaw = b.ry - a.ry;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const ry = a.ry + dyaw * k;
    // stale buffer (player left interest radius) -> idle pose, no fake run
    const mode =
      performance.now() - buf[buf.length - 1].t > 1000 ? 0 : (b.mode ?? 0);

    this.rig.root.position.set(x, y, z);
    this.rig.root.rotation.y = ry;

    // feed the rig: walk/run cycle + active emote
    const posDelta = this.lastPos
      ? Math.hypot(x - this.lastPos.x, z - this.lastPos.z)
      : 0;
    this.lastPos = this.lastPos
      ? this.lastPos.set(x, y, z)
      : new THREE.Vector3(x, y, z);
    this.rig.tick(dt, mode, this.rig.emote, posDelta);
  }
}

class Game {
  constructor() {
    this.net = new Net();
    this.voice = new VoiceChat(this.net);
    this.name = "";
    this.id = -1;
    this.room = null;
    this.roomType = null;
    this.playing = false;
    this.remotePlayers = new Map();
    this.previewAv = { g: 1, b: 0, h: 1, y: 0, e: 0 };
    this.seq = 0;
    this._lastSend = 0;
    this.myHouseId = null;
    this.timeOfDay = "night";

    // --- Diwali economy (server is authoritative; this is only a cached view) --
    const cached = loadWalletCache();
    this.wallet = {
      balance: cached?.balance ?? CURRENCY.start,
      inventory: cached?.inventory ?? {},
      currency: CURRENCY,
      ready: false,
    };
    this.equipped = loadEquipped();
    this._buyPending = false;
    this._buyTimer = null;
    this._useLock = false;

    this._initThree();
    this._initCompass();
    this.ui = new UI(this);
    // Honour a saved Low/Medium/High choice; "auto" keeps the detected tier.
    this.applyQuality(this.ui.settings.quality || "auto");
    this.controller = new Controller({
      canvas: $("gl"),
      world: this.world,
      camera: this.camera,
      net: this.net,
    });
    this.controller.setSensitivity(this.ui.settings.sens);
    this.controller.onPrompt = (it) => this.ui.setPrompt(it);
    // firecracker store interaction (kind: 'shop' existables in world.js)
    this.controller.onShop = (it) => this.ui.openShop(it);
    // Festival element interactions (Light a diya / bonfire / lanterns / wheel)
    if (this.world.festival) {
      this.world.festival.onNotify = (t) => this.ui.toast(t, [], 2600);
      this.world.festival.onEmote = (e) => this.controller.playEmote(e);
      this.world.festival.onRevealStart = () => {
        if (!this.world.festival.reduceMotion) this.controller.startSkyCam();
      };
    }
    this._wireNet();
    this._wireTouch();
    this._initOrientation();
    this._wireEconomyKeys();
    this.ui.bootFlow();
    requestAnimationFrame(() => this._loop(performance.now()));
  }

  // ---------------------------------------------------------------- three ---
  _initThree() {
    const canvas = $("gl");
    this._autoQuality = detectDeviceQuality();
    this.quality = this._autoQuality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // MSAA is cheap insurance on desktop and a real cost on phones; the
      // high tier only ever runs on capable machines.
      antialias: this._autoQuality === "high",
      powerPreference: "low-power",
    });
    // Keep the night festival readable on laptop/mobile displays. The old
    // low exposure made unlit faces, hands, trousers, and shoes collapse into
    // silhouettes.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.7;
    // real character shadows (the moon light casts; see _enableWorldShadows)
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setSize(innerWidth, innerHeight);
    this._applyRendererQuality(this.quality);

    this.scene = new THREE.Scene();
    // Festival of Lights: deep indigo twilight with a warm horizon haze,
    // supplied by the sky dome; the flat colour is only a fallback backdrop.
    this.scene.background = new THREE.Color(0x151a38);
    this.scene.fog = new THREE.Fog(0x25284d, 150, 1100);

    this.camera = new THREE.PerspectiveCamera(
      60,
      innerWidth / innerHeight,
      0.1,
      1200,
    );
    this.camera.position.set(30, 6, 14);

    // cool moonlight + warm-tinted sky bounce; the festival's own point lights
    // and emissive materials carry the golden glow
    const ambient = new THREE.AmbientLight(0xfff7ea, 0.42);
    const hemi = new THREE.HemisphereLight(0x9bb8ec, 0x40374d, 1.05);
    const moon = new THREE.DirectionalLight(0xc8d8ff, 0.72);
    moon.position.set(-120, 180, -70);
    const warmFill = new THREE.DirectionalLight(0xffd9b5, 0.62);
    warmFill.position.set(80, 70, 100);
    this.scene.add(ambient, hemi, moon, warmFill);
    this.dayNightLights = { ambient, hemi, moon, warmFill };

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(innerWidth, innerHeight);
    this.labelRenderer.domElement.style.position = "absolute";
    this.labelRenderer.domElement.style.top = "0";
    this.labelRenderer.domElement.style.pointerEvents = "none";
    this.labelRenderer.domElement.style.zIndex = "5";
    // Mount inside #app so the UI layer (screens z30 / HUD z10 / toasts z60)
    // always paints above floating name tags.
    $("app").appendChild(this.labelRenderer.domElement);

    addEventListener("resize", () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.labelRenderer.setSize(innerWidth, innerHeight);
      this.world?.setViewport(innerWidth / innerHeight, this.camera.fov);
    });

    this.world = new World(this.scene, { quality: this.quality });
    this.world.setViewport(innerWidth / innerHeight, this.camera.fov);
    this.setTimeOfDay("night");
    this._enableWorldShadows();
  }

  // -------------------------------------------------------------- compass --
  _initCompass() {
    const tape = $("compass-tape");
    if (!tape) return;
    this._compassTape = tape;
    this._compassCardinal = $("compass-cardinal");
    this._compassDegrees = $("compass-degrees");
    this._compassDir = new THREE.Vector3();
    this._compassHeading = null;
    tape.style.width = `${COMPASS_CYCLE * COMPASS_COPIES}px`;

    const frag = document.createDocumentFragment();
    for (let copy = 0; copy < COMPASS_COPIES; copy++) {
      for (let deg = 0; deg < 360; deg += 15) {
        const x = (copy * 360 + deg) * COMPASS_PPD;
        const tick = document.createElement("span");
        tick.className =
          "compass-tick" +
          (deg % 90 === 0 ? " cardinal" : deg % 45 === 0 ? " major" : "");
        tick.style.left = `${x}px`;
        frag.appendChild(tick);

        if (deg % 45 === 0) {
          const label = document.createElement("span");
          label.textContent = COMPASS_LABELS[deg / 45];
          label.className =
            "compass-label" +
            (deg % 90 === 0 ? " cardinal" : "") +
            (deg === 0 ? " north" : "");
          label.style.left = `${x}px`;
          frag.appendChild(label);
        }
      }
    }
    tape.appendChild(frag);
    this._updateCompass();
  }

  _updateCompass() {
    if (!this._compassTape || !this.camera || !this._compassDir) return;
    this.camera.getWorldDirection(this._compassDir);
    const heading =
      ((Math.atan2(this._compassDir.x, this._compassDir.z) * 180) / Math.PI +
        360) %
      360;
    // The tape is a wide DOM layer; writing a transform every frame makes the
    // compositor work hard for sub-pixel changes nobody can see. Only move it
    // when the heading actually shifted ~0.3°.
    if (
      this._compassDrawHeading === undefined ||
      Math.abs(heading - this._compassDrawHeading) >= 0.3 ||
      Math.abs(heading - this._compassDrawHeading) > 300 // wrapped past 0°
    ) {
      this._compassDrawHeading = heading;
      this._compassTape.style.transform =
        `translate3d(${-COMPASS_CYCLE - heading * COMPASS_PPD}px, 0, 0)`;
    }

    const rounded = Math.round(heading) % 360;
    if (this._compassHeading === rounded) return;
    this._compassHeading = rounded;
    if (this._compassCardinal) {
      const dir = COMPASS_LABELS[Math.round(rounded / 45) % 8];
      this._compassCardinal.textContent = dir;
    }
    if (this._compassDegrees) {
      this._compassDegrees.textContent = `${String(rounded).padStart(3, "0")}°`;
    }
  }

  // Real shadows: the moon directional light casts through a tight ortho
  // frustum that follows the player (cheap and crisp). Disabled entirely on
  // the low tier; on other tiers only reasonably-sized, non-instanced meshes
  // cast (instanced forests/decor would otherwise double every draw call in
  // the shadow pass just to render shadows nobody looks at).
  _enableWorldShadows() {
    const moon = this.dayNightLights?.moon;
    const on = this.quality !== "low";
    if (moon) {
      this._shadowMoonDir ||= moon.position.clone().normalize();
      moon.castShadow = on;
      if (on) {
        moon.shadow.mapSize.set(1024, 1024);
        const c = moon.shadow.camera;
        c.left = -12;
        c.right = 12;
        c.top = 12;
        c.bottom = -12;
        c.near = 20;
        c.far = 160;
        moon.shadow.bias = -0.0004;
        moon.shadow.normalBias = 0.02;
        if (!moon.target.parent) this.scene.add(moon.target);
      }
    }
    this.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.receiveShadow = on;
      if (!on || o.isInstancedMesh) {
        o.castShadow = false;
        return;
      }
      let r = o.geometry?.boundingSphere?.radius;
      if (r === undefined) {
        o.geometry?.computeBoundingSphere?.();
        r = o.geometry?.boundingSphere?.radius ?? 0;
      }
      if (r > 0 && r < 30) o.castShadow = true;
    });
  }

  // keep the shadow frustum centered on the local player
  _updateShadowFollow() {
    const moon = this.dayNightLights?.moon;
    if (!moon?.castShadow || !this.rig) return;
    const p = this.controller.pos;
    moon.position.copy(this._shadowMoonDir).multiplyScalar(90).add(p);
    moon.target.position.copy(p);
    moon.target.updateMatrixWorld();
  }

  // ------------------------------------------------------------- quality ---
  _applyRendererQuality(q) {
    const preset = QUALITY_PRESETS[q] || QUALITY_PRESETS.high;
    this.quality = QUALITY_PRESETS[q] ? q : "high";
    this._frameMinMs = preset.frameCap ? 1000 / preset.frameCap : 0;
    if (!this.renderer) return;
    // Cap the backing-buffer resolution: a 3x-DPR phone drops from 9x the
    // pixel work to 1x on the low tier, which is the dominant heat saving.
    const dpr = Math.min(devicePixelRatio || 1, preset.dpr);
    this.renderer.setPixelRatio(Math.max(0.75, dpr));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = preset.shadows;
    // Keep the filter type fixed: changing it after materials compile would
    // require recompiling every shadowed material for no meaningful saving.
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  applyQuality(q) {
    // "auto" (or an unknown value) resolves through the device tier.
    const resolved =
      q === "low" || q === "medium" || q === "high" ? q : this._autoQuality;
    this._applyRendererQuality(resolved);
    this.world?.setQuality(this.quality);
    this._enableWorldShadows();
  }

  setTimeOfDay(mode) {
    const day = mode === "day";
    this.timeOfDay = day ? "day" : "night";
    const l = this.dayNightLights;
    if (l) {
      if (day) {
        l.ambient.intensity = 0.82;
        l.hemi.color.setHex(0xbfe7ff);
        l.hemi.groundColor.setHex(0x78917b);
        l.hemi.intensity = 1.45;
        l.moon.intensity = 0.28;
        l.warmFill.intensity = 0.9;
        this.renderer.toneMappingExposure = 1.2;
        this.scene.background.setHex(0x8fc7e8);
        this.scene.fog.color.setHex(0x9fc8dc);
      } else {
        l.ambient.intensity = 0.42;
        l.hemi.color.setHex(0x9bb8ec);
        l.hemi.groundColor.setHex(0x40374d);
        l.hemi.intensity = 1.05;
        l.moon.intensity = 0.72;
        l.warmFill.intensity = 0.62;
        this.renderer.toneMappingExposure = 1.7;
        this.scene.background.setHex(0x151a38);
        this.scene.fog.color.setHex(0x292d52);
      }
    }
    this.world?.setTimeOfDay(this.timeOfDay);
  }

  // ----------------------------------------------------------------- flow ---
  setName(name) {
    this.name = name;
    const p = loadProfile();
    saveProfile({ ...p, name });
  }

  enterWorld() {
    // Keep this at the top of the tap handler: fullscreen + orientation lock
    // are only allowed while the browser still sees a user gesture.
    void enterLandscape();
    const prof = loadProfile();
    const av = prof.av || this.previewAv;
    this.ui.hideScreens();
    this.ui.show("__none__");
    $("hud").hidden = false;
    this.playing = true;
    this._syncOrientation?.();
    this.ui.renderWallet(); // instant paint from the local cache
    this.ui.renderQuickBar();
    // arm + start the golden "HAPPY DIWALI" reveal (triggers the look-up intro)
    if (this.world?.festival) this.world.festival.armed = true;
    this.world?.festival?.beginReveal?.();
    this.net.connect({ name: this.name || prof.name, av });
    // Speaker/voice receive is always on; the mic stays opt-in.
    this.voice.startListening();
    if (isMobileDevice()) {
      $("touch-controls").hidden = false;
      $("cam-touch").hidden = false;
    }
  }

  _wireTouch() {
    const joy = $("joystick"),
      knob = $("joy-knob");
    if (!isMobileDevice() || !joy) return;
    const R = 50;
    // Track the joystick's own touch id so a second finger (jump / camera /
    // interact) never steals or resets the movement vector (multi-touch).
    let joyId = null;
    const move = (t) => {
      const r = joy.getBoundingClientRect();
      const dx = THREE.MathUtils.clamp(
        t.clientX - (r.left + r.width / 2),
        -R,
        R,
      );
      const dy = THREE.MathUtils.clamp(
        t.clientY - (r.top + r.height / 2),
        -R,
        R,
      );
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      this.controller.setJoystick(dx / R, dy / R, true);
    };
    joy.addEventListener(
      "touchstart",
      (e) => {
        if (joyId === null) {
          const t = e.changedTouches[0];
          joyId = t.identifier;
          move(t);
        }
        e.preventDefault();
      },
      { passive: false },
    );
    joy.addEventListener(
      "touchmove",
      (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier === joyId) move(t);
        }
        e.preventDefault();
      },
      { passive: false },
    );
    const release = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === joyId) {
          joyId = null;
          knob.style.transform = "translate(-50%,-50%)";
          this.controller.setJoystick(0, 0, false);
        }
      }
    };
    joy.addEventListener("touchend", release);
    joy.addEventListener("touchcancel", release);

    // jump: press-and-hold works; release clears so landing doesn't re-jump
    const jumpBtn = $("btn-jump");
    jumpBtn.addEventListener(
      "touchstart",
      (e) => {
        this.controller.joy.jump = true;
        jumpBtn.classList.add("pressed");
        e.preventDefault();
      },
      { passive: false },
    );
    const jumpUp = () => jumpBtn.classList.remove("pressed");
    jumpBtn.addEventListener("touchend", jumpUp);
    jumpBtn.addEventListener("touchcancel", jumpUp);

    // interact (E) button — now acts as the mobile "use my cracker" button on
    // the island, and falls back to the E interact prompt near interactables.
    const useBtn = $("btn-use");
    if (useBtn) {
      useBtn.addEventListener(
        "touchstart",
        (e) => {
          e.preventDefault();
          if (this.game.equipped) {
            this.game.useEquipped();
          } else if (this.controller.hoverInteract) {
            this.controller.activate(this.controller.hoverInteract);
          }
        },
        { passive: false },
      );
    }
  }

  // ------------------------------------------------------- orientation ------
  _initOrientation() {
    this._rotateEl = $("rotate-device");
    this._syncOrientation = () => {
      if (!this._rotateEl) return;
      const viewportPortrait = window.innerHeight > window.innerWidth;
      // While the orientation lock is active the viewport can report portrait
      // for a frame or two before the device finishes rotating; don't flash the
      // guard during that handoff.
      const fullscreen =
        document.fullscreenElement || document.webkitFullscreenElement;
      const lockedLandscape =
        !!fullscreen && screen.orientation?.type?.startsWith("landscape");
      const portrait = viewportPortrait && !lockedLandscape;
      this._rotateEl.hidden = !(
        this.playing &&
        portrait &&
        isMobileDevice()
      );
    };
    window.addEventListener("resize", this._syncOrientation);
    window.addEventListener("orientationchange", this._syncOrientation);
    document.addEventListener("fullscreenchange", this._syncOrientation);
    document.addEventListener("webkitfullscreenchange", this._syncOrientation);
    this._syncOrientation();
  }

  // ------------------------------------------------------ economy / hotkeys ---
  // Every HUD button has a desktop shortcut; they never fire while typing and
  // gameplay shortcuts are suppressed while a modal (shop/inventory/settings)
  // is open. Escape always backs out of whatever is on top.
  _wireEconomyKeys() {
    addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (e.target.closest && e.target.closest("input, textarea")) return;
      const ui = this.ui;
      const modalOpen =
        ui.current === "shop" ||
        ui.current === "inventory" ||
        ui.current === "settings";
      if (e.code === "Escape") {
        ui.closeShop();
        ui.closeInventory();
        ui.closePanels();
        const menu = $("player-menu");
        if (menu) menu.remove();
        return;
      }
      if (modalOpen) return;
      switch (e.code) {
        case "KeyI":
          e.preventDefault();
          if (ui.current !== "shop") ui.toggleInventory();
          break;
        case "KeyF":
          e.preventDefault();
          this.useEquipped();
          break;
        case "KeyE": // handled in controller when a prompt is hovered
          break;
        case "Digit1":
          ui.showPlaying(() => this.controller.playEmote("wave"));
          break;
        case "Digit2":
          ui.showPlaying(() => this.controller.playEmote("dance"));
          break;
        case "Digit3":
          ui.showPlaying(() => this.controller.playEmote("greet"));
          break;
        case "KeyP":
          ui.showPlaying(() => ui.togglePlayers());
          break;
        case "KeyB":
          ui.showPlaying(() => ui.toggleFriends());
          break;
        case "KeyV":
          ui.showPlaying(() => ui.toggleMic());
          break;
        case "KeyT":
          ui.showPlaying(() => $("btn-timeofday").click());
          break;
        case "KeyG":
          ui.showPlaying(() => ui.toggleFullscreen());
          break;
      }
    });
  }

  buy(itemId, qty = 1) {
    if (this._buyPending) return; // one order in flight
    const item = fireworkById(itemId);
    if (!item) return;
    const q = Math.max(
      1,
      Math.min(MAX_BUY_QTY, Number.isFinite(qty) ? Math.floor(qty) : 1),
    );
    if (this.net.status !== "open") {
      this.ui.toast("Not connected — try again in a moment.", [], 2400);
      return;
    }
    if (item.price * q > Number(this.wallet.balance || 0)) {
      this.ui.toast("Not enough Diwali Coins for that.", [], 2600);
      this.ui.shakeShop();
      return;
    }
    this._buyPending = true;
    this.ui.setBuying(true);
    clearTimeout(this._buyTimer);
    this._buyTimer = setTimeout(() => {
      this._buyPending = false;
      this.ui.setBuying(false);
    }, 5000);
    this.net.send({ t: "shopBuy", itemId, qty: q });
  }

  equipItem(id) {
    const f = fireworkById(id);
    if (!f || f.kind === "pack") return;
    if ((this.wallet.inventory[id] || 0) <= 0) {
      this.ui.toast(`You don't own any ${f.name}.`, [], 2200);
      this.ui.renderWallet();
      return;
    }
    this.equipped = id;
    this._saveEquipped();
    this.ui.renderWallet();
    this.ui.toast(`${f.name} equipped — press F to use.`, [], 2200);
  }

  unequipItem() {
    this.equipped = null;
    this._saveEquipped();
    this.ui.renderWallet();
  }

  useItem(id) {
    const f = fireworkById(id);
    if (!f || f.kind === "pack") return;
    this.equipped = id;
    this._saveEquipped();
    this.ui.renderWallet();
    // using from the bag should reveal the effect in the world right away
    if (this.ui.current === "inventory") this.ui.closeInventory();
    this.useEquipped();
  }

  _saveEquipped() {
    try {
      if (this.equipped) localStorage.setItem(EQUIPPED_KEY, this.equipped);
      else localStorage.removeItem(EQUIPPED_KEY);
    } catch {
      /* private mode: keep it in memory only */
    }
  }

  // Find a clear, reachable spot just in front of the player. Tries several
  // distances/angles so a cracker is never placed inside a wall or a tree.
  _placementSpot() {
    const p = this.controller.pos,
      yaw = this.controller.yaw;
    for (const dist of [2.4, 1.6, 3.2, 4.2]) {
      for (const da of [0, 0.45, -0.45, 0.95, -0.95, 1.6, -1.6, Math.PI]) {
        const a = yaw + da;
        // Character forward is local -Z, matching the head/face orientation.
        const x = p.x - Math.sin(a) * dist;
        const z = p.z - Math.cos(a) * dist;
        if (this._spotFree(x, z)) return { x, z };
      }
    }
    return null;
  }

  _spotFree(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    if (Math.hypot(x, z) > PLAY_RADIUS - 1.5) return false;
    if (Math.hypot(x - FOUNTAIN.x, z - FOUNTAIN.z) < FOUNTAIN.r + 1.6)
      return false;
    const pad = 0.7;
    for (const c of this.world.colliders) {
      if (c.type === "aabb") {
        if (
          x > c.x0 - pad &&
          x < c.x1 + pad &&
          z > c.z0 - pad &&
          z < c.z1 + pad
        )
          return false;
      } else {
        const r = (c.r ?? 0) + pad;
        const dx = x - c.x,
          dz = z - c.z;
        if (dx * dx + dz * dz < r * r) return false;
      }
    }
    return true;
  }

  // Only send a use when we own one, we're connected, and placement is valid.
  // The server decrements exactly once; the HUD updates from its wallet reply.
  useEquipped() {
    const id = this.equipped;
    if (!id) {
      this.ui.toast(
        "Open your bag and equip a firecracker first (I).",
        [],
        2600,
      );
      return;
    }
    const item = fireworkById(id);
    if (!item) {
      this.equipped = null;
      this._saveEquipped();
      return;
    }
    if ((this.wallet.inventory[id] || 0) <= 0) {
      this.ui.toast(`You're out of ${item.name}.`, [], 2400);
      this.equipped = null;
      this._saveEquipped();
      this.ui.renderWallet();
      return;
    }
    if (this.net.status !== "open") {
      this.ui.toast("Not connected — try again in a moment.", [], 2400);
      return;
    }
    if (this._useLock) return;
    if (this.controller.roomType !== "island") {
      this.ui.toast("Light crackers outside on the island.", [], 2400);
      return;
    }
    let x = this.controller.pos.x,
      z = this.controller.pos.z;
    if (item.kind !== "handheld") {
      const spot = this._placementSpot();
      if (!spot) {
        this.ui.toast("There isn't a clear spot to light that here.", [], 2600);
        return;
      }
      x = spot.x;
      z = spot.z;
    }
    this._useLock = true;
    setTimeout(() => {
      this._useLock = false;
    }, 450); // double-press guard
    this.net.send({
      t: "useItem",
      itemId: id,
      x: +x.toFixed(2),
      z: +z.toFixed(2),
      ry: +this.controller.yaw.toFixed(2),
    });
  }

  _onWallet(m) {
    this.wallet = {
      balance: Number.isFinite(m.balance) ? m.balance : this.wallet.balance,
      inventory:
        m.inventory && typeof m.inventory === "object"
          ? { ...m.inventory }
          : {},
      currency: m.currency || CURRENCY,
      ready: true,
    };
    try {
      localStorage.setItem(
        WALLET_KEY,
        JSON.stringify({
          balance: this.wallet.balance,
          inventory: this.wallet.inventory,
        }),
      );
    } catch {
      /* storage unavailable: play session still works */
    }

    if (m.bought || m.used) {
      this._buyPending = false;
      clearTimeout(this._buyTimer);
      this.ui.setBuying(false);
    }
    // equipped cracker sold out -> clear the selection
    if (this.equipped && (this.wallet.inventory[this.equipped] || 0) <= 0) {
      this.equipped = null;
      this._saveEquipped();
    }
    this.ui.renderWallet();
    if (m.bought) {
      const b = m.bought;
      const name = b.name || fireworkById(b.id)?.name || b.id;
      this.ui.celebrate(
        `Purchased ${name}`,
        `${b.qty}× · ${b.cost} ${CURRENCY.symbol}`,
      );
      if (this.ui.current === "shop") this.ui.renderShop();
    }
    if (m.used) {
      this.ui.flashUse(
        m.used.name || fireworkById(m.used.id)?.name || m.used.id,
      );
    }
  }

  _onFx(m) {
    const fw = this.world.festival;
    if (!fw) return;
    if (m.kind === "handheld") {
      const dur = Number(m.dur) > 0 ? Number(m.dur) : 7;
      if (m.id === this.id) {
        if (this.rig) fw.attachSparkler(this.id, this.rig, dur);
      } else {
        const rp = this.remotePlayers.get(m.id);
        if (rp) fw.attachSparkler(m.id, rp.rig, dur);
      }
      return;
    }
    fw.playFirework(m.item, m.x, m.z, m.ry, m.seed, m.id === this.id);
    // local sky crackers: gently follow the shell so the burst is on-screen
    if (m.id === this.id && (m.kind === "rocket" || m.kind === "aerial")) {
      this.controller.skyGlance(m.kind === "aerial" ? 3.4 : 3.0);
    }
  }

  // ------------------------------------------------------------------ net ---
  _wireNet() {
    const n = this.net;
    n.on("status", (s) => this.ui.connectedUi(s));
    n.on("welcome", (w) => this._onWelcome(w));
    n.on("roomRoster", (m) => {
      // house room supplementary roster (arrives after 'room')
      for (const p of m.players) this._spawnOrSync(p);
    });
    n.on("join", (p) => {
      this._spawnOrSync(p);
      if (p.id !== this.id)
        this.ui.chatLine({ scope: "sys", text: `${p.name} appeared nearby.` });
    });
    n.on("leave", (id) => this._removeRemote(id));
    n.on("snap", (m) => {
      const tNow = performance.now();
      for (const row of m.u || []) {
        const [id, x, y, z, ry, mode] = row;
        const rp = this.remotePlayers.get(id);
        if (!rp) continue;
        rp.push({ t: tNow, x, y, z, ry, mode });
      }
    });
    n.on("chat", (m) => this.ui.chatLine(m));
    n.on("sys", (m) => this.ui.chatLine({ scope: "sys", text: m.text }));
    n.on("emote", (m) => this.remotePlayers.get(m.id)?.emote(m.e));
    n.on("err", (m) => {
      if (!m.msg) return;
      this.ui.toast(m.msg, [], 3000);
      // transaction rejected: release the in-flight lock immediately so the
      // player can correct the order instead of waiting for the watchdog.
      if (typeof m.code === "string" && m.code.startsWith("shop-")) {
        this._buyPending = false;
        clearTimeout(this._buyTimer);
        this.ui.setBuying(false);
        this.ui.shakeShop();
        this.ui.renderShop();
      }
    });
    n.on("room", (m) => this._onRoomSwitch(m));
    n.on("friends", (m) => {
      this.ui.friendsCache = m.list;
      if (!$("friends-panel").hidden) this.ui._renderFriendsPanel();
      if (this.ui.current === "friends") this.ui._renderFriendsScreen();
    });
    n.on("fReq", (m) =>
      this.ui.acceptInvite({ freq: true, from: m.from, name: m.name }),
    );
    n.on("invite", (m) => this.ui.acceptInvite(m));
    n.on("houseOwned", (m) => this.ui.setOwnedHouse(m.houseId));
    n.on("netstat", (ns) => {
      $("hud-room").title = `ping ${this.net.rtt.toFixed(0)} ms`;
      void ns;
    });
    n.on("wallet", (m) => this._onWallet(m));
    n.on("fx", (m) => this._onFx(m));
  }

  _onWelcome(w) {
    this.id = w.id;
    this.name = w.name;
    this.room = w.room;
    this.roomType = w.roomType;
    this.myHouseId = w.house;
    this.voice.setSelf(w.id);
    $("hud-name").textContent = w.name;
    this.ui.setRoomLabel(w.room, w.roomType);

    // local rig
    const prof = loadProfile();
    if (!this.rig) {
      this.rig = new CharacterRig(prof.av || this.previewAv, w.name);
      this.scene.add(this.rig.root);
      this.controller.rig = this.rig;
      // travelling lantern light so the player and nearby ground stay readable
      // in the festival night
      const lamp = new THREE.PointLight(0xffd8aa, 2.2, 24, 2);
      lamp.position.set(0, 2.2, 0);
      this.rig.root.add(lamp);
      this.playerLamp = lamp;
    }
    this.rig.setName(w.name);
    if (w.roomType === "island") {
      this.world.showisland();
    } else {
      this.world.showInterior(this.room.split(":")[1]);
    }
    this._enableWorldShadows(); // room meshes are built lazily per switch
    this.controller.roomType = w.roomType;
    this.controller.roomId = w.room;
    this.controller.pos.set(w.x, w.y || 0, w.z);

    for (const p of w.players) this._spawnOrSync(p);
  }

  _onRoomSwitch(m) {
    // clear current-room remotes; server sends room/join/welcome2 for the new one
    for (const id of [...this.remotePlayers.keys()]) this._removeRemote(id);
    this.room = m.room;
    this.roomType = m.roomType;
    this.controller.roomType = m.roomType;
    this.controller.roomId = m.room;
    this.world.festival?.detachSparkler?.(this.id);
    if (m.roomType === "island") {
      this.world.showisland();
      if (m.plot) {
        this.controller.pos.set(m.x, m.y, m.z);
      }
    } else {
      this.world.showInterior(m.houseId);
      this.controller.pos.set(m.x, m.y, m.z);
      if (m.owner) this.myHouseId = m.houseId;
    }
    this._enableWorldShadows();
    this.controller.roomType = m.roomType;
    this.controller.roomId = m.room;
    this.ui.setRoomLabel(m.room, m.roomType);
    this.controller.pos.set(m.x, m.y, m.z);
  }

  _spawnOrSync(p) {
    if (p.id === this.id) return;
    let rp = this.remotePlayers.get(p.id);
    if (!rp) {
      rp = new RemotePlayer(p, { roomId: this.room });
      this.scene.add(rp.rig.root);
      this.remotePlayers.set(p.id, rp);
    } else {
      rp.rig.setName(p.name);
      rp.name = p.name;
      rp.room = this.room;
    }
    rp.push({
      t: performance.now(),
      x: p.x,
      y: p.y,
      z: p.z,
      ry: p.ry,
      mode: p.mode,
    });
  }

  _removeRemote(id) {
    const rp = this.remotePlayers.get(id);
    if (!rp) return;
    this.scene.remove(rp.rig.root);
    // CSS2D name tags are DOM nodes owned by the rig: removing the 3D root from
    // the scene does NOT remove its label, so dispose the rig explicitly or the
    // name stays stuck on screen after the player leaves / enters a house.
    rp.rig.dispose();
    this.voice.hangup(id);
    this.world.festival?.detachSparkler?.(id);
    this.remotePlayers.delete(id);
  }

  // ------------------------------------------------------------------ loop ---
  _loop(tNow) {
    // Frame cap: skip presentation work until the tier's budget has elapsed.
    // _lastT only advances on processed frames, so dt stays correct.
    if (this._frameMinMs) {
      const minGap = this._frameMinMs * 0.85;
      if (this._lastFrameAt && tNow - this._lastFrameAt < minGap) {
        // On low tier (30 fps) don't keep the GPU driver woken at the full
        // 120 Hz display rate — pace the next wake with setTimeout so the
        // device can rest the pipeline between the 30 frames it actually
        // displays. Medium/high keep requestAnimationFrame (they need the
        // smoother 60 Hz cadence).
        if (this.quality === "low") {
          const wait = this._frameMinMs - (tNow - this._lastFrameAt);
          setTimeout(() => this._loop(performance.now()), Math.max(1, wait));
        }
        return;
      }
    }
    this._lastFrameAt = tNow;
    requestAnimationFrame((t) => this._loop(t));
    const t = tNow / 1000;
    if (this._lastT === undefined) this._lastT = t;
    let dt = Math.min(0.1, t - this._lastT);
    this._lastT = t;

    if (this.playing && this.rig) {
      this.controller.update(dt);
      if (this.quality !== "low") this._updateShadowFollow();
      if (this.quality !== "low") this._updateCompass();

      // send state at 15 Hz
      if (tNow - this._lastSend > 1000 / 15) {
        this._lastSend = tNow;
        this.controller.net.send({
          t: "st",
          seq: this.seq++,
          x: +this.controller.pos.x.toFixed(2),
          y: +this.controller.pos.y.toFixed(2),
          z: +this.controller.pos.z.toFixed(2),
          ry: +this.controller.yaw.toFixed(2),
          mode: this.controller.mode,
        });
      }

      // remote interpolation + room-wide voice
      const renderT = performance.now() - SNAPSHOT_BUFFER;
      const candidates = [];
      for (const rp of this.remotePlayers.values()) {
        rp.tick(renderT, dt);
        const dist = Math.hypot(
          rp.rig.root.position.x - this.controller.pos.x,
          rp.rig.root.position.z - this.controller.pos.z,
        );
        candidates.push({ id: rp.id, dist });
        // Name tags are DOM layers re-projected through CSS2DRenderer; at
        // distance they are unreadable anyway, so skip them entirely.
        if (rp.rig.label) rp.rig.label.visible = dist < 70;
      }
      this.voice.updatePeers(candidates);
    }

    // character select preview also animates through its own hook
    if (this.ui.previewLoop && this.ui.current === "character")
      this.ui.previewLoop(tNow);
    if (this.world) this.world.tick(tNow, dt);

    this.renderer.render(this.scene, this.camera);
    // CSS2D re-projects every label, re-sorts z-order and writes DOM
    // transforms. Name tags don't need to track the world smoothly, so we
    // cut the write rate to ~15 Hz on low tier and 30 Hz otherwise.
    this._labelAcc = (this._labelAcc || 0) + dt;
    const labelHz = this.quality === "low" ? 0.066 : 0.033;
    if (this._labelAcc >= labelHz) {
      this._labelAcc = 0;
      this.labelRenderer.render(this.scene, this.camera);
    }
  }
}

// patch: the UI needs a reference back for invite/freq flows
class UIWithFreq extends UI {}
void UIWithFreq;

window.__DiwalyMeetUp = new Game();
