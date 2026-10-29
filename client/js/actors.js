// ---------------------------------------------------------------------------
// Procedural low-poly human character rig (male + female).
// No external model files: bodies are built from primitives and animated by
// code (idle / walk / run / air + wave / dance / greet / sit).
//
// Appearance object (server-checked ints):
//   g  gender: 0 female, 1 male          (missing -> 1, legacy profiles)
//   b  skin tone index (SKIN)
//   h  hair color index (HAIRS)
//   y  hairstyle index 0-2 (per-gender sets; legacy = h % 3)
//   o  outfit index 0-2 (per-gender Nepalese festival sets)
//   s  main fabric color index (CLOTH)
//   p  accent fabric color index (CLOTH)
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CSS2DObject } from '/vendor/CSS2DRenderer.js';

// natural human skin tones (South-Asian leaning, festival under warm light)
export const SKIN = [0xf2c29b, 0xe6a774, 0xc98a5e, 0x8d5a3c, 0x66412a, 0xd9a06e, 0xb87a4e, 0x7a4a2e];
// natural hair colors
export const HAIRS = [0x1d1410, 0x2c1d12, 0x4a3220, 0x6b4a28, 0x8a6236, 0x3d2e20, 0x24201c, 0x554433];
// rich festival fabrics: maroon, red, royal blue, emerald, purple, cream, teal, magenta
export const CLOTH = [0x7a1f2b, 0xc22b3a, 0x2b4ea2, 0x1f7a4d, 0x6b3fa0, 0xf3e6c8, 0x1f7fa8, 0xb23a67];

export const GOLD = 0xd9a441;
const DARK = [0x2e3446, 0x3d2e20, 0x443c50]; // trousers / shadowed cloth

export function palette(av) {
  return {
    gender: av.g === undefined ? 1 : (av.g ? 1 : 0),
    skin: SKIN[av.b % SKIN.length],
    hair: HAIRS[av.h % HAIRS.length],
    main: CLOTH[av.s % CLOTH.length],
    accent: CLOTH[av.p % CLOTH.length],
  };
}

// shared geometries (reused across every rig)
const G = {
  head: new THREE.SphereGeometry(0.16, 14, 12),
  eye: new THREE.SphereGeometry(0.03, 8, 6),
  pupil: new THREE.SphereGeometry(0.0135, 6, 5),
  brow: new THREE.BoxGeometry(0.055, 0.011, 0.012),
  nose: new THREE.ConeGeometry(0.017, 0.05, 6),
  mouth: new THREE.BoxGeometry(0.05, 0.012, 0.01),
  hairCap: new THREE.SphereGeometry(0.168, 12, 10),
  hairSwing: new THREE.SphereGeometry(0.13, 10, 8),
  bun: new THREE.SphereGeometry(0.07, 10, 8),
  braid: new THREE.SphereGeometry(0.055, 8, 6),
  torso: null, // built per gender below
  hip: null,
  limbSeg: new THREE.CylinderGeometry(0.05, 0.042, 1, 8), // scaled per bone
  hand: new THREE.SphereGeometry(0.052, 8, 7),
  shoe: new THREE.BoxGeometry(0.11, 0.07, 0.24),
  skirt: new THREE.CylinderGeometry(0.17, 0.25, 0.98, 10),
  skirtLong: new THREE.CylinderGeometry(0.18, 0.34, 0.95, 10),
  skirtTrim: new THREE.CylinderGeometry(0.255, 0.26, 0.055, 10),
  skirtTrimLong: new THREE.CylinderGeometry(0.345, 0.35, 0.06, 10),
  kurta: new THREE.CylinderGeometry(0.165, 0.2, 0.72, 9),
  coat: new THREE.CylinderGeometry(0.185, 0.155, 0.44, 9),
  sash: new THREE.BoxGeometry(0.1, 0.52, 0.022),
  dupatta: new THREE.BoxGeometry(0.08, 0.42, 0.02),
  bangle: new THREE.TorusGeometry(0.048, 0.009, 6, 12),
  necklace: new THREE.TorusGeometry(0.075, 0.011, 6, 14),
  earring: new THREE.SphereGeometry(0.016, 6, 5),
  topi: new THREE.CylinderGeometry(0.075, 0.115, 0.13, 9),
  topiBand: new THREE.CylinderGeometry(0.108, 0.117, 0.03, 9),
  blob: new THREE.CircleGeometry(0.42, 20),
};

