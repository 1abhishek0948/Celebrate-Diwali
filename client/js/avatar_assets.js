// ---------------------------------------------------------------------------
// Realistic avatar asset pipeline (Ready Player Me full-body characters).
//
// Six licensed full-body avatar GLBs (three feminine, three masculine) plus a
// set of retargeted motion-capture clips are vendored under /assets. They are
// loaded ONCE per URL and shared: every player gets a SkeletonUtils.clone()
// of the avatar template and references the same AnimationClips, textures and
// untinted materials. Per-player appearance (skin tone / hair) is applied by
// cloning the few tintable materials per instance; clothing keeps the clean
// default colors baked into the GLBs.
//
// Avatar appearance object (server-checked ints, unchanged wire format):
//   g  gender: 0 feminine, 1 masculine    (missing -> 1, legacy profiles)
//   b  skin tone index (SKIN)             -> Wolf3D_Skin + Wolf3D_Body tint
//   h  hair color index (HAIRS)           -> Wolf3D_Hair tint (darken only)
//   y  hairstyle index 0-2                -> avatar variant within the gender set
//   e  eyewear index 0-2 (none/glasses/sunglasses) -> Glasses mesh if the
//      chosen variant has one baked in
//
// Asset sources & licenses: see docs/LICENSES.md and tools/fetch-assets.sh.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/GLTFLoader.js';
import * as SkeletonUtils from '/vendor/SkeletonUtils.js';

// natural human skin tones (South-Asian leaning, festival under warm light)
export const SKIN = [0xf2c29b, 0xe6a774, 0xc98a5e, 0x8d5a3c, 0x66412a, 0xd9a06e, 0xb87a4e, 0x7a4a2e];
// natural hair colors
export const HAIRS = [0x1d1410, 0x2c1d12, 0x4a3220, 0x6b4a28, 0x8a6236, 0x3d2e20, 0x24201c, 0x554433];

export const GOLD = 0xd9a441;
// shadowed cloth tones for the procedural fallback rig
export const DARK = [0x2e3446, 0x3d2e20, 0x443c50];

// feminine set: long hair / glasses / alt long hair. masculine: beard / clean
// crop / fuller beard. (Bone naming, materials and rest pose are identical
// across all six — the RPM standard armature.)
const AVATAR_URLS = {
  0: ['/assets/avatars/f0.glb', '/assets/avatars/f1.glb', '/assets/avatars/f2.glb'],
  1: ['/assets/avatars/m0.glb', '/assets/avatars/m1.glb', '/assets/avatars/m2.glb'],
};
const ANIM_URLS = {
  0: {
    idle: '/assets/anims/f_idle.glb',
    walk: '/assets/anims/f_walk.glb',
    run: '/assets/anims/f_run.glb',
    jump: '/assets/anims/f_jump.glb',
    dance: '/assets/anims/f_dance.glb',
  },
  1: {
    idle: '/assets/anims/m_idle.glb',
    walk: '/assets/anims/m_walk.glb',
    run: '/assets/anims/m_run.glb',
    jump: '/assets/anims/m_jump.glb',
    dance: '/assets/anims/m_dance.glb',
  },
};

// Estimated baked (sRGB) base colors of the untinted avatar materials; tinting
// multiplies toward the player's chosen tone. Only darkening works reliably,
// which is also what the tint system needs.
const BAKED = {
  skin: new THREE.Color(0xe8b49c),
  hair: new THREE.Color(0x4a3524),
};

const loader = new GLTFLoader();
const gltfCache = new Map(); // url -> Promise<{scene, animations}>
const animSetCache = new Map(); // gender -> Promise<{idle, walk, run, jump, dance}>
const avatarTplCache = new Map(); // "g:y" -> Promise<template>

function loadGltf(url) {
  let p = gltfCache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, () => reject(new Error(`avatar asset failed: ${url}`)));
    });
    gltfCache.set(url, p);
  }
  return p;
}

