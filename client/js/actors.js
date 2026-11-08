// ---------------------------------------------------------------------------
// Player character system — realistic Ready Player Me avatars with mocap
// animation (idle / walk / run / jump / dance) plus a code-driven gesture
// layer (wave, namaste greet) that runs as a two-bone IK override on the real
// arm bones. The pre-2024 procedural primitive rig is kept verbatim as
// ProceduralRig and is used automatically if the avatar assets cannot load
// (offline dev, missing files), so the game never breaks.
//
// The public CharacterRig API is unchanged:
//   new CharacterRig(av, name, {noLabel})  .root  .setName()  .t  .emote
//   rig.tick(dt, mode, emoteNow, posDelta) with mode 0 idle / 1 walk / 2 run /
//   3 air and emoteNow = {e:'wave'|'dance'|'greet', started: rig.t} | null.
//
// Appearance ints (wire format unchanged, see avatar_assets.js):
//   g gender, b skin, h hair color, y hairstyle->avatar variant, e eyewear.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CSS2DObject } from '/vendor/CSS2DRenderer.js';
import { WALK_SPEED, RUN_SPEED } from '../shared/constants.js';
import {
  SKIN, HAIRS, GOLD, DARK,
  loadAnimationSet, instantiateAvatar, makeAvatarHolder,
} from './avatar_assets.js';