// torso shapes: male broad chest, female narrower with softer taper
G.torsoM = new THREE.CylinderGeometry(0.175, 0.13, 0.5, 10);
G.torsoF = new THREE.CylinderGeometry(0.145, 0.12, 0.48, 10);
G.hipM = new THREE.CylinderGeometry(0.13, 0.15, 0.2, 9);
G.hipF = new THREE.CylinderGeometry(0.125, 0.165, 0.2, 9);

// two-bone limb with configurable thickness; returns joint groups for animating
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

export class CharacterRig {
  constructor(av, name, opts = {}) {
    const P = palette(av);
    this.av = { ...av };
    this.female = P.gender === 0;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);

    const skinM = new THREE.MeshLambertMaterial({ color: P.skin });
    const mainM = new THREE.MeshLambertMaterial({ color: P.main });
    const accM = new THREE.MeshLambertMaterial({ color: P.accent });
    const hairM = new THREE.MeshLambertMaterial({ color: P.hair });
    const goldM = new THREE.MeshLambertMaterial({ color: GOLD });
    const darkM = new THREE.MeshLambertMaterial({ color: DARK[av.o % DARK.length] });
    const lipM = new THREE.MeshLambertMaterial({ color: this.female ? 0xa14a4a : 0x8a4a42 });
    this.materials = new Set([skinM, mainM, accM, hairM, goldM, darkM, lipM]);
    Object.assign(this, { skinM, mainM, accM, hairM, goldM });

    const F = this.female;

    // ---- core body --------------------------------------------------------
    this.torso = new THREE.Mesh(F ? G.torsoF : G.torsoM, mainM);
    this.torso.position.y = 1.3;
    this.hips = new THREE.Mesh(F ? G.hipF : G.hipM, darkM);
    this.hips.position.y = 1.0;
    this.neck = new THREE.Mesh(G.limbSeg, skinM);
    this.neck.scale.set(0.9, 0.1 / 1, 0.9);
    this.neck.position.y = 1.58;
    this.body.add(this.torso, this.hips, this.neck);

    if (F) {
      // subtle bust + softer chest taper (kept understated)
      const bust = new THREE.Mesh(G.hairSwing, mainM);
      bust.scale.set(0.62, 0.36, 0.4);
      bust.position.set(0, 1.42, -0.07);
      this.body.add(bust);
    }

    // ---- head + face ------------------------------------------------------
    this.head = new THREE.Group();
    this.head.position.y = 1.72;
    const skull = new THREE.Mesh(G.head, skinM);
    skull.scale.set(1, 1.08, 1.02);
    this.head.add(skull);
    this.body.add(this.head);

    this.eyes = [];
    for (const sx of [-1, 1]) {
      const white = new THREE.Mesh(G.eye, new THREE.MeshLambertMaterial({ color: 0xf6f3ee }));
      white.scale.set(1, 0.8, 0.55);
      white.position.set(sx * 0.058, 0.015, -0.132);
      const pupil = new THREE.Mesh(G.pupil, new THREE.MeshLambertMaterial({ color: 0x2a1c12 }));
      pupil.position.set(sx * 0.058, 0.015, -0.152);
      const brow = new THREE.Mesh(G.brow, hairM);
      brow.position.set(sx * 0.06, 0.07, -0.142);
      brow.rotation.z = sx * -0.12;
      this.head.add(white, pupil, brow);
      this.eyes.push(white, pupil);
      this.materials.add(white.material, pupil.material);
    }
    const nose = new THREE.Mesh(G.nose, skinM);
    nose.rotation.x = Math.PI / 2 + 0.25;
    nose.position.set(0, -0.02, -0.158);
    const mouth = new THREE.Mesh(G.mouth, lipM);
    mouth.position.set(0, -0.082, -0.148);
    this.head.add(nose, mouth);
    if (F) mouth.scale.set(1.12, 1.35, 1); // slightly fuller lips

