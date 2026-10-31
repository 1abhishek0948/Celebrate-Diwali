// ---------------------------------------------------------------------------
// Third-person controller: input (mouse+kb / touch joystick), camera boom,
// collision resolution vs world colliders, emote state, interaction scanning.
// Movement is predicted locally; the server validates and clamps it.
// ---------------------------------------------------------------------------
import * as THREE from "three";
import {
  WALK_SPEED,
  RUN_SPEED,
  JUMP_SPEED,
  GRAVITY,
  PLAY_RADIUS,
} from "../shared/constants.js";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

const SKY_CAM_DUR = 6.0; // seconds the opening sky framing holds
const SKY_CAM_PITCH = -0.1; // resting camera pitch once it has lifted
const GLANCE_LIFT = 4.0; // metres the look target lifts for a local sky cracker
const GLANCE_DUR = 3.2; // seconds the sky glance holds (input cancels it)

function shortestDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Controller {
  constructor({ canvas, world, camera, net }) {
    this.canvas = canvas;
    this.camera = camera;
    this.world = world;
    this.net = net;

    this.pos = new THREE.Vector3(30, 0, 0);
    this.vel = new THREE.Vector3();
    this.vy = 0;
    this.yaw = 0; // character facing
    this.camYaw = 0; // camera orbit around player
    this.camPitch = 0.38;
    this.lookSensitivity = 0.0042;
    this.camDist = 7.4;
    this.grounded = true;
    this.mode = 0;
    this.motionSpeed = 0;
    this._moving = false; // hysteresis latches for the animation state machine
    this._running = false;

    this.keys = new Set();
    this.joy = { x: 0, y: 0, active: false };
    this.pointerLocked = false;

    // right/left mouse-drag camera orbit state (no pointer lock: the cursor
    // stays visible); see _bind
    this._dragBtns = new Set();
    this._lastMouse = { x: 0, y: 0 };

    // smoothed effective boom distance (zoom + obstruction clamp + portrait boost)
    this._camDistEff = this.camDist;

    this.rig = null; // CharacterRig owned by main
    this.emote = null;
    this.roomType = "island";
    this.roomId = "island-1";
    this.hoverInteract = null;
    this.onPrompt = null;
    this.onShop = null; // set by main -> open the firecracker shop

    // cinematic "look up at the sky greeting" intro (cancelled by any input)
    this._sky = { on: false, t: 0, cancel: false };

    // brief look-up when the local player lights a rocket / aerial so the
    // trail and sky burst stay inside the third-person frame (cancelled by
    // movement or camera input, then eased back down)
    this._glance = { t: 0, dur: 0 };
    this._lookLift = 0;

    // set while a shop/inventory modal is open: freezes movement + activation
    // so typing/clicking in the UI can never walk the character around.
    this.locked = false;

    this._bind();
  }

  setLocked(v) {
    this.locked = !!v;
    if (this.locked) {
      this.keys.clear();
      this.joy = { x: 0, y: 0, active: false };
      this.hoverInteract = null;
      this.onPrompt?.(null);
      this.cancelSkyGlance();
    }
  }

  setSensitivity(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    this.lookSensitivity = (0.0042 * clamp(n, 30, 200)) / 100;
  }

  _bind() {
    addEventListener("keydown", (e) => {
      if (this.locked) return;
      if (e.target.closest && e.target.closest("input, textarea")) return;
      this.keys.add(e.code);
      // keep the page from scrolling on movement keys while playing
      if (
        /^(Key[WASD]|Arrow|Space)$/.test(e.code) ||
        e.code.startsWith("Arrow")
      )
        e.preventDefault();
      if (this._sky.on && /^(Key[WASD]|Arrow)/.test(e.code))
        this._sky.cancel = true;
      if (/^(Key[WASD]|Arrow|Space)/.test(e.code)) this.cancelSkyGlance();
      if (e.code === "KeyE" && this.hoverInteract)
        this.activate(this.hoverInteract);
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => {
      this.keys.clear();
      this._dragBtns.clear();
    });

    // --- mouse camera: rotate while a mouse button is held on the world -----
    // Hold left-click (or right-click) and drag to orbit. No pointer lock is
    // used, so the cursor always stays visible; left-clicks on HUD/UI elements
    // sit above the canvas and never reach this handler.
    this._dragBtns = new Set();
    const suppressMenu = (e) => {
      if (this._dragBtns.size || e.target === this.canvas) e.preventDefault();
    };
    this.canvas.addEventListener("contextmenu", suppressMenu);
    addEventListener("contextmenu", suppressMenu); // release after right-drag
    this.canvas.addEventListener("mousedown", (e) => {
      if (this.locked || (e.button !== 0 && e.button !== 2)) return;
      this._dragBtns.add(e.button);
      this._lastMouse = { x: e.clientX, y: e.clientY };
      this.canvas.style.cursor = "grabbing";
    });
    addEventListener("mousemove", (e) => {
      if (!this._dragBtns.size || this.locked) return;
      this._look(e.clientX - this._lastMouse.x, e.clientY - this._lastMouse.y);
      this._lastMouse = { x: e.clientX, y: e.clientY };
    });
    const endDragBtn = (e) => {
      this._dragBtns.delete(e.button);
      if (!this._dragBtns.size) this.canvas.style.cursor = "";
    };
    addEventListener("mouseup", endDragBtn);
    const endDragAll = () => {
      this._dragBtns.clear();
      this.canvas.style.cursor = "";
    };
    addEventListener("blur", endDragAll);
    // keep the old pointer-lock flag accurate in case other code locks the page
    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });

    addEventListener(
      "wheel",
      (e) => {
        if (this.locked) return;
        this.camDist = clamp(this.camDist + Math.sign(e.deltaY) * 0.7, 3.4, 12);
      },
      { passive: true },
    );

    const camZone = document.getElementById("cam-touch");
    if (camZone) {
      let last = null;
      camZone.addEventListener(
        "touchstart",
        (e) => {
          last = e.changedTouches[0];
          e.preventDefault();
        },
        { passive: false },
      );
      camZone.addEventListener(
        "touchmove",
        (e) => {
          const t = e.changedTouches[0];
          if (last && t.identifier === last.identifier) {
            this._look(t.clientX - last.clientX, t.clientY - last.clientY);
          }
          last = t;
        },
        { passive: false },
      );
      camZone.addEventListener("touchend", (e) => {
        if (
          last &&
          [...e.changedTouches].some((t) => t.identifier === last.identifier)
        )
          last = null;
      });
      camZone.addEventListener("touchcancel", () => {
        last = null;
      });
    }
  }

  _look(dx, dy) {
    if (this.locked) return;
    this.cancelSkyGlance(); // hand control back at once
    if (this._sky.on) this._sky.cancel = true; // hand control straight back to the player
    this.camYaw -= dx * this.lookSensitivity;
    this.camPitch = clamp(
      this.camPitch + dy * this.lookSensitivity,
      -0.3,
      1.15,
    );
  }

  // Ease the camera to face the festival street and lift to the sky greeting so
  // the golden "HAPPY DIWALI" reveal is witnessed as the opening moment. The
  // camera settles at a horizon-level pitch and hands control back; any drag,
  // joystick or look input cancels it instantly.
  startSkyCam() {
    if (this._sky.on) return;
    this._sky = { on: true, t: 0, cancel: false };
  }

  _skyCam(dt) {
    const s = this._sky;
    if (!s.on) return;
    s.t += dt;
    if (s.cancel) {
      s.on = false;
      return;
    }
    if (s.t >= SKY_CAM_DUR) {
      s.on = false;
      return;
    }
    const k = smoothstep(0.15, 1.9, s.t); // ramp in, then hold the framing
    this.camYaw +=
      shortestDelta(this.camYaw, Math.PI) * Math.min(1, dt * 1.6 * k);
    this.camPitch +=
      (SKY_CAM_PITCH - this.camPitch) * Math.min(1, dt * 1.6 * k);
  }

  setJoystick(x, y, active) {
    if (this.locked) {
      this.joy = { x: 0, y: 0, active: false };
      return;
    }
    if (active && this._sky.on) this._sky.cancel = true;
    if (active) this.cancelSkyGlance();
    this.joy = { x, y, active };
  }

  // Follow a locally lit rocket / aerial shell with a brief, gentle look-up.
  // Movement or camera input cancels it immediately (see cancelSkyGlance).
  skyGlance(dur = GLANCE_DUR) {
    if (this.locked) return;
    this._glance.t = 0;
    this._glance.dur = dur;
  }

  cancelSkyGlance() {
    this._glance.dur = 0;
  }

  _skyGlance(dt) {
    const g = this._glance;
    let want = 0;
    if (g.dur > 0) {
      g.t += dt;
      if (g.t >= g.dur) {
        g.dur = 0;
      } else {
        const easeIn = Math.min(1, g.t / 0.3);
        const easeOut = Math.min(1, (g.dur - g.t) / 0.7);
        want = GLANCE_LIFT * Math.min(easeIn, easeOut);
      }
    }
    this._lookLift += (want - this._lookLift) * Math.min(1, dt * 9);
  }

  scanInteract() {
    const { x, z } = this.pos;
    let best = null,
      bestD = 3.0;
    for (const it of this.world.interactables) {
      // Keep room-specific objects inside their own house interiors.
      if (it.room && it.room !== this.roomId) continue;
      if (it.kind === "door" && this.roomType !== "island") continue;
      if (it.kind === "festival" && this.roomType !== "island") continue;
      if (it.kind === "shop" && this.roomType !== "island") continue;
      const d = Math.hypot(it.x - x, it.z - z);
      if (d < bestD) {
        best = it;
        bestD = d;
      }
    }
    if (best !== this.hoverInteract) {
      this.hoverInteract = best;
      this.onPrompt?.(best);
    }
  }

  activate(it) {
    if (!it) return;
    if (it.kind === "door") {
      this.net.send({ t: "door", houseId: it.houseId });
    } else if (it.kind === "greet") {
      this.playEmote("greet");
    } else if (it.kind === "festival") {
      this.world.festival?.interact(it.id);
    } else if (it.kind === "shop") {
      this.onShop?.(it);
    }
  }

  playEmote(e) {
    // rig time domain: CharacterRig.tick computes et = rig.t - started
    this.emote = { e, started: this.rig.t, expire: this.rig.t + 6.5 };
    this.net.send({ t: "emote", e });
  }

  update(dt) {
    if (!this.rig) return;

    //----------- input vector -------------------------------------------------
    let ix = 0,
      iz = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) iz -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) iz += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) ix -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) ix += 1;
    if (!ix && !iz && this.joy.active) {
      ix = this.joy.x;
      iz = this.joy.y;
    }
    let mag = Math.hypot(ix, iz);
    if (mag > 1) {
      ix /= mag;
      iz /= mag;
      mag = 1;
    }

    //----------- movement -----------------------------------------------------
    // Shift (or a fully-deflected joystick) RUNS; releasing Shift returns to
    // the slower, natural walk speed.
    const run =
      this.keys.has("ShiftLeft") ||
      this.keys.has("ShiftRight") ||
      (this.joy.active && mag > 0.72);
    let target = new THREE.Vector3(0, 0, 0);
    if (mag > 0.05) {
      const camYaw = this.camYaw;
      // camera-relative forward/right (camera sits behind at +offset)
      const fx = -Math.sin(camYaw),
        fz = -Math.cos(camYaw);
      const rx = -fz,
        rz = fx;
      target.set(ix * rx - iz * fx, 0, ix * rz - iz * fz);
      target.normalize().multiplyScalar((run ? RUN_SPEED : WALK_SPEED) * mag);
      // Character meshes face local -Z. Convert the world movement vector to
      // that convention so the face leads the walk instead of looking/backing
      // into the direction of travel.
      const want = Math.atan2(-target.x, -target.z);
      this.yaw += shortestDelta(this.yaw, want) * Math.min(1, dt * 14);
      if (!this.grounded) {
        /* mid-air drift allowed */
      }
    } else {
      this.vel.multiplyScalar(Math.exp(-dt * 12));
    }

    this.vel.x += (target.x - this.vel.x) * Math.min(1, dt * 12);
    this.vel.z += (target.z - this.vel.z) * Math.min(1, dt * 12);

    // jump
    if ((this.keys.has("Space") || this.joy.jump) && this.grounded) {
      this.vy = JUMP_SPEED;
      this.grounded = false;
      this.joy.jump = false;
    }
    this.vy -= GRAVITY * dt;
    this.pos.y += this.vy * dt;
    if (this.pos.y <= 0) {
      this.pos.y = 0;
      this.vy = 0;
      this.grounded = true;
    }

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // world bounds + collisions
    if (this.roomType === "island") {
      const r = Math.hypot(this.pos.x, this.pos.z);
      if (r > PLAY_RADIUS) {
        const k = PLAY_RADIUS / r;
        this.pos.x *= k;
        this.pos.z *= k;
      }
    } else {
      this.pos.x = clamp(this.pos.x, -8.2, 8.2);
      this.pos.z = clamp(this.pos.z, -6.6, 6.6);
    }
    this._collide();

    //----------- rig ----------------------------------------------------------
    this.rig.root.position.copy(this.pos);
    this.rig.root.rotation.y = this.yaw;
    // Use displacement after collision resolution for animation state. This
    // prevents a blocked character from running in place against a wall. The
    // raw ground-plane distance drives the rig's stride matching (Y excluded so
    // jump arcs don't spike the cadence); a lightly smoothed speed keeps the
    // mode thresholds (below) from flickering on raw per-frame noise.
    const dx = this.pos.x - (this._prev?.x ?? this.pos.x);
    const dz = this.pos.z - (this._prev?.z ?? this.pos.z);
    const moved = Math.hypot(dx, dz);
    this.motionSpeed +=
      (moved / Math.max(dt, 1e-4) - this.motionSpeed) * Math.min(1, dt * 10);
    this.mode = this.animMode();
    this.rig.tick(dt, this.mode, this._activeEmote(), moved);
    this._prev = this.pos.clone();

    //----------- camera -------------------------------------------------------
    // Fixed, stable third-person boom. Portrait / narrow viewports pull the
    // camera back a little so the character never fills more of the frame than
    // it does on wide screens.
    this._skyCam(dt);
    this._skyGlance(dt);
    const pitch = clamp(this.camPitch, -0.42, 1.15);
    const aspect = this.camera.aspect || 1;
    const portraitBoost = aspect < 1.05 ? clamp(1.05 / aspect, 1, 1.38) : 1;
    const wantDist = this.camDist * portraitBoost;
    this._camDistEff += (wantDist - this._camDistEff) * Math.min(1, dt * 6);

    // boom direction (unit): behind the character, lifted by pitch
    const dir = new THREE.Vector3(
      Math.sin(this.camYaw) * Math.cos(pitch),
      Math.sin(pitch) + 0.35,
      Math.cos(this.camYaw) * Math.cos(pitch),
    ).normalize();

    // obstruction: walk the boom from near to far and stop before the eye
    // point would end up inside a building / the ground
    const dist = this._camObstructDist(dir, this._camDistEff);
    const eye = this.pos.clone().addScaledVector(dir, dist);
    eye.y = Math.max(eye.y, 0.45);
    this.camera.position.lerp(eye, Math.min(1, dt * 9));
    this.camera.lookAt(
      this.pos.x,
      this.pos.y + 1.4 + this._lookLift,
      this.pos.z,
    );

    this.scanInteract();
  }

  // largest boom length that keeps the camera eye out of tall colliders
  // (houses, shops, fountain, beach bar — anything registered with an `h`)
  _camObstructDist(dir, want) {
    const cols = (this.world.camColliders ??= (
      this.world.colliders || []
    ).filter((c) => Number.isFinite(c.h) && c.h > 1.5));
    if (!cols.length) return want;
    const PAD = 0.35;
    const py = this.pos.y;
    let best = want;
    const STEPS = 10;
    for (let i = 2; i <= STEPS; i++) {
      const t = (i / STEPS) * want;
      const x = this.pos.x + dir.x * t;
      const y = py + dir.y * t;
      const z = this.pos.z + dir.z * t;
      if (y < 0.45) {
        best = t;
        continue;
      } // grazing the ground: clamp at eye level later
      let blocked = false;
      for (const c of cols) {
        if (y > c.h) continue;
        if (c.type === "aabb") {
          if (
            x > c.x0 - PAD &&
            x < c.x1 + PAD &&
            z > c.z0 - PAD &&
            z < c.z1 + PAD
          ) {
            blocked = true;
            break;
          }
        } else {
          const dx = x - c.x,
            dz = z - c.z;
          const r = (c.r ?? 0) + PAD;
          if (dx * dx + dz * dz < r * r) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) {
        best = Math.max(1.6, t - want / STEPS);
        break;
      }
      best = t;
    }
    return Math.min(want, best);
  }

  _activeEmote() {
    if (!this.emote) return null;
    if (this.rig.t > this.emote.expire) {
      this.emote = null;
      return null;
    }
    return this.emote;
  }

  _standPosSet(p) {
    this._standPos = p;
  }

  animMode() {
    // Airborne: play the jump clip for the whole arc (the old rule left the
    // character "walking/running" in the air while falling).
    if (!this.grounded) return 3;
    const sp = this.motionSpeed;
    // Hysteresis on the idle/moving and walk/run thresholds so a speed hovering
    // near a cut-off can no longer flicker the animation between clips.
    if (this._moving) {
      if (sp < 0.18) this._moving = false;
    } else if (sp > 0.34) {
      this._moving = true;
    }
    if (!this._moving) return 0;
    if (this._running) {
      if (sp < 3.9) this._running = false;
    } else if (sp > 4.4) {
      this._running = true;
    }
    return this._running ? 2 : 1;
  }

  _collide() {
    const r = 0.35;
    const c = { x: this.pos.x, z: this.pos.z };
    for (const col of this.world.colliders) {
      if (col.type === "aabb") {
        const nx = clamp(c.x, col.x0, col.x1);
        const nz = clamp(c.z, col.z0, col.z1);
        const dx = c.x - nx,
          dz = c.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 < r * r) {
          if (d2 > 1e-9) {
            const d = Math.sqrt(d2);
            c.x = nx + (dx / d) * r;
            c.z = nz + (dz / d) * r;
          } else {
            // deep inside: push along the smallest exit axis
            const exitX = Math.min(c.x - (col.x0 - r), col.x1 + r - c.x);
            const exitZ = Math.min(c.z - (col.z0 - r), col.z1 + r - c.z);
            if (exitX < exitZ)
              c.x += c.x - (col.x0 + col.x1) / 2 >= 0 ? exitX : -exitX;
            else c.z += c.z - (col.z0 + col.z1) / 2 >= 0 ? exitZ : -exitZ;
          }
        }
      } else {
        const dx = c.x - col.x,
          dz = c.z - col.z;
        const d = Math.hypot(dx, dz);
        const min = col.r + r;
        if (d < min) {
          const k = d < 1e-5 ? 0 : (min - d) / d;
          c.x += dx * k;
          c.z += dz * k;
        }
      }
    }
    this.pos.x = c.x;
    this.pos.z = c.z;
  }
}