export { SKIN, HAIRS };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / ((b - a) || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

// shared geometry for the wrapper's contact shadow + procedural fallback
const BLOB_GEO = new THREE.CircleGeometry(0.42, 20);

// ---------------------------------------------------------------------------
// Realistic avatar implementation (primary path)
// ---------------------------------------------------------------------------
class AvatarRig {
  // inst: the object returned by instantiateAvatar(); rig: owning CharacterRig
  constructor(rig, inst) {
    this.inst = inst;
    this.model = new THREE.Group();
    this.holder = makeAvatarHolder(); // glTF avatars face +Z; FunLand faces -Z
    this.holder.add(inst.root);
    this.model.add(this.holder);

    this.mixer = new THREE.AnimationMixer(inst.root);
    const mk = (clip, loop, clampWhenFinished = false) => {
      const a = this.mixer.clipAction(clip);
      a.loop = loop;
      a.clampWhenFinished = clampWhenFinished;
      return a;
    };
    this.actions = {
      idle: mk(inst.clips.idle, THREE.LoopRepeat),
      walk: mk(inst.clips.walk, THREE.LoopRepeat),
      run: mk(inst.clips.run, THREE.LoopRepeat),
      dance: mk(inst.clips.dance, THREE.LoopRepeat),
      jump: mk(inst.clips.jump, THREE.LoopOnce, true),
    };
    // natural cadence of each clip at timeScale 1, MEASURED from the vendored
    // clips (stance-foot slide while planted, averaged; 120 Hz FK integration):
    //   masculine walk 1.65 m/s, feminine walk 1.45 m/s, run 4.05 m/s both.
    // Cadence matching = speed / natural — this is what keeps the feet
    // tracking the ground instead of skating.
    this.natural = inst.gender === 0
      ? { walk: 1.45, run: 4.05 }
      : { walk: 1.65, run: 4.05 };
    // native jump duration vs the game's air time (0.77 s at 5.4 m/s / g 14)
    this.jumpScale = clamp(inst.clips.jump.duration / 0.78, 0.6, 2.4);

    // Every action is played once and stays live; afterwards only weights and
    // time scales change (the tick's blend layer). Keeping the phases running
    // means a blend can never restart a clip at t=0, so transitions have no
    // pose pops.
    this._wt = { idle: 1, walk: 0, run: 0, jump: 0, dance: 0 };
    this._tgt = { idle: 1, walk: 0, run: 0, jump: 0, dance: 0 };
    for (const [key, action] of Object.entries(this.actions)) {
      action.enabled = true;
      action.setEffectiveWeight(this._wt[key]);
      action.play();
    }
    this.mixer.update(0); // pose from the idle clip before first render
    rig.root.add(this.model);

    // gesture layer state (wave / greet / dance): {name, t, key, blend} | null
    this.gesture = null;
    // Key of the last emote consumed by the gesture layer. Keying on
    // `${e}:${started}` instead of object identity means a replayed/retriggered
    // emote is detected reliably (and the same emote never restarts itself).
    this._lastEmoteKey = null;
    this._blinkAt = 1.2 + Math.random() * 2.5;
    this.speedEma = 0;

    // scratch objects — reused every frame, nothing allocated in tick().
    // Gesture-side temps (targets/bases passed into _ikArm) are kept separate
    // from the solver-side temps so _ikArm can never clobber its own inputs.
    this._gv1 = new THREE.Vector3();
    this._gv2 = new THREE.Vector3();
    this._gv3 = new THREE.Vector3();
    this._gv4 = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._iv1 = new THREE.Vector3();
    this._iv2 = new THREE.Vector3();
    this._iv3 = new THREE.Vector3();
    this._iv4 = new THREE.Vector3();
    this._iv5 = new THREE.Vector3();
    this._iv6 = new THREE.Vector3();
    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._q3 = new THREE.Quaternion();
    this._q4 = new THREE.Quaternion();
    this._q5 = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._UP_Y = new THREE.Vector3(0, 1, 0);
  }

  // ---- two-bone IK for one arm, in world space ------------------------------
  // Wrist target and bend hint are given in avatar-local space (holder), so
  // the same numbers work for every avatar (the RPM armatures share their
  // proportions). Basis = [x, y, z] axes of the hand in avatar space:
  // +y along the fingers, +z the palm normal.
  _ikArm(side, wristLocal, bendLocal, basis, env, dt, handRoll = 0, foreRoll = 0) {
    const { bones, rest } = this.inst;
    const arm = bones[`${side}Arm`];
    const fore = bones[`${side}ForeArm`];
    const hand = bones[`${side}Hand`];
    const r = rest[side];
    if (!arm || !fore || !hand || !r || env <= 0.001) return;

    const upperLen = r.upperLen;
    const lowerLen = r.lowerLen;

    this.holder.updateWorldMatrix(true, false);

    // wrist target: avatar-local -> world
    const wristW = this._iv1.copy(wristLocal);
    this.holder.localToWorld(wristW);
    const shoulderW = arm.getWorldPosition(this._iv2);
    const axis = this._iv3.subVectors(wristW, shoulderW);
    let dist = axis.length();
    if (dist < 1e-4) return;
    dist = clamp(dist, 0.02, upperLen + lowerLen - 0.005);
    axis.normalize();

    // elbow bend direction: avatar-local hint -> world direction
    const bendW = this._iv4.copy(bendLocal).applyQuaternion(
      this.holder.getWorldQuaternion(this._q1),
    );
    bendW.addScaledVector(axis, -bendW.dot(axis));
    if (bendW.lengthSq() < 1e-5) bendW.set(0, -1, 0).addScaledVector(axis, -axis.y);
    bendW.normalize();

    const along = (upperLen * upperLen - lowerLen * lowerLen + dist * dist) / (2 * dist);
    const reach = Math.sqrt(Math.max(0, upperLen * upperLen - along * along));
    // elbow position, then the two bone directions in world space
    const elbowPos = this._iv6.copy(shoulderW).addScaledVector(axis, along).addScaledVector(bendW, reach);
    const upperDir = this._iv5.copy(elbowPos).sub(shoulderW).normalize();
    const lowerDir = this._iv4.copy(wristW).sub(elbowPos).normalize();

    const k = Math.min(1, dt * 16) * env;

    // shoulder: align bone +Y (which points at the child joint in the RPM
    // rest pose) with the upper-arm direction
    const qU = this._q1.setFromUnitVectors(this._UP_Y, upperDir);
    const parentU = arm.parent.getWorldQuaternion(this._q2);
    const armTarget = this._q3.copy(parentU).invert().multiply(qU);
    arm.quaternion.slerp(armTarget, k);

    // forearm: solve against the shoulder target so the chain stays stable
    const armWorldTarget = this._q4.copy(parentU).multiply(armTarget);
    const qL = this._q1.setFromUnitVectors(this._UP_Y, lowerDir);
    const foreTarget = this._q4.invert().multiply(qL);
    fore.quaternion.slerp(foreTarget, k);
    if (foreRoll !== 0) {
      fore.quaternion.multiply(
        this._q4.setFromAxisAngle(this._UP_Y, foreRoll * env),
      );
    }

    // hand: explicit orientation (basis in avatar space) + optional roll about
    // the finger axis so the wave rocks the palm, not the whole arm
    const handQWorld = this._q3.setFromRotationMatrix(
      this._m.makeBasis(basis[0], basis[1], basis[2]),
    );
    this.holder.getWorldQuaternion(this._q2);
    handQWorld.premultiply(this._q2);
    const handParent = fore.getWorldQuaternion(this._q1).invert();
    const handTarget = handParent.multiply(handQWorld);
    hand.quaternion.slerp(handTarget, k);
    if (handRoll !== 0) {
      hand.quaternion.multiply(
        this._q4.setFromAxisAngle(this._UP_Y, handRoll * env),
      );
    }
  }

  // ---- per-frame update ------------------------------------------------------
  tick(dt, mode, emoteNow, posDelta) {
    const inst = this.inst;

    // smoothed movement speed (m/s). Each raw sample is clamped so a single
    // late frame (hitch, teleport) can never spike the cadence or weights.
    const rawSpd = posDelta / Math.max(dt, 1e-4);
    const s = (this.speedEma +=
      (clamp(rawSpd, 0, RUN_SPEED * 1.3) - this.speedEma) * Math.min(1, dt * 9));

    // ---------------- gesture layer (wave / namaste / dance) ----------------
    const e = emoteNow ? emoteNow.e : null;
    const emoteKey = emoteNow
      ? `${emoteNow.e}:${emoteNow.started ?? 0}`
      : null;
    const isGesture = e === 'wave' || e === 'greet' || e === 'dance';
    if (this.gesture) {
      const g = this.gesture;
      g.t += dt;
      const gd = g.name === 'wave' ? 3.0 : g.name === 'greet' ? 3.4 : 0;
      if (g.done) {
        // One-shot wave/namaste finishing after its driving emote ended
        // early: keep the arc playing until its own duration is up, unless a
        // brand-new emote arrives in the meantime.
        if (isGesture && emoteKey) {
          this.gesture = { name: e, t: 0, key: emoteKey, blend: true };
          this._lastEmoteKey = emoteKey;
        } else if (gd && g.t >= gd) {
          this.gesture = null;
        }
      } else if (emoteKey !== g.key) {
        if (isGesture) {
          // New wave/greet/dance (different type, or a newly started
          // instance): switch immediately, starting near full envelope so
          // the arms do not pop back through the idle pose first.
          this.gesture = { name: e, t: 0, key: emoteKey, blend: true };
          this._lastEmoteKey = emoteKey;
        } else if (gd && g.t < gd) {
          // Source emote expired: let the one-shot finish its own arc.
          g.done = true;
          this._lastEmoteKey = g.key;
          g.key = null;
        } else {
          if (g.key) this._lastEmoteKey = g.key;
          this.gesture = null;
        }
      } else if (gd && g.t >= gd) {
        this._lastEmoteKey = g.key;
        this.gesture = null;
      }
    } else if (isGesture && emoteKey !== this._lastEmoteKey) {
      this._lastEmoteKey = emoteKey;
      this.gesture = { name: e, t: 0, key: emoteKey, blend: false };
    }

    // ---------------- locomotion blend targets ------------------------------
    // Idle / walk / run are three always-live clips whose weights morph with
    // the measured speed; jump and dance are exclusive whole-body states.
    // Nothing is ever reset mid-stride, so state changes blend instead of pop.
    const act = this.actions;
    const tgt = this._tgt;
    tgt.idle = tgt.walk = tgt.run = tgt.jump = tgt.dance = 0;
    if (mode === 3) {
      tgt.jump = 1;
    } else if (this.gesture?.name === 'dance') {
      tgt.dance = 1;
    } else if (this.gesture) {
      tgt.idle = 1; // wave / greet: legs hold the idle mocap, IK drives arms
    } else {
      const moving = smoothstep(0.14, 0.55, s);
      let walkW = (1 - smoothstep(1.9, 3.4, s)) * moving; // full walk below 1.9 m/s
      let runW = smoothstep(2.6, 4.0, s) * moving;       // full run above 4.0 m/s
      const mv = walkW + runW;
      if (mv > 1e-3) { tgt.walk = walkW / mv; tgt.run = runW / mv; }
      tgt.idle = 1 - (tgt.walk + tgt.run);
    }

    // ease the weights toward the targets (a bit faster ramping up than down),
    // then normalize so the pose is always driven at full strength: whichever
    // clips are racing each other, their total is exactly 1 — same contract a
    // crossfade gives, without any of the resets.
    let wSum = 0;
    const ease = {};
    for (const key of ['idle', 'walk', 'run', 'jump', 'dance']) {
      const a = act[key];
      if (!a) { ease[key] = 0; continue; }
      const to = tgt[key];
      const from = this._wt[key];
      ease[key] = Math.abs(to - from) < 0.004
        ? to
        : from + (to - from) * Math.min(1, dt * (to > from ? 12 : 8.5));
      wSum += ease[key];
    }
    const inv = wSum > 1e-6 ? 1 / wSum : 0;
    for (const key of ['idle', 'walk', 'run', 'jump', 'dance']) {
      const a = act[key];
      if (!a) continue;
      if (key === 'jump' && ease.jump > 0.001 && this._wt.jump <= 0.001) {
        // one-shot hop: restart from take-off whenever it rises out of rest
        a.reset();
      }
      const w = ease[key] * inv;
      this._wt[key] = w;
      a.setEffectiveWeight(w);
      if (key === 'jump' && w > 0.001) a.setEffectiveTimeScale(this.jumpScale);
    }

    // cadence: match each clip's playback to the actual movement so the feet
    // track the ground instead of skating
    act.walk.setEffectiveTimeScale(clamp(s / this.natural.walk, 0.55, 2.1));
    act.run.setEffectiveTimeScale(clamp(s / this.natural.run, 0.7, 1.8));

    // while walk and run are both audible, lock them to the same stride phase
    // so the weight blend reads as one continuous gait (no foot pops mid-fade)
    if (this._wt.walk > 0.03 && this._wt.run > 0.03) {
      const leadIsWalk = this._wt.walk >= this._wt.run;
      const lead = leadIsWalk ? act.walk : act.run;
      const trail = leadIsWalk ? act.run : act.walk;
      trail.time =
        ((lead.time % lead.getClip().duration) / lead.getClip().duration) *
        trail.getClip().duration;
    }

    // 1) evaluate the blended clips into the bone pose for this frame
    this.mixer.update(dt);

    // 2) gesture IK overrides the arm bones AFTER the mixer has written
    // (dance is a full-body clip, so it stays out of the IK layer)
    if (this.gesture && (this.gesture.name === 'wave' || this.gesture.name === 'greet')) {
      const g = this.gesture;
      const gd = g.name === 'wave' ? 3.0 : 3.4;
      const easeIn = g.blend
        ? smoothstep(0.02, 0.22, g.t)
        : smoothstep(0.05, 0.35, g.t);
      const env = easeIn * (1 - smoothstep(gd - 0.45, gd, g.t));
      if (g.name === 'wave') {
        // Right arm up beside the head, elbow out+down, palm toward the
        // camera (avatar-local -Z), rocking side to side about the forearm
        // axis (a real hand-wave).
        const osc = Math.sin(g.t * 8.5);
        const wrist = this._gv1.set(-0.27, 1.58 + osc * 0.012, 0.10);
        const bend = this._gv2.set(-0.55, -0.75, 0.05);
        const up = this._up;
        const palmN = this._gv3.set(0, 0, -1);
        const bx = this._gv4.crossVectors(up, palmN); // (-1, 0, 0)
        this._ikArm('Right', wrist, bend, [bx, up, palmN], env, dt, osc * 0.55, osc * 0.1);
      } else {
        // Namaste: both wrists meet at the sternum, palms facing each other,
        // fingers up, elbows down and outward.
        for (const [side, sx] of [['Left', 1], ['Right', -1]]) {
          const wrist = this._gv1.set(sx * 0.035, 1.34, 0.16);
          const bend = this._gv2.set(sx * 0.9, -0.5, 0);
          const up = this._up;
          const palmN = this._gv3.set(-sx, 0, 0.15).normalize();
          const bx = this._gv4.crossVectors(up, palmN).normalize();
          this._ikArm(side, wrist, bend, [bx, up, palmN], env, dt, 0, 0);
        }
      }
    }

    // ---------------- life details ------------------------------------------
    // blinking: squash the eye meshes briefly every few seconds
    this._blinkAt -= dt;
    if (this._blinkAt <= 0) {
      if (this._blinkAt > -0.13) {
        for (const m of inst.eyeMeshes) m.scale.y = 0.08;
      } else {
        for (const m of inst.eyeMeshes) m.scale.y = 1;
        this._blinkAt = 2.4 + Math.random() * 3.2;
      }
    }

    // breathing: a touch of mouthOpen while running, fading out otherwise
    const running = mode === 2 && !this.gesture ? 1 : 0;
    this._breath = (this._breath ?? 0) + (running - (this._breath ?? 0)) * Math.min(1, dt * 3);
    if (this._breath > 0.01) {
      for (const m of inst.smileMeshes) {
        const idx = m.morphTargetDictionary.mouthOpen;
        if (idx !== undefined) m.morphTargetInfluences[idx] = 0.12 * this._breath;
      }
    }
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.inst.root);
  }
}