// Load the five retargeted clips for one armature. Each clip GLB holds exactly
// one animation track set; keep the source clip name for debugging.
export function loadAnimationSet(gender) {
  let p = animSetCache.get(gender);
  if (!p) {
    const urls = ANIM_URLS[gender === 0 ? 0 : 1];
    p = Promise.all(
      Object.entries(urls).map(async ([key, url]) => {
        const gltf = await loadGltf(url);
        const clip = gltf.animations[0];
        if (!clip) throw new Error(`no animation in ${url}`);
        flattenRootMotion(clip); // see below — critical for loop safety
        return [key, clip];
      }),
    ).then((pairs) => Object.fromEntries(pairs));
    p.catch(() => animSetCache.delete(gender));
    animSetCache.set(gender, p);
  }
  return p;
}

// Gait mocap often ships with the actor's forward travel baked into the Hips
// position track (measured: m_walk +3.2 m over its 1.92 s loop, f_walk +4.4 m,
// f_jump +3.3 m). Played on LoopRepeat while the game translates the rig, that
// track makes the avatar drift forward inside its root and then teleport back
// the full distance at every wrap — a violent periodic hitch that was the main
// cause of the old "not smooth" walking/running. Zero the HORIZONTAL values
// (including interpolation tangents) and keep the vertical ones so the hip
// bob and jump arcs survive. After this every clip is safely in-place.
function flattenRootMotion(clip) {
  for (const track of clip.tracks) {
    if (!/^Hips\.[^./]*position$/.test(track.name) && track.name !== 'Hips.position') continue;
    const values = track.values; // plain Float32Array for vector3 tracks
    const arr = values;
    const comps = track.getValueSize();          // 3 for vector3
    const stride = track.getInterpolation() === THREE.InterpolateSmooth ? comps * 3 : comps;
    for (let i = 0; i < arr.length; i++) {
      if (i % stride % comps !== 1) arr[i] = 0;  // zero x/z (+ their tangents)
    }
  }
}

function tintInstance(mat, targetColor, baked) {
  // multiply the baked texture toward the target tone (linear space)
  const t = new THREE.Color(targetColor);
  const b = baked.clone().convertSRGBToLinear();
  const out = new THREE.Color(
    t.r / Math.max(0.05, b.r),
    t.g / Math.max(0.05, b.g),
    t.b / Math.max(0.05, b.b),
  );
  mat.color.copy(out);
}

// Build the shared template for one gender+variant: scene graph, bone rest
// lengths, material handles. Templates are never added to the scene directly.
export function loadAvatarTemplate(gender, variant) {
  const y = ((variant ?? 0) % 3 + 3) % 3;
  const g = gender === 0 ? 0 : 1;
  const key = `${g}:${y}`;
  let p = avatarTplCache.get(key);
  if (!p) {
    p = (async () => {
      const gltf = await loadGltf(AVATAR_URLS[g][y]);
      const root = gltf.scene;
      root.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          o.frustumCulled = false; // skinned bounds lag; cheap for 6 avatars
        }
      });
      root.updateMatrixWorld(true);
      // find materials by Wolf3D name and bones by standard name
      const materials = {};
      root.traverse((o) => {
        if (o.isMesh && o.material) {
          const m = Array.isArray(o.material) ? o.material[0] : o.material;
          if (m && m.name && materials[m.name] === undefined) materials[m.name] = m;
        }
      });
      const bones = {};
      root.traverse((o) => {
        if (o.isBone && !bones[o.name]) bones[o.name] = o;
      });
      const eyeMeshes = [];
      root.traverse((o) => {
        if (o.isMesh && (o.name === 'EyeLeft' || o.name === 'EyeRight')) eyeMeshes.push(o);
      });
      // rest bone positions (avatar space, standing) for IK lengths
      const world = (name) => {
        const b = bones[name];
        return b ? b.getWorldPosition(new THREE.Vector3()) : null;
      };
      const rest = {};
      for (const side of ['Left', 'Right']) {
        const s = world(`${side}Arm`);
        const e = world(`${side}ForeArm`);
        const w = world(`${side}Hand`);
        if (s && e && w) {
          rest[side] = {
            shoulder: s.clone(),
            upperLen: s.distanceTo(e),
            lowerLen: e.distanceTo(w),
          };
        }
      }
      return { root, materials, bones, eyeMeshes, rest, gender: g, variant: y };
    })();
    p.catch(() => avatarTplCache.delete(key));
    avatarTplCache.set(key, p);
  }
  return p;
}

