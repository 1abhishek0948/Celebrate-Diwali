// ---------------------------------------------------------------------------
// Procedural "tilled soil" PBR texture set, generated at runtime on canvases —
// same zero-asset philosophy as the rest of the island (see festival.js).
// Produces albedo / bump / roughness maps of a tilled agricultural acre:
// furrow ridges, dark organic clods, small pebbles, coarse sand grain and
// scattered dried chaff. Every field is periodic over the tile, so the maps
// repeat seamlessly with RepeatWrapping.
//
// Cost: three 1024² canvases built once at world load (~100-200ms desktop).
// ---------------------------------------------------------------------------
import * as THREE from "three";

// local copy of the world's deterministic RNG (kept self-contained on purpose)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// integer lattice hash -> [0,1)
function latHash(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// value noise on a lattice with integer `period` -> seamless over [0,1)²
function tileNoise(x, y, period, seed) {
  const fx = x * period,
    fy = y * period;
  const ix = Math.floor(fx),
    iy = Math.floor(fy);
  let tx = fx - ix,
    ty = fy - iy;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  const x0 = ((ix % period) + period) % period,
    x1 = (x0 + 1) % period;
  const y0 = ((iy % period) + period) % period,
    y1 = (y0 + 1) % period;
  const a = latHash(x0, y0, seed),
    b = latHash(x1, y0, seed);
  const c = latHash(x0, y1, seed),
    d = latHash(x1, y1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

// seamless fBm rendered into a small grid, bilinearly upsampled per pixel
function fbmGrid(size, period, octaves, seed) {
  const g = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let v = 0,
        amp = 1,
        tot = 0,
        p = period;
      for (let o = 0; o < octaves; o++) {
        v += tileNoise(i / size, j / size, p, seed + o * 101) * amp;
        tot += amp;
        amp *= 0.5;
        p *= 2;
      }
      g[j * size + i] = v / tot;
    }
  }
  return g;
}

function sampleWrapped(g, size, x, y) {
  const fx = x * size,
    fy = y * size;
  const ix = Math.floor(fx),
    iy = Math.floor(fy);
  const tx = fx - ix,
    ty = fy - iy;
  const x0 = ix % size,
    y0 = iy % size,
    x1 = (x0 + 1) % size,
    y1 = (y0 + 1) % size;
  const a = g[y0 * size + x0],
    b = g[y0 * size + x1],
    c = g[y1 * size + x0],
    d = g[y1 * size + x1];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

// smooth dome stamp with wrapped indexing — anything stamped this way tiles
function stamp(H, S, cx, cy, radius, hAdd, mask, maskAdd, tint, tintV) {
  const r = Math.ceil(radius),
    r2 = radius * radius;
  const icx = cx | 0,
    icy = cy | 0;
  for (let dy = -r; dy <= r; dy++) {
    const yy = (((icy + dy) % S) + S) % S;
    for (let dx = -r; dx <= r; dx++) {
      const d2 = (dx * dx + dy * dy) / r2;
      if (d2 > 1) continue;
      const fall = 1 - d2;
      const w = fall * fall * (3 - 2 * fall);
      const xx = (((icx + dx) % S) + S) % S;
      const idx = yy * S + xx;
      H[idx] += hAdd * w;
      if (mask) mask[idx] = Math.min(1, mask[idx] + w * maskAdd);
      if (tint) tint[idx] += (tintV - tint[idx]) * w;
    }
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function makeSoilTextures(size = 1024, repeat = 112) {
  const rng = mulberry32(20261031);

  // low-res tileable drivers: furrow-line wobble + dry/moist macro patches
  const wobble = fbmGrid(128, 3, 2, 11);
  const macro = fbmGrid(128, 5, 3, 23);

  const H = new Float32Array(size * size); // combined height field
  const clodM = new Float32Array(size * size); // clod mask (albedo blend)
  const clodT = new Float32Array(size * size); // clod tint selector 0..1
  const pebM = new Float32Array(size * size); // pebble mask
  const pebG = new Float32Array(size * size); // pebble gray selector 0..1

  const ROWS = 7; // furrow ridges per tile

  // ---- base relief: furrow ridges + macro undulation -----------------------
  for (let j = 0; j < size; j++) {
    const ty = j / size;
    for (let i = 0; i < size; i++) {
      const tx = i / size;
      const w = sampleWrapped(wobble, 128, tx, ty);
      const m = sampleWrapped(macro, 128, tx, ty);
      // ploughed rows along X, lines wobbled by the seamless field
      let f = 0.5 + 0.5 * Math.sin(2 * Math.PI * (ROWS * ty + w * 0.55));
      f = f * f * (3 - 2 * f); // flatter crests, tighter valleys
      H[j * size + i] = f * 0.46 + m * 0.3 + w * 0.06;
    }
  }

  // ---- fresh-plough macro clods (chunky plates of turned earth) ------------
  for (let c = 0; c < 70; c++) {
    const bx = rng() * size,
      by = rng() * size;
    const t = 0.1 + rng() * 0.35; // dark, rich organic tones
    stamp(H, size, bx, by, 18 + rng() * 30, 0.09 + rng() * 0.13, clodM, 0.8, clodT, t);
  }

  // ---- crumb clods: clustered lumps of rough dirt --------------------------
  for (let c = 0; c < 900; c++) {
    const bx = rng() * size,
      by = rng() * size;
    const n = 2 + ((rng() * 5) | 0);
    const t = rng();
    for (let k = 0; k < n; k++) {
      const ang = rng() * Math.PI * 2,
        rad = rng() * 15;
      stamp(
        H, size,
        bx + Math.cos(ang) * rad,
        by + Math.sin(ang) * rad,
        4 + rng() * 12,
        0.05 + rng() * 0.16,
        clodM, 0.9, clodT, t,
      );
    }
  }

  // ---- small pebbles + a few bigger stones ---------------------------------
  for (let p = 0; p < 190; p++) {
    stamp(
      H, size, rng() * size, rng() * size,
      2.2 + rng() * 5.5,
      0.26 + rng() * 0.3,
      pebM, 1, pebG, 0.25 + rng() * 0.75,
    );
  }
  for (let p = 0; p < 14; p++) {
    stamp(
      H, size, rng() * size, rng() * size,
      6 + rng() * 6,
      0.3 + rng() * 0.25,
      pebM, 1, pebG, 0.3 + rng() * 0.6,
    );
  }

  // ---- albedo ---------------------------------------------------------------
  const mkCanvas = () => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    return c;
  };
  const albedo = mkCanvas();
  const ctx = albedo.getContext("2d");
  const img = ctx.createImageData(size, size);
  const D = img.data;

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const idx = j * size + i;
      const h = H[idx];
      // dryness: ridge crests & high clumps read dry, valleys read moist
      const grain = latHash(i, j, 777);
      const d = clamp01(h * 1.35 - 0.14 + (grain - 0.5) * 0.16);
      // wet loam -> mid earth -> dry crest
      let r = 36 + 44 * clamp01(d * 2) + 26 * clamp01(d * 2 - 1);
      let g = 26 + 31 * clamp01(d * 2) + 20 * clamp01(d * 2 - 1);
      let b = 18 + 22 * clamp01(d * 2) + 13 * clamp01(d * 2 - 1);

      // clod bodies: organic browns, lit tops
      const cm = clodM[idx];
      if (cm > 0.01) {
        const t = clodT[idx];
        const cr = 50 + 62 * t,
          cg = 35 + 47 * t,
          cb = 24 + 33 * t;
        const k = cm * 0.85;
        r += (cr - r) * k;
        g += (cg - g) * k;
        b += (cb - b) * k;
      }

      // pebbles: warm grays
      const pm = pebM[idx];
      if (pm > 0.01) {
        const v = pebG[idx];
        const k = clamp01(pm * 1.5);
        r += (98 + 86 * v - r) * k;
        g += (92 + 80 * v - g) * k;
        b += (84 + 72 * v - b) * k;
      }

      // coarse sand speckles (show more on dry ground)
      if (grain > 0.8) {
        const s = (grain - 0.8) * 2.6 * (0.35 + 0.65 * d);
        r += (168 - r) * s * 0.55;
        g += (146 - g) * s * 0.55;
        b += (112 - b) * s * 0.55;
      }

      // per-pixel organic jitter
      const jit = (latHash(i, j, 31) - 0.5) * 9;
      const p4 = idx * 4;
      D[p4] = clamp01((r + jit) / 255) * 255;
      D[p4 + 1] = clamp01((g + jit * 0.85) / 255) * 255;
      D[p4 + 2] = clamp01((b + jit * 0.7) / 255) * 255;
      D[p4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // ---- dried chaff: tiny straw fragments drawn over everything -------------
  ctx.lineCap = "round";
  for (let s = 0; s < 260; s++) {
    const x = rng() * size,
      y = rng() * size;
    const ang = rng() * Math.PI * 2;
    const len = 5 + rng() * 11;
    const w = 0.8 + rng() * 0.9;
    const dark = rng() < 0.25; // some darker stem bits
    ctx.strokeStyle = dark
      ? `rgba(124,102,70,${0.45 + rng() * 0.35})`
      : `rgba(206,182,132,${0.5 + rng() * 0.4})`;
    ctx.lineWidth = w;
    const dx = Math.cos(ang) * len,
      dy = Math.sin(ang) * len;
    // draw at 9 wrapped offsets so fragments crossing the edge tile too
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        ctx.beginPath();
        ctx.moveTo(x + ox * size, y + oy * size);
        ctx.lineTo(x + ox * size + dx, y + oy * size + dy);
        ctx.stroke();
      }
  }

  // ---- bump: normalized height ----------------------------------------------
  let hMin = 1e9,
    hMax = -1e9;
  for (let k = 0; k < H.length; k++) {
    if (H[k] < hMin) hMin = H[k];
    if (H[k] > hMax) hMax = H[k];
  }
  const hSpan = hMax - hMin || 1;
  const bump = mkCanvas();
  const bctx = bump.getContext("2d");
  const bimg = bctx.createImageData(size, size);
  const BD = bimg.data;

  // ---- roughness: matte soil, pebbles slightly slicker ----------------------
  const rough = mkCanvas();
  const rctx = rough.getContext("2d");
  const rimg = rctx.createImageData(size, size);
  const RD = rimg.data;

  for (let k = 0; k < H.length; k++) {
    const v = (((H[k] - hMin) / hSpan) * 255) | 0;
    const p4 = k * 4;
    BD[p4] = BD[p4 + 1] = BD[p4 + 2] = v;
    BD[p4 + 3] = 255;
    const ro = clamp01(0.94 - pebM[k] * 0.38 + (latHash(k & 1023, k >> 10, 55) - 0.5) * 0.06);
    const rv = (ro * 255) | 0;
    RD[p4] = RD[p4 + 1] = RD[p4 + 2] = rv;
    RD[p4 + 3] = 255;
  }
  bctx.putImageData(bimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);

  // ---- three.js textures -----------------------------------------------------
  const tex = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = 8; // clamped to GPU max by three
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  return {
    map: tex(albedo, true),
    bumpMap: tex(bump, false),
    roughnessMap: tex(rough, false),
  };
}