// ---------------------------------------------------------------------------
// CharacterRig — synchronous public wrapper. Shows the contact blob + name
// label immediately, swaps in the realistic avatar when its GLB finishes
// loading, and transparently falls back to the procedural rig if loading
// fails.
// ---------------------------------------------------------------------------
export class CharacterRig {
  constructor(av, name, opts = {}) {
    this.av = { ...av };
    this.root = new THREE.Group();
    this.t = 0;
    this.emote = null; // {e, started} — set externally for RemotePlayer flow

    // soft contact shadow blob under the character
    this.blob = new THREE.Mesh(
      BLOB_GEO,
      new THREE.MeshBasicMaterial({ color: 0x0a1220, transparent: true, opacity: 0.28 }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.root.add(this.blob);

    if (!opts.noLabel) {
      this.label = makeLabel(name);
      this.root.add(this.label);
    }

    this._opts = opts;
    this._name = name;
    this._impl = null;

    instantiateAvatar(this.av)
      .then((inst) => {
        if (this._disposed) return;
        const impl = new AvatarRig(this, inst);
        impl.tick(0, 0, null, 0); // settle a pose before it becomes visible
        this._impl = impl;
      })
      .catch((err) => {
        console.warn('[FunLand] realistic avatar unavailable — procedural fallback.', err);
        if (this._disposed) return;
        const impl = new ProceduralRig(this.av, this._name, { noLabel: true });
        impl.t = this.t;
        this._impl = impl;
        this.root.add(impl.root);
      });
  }

  setName(name) {
    this._name = name;
    if (this.label) this.label.element.querySelector('.nb-label').textContent = name;
  }

  tick(dt, mode, emoteNow, posDelta) {
    this.t += dt;
    this.emote = emoteNow ?? null;
    if (this._impl) this._impl.tick(dt, mode, emoteNow, posDelta, this.t);
  }

  dispose() {
    this._disposed = true;
    if (this._impl?.dispose) this._impl.dispose();
    if (this.label) {
      this.label.element.remove();
      this.label = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Procedural low-poly fallback rig (offline safety net; original 2024 code,
// preserved so gameplay never depends on asset availability).
// ---------------------------------------------------------------------------
class ProceduralRig {
  constructor(av, name, opts = {}) {
    const P = palette(av);
    this.av = { ...av };
    this.female = P.gender === 0;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);

    const skinM = new THREE.MeshLambertMaterial({ color: P.skin });
    // clean default clothing colors (no outfit customization)
    const mainM = new THREE.MeshLambertMaterial({ color: 0xd8d4cc });
    const hairM = new THREE.MeshLambertMaterial({ color: P.hair });
    const goldM = new THREE.MeshLambertMaterial({ color: GOLD });
    const darkM = new THREE.MeshLambertMaterial({ color: DARK[0] });
    this.materials = new Set([skinM, mainM, hairM, goldM, darkM]);
    Object.assign(this, { skinM, mainM, hairM, goldM, darkM });
    this.palette = P;
    this.followHands = true;

    const F = this.female;

    // ---- core body --------------------------------------------------------
    this.torso = new THREE.Mesh(F ? G.torsoF : G.torsoM, mainM);
    this.torso.position.y = 1.3;
    this.hips = new THREE.Mesh(F ? G.hipF : G.hipM, darkM);
    this.hips.position.y = 1.0;
    this.neck = new THREE.Mesh(G.limbSeg, skinM);
    this.neck.scale.set(1.0, 0.2 / 1, 1.0);
    this.neck.position.y = 1.63;
    this.body.add(this.torso, this.hips, this.neck);

    if (F) {
      const bust = new THREE.Mesh(G.hairSwing, mainM);
      bust.scale.set(0.62, 0.36, 0.4);
      bust.position.set(0, 1.42, -0.07);
      this.body.add(bust);
    }

    // ---- head + face ------------------------------------------------------
    this.head = new THREE.Group();
    this.head.position.y = F ? 1.76 : 1.88;
    const skull = new THREE.Mesh(G.head, skinM);
    skull.scale.set(1, 1.08, 1.02);
    this.head.add(skull);
    this.body.add(this.head);

    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(G.ear, skinM);
      ear.scale.set(0.72, 1.12, 0.48);
      ear.position.set(sx * 0.16, 0, 0);
      this.head.add(ear);
    }
    if (!F) {
      const cheekM = new THREE.MeshLambertMaterial({ color: 0xd98d78, transparent: true, opacity: 0.42 });
      this.materials.add(cheekM);
      for (const sx of [-1, 1]) {
        const cheek = new THREE.Mesh(G.cheek, cheekM);
        cheek.scale.set(1.1, 0.62, 0.28);
        cheek.position.set(sx * 0.082, -0.045, -0.145);
        this.head.add(cheek);
      }
    }

    this.eyes = [];
    for (const sx of [-1, 1]) {
      const ex = sx * 0.056;
      const whiteM = new THREE.MeshLambertMaterial({ color: 0xf7f2ec });
      const white = new THREE.Mesh(G.eye, whiteM);
      white.scale.set(1, 0.88, 0.5);
      white.position.set(ex, 0.03, -0.142);
      const irisM = new THREE.MeshLambertMaterial({ color: 0x7f8a6b });
      const iris = new THREE.Mesh(G.iris, irisM);
      iris.scale.set(1, 1, 0.4);
      iris.position.set(ex, 0.024, -0.161);
      const pupilM = new THREE.MeshLambertMaterial({ color: 0x2a211a });
      const pupil = new THREE.Mesh(G.pupil, pupilM);
      pupil.scale.set(1, 1, 0.45);
      pupil.position.set(ex, 0.024, -0.166);
      const lid = new THREE.Mesh(G.lid, hairM);
      lid.position.set(ex, 0.036, -0.157);
      white.userData.sy = 0.88;
      iris.userData.sy = 1;
      pupil.userData.sy = 1;
      this.head.add(white, iris, pupil, lid);
      this.eyes.push(white, iris, pupil);
      this.materials.add(whiteM, irisM, pupilM);
    }
    const noseM = new THREE.MeshLambertMaterial({ color: 0xd2ac99 });
    const nose = new THREE.Mesh(G.nose, noseM);
    nose.rotation.z = Math.PI;
    nose.position.set(0, -0.038, -0.156);
    const mouthOuterM = new THREE.MeshLambertMaterial({ color: 0xb0795f });
    const mouthOuter = new THREE.Mesh(G.mouthOuter, mouthOuterM);
    mouthOuter.scale.set(1.02, 0.34, 0.3);
    mouthOuter.position.set(0, -0.09, -0.152);
    const mouthInnerM = new THREE.MeshLambertMaterial({ color: 0xf7f2ec });
    const mouthInner = new THREE.Mesh(G.mouthInner, mouthInnerM);
    mouthInner.scale.set(0.84, 0.22, 0.3);
    mouthInner.position.set(0, -0.086, -0.159);
    this.head.add(nose, mouthOuter, mouthInner);
    this.materials.add(noseM, mouthOuterM, mouthInnerM);

    // ---- eyewear -----------------------------------------------------------
    const eyewear = av.e === undefined ? 0 : av.e % 3;
    if (eyewear) {
      const frameM = new THREE.MeshLambertMaterial({
        color: eyewear === 2 ? 0x24242a : 0x3c3a44,
      });
      const lensM = new THREE.MeshLambertMaterial({
        color: eyewear === 2 ? 0x0d0f14 : 0xbcd7e2,
        transparent: true,
        opacity: eyewear === 2 ? 0.85 : 0.22,
        side: THREE.DoubleSide,
      });
      this.materials.add(frameM, lensM);
      for (const sx of [-1, 1]) {
        const rim = new THREE.Mesh(G.lensRim, frameM);
        rim.scale.set(1.06, 0.94, 0.5);
        rim.position.set(sx * 0.056, 0.03, -0.162);
        const lens = new THREE.Mesh(G.lens, lensM);
        lens.scale.set(1.02, 0.92, 1);
        lens.position.set(sx * 0.056, 0.03, -0.16);
        const temple = new THREE.Mesh(G.limbSeg, frameM);
        temple.scale.set(0.075, 0.17, 0.075);
        temple.rotation.x = Math.PI / 2;
        temple.position.set(sx * 0.122, 0.03, -0.075);
        this.head.add(rim, lens, temple);
      }
      const bridge = new THREE.Mesh(G.limbSeg, frameM);
      bridge.scale.set(0.085, 0.056, 0.085);
      bridge.rotation.z = Math.PI / 2;
      bridge.position.set(0, 0.024, -0.162);
      this.head.add(bridge);
    }

    // ---- hair --------------------------------------------------------------
    const y = av.y === undefined ? (av.h % 3) : (av.y % 3);
    this.hairParts = [];
    for (let i = 0; i < 3; i++) this.hairParts[i] = new THREE.Group();
    this.hairBack = null;
    const crown = (sy = 1, sz = 1.04) => {
      const m = new THREE.Mesh(G.hairTop, hairM);
      m.scale.set(1.02, sy, sz);
      m.position.set(0, 0.02, 0.004);
      return m;
    };
    const shell = () => new THREE.Mesh(G.hairSide, hairM);

    if (F) {
      const cap = crown(1.02, 1.07);
      cap.position.set(0, 0.024, 0.01);
      const side0 = shell();
      side0.scale.set(1.05, 1.06, 1.07);
      const back = new THREE.Mesh(G.hairSwing, hairM);
      back.scale.set(1.15, 2.1, 0.6);
      back.position.set(0, -0.16, 0.135);
      this.hairParts[0].add(cap, side0, back);
      this.hairBack = back;

      this.hairParts[1].add(crown(1.02, 1.07), shell());
      const braid = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const seg = new THREE.Mesh(G.braid, hairM);
        seg.scale.setScalar(1 - i * 0.16);
        seg.position.set(0, -0.12 - i * 0.1, 0.15 + i * 0.012);
        braid.add(seg);
      }
      const tie = new THREE.Mesh(G.braid, goldM);
      tie.scale.setScalar(0.4);
      tie.position.set(0, -0.44, 0.185);
      braid.add(tie);
      this.hairParts[1].add(braid);

      const bun = new THREE.Mesh(G.bun, hairM);
      bun.position.set(0, 0.08, 0.155);
      this.hairParts[2].add(crown(1.02, 1.07), shell(), bun);
      for (const sx of [-1, 1]) {
        const e = new THREE.Mesh(G.earring, goldM);
        e.position.set(sx * 0.155, -0.03, 0.005);
        this.head.add(e);
      }
    } else {
      const side0 = shell();
      side0.scale.set(1.03, 0.9, 1.04);
      this.hairParts[0].add(crown(), side0);

      const mop = crown(1.08, 1.1);
      mop.position.y = 0;
      const side1 = shell();
      side1.scale.set(1.06, 1.02, 1.08);
      this.hairParts[1].add(mop, side1);

      const side2 = shell();
      side2.scale.set(1.03, 0.9, 1.04);
      this.hairParts[2].add(crown(), side2);
    }
    this.hairParts.forEach((part, i) => {
      part.visible = i === y;
      this.head.add(part);
    });

    // ---- limbs -------------------------------------------------------------
    const armR = F ? 0.042 : 0.052;
    const legR = F ? 0.055 : 0.065;
    const armLenU = F ? 0.28 : 0.3;
    const armLenL = 0.27;
    this.armUpperLen = armLenU;
    this.armLowerLen = armLenL;
    this.armL = limb(armLenU, armLenL, armR, mainM);
    this.armR = limb(armLenU, armLenL, armR, mainM);
    this.armL.root.position.set(-(F ? 0.185 : 0.225), 1.5, 0);
    this.armR.root.position.set(F ? 0.185 : 0.225, 1.5, 0);
    this.legL = limb(0.44, 0.4, legR, darkM);
    this.legR = limb(0.44, 0.4, legR, darkM);
    this.legL.root.position.set(-0.085, 1.02, 0);
    this.legR.root.position.set(0.085, 1.02, 0);
    if (!F) {
      for (const arm of [this.armL, this.armR]) {
        arm.mid.children[0].material = skinM;
        const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.057, 0.057, 0.045, 10), mainM);
        cuff.position.y = 0.012;
        arm.mid.add(cuff);
      }
    }
    for (const arm of [this.armL, this.armR]) {
      const hand = new THREE.Group();
      const palm = new THREE.Mesh(G.palm, skinM);
      palm.position.set(0, -0.045, -0.012);
      hand.add(palm);
      for (const x of [-0.024, 0, 0.024]) {
        const finger = new THREE.Mesh(G.finger, skinM);
        finger.position.set(x, -0.105, -0.03);
        hand.add(finger);
      }
      const thumb = new THREE.Mesh(G.finger, skinM);
      thumb.scale.set(0.9, 0.85, 0.9);
      thumb.position.set(0.048, -0.055, -0.015);
      thumb.rotation.z = -0.8;
      hand.add(thumb);
      arm.tip.add(hand);
      if (arm === this.armL) this.handL = hand;
      else this.handR = hand;
      this.body.add(arm.root);
    }
    for (const leg of [this.legL, this.legR]) {
      const shoeM = new THREE.MeshLambertMaterial({ color: 0xd8d9d7 });
      const soleM = new THREE.MeshLambertMaterial({ color: 0x454b57 });
      const shoe = new THREE.Mesh(G.shoe, shoeM);
      const sole = new THREE.Mesh(G.sole, soleM);
      shoe.position.set(0, -0.035, -0.05);
      sole.position.set(0, -0.078, -0.05);
      leg.tip.add(shoe, sole);
      this.materials.add(shoe.material);
      this.materials.add(sole.material);
      this.body.add(leg.root);
    }

    // animation state
    this.t = 0;
    this.gaitPhase = 0;
    this.motionBlend = 0;
    this.runBlend = 0;
    this.mode = 0;
    this.emote = null;
    this._targets = new Map();
    this.speedEma = 0;
    this._blinkAt = 1.5;
  }

  setName(name) {
    if (!this.label) return;
    this.label.element.querySelector('.nb-label').textContent = name;
  }

  updateLabels(renderer, camera, scene) {
    void renderer; void camera; void scene;
  }

  setPart(part, x, y = 0, z = 0) {
    this._targets.set(part, { x, y, z });
  }

  apply() {
    for (const [part, t] of this._targets) {
      part.rotation.x += (t.x - part.rotation.x) * 0.35;
      part.rotation.y += (t.y - part.rotation.y) * 0.35;
      part.rotation.z += (t.z - part.rotation.z) * 0.35;
    }
  }

  // dt in seconds (signature matches AvatarRig.tick incl. trailing tNow)
  tick(dt, mode, emoteNow, posDelta) {
    this.t += dt;
    // One-shot gestures have their own duration; the network emote can stay
    // "active" for 6.5 s, so stop driving the pose once the gesture is over.
    if (emoteNow) {
      const limit =
        emoteNow.e === 'wave' ? 3.0 : emoteNow.e === 'greet' ? 3.4 : Infinity;
      const et = this.t - (emoteNow.started ?? this.t);
      if (et > limit) emoteNow = null;
    }
    this.mode = mode;
    const spd = posDelta / Math.max(dt, 1e-4);
    this.speedEma += (spd - this.speedEma) * 0.2;

    const moving = mode === 1 || mode === 2;
    const run = mode === 2;
    const targetSpeed = run ? RUN_SPEED : WALK_SPEED;
    const speedRatio = moving ? clamp(this.speedEma / targetSpeed, 0.28, 1.12) : 0;
    const cadence = run ? 9.5 : 6.2;
    this.gaitPhase += dt * (moving ? cadence * speedRatio : 2.0);
    const cyc = this.gaitPhase;
    const stride = Math.sin(cyc);
    this.motionBlend += ((moving ? 1 : 0) - this.motionBlend) * Math.min(1, dt * 10);
    this.runBlend += ((run ? 1 : 0) - this.runBlend) * Math.min(1, dt * 8);
    const strideAmp = (0.48 + this.runBlend * 0.18) * this.motionBlend;

    let shoulderL = -stride * strideAmp - 0.06 * this.motionBlend;
    let shoulderR = stride * strideAmp - 0.06 * this.motionBlend;
    let shoulderZL = 0.1, shoulderZR = -0.1;
    let armLmid = moving ? -0.22 - Math.max(0, stride) * (0.18 + this.runBlend * 0.08) : -0.08;
    let armRmid = moving ? -0.22 - Math.max(0, -stride) * (0.18 + this.runBlend * 0.08) : -0.08;
    let elbowZL = 0, elbowZR = 0;
    let hipL = stride * strideAmp * 0.92;
    let hipR = -stride * strideAmp * 0.92;
    let kneeL = mode === 3 ? 0.9 : moving ? 0.04 + Math.max(0, -stride) * (0.24 + this.runBlend * 0.18) : 0;
    let kneeR = mode === 3 ? 0.9 : moving ? 0.04 + Math.max(0, stride) * (0.24 + this.runBlend * 0.18) : 0;
    let bodyY = moving ? Math.abs(stride) * (0.025 + this.runBlend * 0.035) : Math.sin(this.t * 1.8) * 0.012 + 0.012;
    let bodyRotX = moving ? 0.025 + this.runBlend * 0.035 : 0;
    let headNod = moving ? Math.sin(cyc * 2) * 0.012 : Math.sin(this.t * 1.2) * 0.03;
    let chestYaw = moving ? stride * (0.045 + this.runBlend * 0.025) : 0;
    let hipYaw = moving ? -chestYaw * 0.55 : 0;
    let headYaw = moving ? -chestYaw * 0.35 : 0;

    if (mode === 3) {
      hipL = hipR = 0.7; shoulderL = shoulderR = -1.9;
      armLmid = armRmid = -0.4; kneeL = kneeR = 0.9;
      bodyY = 0.05;
      hipYaw = 0;
      headYaw = 0;
    }

    if (emoteNow) {
      const e = emoteNow.e;
      const et = Math.max(0, this.t - emoteNow.started);
      if (e === 'wave') {
        shoulderR = -2.6 + Math.sin(et * 10) * 0.35;
        armRmid = -0.2;
        headNod = 0.08;
        hipL = hipR = 0; kneeL = kneeR = 0;
        bodyY = 0.02;
        hipYaw = 0;
        headYaw = 0.08;
      } else if (e === 'dance') {
        const w = et * 7.5;
        shoulderL = -1.5 + Math.sin(w) * 1.05;
        shoulderR = -1.5 - Math.sin(w) * 1.05;
        armLmid = armRmid = -0.9;
        headNod = Math.sin(w * 0.8) * 0.28;
        bodyY = Math.abs(Math.sin(w * 0.85)) * 0.14;
        hipL = Math.sin(w) * 0.5; hipR = -Math.sin(w) * 0.5;
        kneeL = Math.abs(Math.sin(w)) * 0.7; kneeR = Math.abs(Math.cos(w)) * 0.7;
        hipYaw = -Math.sin(w) * 0.12;
        headYaw = -Math.sin(w * 0.8) * 0.08;
      } else if (e === 'greet') {
        const bow = Math.max(0, Math.sin(Math.min(et, 1.4) * 2.1)) * 0.12;
        headNod = bow * 0.75;
        bodyRotX = -bow;
        shoulderL = 0.58; shoulderR = 0.58;
        shoulderZL = 0.58; shoulderZR = -0.58;
        armLmid = 0.72; armRmid = 0.72;
        elbowZL = 0.48; elbowZR = -0.48;
        hipL = hipR = 0; kneeL = kneeR = 0;
        bodyY = 0.0;
        hipYaw = 0;
        headYaw = 0;
      }
    }

    this.body.position.y = bodyY;
    this.body.rotation.x += (bodyRotX - this.body.rotation.x) * 0.3;
    this.head.rotation.x += (headNod - this.head.rotation.x) * 0.3;
    this.head.rotation.y += (headYaw - this.head.rotation.y) * 0.25;
    if (this.torso) this.torso.rotation.y += (chestYaw - this.torso.rotation.y) * 0.3;
    if (this.hips) this.hips.rotation.y += (hipYaw - this.hips.rotation.y) * 0.3;

    if (this.t > this._blinkAt) {
      const closed = this.t - this._blinkAt < 0.12;
      for (const e of this.eyes) e.scale.y = (e.userData.sy || 1) * (closed ? 0.1 : 1);
      if (!closed) this._blinkAt = this.t + 2.2 + Math.random() * 3;
    }

    const sway = moving ? Math.sin(cyc) * 0.07 : Math.sin(this.t * 1.3) * 0.015;
    if (this.hairBack) this.hairBack.rotation.x += (sway * 0.6 - this.hairBack.rotation.x) * 0.2;

    this.setPart(this.armL.root, shoulderL, 0, shoulderZL);
    this.setPart(this.armR.root, shoulderR, 0, shoulderZR);
    this.setPart(this.armL.mid, armLmid, 0, elbowZL);
    this.setPart(this.armR.mid, armRmid, 0, elbowZR);
    this.setPart(this.legL.root, hipL, 0, 0);
    this.setPart(this.legR.root, hipR, 0, 0);
    this.setPart(this.legL.mid, kneeL, 0, 0);
    this.setPart(this.legR.mid, kneeR, 0, 0);
    this.apply();

    const poseHand = (hand, arm, roll = 0, yaw = 0) => {
      if (!hand || !arm) return;
      const forearm = new THREE.Vector3(0, -1, 0)
        .applyQuaternion(arm.root.quaternion)
        .applyQuaternion(arm.mid.quaternion)
        .normalize();
      const yAxis = forearm.clone().negate();
      const zAxis = new THREE.Vector3(0, 0, 1);
      zAxis.addScaledVector(yAxis, -zAxis.dot(yAxis));
      if (zAxis.lengthSq() < 1e-5) zAxis.set(0, 1, 0).addScaledVector(yAxis, -yAxis.y);
      zAxis.normalize();
      const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
      const desired = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis),
      );
      const armQ = arm.root.quaternion.clone().multiply(arm.mid.quaternion);
      const local = armQ.invert().multiply(desired);
      local.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, roll, 'XYZ')));
      hand.quaternion.slerp(local, 0.35);
    };
    let handRollL = 0, handRollR = 0, handYawL = 0, handYawR = 0;
    if (emoteNow?.e === 'wave') {
      const et = Math.max(0, this.t - emoteNow.started);
      handRollR = Math.sin(et * 10) * 0.42;
      handYawR = 0.12;
    } else if (emoteNow?.e === 'dance') {
      const w = Math.max(0, this.t - emoteNow.started) * 7.5;
      handRollL = Math.sin(w) * 0.32;
      handRollR = -Math.sin(w) * 0.32;
      handYawL = -0.12;
      handYawR = 0.12;
    }
    if (emoteNow?.e === 'greet') {
      const solveArm = (arm, side) => {
        const upperLen = this.armUpperLen ?? (this.female ? 0.28 : 0.3);
        const lowerLen = this.armLowerLen ?? 0.27;
        const shoulder = arm.root.position;
        const wrist = new THREE.Vector3(side * 0.024, this.female ? 1.38 : 1.35, -0.19);
        const toWrist = wrist.clone().sub(shoulder);
        const distance = THREE.MathUtils.clamp(toWrist.length(), 0.001, upperLen + lowerLen - 0.001);
        const axis = toWrist.normalize();
        const along = (upperLen * upperLen - lowerLen * lowerLen + distance * distance) / (2 * distance);
        const bend = new THREE.Vector3(side, -0.85, 0);
        bend.addScaledVector(axis, -bend.dot(axis)).normalize();
        const elbowPoint = shoulder.clone().addScaledVector(axis, along)
          .addScaledVector(bend, Math.sqrt(Math.max(0, upperLen * upperLen - along * along)));
        const upperDirection = elbowPoint.clone().sub(shoulder).normalize();
        const lowerDirection = wrist.clone().sub(elbowPoint).normalize();
        const down = new THREE.Vector3(0, -1, 0);
        const targetRoot = new THREE.Quaternion().setFromUnitVectors(down, upperDirection);
        const lowerInRoot = lowerDirection.clone().applyQuaternion(targetRoot.clone().invert());
        const targetMid = new THREE.Quaternion().setFromUnitVectors(down, lowerInRoot);
        const ease = Math.min(1, dt * 12);
        arm.root.quaternion.slerp(targetRoot, ease);
        arm.mid.quaternion.slerp(targetMid, ease);

        const handY = new THREE.Vector3(0, -1, 0);
        const handZ = new THREE.Vector3(side < 0 ? -1 : 1, 0, 0);
        const handX = new THREE.Vector3().crossVectors(handY, handZ);
        const desiredHand = new THREE.Quaternion().setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(handX, handY, handZ),
        );
        const armWorldInBody = arm.root.quaternion.clone().multiply(arm.mid.quaternion);
        this[side < 0 ? 'handL' : 'handR'].quaternion.copy(armWorldInBody.invert().multiply(desiredHand));
      };
      solveArm(this.armL, -1);
      solveArm(this.armR, 1);
    } else if (this.followHands !== false) {
      poseHand(this.handL, this.armL, handRollL, handYawL);
      poseHand(this.handR, this.armR, handRollR, handYawR);
    }

    const toeL = moving ? Math.max(0, stride) * 0.08 : 0;
    const toeR = moving ? Math.max(0, -stride) * 0.08 : 0;
    const footL = -this.legL.root.rotation.x - this.legL.mid.rotation.x + toeL;
    const footR = -this.legR.root.rotation.x - this.legR.mid.rotation.x + toeR;
    this.legL.tip.rotation.x += (footL - this.legL.tip.rotation.x) * 0.35;
    this.legR.tip.rotation.x += (footR - this.legR.tip.rotation.x) * 0.35;
  }
}