// Per-player instance: skeleton clone + private tintable materials + a tiny
// set of live handles (bones, eye meshes, morph influences).
export async function instantiateAvatar(av) {
  const gender = av.g === undefined ? 1 : (av.g ? 1 : 0);
  const y = av.y === undefined ? ((av.h ?? 1) % 3) : (((av.y % 3) + 3) % 3);
  const [tpl, clips] = await Promise.all([
    loadAvatarTemplate(gender, y),
    loadAnimationSet(gender),
  ]);

  const root = SkeletonUtils.clone(tpl.root);
  root.updateMatrixWorld(true);

  // clone the materials this instance recolors (textures stay shared);
  // clothing is left untinted so every avatar keeps its default baked outfit
  const tintable = {};
  for (const name of ['Wolf3D_Skin', 'Wolf3D_Body', 'Wolf3D_Hair']) {
    const src = tpl.materials[name];
    if (src) {
      const m = src.clone();
      tintable[name] = m;
    }
  }
  root.traverse((o) => {
    if (o.isMesh && o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      let changed = false;
      for (let i = 0; i < mats.length; i++) {
        if (mats[i] && tintable[mats[i].name]) {
          mats[i] = tintable[mats[i].name];
          changed = true;
        }
      }
      if (changed) o.material = Array.isArray(o.material) ? mats : mats[0];
    }
  });

  // appearance -> material tints
  const skinT = SKIN[(av.b ?? 0) % SKIN.length];
  const hairT = HAIRS[(av.h ?? 1) % HAIRS.length];
  if (tintable.Wolf3D_Skin) tintInstance(tintable.Wolf3D_Skin, skinT, BAKED.skin);
  if (tintable.Wolf3D_Body) tintInstance(tintable.Wolf3D_Body, skinT, BAKED.skin);
  if (tintable.Wolf3D_Hair) tintInstance(tintable.Wolf3D_Hair, hairT, BAKED.hair);

  // eyewear: hide the baked glasses unless requested; dark lens for sunglasses.
  // The template's glasses material is shared, so clone per instance first.
  const eyewear = av.e === undefined ? 0 : ((av.e % 3) + 3) % 3;
  root.traverse((o) => {
    if (o.isMesh && o.material && o.material.name === 'Wolf3D_Glasses') {
      o.visible = eyewear !== 0;
      o.material = o.material.clone();
      if (eyewear === 2) {
        o.material.color.set(0x15161a);
        o.material.transparent = true;
        o.material.opacity = 0.9;
      }
    }
  });

  // gentle resting smile from the baked ARKit-style morphs (mouthSmile)
  const smileMeshes = [];
  root.traverse((o) => {
    if (o.isMesh && o.morphTargetDictionary && o.morphTargetDictionary.mouthSmile !== undefined) {
      o.morphTargetInfluences[o.morphTargetDictionary.mouthSmile] = 0.25;
      smileMeshes.push(o);
    }
  });

  // bones + per-side arm lengths for the gesture IK layer
  const bones = {};
  root.traverse((o) => {
    if (o.isBone && !bones[o.name]) bones[o.name] = o;
  });
  const eyeMeshes = [];
  root.traverse((o) => {
    if (o.isMesh && (o.name === 'EyeLeft' || o.name === 'EyeRight')) eyeMeshes.push(o);
  });

  return { root, clips, bones, eyeMeshes, rest: tpl.rest, gender, variant: y, smileMeshes };
}

// The avatar template faces +Z (glTF convention); the FunLand rig root faces
// -Z, so every instance mounts inside a holder rotated by PI around Y.
export function makeAvatarHolder() {
  const holder = new THREE.Group();
  holder.rotation.y = Math.PI;
  return holder;
}