    // ---- hair (per-gender style sets) -------------------------------------
    const y = av.y === undefined ? (av.h % 3) : (av.y % 3);
    this.hairParts = [];
    for (let i = 0; i < 3; i++) this.hairParts[i] = new THREE.Group();
    this.hairBack = null;
    if (F) {
      // 0 long flowing, 1 braid, 2 bun
      const cap = new THREE.Mesh(G.hairCap, hairM);
      cap.scale.set(1.06, 0.98, 1.08);
      cap.position.set(0, 0.025, 0.008);
      this.hairParts[0].add(cap);
      const back = new THREE.Mesh(G.hairSwing, hairM);
      back.scale.set(1.15, 2.1, 0.6);
      back.position.set(0, -0.16, 0.135);
      this.hairParts[0].add(back);
      this.hairBack = back;
      const cap2 = cap.clone();
      this.hairParts[1].add(cap2);
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
      this.hairBack = braid;
      const cap3 = cap.clone();
      const bun = new THREE.Mesh(G.bun, hairM);
      bun.position.set(0, 0.08, 0.155);
      this.hairParts[2].add(cap3, bun);
      // earrings
      for (const sx of [-1, 1]) {
        const e = new THREE.Mesh(G.earring, goldM);
        e.position.set(sx * 0.155, -0.03, 0.005);
        this.head.add(e);
      }
    } else {
      // 0 short, 1 curly mop, 2 topknot
      const cap = new THREE.Mesh(G.hairCap, hairM);
      cap.scale.set(1.04, 0.82, 1.06);
      cap.position.y = 0.035;
      this.hairParts[0].add(cap);
      const mop = new THREE.Mesh(G.hairCap, hairM);
      mop.scale.set(1.12, 1.02, 1.14);
      mop.position.set(0, 0.02, 0.005);
      this.hairParts[1].add(mop);
      const cap2 = new THREE.Mesh(G.hairCap, hairM);
      cap2.scale.set(1.05, 0.85, 1.07);
      cap2.position.y = 0.03;
      const knot = new THREE.Mesh(G.bun, hairM);
      knot.scale.setScalar(0.62);
      knot.position.set(0, 0.155, 0.02);
      this.hairParts[2].add(cap2, knot);
    }
    this.hairParts.forEach((part, i) => {
      part.visible = i === y;
      this.head.add(part);
    });

    // ---- limbs ------------------------------------------------------------
    const armR = F ? 0.042 : 0.052;
    const legR = F ? 0.055 : 0.065;
    const armLenU = F ? 0.28 : 0.3;
    this.armL = limb(armLenU, 0.27, armR, mainM);
    this.armR = limb(armLenU, 0.27, armR, mainM);
    this.armL.root.position.set(-(F ? 0.185 : 0.225), 1.5, 0);
    this.armR.root.position.set(F ? 0.185 : 0.225, 1.5, 0);
    this.legL = limb(0.44, 0.4, legR, darkM);
    this.legR = limb(0.44, 0.4, legR, darkM);
    this.legL.root.position.set(-0.085, 1.02, 0);
    this.legR.root.position.set(0.085, 1.02, 0);
    for (const arm of [this.armL, this.armR]) {
      const hand = new THREE.Mesh(G.hand, skinM);
      arm.tip.add(hand);
      this.body.add(arm.root);
    }
    for (const leg of [this.legL, this.legR]) {
      const shoe = new THREE.Mesh(G.shoe, new THREE.MeshLambertMaterial({ color: 0x39322e }));
      shoe.position.set(0, -0.035, -0.05);
      leg.tip.add(shoe);
      this.materials.add(shoe.material);
      this.body.add(leg.root);
    }

    // ---- Nepalese festival outfits ---------------------------------------
    this.skirt = null;
    const o = av.o === undefined ? 0 : (av.o % 3);
    if (F) this._buildFemaleOutfit(o, mainM, accM, goldM, darkM);
    else this._buildMaleOutfit(o, mainM, accM, goldM, darkM);

    // soft shadow blob
    this.blob = new THREE.Mesh(G.blob, new THREE.MeshBasicMaterial({ color: 0x0a1220, transparent: true, opacity: 0.35 }));
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.scale.setScalar(1.0);
    this.root.add(this.blob);

    // name label
    if (!opts.noLabel) {
      this.label = makeLabel(name);
      this.root.add(this.label);
    }