// shared primitive geometries for the procedural fallback rig
const G = {
  head: new THREE.SphereGeometry(0.16, 16, 14),
  eye: new THREE.SphereGeometry(0.03, 12, 10),
  iris: new THREE.SphereGeometry(0.02, 12, 10),
  pupil: new THREE.SphereGeometry(0.011, 10, 8),
  lid: new THREE.TorusGeometry(0.032, 0.0075, 6, 16, Math.PI),
  nose: new THREE.TorusGeometry(0.018, 0.004, 6, 14, Math.PI),
  lensRim: new THREE.TorusGeometry(0.03, 0.0045, 6, 20),
  lens: new THREE.CircleGeometry(0.028, 20),
  mouthOuter: new THREE.SphereGeometry(0.05, 14, 10),
  mouthInner: new THREE.SphereGeometry(0.05, 14, 10),
  ear: new THREE.SphereGeometry(0.04, 10, 8),
  cheek: new THREE.SphereGeometry(0.035, 10, 8),
  hairTop: new THREE.SphereGeometry(0.172, 18, 12, 0, Math.PI * 2, 0, 1.02),
  hairSide: new THREE.SphereGeometry(
    0.172, 18, 14, Math.PI * 1.5 + 0.78, Math.PI * 2 - 1.56, 0.5, 1.16,
  ),
  hairSwing: new THREE.SphereGeometry(0.13, 10, 8),
  bun: new THREE.SphereGeometry(0.07, 10, 8),
  braid: new THREE.SphereGeometry(0.055, 8, 6),
  torso: null,
  hip: null,
  limbSeg: new THREE.CylinderGeometry(0.05, 0.042, 1, 8),
  hand: new THREE.SphereGeometry(0.052, 8, 7),
  palm: new THREE.BoxGeometry(0.074, 0.105, 0.045),
  finger: new THREE.CapsuleGeometry(0.011, 0.038, 4, 6),
  shoe: new THREE.BoxGeometry(0.12, 0.075, 0.25),
  sole: new THREE.BoxGeometry(0.125, 0.018, 0.255),
  earring: new THREE.SphereGeometry(0.016, 6, 5),
};

G.torsoM = new THREE.CapsuleGeometry(0.17, 0.32, 8, 14);
G.torsoF = new THREE.CylinderGeometry(0.145, 0.12, 0.48, 10);
G.hipM = new THREE.CylinderGeometry(0.13, 0.15, 0.2, 9);
G.hipF = new THREE.CylinderGeometry(0.125, 0.165, 0.2, 9);

function limb(upperLen, lowerLen, r, mat) {
  const root = new THREE.Group();
  const upper = new THREE.Mesh(G.limbSeg, mat);
  upper.scale.set(r / 0.05, upperLen / 1, r / 0.05);
  upper.position.y = -upperLen / 2;
  root.add(upper);
  const mid = new THREE.Group();
  mid.position.y = -upperLen;
  root.add(mid);
  const lower = new THREE.Mesh(G.limbSeg, mat);
  lower.scale.set((r * 0.85) / 0.05, lowerLen / 1, (r * 0.85) / 0.05);
  lower.position.y = -lowerLen / 2;
  mid.add(lower);
  const tip = new THREE.Group();
  tip.position.y = -lowerLen;
  mid.add(tip);
  return { root, mid, tip };
}

function palette(av) {
  return {
    gender: av.g === undefined ? 1 : (av.g ? 1 : 0),
    skin: SKIN[av.b % SKIN.length],
    hair: HAIRS[av.h % HAIRS.length],
  };
}

function makeLabel(name) {
  const el = document.createElement('div');
  el.className = 'nb-name';
  const b = document.createElement('span');
  b.className = 'nb-label';
  b.textContent = name;
  el.appendChild(b);
  el.style.background = 'rgba(10,16,28,0.62)';
  el.style.border = '1px solid rgba(255,255,255,0.14)';
  el.style.borderRadius = '999px';
  el.style.padding = '2px 10px';
  el.style.fontSize = '12px';
  el.style.fontWeight = '600';
  el.style.color = '#fff';
  el.style.textShadow = '0 1px 2px rgba(0,0,0,.5)';
  el.style.backdropFilter = 'blur(3px)';
  el.style.whiteSpace = 'nowrap';
  const obj = new CSS2DObject(el);
  obj.position.set(0, 2.26, 0);
  return obj;
}