    // animation state
    this.t = 0;
    this.mode = 0;         // 0 idle,1 walk,2 run,3 air
    this.emote = null;     // {e, started}
    this.seated = null;    // {x,y,z,ry}
    this._targets = new Map();
    this.speedEma = 0;
    this._blinkAt = 1.5;
  }

  // female: 0 saree, 1 kurta-suruwal + dupatta, 2 lehenga
  _buildFemaleOutfit(o, mainM, accM, goldM, darkM) {
    // bangles on both wrists
    for (const arm of [this.armL, this.armR]) {
      for (const dy of [0.012, -0.012]) {
        const b = new THREE.Mesh(G.bangle, goldM);
        b.rotation.x = Math.PI / 2;
        b.position.y = dy;
        arm.tip.add(b);
      }
    }
    // necklace
    const necklace = new THREE.Mesh(G.necklace, goldM);
    necklace.rotation.x = Math.PI / 2 - 0.35;
    necklace.position.set(0, 1.52, -0.06);
    this.body.add(necklace);

    if (o === 0) { // saree: fitted skirt with gold border + pallu sash
      const skirt = new THREE.Mesh(G.skirt, accM);
      skirt.position.y = 0.5;
      const trim = new THREE.Mesh(G.skirtTrim, goldM);
      trim.position.y = 0.06;
      const pallu = new THREE.Mesh(G.sash, accM);
      pallu.position.set(0.05, 1.28, -0.135);
      pallu.rotation.z = 0.5;
      const palluTrim = new THREE.Mesh(new THREE.BoxGeometry(0.104, 0.52, 0.006), goldM);
      palluTrim.position.set(0, -0.02, 0.014);
      pallu.add(palluTrim);
      this.skirt = skirt;
      this.body.add(skirt, trim, pallu);
    } else if (o === 1) { // kurta + dupatta: long kurta, slim trousers, neck drape
      const kurta = new THREE.Mesh(G.kurta, mainM);
      kurta.position.y = 0.98;
      for (const sx of [-1, 1]) {
        const drape = new THREE.Mesh(G.dupatta, accM);
        drape.position.set(sx * 0.1, 1.22, -0.115);
        drape.rotation.z = sx * -0.08;
        this.body.add(drape);
      }
      this.body.add(kurta);
    } else { // lehenga: full flared skirt, gold border, dupatta sash
      const skirt = new THREE.Mesh(G.skirtLong, accM);
      skirt.position.y = 0.5;
      const trim = new THREE.Mesh(G.skirtTrimLong, goldM);
      trim.position.y = 0.06;
      const sash = new THREE.Mesh(G.sash, mainM);
      sash.position.set(-0.05, 1.28, -0.135);
      sash.rotation.z = -0.5;
      this.skirt = skirt;
      this.body.add(skirt, trim, sash);
    }
  }

  // male: 0 daura suruwal + waistcoat, 1 kurta pajama + shawl, 2 daura + dhaka topi
  _buildMaleOutfit(o, mainM, accM, goldM, darkM) {
    if (o === 1) { // long kurta to mid-thigh
      const kurta = new THREE.Mesh(G.kurta, mainM);
      kurta.position.y = 0.98;
      const shawl = new THREE.Mesh(G.sash, accM);
      shawl.position.set(-0.05, 1.28, -0.135);
      shawl.rotation.z = -0.5;
      this.body.add(kurta, shawl);
    } else {
      // waistcoat over the daura
      const coat = new THREE.Mesh(G.coat, accM);
      coat.position.y = 1.24;
      this.body.add(coat);
      if (o === 2) { // dhaka topi replaces the hair silhouette
        const topi = new THREE.Mesh(G.topi, accM);
        topi.position.set(0, 0.14, 0.01);
        topi.rotation.z = 0.06;
        const band = new THREE.Mesh(G.topiBand, goldM);
        band.position.set(0, -0.055, 0);
        topi.add(band);
        this.head.add(topi);
      }
    }
  }

  setName(name) {
    if (!this.label) return;
    this.label.element.querySelector('.nb-label').textContent = name;
  }

  updateLabels(renderer, camera, scene) {
    void renderer; void camera; void scene;
  }

  // pose interpolation helpers ------------------------------------------------
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

  // dt in seconds
  tick(dt, mode, emoteNow, posDelta) {
    this.t += dt;
    this.mode = mode;
    const spd = posDelta / Math.max(dt, 1e-4);
    this.speedEma += (spd - this.speedEma) * 0.2;

    const moving = mode === 1 || mode === 2;
    const cyc = moving ? this.t * (mode === 2 ? 9.5 : 6.2) : this.t * 2;
    const amp = mode === 2 ? 0.95 : mode === 1 ? 0.55 : 0.05;

    // defaults (neutral-ish, overwritten by emotes below)
    let shoulderL = -Math.sin(cyc) * amp * 0.7 - 0.08;
    let shoulderR = Math.sin(cyc) * amp * 0.7 - 0.08;
    let armLmid = moving ? -0.35 - Math.abs(Math.sin(cyc)) * 0.35 : -0.1;
    let armRmid = armLmid;
    let hipL = Math.sin(cyc) * amp;
    let hipR = -Math.sin(cyc) * amp;
    let kneeL = mode === 3 ? 0.9 : Math.max(0, -1 * (hipL - Math.abs(Math.sin(cyc)) * 0.45));
    let kneeR = mode === 3 ? 0.9 : kneeL;
    let bodyY = moving ? Math.abs(Math.sin(cyc)) * (mode === 2 ? 0.07 : 0.045) : Math.sin(this.t * 1.8) * 0.02 + 0.02;
    let bodyRotX = mode === 2 ? 0.14 : moving ? 0.06 : 0;
    let headNod = Math.sin(this.t * 1.2) * 0.05;
    // counter-rotating chest + hips gives the walk a natural gait
    let chestYaw = moving ? Math.sin(cyc) * 0.1 : 0;

    if (mode === 3) { // air tuck
      hipL = hipR = 0.7; shoulderL = shoulderR = -1.9;
      armLmid = armRmid = -0.4; kneeL = kneeR = 0.9;
      bodyY = 0.05;
    }

    // emotes
    if (emoteNow) {
      const e = emoteNow.e;
      const et = Math.max(0, this.t - emoteNow.started);
      if (e === 'wave') {
        shoulderR = -2.6 + Math.sin(et * 10) * 0.35;
        armRmid = -0.2;
        headNod = 0.08;
        hipL = hipR = 0; kneeL = kneeR = 0;
        bodyY = 0.02;
      } else if (e === 'dance') {
        const w = et * 7.5;
        shoulderL = -1.5 + Math.sin(w) * 1.05;
        shoulderR = -1.5 - Math.sin(w) * 1.05;
        armLmid = armRmid = -0.9;
        headNod = Math.sin(w * 0.8) * 0.28;
        bodyY = Math.abs(Math.sin(w * 0.85)) * 0.14;
        hipL = Math.sin(w) * 0.5; hipR = -Math.sin(w) * 0.5;
        kneeL = Math.abs(Math.sin(w)) * 0.7; kneeR = Math.abs(Math.cos(w)) * 0.7;
      } else if (e === 'greet') {
        headNod = Math.sin(Math.min(et, 1) * 4) * 0.35;
        const bow = Math.max(0, Math.sin(Math.min(et, 1.2) * 2.4)) * 0.28;
        bodyRotX = -bow * 1.6;
        shoulderL = -0.7; shoulderR = -0.2;
        armLmid = -0.5;
        hipL = hipR = 0; kneeL = kneeR = 0;
        bodyY = 0.0;
      }
    }

    // seated override
    if (this.seated) {
      hipL = hipR = -1.45;
      kneeL = kneeR = 0;
      shoulderL = -0.25; shoulderR = -0.25;
      armLmid = armRmid = -0.15;
      bodyY = 0; bodyRotX = 0; chestYaw = 0;
      headNod = 0;
    }

    this.body.position.y = bodyY;
    this.body.rotation.x += (bodyRotX - this.body.rotation.x) * 0.3;
    this.head.rotation.x += (headNod - this.head.rotation.x) * 0.3;
    if (this.torso) this.torso.rotation.y += (chestYaw - this.torso.rotation.y) * 0.3;

    // blinking
    if (this.t > this._blinkAt) {
      const closed = this.t - this._blinkAt < 0.12;
      for (const e of this.eyes) e.scale.y = closed ? 0.08 : 0.8;
      if (!closed) this._blinkAt = this.t + 2.2 + Math.random() * 3;
    }

    // cloth life: skirts and long hair sway with the stride
    const sway = moving ? Math.sin(cyc) * 0.07 : Math.sin(this.t * 1.3) * 0.015;
    if (this.skirt) this.skirt.rotation.z += (sway - this.skirt.rotation.z) * 0.25;
    if (this.hairBack) this.hairBack.rotation.x += (sway * 0.6 - this.hairBack.rotation.x) * 0.2;

    this.setPart(this.armL.root, shoulderL, 0, 0.1);
    this.setPart(this.armR.root, shoulderR, 0, -0.1);
    this.setPart(this.armL.mid, armLmid, 0, 0);
    this.setPart(this.armR.mid, armRmid, 0, 0);
    this.setPart(this.legL.root, hipL, 0, 0);
    this.setPart(this.legR.root, hipR, 0, 0);
    this.setPart(this.legL.mid, kneeL, 0, 0);
    this.setPart(this.legR.mid, kneeR, 0, 0);
    this.apply();
  }
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
  obj.position.set(0, 2.12, 0);
  return obj;
}
