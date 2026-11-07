// ---------------------------------------------------------------------------
// Festival of Lights — an immersive night overlay for the Diwali Meet Up island,
// inspired by ancient Nepalese (Newari) and Tibetan mountain islands.
//
// Everything here is procedural and self-contained, matching the project's
// "no external assets / no build step" design (see docs/ROADMAP.md): the
// rangoli, carved-window and stone-paving "image assets" are generated at
// runtime into canvas textures, so there are no downloads, no paid APIs and
// no new dependencies.
//
// The class owns a single Group and attaches it to the island group, so the
// existing island/interior visibility switching keeps working unchanged.
// Interaction is exposed through world.interactables ("kind: 'festival'").
// ---------------------------------------------------------------------------
import * as THREE from "three";
import {
  PLAZA_RADIUS,
  ROADS,
  HOUSE_PLOTS,
  SHOPS,
  BEACH_BAR,
  fireworkById,
} from "../shared/constants.js";

// local deterministic RNG (kept separate from world.js to avoid an import cycle)
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

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
}
function easeOutCubic(x) {
  const t = Math.min(1, Math.max(0, x));
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

// "HAPPY DIWALI" sky greeting ------------------------------------------------
const TEXT_LINES = ["HAPPY", "DIWALI"];
const TEXT_FONT =
  'bold {S}px Georgia, "Times New Roman", "Nimbus Roman", serif';
const TEXT_WIDTH = 144; // world-space width of the widest line
const TEXT_Y = 42; // centre height above the ground
const TEXT_Z = 150; // over the main stone pathway, centred on the island
const TEXT_DEPTH = 5.5; // extrusion depth of the lettering
const TEXT_REVEAL = 3.4; // seconds of the golden particle reveal

const PAL = {
  // Brighter twilight palette keeps the island readable while preserving the
  // Diwali-night mood and warm horizon glow.
  skyTop: 0x151b42,
  skyMid: 0x493875,
  skyBot: 0xa45b72,
  glow: 0xffa660,
  fog: 0x292d52,
  mountNear: 0x1a1f44,
  mountFar: 0x2a2f5e,
  snow: 0xc0c9ee,
  wood: 0x5c3620,
  woodDark: 0x36200f,
  brick: 0x7f4132,
  roof: 0x7e3a29,
  roofDark: 0x5f2a1d,
  stone: 0x6a6a74,
  stoneDark: 0x44444e,
  warm: 0xffb469,
  gold: 0xffd071,
};

// vivid South-Asian festive clothing palette for the street crowd
const CLOTHES = [
  0xe23b3b, 0xf29a3d, 0xf6e05e, 0x3fbfae, 0x3d7ad6, 0x8a4fd8, 0xe0569b,
  0xf3f3ee, 0x27a06a, 0xd94f2b, 0xffd34d, 0x1f7fa8,
];
const SKINS = [0xf2c29b, 0xe6a774, 0xc98a5e, 0x8d5a3c, 0x66412a];

// warm gold/amber string lights, colourful fairy strings, marigold garlands
const WARM_COLS = [0xffd58a, 0xffc266, 0xffb04d, 0xffe6b0, 0xffcf7a];
const FAIRY_COLS = [
  0xff8a3c, 0xffb02e, 0xe23b3b, 0xff5c8a, 0x8a4fd8, 0xffd34d, 0xff6a3c,
];
const MARIGOLD = [0xff9a1e, 0xffb733, 0xffd24d, 0xff7a2e, 0xffc44d];

export class Festival {
  constructor(world, opts = {}) {
    this.world = world;
    this.quality = "high";
    this.timeOfDay = "night";
    // honour the OS "reduce motion" setting: calmer animation, no camera sweep
    this.reduceMotion =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.time = 0;
    this.timeUniform = { value: 0 };
    this.twkUniform = { value: 0 }; // twinkle amplitude (0 when reduced motion)
    this.pulseUniform = { value: 0 }; // all-diyas flare on interaction
    this.bonfireFlare = 0;
    this.wheelBoost = 0;
    this.onNotify = null; // set by main -> UI toast
    this.onEmote = null; // set by main -> play emote
    this.onRevealStart = null; // set by main -> cinematic look-up
    this.armed = false; // greeting only reveals once in-world
    this.clearings = []; // no-tree zones for world._natureSpotOk
    this.pagodas = [];

    this.root = new THREE.Group();
    this.root.name = "festival";
    this.rand = mulberry32(0x5eed1a);
    this._unitBox = new THREE.BoxGeometry(1, 1, 1); // shared, avoids per-prop geometry
    this.windowSpots = []; // instanced carved windows (all pagodas)
    this._decoStrings = []; // aligned bulb strings (every building)
    this._decoGarland = []; // marigold garland blossoms
    this._decoDiyas = []; // sill / step / rangoli diyas

    this._buildSky();
    this._buildMountains();
    this._buildSkyText();
    this._buildGround();
    this._buildTownhouses();
    this._buildPagodas();
    this._buildBunting();
    this._buildDiyas();
    this._buildHouseDecor();
    this._buildBonfire();
    this._buildLanterns();
    this._buildCrowd();
    this._buildFireworks();
    this._buildSmoke();
    this._buildCrackers();
    this._initPlayerFx();
    this._buildMotes();
    this._buildMist();
    this._registerInteractions();

    world.island.add(this.root);
  }

  // ---------------------------------------------------------------- helpers --
  _rr(a, b) {
    return a + this.rand() * (b - a);
  }
  _pick(arr) {
    return arr[(this.rand() * arr.length) | 0];
  }

  _clear(x, z, r) {
    this.clearings.push({ x, z, r });
  }

  _box(parent, color, x, y, z, sx, sy, sz, emissive = 0x000000) {
    const m = new THREE.Mesh(
      this._unitBox,
      new THREE.MeshLambertMaterial({ color, emissive }),
    );
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    parent.add(m);
    return m;
  }

  _finalize(im, dynamic = false) {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    if (dynamic) im.frustumCulled = false;
    else if (im.computeBoundingSphere) im.computeBoundingSphere();
    else im.frustumCulled = false;
    return im;
  }

  _canvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  _softTexture(
    size = 64,
    stops = [
      [0, "rgba(255,255,255,1)"],
      [1, "rgba(255,255,255,0)"],
    ],
  ) {
    const c = this._canvas(size, size);
    const x = c.getContext("2d");
    const g = x.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    for (const [o, col] of stops) g.addColorStop(o, col);
    x.fillStyle = g;
    x.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // --------------------------------------------------------------- night sky --
  _buildSky() {
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(PAL.skyTop) },
        midColor: { value: new THREE.Color(PAL.skyMid) },
        botColor: { value: new THREE.Color(PAL.skyBot) },
        glowColor: { value: new THREE.Color(PAL.glow) },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 topColor, midColor, botColor, glowColor;
        void main() {
          float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = mix(botColor, midColor, smoothstep(0.42, 0.64, h));
          col = mix(col, topColor, smoothstep(0.60, 0.98, h));
          float horizon = exp(-abs(vDir.y) * 7.0);
          float west = 0.5 + 0.5 * (-vDir.x);
          col += glowColor * horizon * (0.18 + 0.30 * west);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.skyMat = skyMat;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(980, 32, 20), skyMat);
    sky.renderOrder = -10;
    this.root.add(sky);

    // stars (upper hemisphere)
    const N = this.quality === "high" ? 1600 : 900;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = this.rand() * Math.PI * 2;
      const y = 0.05 + this.rand() * 0.95;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const R = 940;
      pos[i * 3] = Math.cos(a) * r * R;
      pos[i * 3 + 1] = y * R;
      pos[i * 3 + 2] = Math.sin(a) * r * R;
      const b = 0.5 + this.rand() * 0.5;
      col[i * 3] = b;
      col[i * 3 + 1] = b * (0.9 + this.rand() * 0.1);
      col[i * 3 + 2] = 1.0;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size: 1.6,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    this.stars.renderOrder = -9;
    this.root.add(this.stars);

    // moon with a soft halo
    const moonTex = this._softTexture(128, [
      [0.0, "rgba(255,250,235,1)"],
      [0.22, "rgba(240,240,255,0.85)"],
      [0.45, "rgba(180,190,255,0.28)"],
      [1.0, "rgba(150,160,255,0)"],
    ]);
    const moon = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: moonTex,
        color: 0xdfe6ff,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    moon.position.set(-430, 430, -720);
    moon.scale.setScalar(210);
    moon.renderOrder = -9;
    this.moonSprite = moon;
    this.root.add(moon);
  }

  // ------------------------------------------------------------- himalayas ---
  _mountainRing(radius, count, hMin, hMax, baseW, color, snow) {
    const cone = new THREE.ConeGeometry(1, 1, 5);
    const mat = new THREE.MeshLambertMaterial({
      color,
      flatShading: true,
      emissive: 0x0b0e22,
    });
    const im = new THREE.InstancedMesh(cone, mat, count);
    const M = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      s = new THREE.Vector3(),
      p = new THREE.Vector3();
    const snowIM = snow
      ? new THREE.InstancedMesh(
          cone,
          new THREE.MeshLambertMaterial({
            color: PAL.snow,
            flatShading: true,
            emissive: 0x2a3050,
          }),
          count,
        )
      : null;
    let snowN = 0;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + this._rr(-0.06, 0.06);
      const rad = radius + this._rr(-40, 40);
      const h = this._rr(hMin, hMax);
      const w = baseW * this._rr(0.75, 1.35);
      const x = Math.cos(a) * rad,
        z = Math.sin(a) * rad;
      p.set(x, h / 2 - 4, z);
      q.setFromEuler(new THREE.Euler(0, this._rr(0, Math.PI), 0));
      s.set(w, h, w);
      M.compose(p, q, s);
      im.setMatrixAt(i, M);
      if (snowIM && h > hMax * 0.72) {
        p.set(x, h - 4 - h * 0.14, z);
        q.setFromEuler(new THREE.Euler(0, this._rr(0, Math.PI), 0));
        s.set(w * 0.34, h * 0.3, w * 0.34);
        M.compose(p, q, s);
        snowIM.setMatrixAt(snowN++, M);
      }
    }
    if (snowIM) snowIM.count = snowN;
    this.root.add(this._finalize(im));
    if (snowIM) this.root.add(this._finalize(snowIM));
  }

  _buildMountains() {
    this._mountainRing(760, 40, 95, 235, 210, PAL.mountFar, true);
    this._mountainRing(600, 34, 70, 165, 175, PAL.mountNear, true);
  }

  // ------------------------------------------------------- ground & mandala --
  _cobbleTexture() {
    const S = 256;
    const c = this._canvas(S, S);
    const x = c.getContext("2d");
    x.fillStyle = "#33333b";
    x.fillRect(0, 0, S, S);
    for (let gy = 0; gy < 8; gy++) {
      for (let gx = 0; gx < 8; gx++) {
        const px = gx * 32 + this._rr(-3, 3);
        const py = gy * 32 + this._rr(-3, 3);
        const t = 0.5 + this._rr(-0.18, 0.18);
        const v = Math.floor(70 + t * 46);
        x.fillStyle = `rgb(${v},${v - 4},${v - 10})`;
        x.beginPath();
        if (x.roundRect) x.roundRect(px + 2, py + 2, 27, 27, 7);
        else x.rect(px + 2, py + 2, 27, 27);
        x.fill();
        x.strokeStyle = "rgba(12,12,18,0.55)";
        x.lineWidth = 3;
        x.stroke();
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  _mandalaTexture(variant) {
    const S = 1024;
    const c = this._canvas(S, S);
    const x = c.getContext("2d");
    const cols =
      variant === 0
        ? ["#ffd36b", "#ff8a3c", "#ff3d7f", "#8a5bff", "#3fd6d0"]
        : variant === 1
          ? ["#9ff0ff", "#5b8bff", "#b06bff", "#ff8fd0", "#ffe6a0"]
          : ["#ffe08a", "#ff9d4d", "#ff5c8a", "#43e0b0", "#6ea8ff"];
    x.translate(S / 2, S / 2);
    const maxR = S / 2 - 24;
    // rings + dot work
    for (let r = 0; r < 8; r++) {
      const rad = 34 + (r * (maxR - 34)) / 8;
      x.globalAlpha = 0.55 + r * 0.05;
      x.beginPath();
      x.arc(0, 0, rad, 0, Math.PI * 2);
      x.strokeStyle = cols[r % cols.length];
      x.lineWidth = 2.5 + (r % 3);
      x.stroke();
      const n = 10 + r * 9;
      x.globalAlpha = 0.95;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + r * 0.12;
        x.beginPath();
        x.arc(
          Math.cos(a) * rad,
          Math.sin(a) * rad,
          2.4 + (r % 2),
          0,
          Math.PI * 2,
        );
        x.fillStyle = cols[(r + i) % cols.length];
        x.fill();
      }
    }
    // radial petals
    const petals = 16;
    for (let p = 0; p < petals; p++) {
      x.save();
      x.rotate((p / petals) * Math.PI * 2);
      x.beginPath();
      x.moveTo(0, -58);
      x.quadraticCurveTo(96, -250, 0, -maxR + 12);
      x.quadraticCurveTo(-96, -250, 0, -58);
      x.closePath();
      x.globalAlpha = 0.9;
      x.strokeStyle = cols[p % cols.length];
      x.lineWidth = 4;
      x.stroke();
      x.globalAlpha = 0.18;
      x.fillStyle = cols[(p + 2) % cols.length];
      x.fill();
      x.restore();
    }
    // centre lotus
    x.globalAlpha = 0.95;
    for (let i = 0; i < 12; i++) {
      x.save();
      x.rotate((i / 12) * Math.PI * 2);
      x.beginPath();
      x.ellipse(0, -26, 12, 26, 0, 0, Math.PI * 2);
      x.fillStyle = cols[i % cols.length];
      x.fill();
      x.restore();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  _mandala(x, z, radius, y, variant, opacity = 1) {
    const mat = new THREE.MeshBasicMaterial({
      map: this._mandalaTexture(variant),
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 64), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.renderOrder = 2;
    this.root.add(m);
    return m;
  }

  _buildGround() {
    const cobble = this._cobbleTexture();

    // paved plaza (soft stone) over the existing colour plaza
    const plazaMat = new THREE.MeshLambertMaterial({
      map: cobble.clone(),
      color: 0xbfb8ad,
    });
    plazaMat.map.repeat.set(16, 16);
    plazaMat.map.needsUpdate = true;
    const plaza = new THREE.Mesh(
      new THREE.CircleGeometry(PLAZA_RADIUS - 0.5, 64),
      plazaMat,
    );
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.y = 0.072;
    this.root.add(plaza);

    // stone-paved avenue bands (the "festival street")
    const avLen = ROADS.ringRadius - PLAZA_RADIUS - ROADS.avenueEndGap;
    const halfW = ROADS.avenueHalfWidth + ROADS.sidewalkHalfWidth;
    for (const axis of ["x", "z"]) {
      for (const sign of [1, -1]) {
        const center = sign * (PLAZA_RADIUS + avLen / 2);
        const m = cobble.clone();
        m.repeat.set(axis === "x" ? 48 : 7, axis === "x" ? 7 : 48);
        m.needsUpdate = true;
        const mat = new THREE.MeshLambertMaterial({
          map: m,
          color: 0xb4ada3,
        });
        const geo =
          axis === "x"
            ? new THREE.PlaneGeometry(avLen, halfW * 2)
            : new THREE.PlaneGeometry(halfW * 2, avLen);
        const box = new THREE.Mesh(geo, mat);
        box.rotation.x = -Math.PI / 2;
        box.position.set(
          axis === "x" ? center : 0,
          0.07,
          axis === "x" ? 0 : center,
        );
        this.root.add(box);
      }
    }

    // glowing rangoli / mandalas — a refined central rangoli that reads as
    // hand-drawn pigment lit by the surrounding diyas, not a floor-to-edge
    // neon carpet (which drowns the stone plaza and the crowd).
    this._mandala(0, 0, 14, 0.082, 0, 0.42);
    this._mandala(-44, 44, 7, 0.09, 1, 0.7);
    this._mandala(40, 34, 5.5, 0.09, 2, 0.7);
    this._mandala(-40, 34, 5.5, 0.09, 2, 0.7);
  }

  // --------------------------------------------------------- carved windows --
  _windowTexture() {
    const S = 128;
    const c = this._canvas(S, S);
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, "#ffd98a");
    g.addColorStop(0.55, "#ffab45");
    g.addColorStop(1, "#ff7a1e");
    x.fillStyle = g;
    x.fillRect(0, 0, S, S);
    // Newari-style carved lattice
    x.strokeStyle = "#4a2408";
    x.lineWidth = 5;
    x.strokeRect(3, 3, S - 6, S - 6);
    x.lineWidth = 2.5;
    for (let i = 1; i < 5; i++) {
      x.beginPath();
      x.moveTo((i * S) / 5, 6);
      x.lineTo((i * S) / 5, S - 6);
      x.stroke();
      x.beginPath();
      x.moveTo(6, (i * S) / 5);
      x.lineTo(S - 6, (i * S) / 5);
      x.stroke();
    }
    x.fillStyle = "#4a2408";
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        x.beginPath();
        x.arc(((gx + 0.5) * S) / 5, ((gy + 0.5) * S) / 5, 4.2, 0, Math.PI * 2);
        x.fill();
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ------------------------------------------------------------ townhouses ---
  _buildTownhouses() {
    const windowTex = this._windowTexture();
    const houses = [];
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 4; i++) {
        const z = 72 + i * 38 + this._rr(-3, 3);
        houses.push({
          x: side * 16.5,
          z,
          ry: side < 0 ? Math.PI / 2 : -Math.PI / 2,
          side,
        });
      }
    }
    for (const h of houses) this._clear(h.x, h.z, 10);
    this._townhouses = houses;

    const n = houses.length;
    const plinthIM = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({
        color: PAL.stoneDark,
        emissive: 0x0a0a12,
      }),
      n,
    );
    const bodyIM = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({
        color: 0xffffff,
        emissive: 0x140605,
        vertexColors: false,
      }),
      n,
    );
    const bandIM = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: PAL.woodDark }),
      n * 2,
    );
    const roofIM = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 4),
      new THREE.MeshLambertMaterial({
        color: PAL.roof,
        emissive: 0x1a0703,
        flatShading: true,
      }),
      n,
    );
    const winIM = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: windowTex }),
      n * 5,
    );
    const doorIM = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshLambertMaterial({ color: PAL.woodDark }),
      n,
    );

    const M = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      p = new THREE.Vector3(),
      s = new THREE.Vector3();
    const e = new THREE.Euler();
    const setM = (im, idx, x, y, z, sx, sy, sz, ry = 0, rx = 0) => {
      e.set(rx, ry, 0);
      q.setFromEuler(e);
      p.set(x, y, z);
      s.set(sx, sy, sz);
      M.compose(p, q, s);
      im.setMatrixAt(idx, M);
    };
    // local -> world for a house (only rotation about Y)
    const localToWorld = (h, lx, lz) => {
      const c = Math.cos(h.ry),
        sn = Math.sin(h.ry);
      return [h.x + lx * c + lz * sn, h.z - lx * sn + lz * c];
    };

    let wi = 0;
    houses.forEach((h, i) => {
      setM(plinthIM, i, h.x, 0.3, h.z, 11, 0.6, 8, h.ry);
      setM(bodyIM, i, h.x, 3.2, h.z, 10, 6.2, 7, h.ry);
      bodyIM.setColorAt(
        i,
        new THREE.Color(this._pick([0x8a4a3a, 0x9a5340, 0x7a4436, 0xa35c46])),
      );
      let bi = i * 2;
      setM(bandIM, bi++, h.x, 4.6, h.z, 10.2, 0.32, 7.2, h.ry);
      setM(bandIM, bi++, h.x, 2.6, h.z, 10.2, 0.28, 7.2, h.ry);
      setM(roofIM, i, h.x, 7.4, h.z, 8.6, 2.6, 7.6, h.ry + Math.PI / 4);
      // door + windows on the street-facing (+Z local) side
      const [dx, dz] = localToWorld(h, 0, 3.55);
      setM(doorIM, i, dx, 1.4, dz, 1.9, 2.7, 1, h.ry);
      for (const [lx, ly] of [
        [-2.7, 2.0],
        [2.7, 2.0],
        [-2.7, 4.6],
        [2.7, 4.6],
        [0, 4.6],
      ]) {
        const [wx, wz] = localToWorld(h, lx, 3.53);
        setM(winIM, wi++, wx, ly, wz, 1.5, 1.4, 1, h.ry);
      }
      // warm pooled light for a couple of houses only (perf)
      if (i % 4 === 0) {
        const [lx2, lz2] = localToWorld(h, 0, 4.6);
        const pl = new THREE.PointLight(PAL.warm, 0.0, 22, 2);
        pl.position.set(lx2, 2.6, lz2);
        pl.userData.baseIntensity = 0.9;
        this.root.add(pl);
        (this._houseLights ||= []).push(pl);
      }
      // collider (rotated footprint is axis-aligned here)
      this.world._addCollider({
        type: "aabb",
        x0: h.x - 3.6,
        x1: h.x + 3.6,
        z0: h.z - 5.1,
        z1: h.z + 5.1,
      });
    });

    this.root.add(this._finalize(plinthIM));
    this.root.add(this._finalize(bodyIM));
    this.root.add(this._finalize(bandIM));
    this.root.add(this._finalize(roofIM));
    this.root.add(this._finalize(winIM));
    this.root.add(this._finalize(doorIM));
  }

  // --------------------------------------------------------------- pagodas ---
  _buildPagoda(cx, cz, ry) {
    const g = new THREE.Group();
    g.position.set(cx, 0, cz);
    g.rotation.y = ry;
    this.root.add(g);

    // stepped stone plinth
    this._box(g, PAL.stoneDark, 0, 0.35, 0, 9, 0.7, 9);
    this._box(g, PAL.stone, 0, 0.85, 0, 7.6, 0.4, 7.6);

    const tiers = 3;
    const c = Math.cos(g.rotation.y),
      sn = Math.sin(g.rotation.y);
    for (let t = 0; t < tiers; t++) {
      const w = 5.6 - t * 1.0;
      const yBase = 1.05 + t * 2.55;
      const bodyMat = new THREE.MeshLambertMaterial({
        color: t % 2 ? PAL.wood : PAL.brick,
        emissive: 0x160706,
      });
      const body = new THREE.Mesh(this._unitBox, bodyMat);
      body.position.set(0, yBase + 1.15, 0);
      body.scale.set(w, 2.3, w);
      g.add(body);
      // carved windows on the four faces -> collected into one InstancedMesh
      for (let f = 0; f < 4; f++) {
        const a = (f * Math.PI) / 2;
        const lx = Math.sin(a) * (w / 2 + 0.02);
        const lz = Math.cos(a) * (w / 2 + 0.02);
        this.windowSpots.push({
          x: cx + lx * c + lz * sn,
          y: yBase + 1.25,
          z: cz - lx * sn + lz * c,
          ry: g.rotation.y + a,
        });
      }
      // wide overhanging roof
      const rw = 7.6 - t * 1.05;
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(1, 1, 4),
        new THREE.MeshLambertMaterial({
          color: PAL.roofDark,
          emissive: 0x160603,
          flatShading: true,
        }),
      );
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(rw, 1.5, rw);
      roof.position.y = yBase + 2.3 + 0.75;
      g.add(roof);
      // gold eave trim
      const trim = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.03, 6, 4),
        new THREE.MeshBasicMaterial({ color: PAL.gold }),
      );
      trim.rotation.x = Math.PI / 2;
      trim.scale.setScalar(rw * 0.62);
      trim.position.y = yBase + 2.32;
      g.add(trim);
    }
    // crowning roof + gilded finial
    const cap = new THREE.Mesh(
      new THREE.ConeGeometry(1, 1, 4),
      new THREE.MeshLambertMaterial({
        color: PAL.roofDark,
        emissive: 0x160603,
        flatShading: true,
      }),
    );
    cap.rotation.y = Math.PI / 4;
    cap.scale.set(4.4, 2.0, 4.4);
    cap.position.y = 1.05 + tiers * 2.55 + 0.75;
    g.add(cap);
    const finBase = 1.05 + tiers * 2.55 + 1.75;
    const finial = new THREE.Mesh(
      new THREE.ConeGeometry(0.28, 1.4, 8),
      new THREE.MeshBasicMaterial({ color: PAL.gold }),
    );
    finial.position.y = finBase + 0.7;
    g.add(finial);
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff0b0 }),
    );
    orb.position.y = finBase + 1.55;
    g.add(orb);

    // spinning prayer wheel at the entrance
    const wheel = new THREE.Group();
    wheel.position.set(0, 1.5, 4.4);
    const drum = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.45, 0.9, 12),
      new THREE.MeshLambertMaterial({ color: 0xb8862f, emissive: 0x3a2404 }),
    );
    drum.rotation.x = Math.PI / 2;
    const spindle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 1.4, 6),
      new THREE.MeshLambertMaterial({ color: PAL.woodDark }),
    );
    wheel.add(drum, spindle);
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.1, 1.2, 6),
      new THREE.MeshLambertMaterial({ color: PAL.woodDark }),
    );
    post.position.set(0, 0.6, 4.4);
    g.add(wheel, post);
    this.wheels ||= [];
    this.wheels.push(wheel);

    this.pagodas.push({ x: cx, z: cz, ry });
    this._clear(cx, cz, 11);
    this.world._addCollider({ type: "circle", x: cx, z: cz, r: 5.6 });

    // soft warm light at the shrine
    const pl = new THREE.PointLight(PAL.warm, 0, 40, 2);
    pl.position.set(cx, 4.5, cz);
    pl.userData.baseIntensity = 1.1;
    this.root.add(pl);
    (this._shrineLights ||= []).push(pl);
  }

  _buildPagodas() {
    // flanking the festival street, facing the plaza
    const place = [
      { x: 40, z: 34 },
      { x: -40, z: 34 },
    ];
    for (const s of place) {
      const ry = Math.atan2(-s.x, -s.z);
      this._buildPagoda(s.x, s.z, ry);
    }
    // all pagoda windows in a single draw call
    const winTex = this._windowTexture();
    const winIM = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: winTex }),
      this.windowSpots.length,
    );
    const M = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      p = new THREE.Vector3(),
      s = new THREE.Vector3();
    this.windowSpots.forEach((w, i) => {
      q.setFromEuler(new THREE.Euler(0, w.ry, 0));
      p.set(w.x, w.y, w.z);
      s.set(1.5, 1.3, 1);
      M.compose(p, q, s);
      winIM.setMatrixAt(i, M);
    });
    this.root.add(this._finalize(winIM));
  }

  // ---------------------------------------------------------------- bunting --
  _buildBunting() {
    const tri = new THREE.PlaneGeometry(0.62, 0.8);
    const per = 14,
      rows = 4;
    const im = new THREE.InstancedMesh(
      tri,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
      }),
      per * rows,
    );
    const M = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      p = new THREE.Vector3(),
      s = new THREE.Vector3(1, 1, 1);
    let k = 0;
    const cols = [0xe23b3b, 0xffd34d, 0x3fbfae, 0x3d7ad6, 0x8a4fd8, 0xff8a3c];
    for (let r = 0; r < rows; r++) {
      const z = 78 + r * 34;
      const span = 26; // between the two townhouse rows
      for (let i = 0; i < per; i++) {
        const u = (i + 0.5) / per;
        const x = -span / 2 + u * span;
        const sag = Math.sin(u * Math.PI) * 1.6;
        p.set(x, 6.4 - sag, z);
        q.setFromEuler(new THREE.Euler(0, 0, 0));
        M.compose(p, q, s);
        im.setMatrixAt(k, M);
        im.setColorAt(k, new THREE.Color(cols[(i + r) % cols.length]));
        k++;
      }
    }
    this.root.add(this._finalize(im));
  }

  // ------------------------------------------------------------------ diyas --
  _diyaFlameMaterial() {
    const m = new THREE.MeshBasicMaterial({
      color: 0xffca6a,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const uTime = this.timeUniform,
      uPulse = this.pulseUniform;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.uniforms.uPulse = uPulse;
      sh.vertexShader =
        `uniform float uTime;\nuniform float uPulse;\nvarying float vFlick;\n` +
        sh.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 ipos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          #else
            vec3 ipos = vec3(0.0);
          #endif
          float ph = ipos.x * 1.7 + ipos.z * 2.3;
          float flick = sin(uTime * 7.0 + ph) * 0.5 + sin(uTime * 13.0 + ph * 1.9) * 0.3;
          float sc = 1.0 + flick * 0.18 + uPulse * 0.9;
          transformed.y *= sc;
          transformed.x *= (1.0 + flick * 0.07);
          transformed.z *= (1.0 + flick * 0.07);
          vFlick = 0.72 + 0.28 * flick + uPulse;`,
        );
      sh.fragmentShader =
        `varying float vFlick;\n` +
        sh.fragmentShader.replace(
          "#include <tonemapping_fragment>",
          `gl_FragColor.rgb *= vFlick;\n#include <tonemapping_fragment>`,
        );
    };
    m.customProgramCacheKey = () => "nb-diya-flame";
    return m;
  }

  _diyaPositions() {
    const out = [];
    const ringAt = (cx, cz, rad, count, jitter = 0.4) => {
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        out.push({
          x: cx + Math.cos(a) * rad + this._rr(-jitter, jitter),
          z: cz + Math.sin(a) * rad + this._rr(-jitter, jitter),
        });
      }
    };
    // concentric rings around the central mandala / fountain
    ringAt(0, 0, 11, 20);
    ringAt(0, 0, 18, 30);
    ringAt(0, 0, 25, 40);
    ringAt(0, 0, 31, 48);
    // ceremonial bonfire ring + a small mandala there
    ringAt(-44, 44, 4.2, 16, 0.3);
    ringAt(-44, 44, 7.4, 24, 0.5);
    // shrine rings
    ringAt(40, 34, 9.2, 24, 0.6);
    ringAt(-40, 34, 9.2, 24, 0.6);
    // lamp rows lining the stone-paved festival street
    for (let z = 56; z <= 196; z += 6.5) {
      out.push({ x: -7.3 + this._rr(-0.2, 0.2), z });
      out.push({ x: 7.3 + this._rr(-0.2, 0.2), z });
    }
    return out;
  }

  _buildDiyas() {
    const pos = this._diyaPositions();
    const bowlGeo = new THREE.CylinderGeometry(0.15, 0.1, 0.12, 8);
    const bowlMat = new THREE.MeshLambertMaterial({
      color: 0x9a5a34,
      emissive: 0x2a1206,
    });
    const flameGeo = new THREE.ConeGeometry(0.055, 0.2, 6);
    const bowls = new THREE.InstancedMesh(bowlGeo, bowlMat, pos.length);
    const flames = new THREE.InstancedMesh(
      flameGeo,
      this._diyaFlameMaterial(),
      pos.length,
    );
    const M = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      p = new THREE.Vector3(),
      s = new THREE.Vector3();
    pos.forEach((d, i) => {
      const sc = this._rr(0.85, 1.15);
      q.setFromEuler(new THREE.Euler(0, this._rr(0, 6.28), 0));
      p.set(d.x, 0.06, d.z);
      s.set(sc, sc, sc);
      M.compose(p, q, s);
      bowls.setMatrixAt(i, M);
      p.set(d.x, 0.06 + 0.12 * sc + 0.09, d.z);
      M.compose(p, q, s);
      flames.setMatrixAt(i, M);
    });
    this.root.add(this._finalize(bowls));
    this.root.add(this._finalize(flames));
  }

  // ==================================== house / shop / temple decorations ===
  // Every residential house, shop, the beach bar, both pagoda temples and all
  // festival townhouses receive their own architecturally-aligned decorations:
  // roofline string lights, a colourful fairy string, marigold garlands over
  // the entrance, sill/step diyas and a small rangoli on the ground before the
  // door. Everything is instanced (a handful of draw calls total) and placed by
  // walking the real layout data, so no house is ever skipped.
  _bulbMaterial() {
    const m = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const uTime = this.timeUniform,
      uAmp = this.twkUniform;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.uniforms.uAmp = uAmp;
      sh.vertexShader =
        `uniform float uTime;\nuniform float uAmp;\nvarying float vFlick;\n` +
        sh.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          #else
            vec3 ip = vec3(0.0);
          #endif
          float ph = ip.x * 12.9 + ip.y * 5.3 + ip.z * 8.1;
          float sp = 1.3 + fract(sin(ph * 12.9898) * 43758.5453) * 2.7;
          float fl = 0.62 + 0.38 * sin(uTime * sp + ph);
          vFlick = mix(1.0, fl, uAmp);`,
        );
      sh.fragmentShader =
        `varying float vFlick;\n` +
        sh.fragmentShader.replace(
          "#include <tonemapping_fragment>",
          `gl_FragColor.rgb *= vFlick;\n#include <tonemapping_fragment>`,
        );
    };
    m.customProgramCacheKey = () => "nb-bulb-twinkle";
    return m;
  }

  // cycles the six rangoli patterns across every structure so neighbouring
  // entrances never repeat the same design (x/z coordinates are all multiples
  // of six, so a coordinate hash would collapse to a single variant)
  _rangoliVariant() {
    this._rangoliSeq = (this._rangoliSeq || 0) + 1;
    return (this._rangoliSeq * 5) % 6;
  }

  // traditional rangoli floor art — six distinct, hand-tuned patterns
  _rangoliTexture(variant) {
    this._rangoliTex ||= [];
    if (this._rangoliTex[variant]) return this._rangoliTex[variant];
    const S = 512;
    const c = this._canvas(S, S);
    const x = c.getContext("2d");
    x.translate(S / 2, S / 2);
    x.lineCap = "round";
    x.lineJoin = "round";
    const R = S / 2 - 16;
    const pals = [
      ["#ff4d4d", "#ff9d2e", "#ffd93d", "#ff7ab8", "#43d6c0", "#ffffff"],
      ["#ff8a3c", "#ffd36b", "#ff3d7f", "#8a5bff", "#3fd6d0", "#fff2c4"],
      ["#ff6b6b", "#ffb347", "#fff3a0", "#ff5ca8", "#6ee7d6", "#ffffff"],
      ["#e0569b", "#ffb02e", "#ffd93d", "#43d6c0", "#7a6bff", "#ffffff"],
      ["#ff5252", "#ffa53c", "#ffe066", "#ff7ab8", "#4fd6ff", "#ffffff"],
      ["#ff7043", "#ffca28", "#fff59d", "#ff4081", "#40c4ff", "#ffffff"],
    ];
    const pal = pals[variant % pals.length];
    const ring = (r, w, col, a = 1) => {
      x.globalAlpha = a;
      x.beginPath();
      x.arc(0, 0, r, 0, Math.PI * 2);
      x.lineWidth = w;
      x.strokeStyle = col;
      x.stroke();
    };
    const dots = (r, n, dr, col, a = 0.95, off = 0) => {
      x.globalAlpha = a;
      x.fillStyle = col;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + off;
        x.beginPath();
        x.arc(Math.cos(ang) * r, Math.sin(ang) * r, dr, 0, Math.PI * 2);
        x.fill();
      }
    };
    const petal = (len, wid, col, fillA, rot) => {
      x.save();
      x.rotate(rot);
      x.beginPath();
      x.moveTo(0, 0);
      x.quadraticCurveTo(wid, -len * 0.55, 0, -len);
      x.quadraticCurveTo(-wid, -len * 0.55, 0, 0);
      x.closePath();
      if (fillA) {
        x.globalAlpha = fillA;
        x.fillStyle = col;
        x.fill();
      }
      x.globalAlpha = 0.95;
      x.lineWidth = 3;
      x.strokeStyle = col;
      x.stroke();
      x.restore();
    };
    if (variant % 6 === 0) {
      // concentric rings with dotted rows
      for (let r = 0; r < 5; r++) {
        const rr = R * (0.22 + r * 0.185);
        ring(rr, 3.4, pal[r % pal.length], 0.9);
        dots(rr, 12 + r * 6, 3.4, pal[(r + 2) % pal.length], 0.85, r * 0.22);
      }
      ring(R * 0.12, 5, pal[5], 0.95);
    } else if (variant % 6 === 1) {
      // symmetrical geometric mandala (nested rotated squares)
      for (let i = 0; i < 4; i++) {
        x.save();
        x.rotate(Math.PI / 4 + (i * Math.PI) / 8);
        const s2 = R * (0.42 + i * 0.16);
        x.globalAlpha = 0.85;
        x.lineWidth = 3;
        x.strokeStyle = pal[i % pal.length];
        x.strokeRect(-s2, -s2, s2 * 2, s2 * 2);
        x.restore();
      }
      ring(R * 0.92, 3, pal[4], 0.75);
      dots(R * 0.92, 16, 4, pal[2]);
      for (let i = 0; i < 8; i++)
        petal(R * 0.3, R * 0.1, pal[i % pal.length], 0.25, (i * Math.PI) / 4);
    } else if (variant % 6 === 2) {
      // lotus — layered petals
      for (let lay = 0; lay < 3; lay++) {
        const n = 8 + lay * 4;
        for (let i = 0; i < n; i++) {
          petal(
            R * (0.9 - lay * 0.22),
            R * 0.15,
            pal[(lay + i) % pal.length],
            0.18,
            (i * Math.PI * 2) / n + lay * 0.2,
          );
        }
      }
      ring(R * 0.16, 4, pal[3], 0.9);
      dots(R * 0.5, 12, 3, pal[2]);
    } else if (variant % 6 === 3) {
      // eight-petal pinwheel flower
      for (let i = 0; i < 8; i++) {
        x.save();
        x.rotate((i * Math.PI) / 4);
        x.globalAlpha = 0.32;
        x.fillStyle = pal[i % pal.length];
        x.beginPath();
        x.ellipse(0, -R * 0.5, R * 0.16, R * 0.42, 0, 0, Math.PI * 2);
        x.fill();
        x.globalAlpha = 0.9;
        x.lineWidth = 2.5;
        x.strokeStyle = pal[(i + 3) % pal.length];
        x.stroke();
        x.restore();
      }
      ring(R * 0.92, 3, pal[1], 0.7);
      dots(R * 0.92, 24, 3, pal[4]);
    } else if (variant % 6 === 4) {
      // sunburst / star
      const spikes = 16;
      for (let i = 0; i < spikes; i++) {
        x.save();
        x.rotate((i * Math.PI * 2) / spikes);
        x.globalAlpha = 0.85;
        x.strokeStyle = pal[i % pal.length];
        x.lineWidth = 4;
        x.beginPath();
        x.moveTo(0, -R * 0.2);
        x.lineTo(0, -R * 0.92);
        x.stroke();
        x.restore();
      }
      ring(R * 0.22, 5, pal[5], 0.95);
      dots(R * 0.55, 18, 3.2, pal[3]);
      dots(R * 0.95, 20, 2.6, pal[0]);
    } else {
      // kolam — dotted loops with small blossoms
      for (let r = 0; r < 4; r++)
        dots(
          R * (0.25 + r * 0.2),
          8 + r * 4,
          2.6,
          pal[r % pal.length],
          0.85,
          r * 0.3,
        );
      for (let i = 0; i < 6; i++) {
        x.save();
        x.rotate((i * Math.PI) / 3);
        x.globalAlpha = 0.5;
        x.fillStyle = pal[(i + 1) % pal.length];
        x.beginPath();
        x.ellipse(0, -R * 0.62, R * 0.12, R * 0.2, 0, 0, Math.PI * 2);
        x.fill();
        x.restore();
      }
      ring(R * 0.95, 3, pal[2], 0.7);
      ring(R * 0.12, 4, pal[5], 0.95);
    }
    x.globalAlpha = 1;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    this._rangoliTex[variant] = t;
    return t;
  }

  _rangoli(x, z, r, variant, opacity = 0.95) {
    const mat = new THREE.MeshBasicMaterial({
      map: this._rangoliTexture(variant),
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 48), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.105, z);
    m.renderOrder = 2;
    m.frustumCulled = false;
    this.root.add(m);
    // warm diya light pooled onto the stone around the pattern
    this._rangoliGlowTex ||= this._softTexture(96, [
      [0, "rgba(255,196,120,0.55)"],
      [0.5, "rgba(255,150,70,0.16)"],
      [1, "rgba(255,120,40,0)"],
    ]);
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(r * 1.8, 32),
      new THREE.MeshBasicMaterial({
        map: this._rangoliGlowTex,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(x, 0.1, z);
    glow.renderOrder = 1;
    glow.frustumCulled = false;
    this.root.add(glow);
    return m;
  }

  // walk one building footprint and emit aligned decorations (local frame:
  // entrance faces +Z, rotated by ry into world space)
  _decorateStructure(d) {
    const cos = Math.cos(d.ry),
      sin = Math.sin(d.ry);
    const W = (lx, ly, lz) => [
      d.x + lx * cos + lz * sin,
      ly,
      d.z - lx * sin + lz * cos,
    ];
    const bulb = (lx, ly, lz, col) => {
      const [x, y, z] = W(lx, ly, lz);
      this._decoStrings.push({ x, y, z, col });
    };
    const line = (x0, y0, z0, x1, y1, z1, step, col) => {
      const dist = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
      const n = Math.max(1, Math.round(dist / step));
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        bulb(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, z0 + (z1 - z0) * u, col);
      }
    };
    const warm = () => this._pick(WARM_COLS);

    // roofline outline follows the real eave rectangle
    const ey = d.eaveY,
      ex = d.eaveX,
      ez = d.eaveZ;
    line(-ex, ey, ez, ex, ey, ez, 0.72, warm());
    line(-ex, ey, -ez, ex, ey, -ez, 0.72, warm());
    line(ex, ey, -ez, ex, ey, ez, 0.72, warm());
    line(-ex, ey, -ez, -ex, ey, ez, 0.72, warm());

    // doorframe
    if (d.door) {
      const { hw, top, z } = d.door;
      const zz = z + 0.12;
      line(-hw, 0.3, zz, -hw, top, zz, 0.42, warm());
      line(hw, 0.3, zz, hw, top, zz, 0.42, warm());
      line(-hw, top, zz, hw, top, zz, 0.42, warm());
      // marigold toran over the doorway
      const n = 16;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const lx = -hw - 0.18 + 2 * (hw + 0.18) * u;
        const y = top + 0.4 - Math.sin(Math.PI * u) * 0.55;
        const [gx, , gz] = W(lx, y, z + 0.32);
        this._decoGarland.push({ x: gx, y, z: gz, col: this._pick(MARIGOLD) });
      }
    }

    // window frames + sill diyas
    for (const w of d.windows) {
      const zz = d.frontZ + 0.12;
      const y0 = w.y - w.hh,
        y1 = w.y + w.hh;
      const x0 = w.x - w.hw,
        x1 = w.x + w.hw;
      line(x0, y0, zz, x1, y0, zz, 0.4, warm());
      line(x0, y1, zz, x1, y1, zz, 0.4, warm());
      line(x0, y0, zz, x0, y1, zz, 0.4, warm());
      line(x1, y0, zz, x1, y1, zz, 0.4, warm());
      if (d.sillDiyas !== false) {
        const [dx, , dz] = W(
          w.x + this._rr(-0.2, 0.2),
          y0 - 0.06,
          d.frontZ + 0.24,
        );
        this._decoDiyas.push({
          x: dx,
          y: y0 - 0.06,
          z: dz,
          sc: this._rr(0.7, 0.9),
        });
      }
    }

    // colourful fairy string slung across the facade
    if (d.fairy) {
      const span = d.fairy.span,
        z = d.frontZ + 0.4,
        n = Math.round(span * 4);
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const lx = -span + 2 * span * u;
        bulb(
          lx,
          d.fairy.y - Math.sin(Math.PI * u) * d.fairy.sag,
          z,
          this._pick(FAIRY_COLS),
        );
      }
    }
    // decorative carved band lights
    if (d.bandY) {
      line(
        -d.halfW,
        d.bandY,
        d.frontZ + 0.12,
        d.halfW,
        d.bandY,
        d.frontZ + 0.12,
        0.62,
        warm(),
      );
    }
    // shop awning edge lights + a marigold swag beneath
    if (d.awning) {
      const a = d.awning;
      line(-a.hw, a.y, a.z, a.hw, a.y, a.z, 0.5, this._pick(FAIRY_COLS));
      const n = 12;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const lx = -a.hw + 2 * a.hw * u;
        const y = a.y - 0.1 - Math.sin(Math.PI * u) * 0.42;
        const [gx, , gz] = W(lx, y, a.z + 0.05);
        this._decoGarland.push({ x: gx, y, z: gz, col: this._pick(MARIGOLD) });
      }
    }

    // entrance diyas on the step
    const stepZ = d.frontZ + 0.62;
    for (const sx of [-1.0, 1.0]) {
      if (d.entryDiyas === false) break;
      const [dx, , dz] = W(sx, 0.12, stepZ);
      this._decoDiyas.push({ x: dx, y: 0.12, z: dz, sc: this._rr(0.85, 1.05) });
    }

    // rangoli on the ground before the entrance (with its own ring of diyas)
    if (d.rangoli) {
      const [rx, , rz] = W(0, 0, d.rangoli.z);
      const variant = this._rangoliVariant();
      this._rangoli(rx, rz, d.rangoli.r, variant);
      const nd = 6;
      for (let i = 0; i < nd; i++) {
        const ang = (i / nd) * Math.PI * 2 + 0.4;
        this._decoDiyas.push({
          x: rx + Math.cos(ang) * d.rangoli.r * 0.98,
          y: 0.11,
          z: rz + Math.sin(ang) * d.rangoli.r * 0.98,
          sc: 0.62,
        });
      }
    }
  }

  _buildHouseDecor() {
    this.twkUniform.value = this.reduceMotion ? 0.3 : 1;

    // residential houses (door + windows + stone path face −Z in world)
    for (const plot of HOUSE_PLOTS) {
      this._decorateStructure({
        x: plot.x,
        z: plot.z,
        ry: plot.ry,
        halfW: 5,
        frontZ: 4,
        eaveY: 3.45,
        eaveX: 5.95,
        eaveZ: 4.85,
        door: { hw: 0.78, top: 2.62, z: 4.02 },
        windows: [
          { x: -3.1, y: 2.1, hw: 0.85, hh: 0.72 },
          { x: 3.1, y: 2.1, hw: 0.85, hh: 0.72 },
        ],
        fairy: { span: 4.2, y: 3.15, sag: 0.85 },
        rangoli: { z: 6.4, r: 1.7 },
      });
      this._clear(plot.x, plot.z - 5.4, 5.6);
    }

    // shops (facade faces +Z)
    for (const s of SHOPS) {
      this._decorateStructure({
        x: s.x,
        z: s.z,
        ry: 0,
        halfW: s.w / 2,
        frontZ: s.d / 2,
        eaveY: s.h - 0.15,
        eaveX: s.w / 2,
        eaveZ: s.d / 2,
        door: { hw: 1.1, top: 2.82, z: s.d / 2 },
        windows: [
          { x: -s.w * 0.27, y: 2.1, hw: s.w * 0.1, hh: 0.82 },
          { x: s.w * 0.27, y: 2.1, hw: s.w * 0.1, hh: 0.82 },
        ],
        fairy: { span: s.w * 0.42, y: s.h - 2.4, sag: 1.0 },
        awning: { hw: s.w * 0.3, y: s.h - 1.75, z: s.d / 2 + 1.42 },
        rangoli: { z: s.d / 2 + 3.6, r: 2.0 },
      });
      this._clear(s.x + s.w * 0.32 + 3.5, s.z + s.d / 2 + 3.4, 4.5);
    }

    // beach bar
    {
      const b = BEACH_BAR;
      this._decorateStructure({
        x: b.x,
        z: b.z,
        ry: b.ry || 0,
        halfW: 5,
        frontZ: 3,
        eaveY: 2.62,
        eaveX: 4.9,
        eaveZ: 2.9,
        windows: [],
        sillDiyas: false,
        entryDiyas: false,
        fairy: { span: 4.2, y: 2.5, sag: 0.7 },
        rangoli: { z: 6.6, r: 2.0 },
      });
      const cos = Math.cos(b.ry || 0),
        sin = Math.sin(b.ry || 0);
      const Wb = (lx, ly, lz) => [
        b.x + lx * cos + lz * sin,
        ly,
        b.z - lx * sin + lz * cos,
      ];
      // marigold swag across the counter
      for (let i = 0; i <= 16; i++) {
        const u = i / 16;
        const lx = -3.6 + 7.2 * u;
        const y = 2.35 - Math.sin(Math.PI * u) * 0.5;
        const [gx, , gz] = Wb(lx, y, 3.35);
        this._decoGarland.push({ x: gx, y, z: gz, col: this._pick(MARIGOLD) });
      }
      for (const sx of [-2.6, -0.9, 0.9, 2.6]) {
        const [dx, , dz] = Wb(sx, 1.4, 3.3);
        this._decoDiyas.push({ x: dx, y: 1.4, z: dz, sc: 0.8 });
      }
      this._clear(b.x, b.z + 8, 7);
    }

    // pagoda temples — outline every tier + entrance garland + plinth diyas
    for (const p of this.pagodas) {
      const cos = Math.cos(p.ry),
        sin = Math.sin(p.ry);
      const Wp = (lx, ly, lz) => [
        p.x + lx * cos + lz * sin,
        ly,
        p.z - lx * sin + lz * cos,
      ];
      const bulb = (lx, ly, lz, col) => {
        const [x, y, z] = Wp(lx, ly, lz);
        this._decoStrings.push({ x, y, z, col });
      };
      const line = (x0, y0, z0, x1, y1, z1, step, col) => {
        const dist = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
        const n = Math.max(1, Math.round(dist / step));
        for (let i = 0; i <= n; i++) {
          const u = i / n;
          bulb(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, z0 + (z1 - z0) * u, col);
        }
      };
      const warm = () => this._pick(WARM_COLS);
      for (let t = 0; t < 3; t++) {
        const rw = 7.6 - t * 1.05;
        const h = rw * 0.7071;
        const y = 1.05 + t * 2.55 + 2.3;
        line(-h, y, h, h, y, h, 0.7, warm());
        line(-h, y, -h, h, y, -h, 0.7, warm());
        line(h, y, -h, h, y, h, 0.7, warm());
        line(-h, y, -h, -h, y, h, 0.7, warm());
      }
      // crowning roof
      const ch = 4.4 * 0.7071,
        cy = 8.45;
      line(-ch, cy, ch, ch, cy, ch, 0.6, warm());
      line(-ch, cy, -ch, ch, cy, -ch, 0.6, warm());
      line(ch, cy, -ch, ch, cy, ch, 0.6, warm());
      line(-ch, cy, -ch, -ch, cy, ch, 0.6, warm());
      // garland over the entrance + a colourful string up the front
      for (let i = 0; i <= 18; i++) {
        const u = i / 18;
        const lx = -2.6 + 5.2 * u;
        const y = 3.35 - Math.sin(Math.PI * u) * 0.6;
        const [gx, , gz] = Wp(lx, y, 3.6);
        this._decoGarland.push({ x: gx, y, z: gz, col: this._pick(MARIGOLD) });
      }
      for (let i = 0; i <= 14; i++) {
        const u = i / 14;
        bulb(
          -2.4 + 4.8 * u,
          5.0 - Math.sin(Math.PI * u) * 0.9,
          3.75,
          this._pick(FAIRY_COLS),
        );
      }
      // diyas ringing the plinth and leading in
      for (let i = 0; i < 10; i++) {
        const ang = (i / 10) * Math.PI * 2;
        const [dx, , dz] = Wp(Math.cos(ang) * 4.3, 0.12, Math.sin(ang) * 4.3);
        this._decoDiyas.push({ x: dx, y: 0.12, z: dz, sc: 0.8 });
      }
      for (const lx of [-1.4, 1.4]) {
        const [dx, , dz] = Wp(lx, 0.12, 6.0);
        this._decoDiyas.push({ x: dx, y: 0.12, z: dz, sc: 0.9 });
      }
      // rangoli before the temple
      const [rx, , rz] = Wp(0, 0, 7.3);
      const variant = this._rangoliVariant();
      this._rangoli(rx, rz, 2.0, variant);
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + 0.3;
        this._decoDiyas.push({
          x: rx + Math.cos(ang) * 2.0,
          y: 0.11,
          z: rz + Math.sin(ang) * 2.0,
          sc: 0.6,
        });
      }
    }

    // festival townhouses
    for (const h of this._townhouses || []) {
      this._decorateStructure({
        x: h.x,
        z: h.z,
        ry: h.ry,
        halfW: 5,
        frontZ: 3.55,
        eaveY: 6.12,
        eaveX: 6.0,
        eaveZ: 5.3,
        door: { hw: 0.95, top: 2.74, z: 3.55 },
        windows: [
          { x: -2.7, y: 2.0, hw: 0.78, hh: 0.72 },
          { x: 2.7, y: 2.0, hw: 0.78, hh: 0.72 },
          { x: -2.7, y: 4.6, hw: 0.78, hh: 0.72 },
          { x: 2.7, y: 4.6, hw: 0.78, hh: 0.72 },
          { x: 0, y: 4.6, hw: 0.78, hh: 0.72 },
        ],
        bandY: 4.6,
        fairy: { span: 4.5, y: 5.5, sag: 0.9 },
        rangoli: { z: 6.0, r: 1.5 },
      });
      this._clear(h.x * 1.3, h.z, 8);
    }

    this._buildDecorMeshes();
  }

  _buildDecorMeshes() {
    const M = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      p = new THREE.Vector3(),
      s = new THREE.Vector3();
    const put = (im, i, x, y, z, sc, ry = 0) => {
      q.setFromEuler(new THREE.Euler(0, ry, 0));
      p.set(x, y, z);
      s.set(sc, sc, sc);
      M.compose(p, q, s);
      im.setMatrixAt(i, M);
    };

    // string / fairy bulbs — one draw call for the whole island
    const S = this._decoStrings;
    if (S.length) {
      const im = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.075, 6, 5),
        this._bulbMaterial(),
        S.length,
      );
      S.forEach((b, i) => {
        put(im, i, b.x, b.y, b.z, this._rr(0.85, 1.15), this._rr(0, 6.28));
        im.setColorAt(i, new THREE.Color(b.col));
      });
      this.root.add(this._finalize(im));
    }

    // marigold garlands — one draw call (unlit so the blossoms stay vivid at night)
    const G = this._decoGarland;
    if (G.length) {
      const gm = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        toneMapped: true,
      });
      const im = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.12, 6, 5),
        gm,
        G.length,
      );
      G.forEach((g, i) => {
        put(im, i, g.x, g.y, g.z, this._rr(0.85, 1.15), this._rr(0, 6.28));
        im.setColorAt(i, new THREE.Color(g.col));
      });
      this.root.add(this._finalize(im));
    }

    // diyas on sills, steps and around every rangoli (flames flicker)
    const D = this._decoDiyas;
    if (D.length) {
      const bowls = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.15, 0.1, 0.12, 8),
        new THREE.MeshLambertMaterial({ color: 0x9a5a34, emissive: 0x2a1206 }),
        D.length,
      );
      const flames = new THREE.InstancedMesh(
        new THREE.ConeGeometry(0.055, 0.2, 6),
        this._diyaFlameMaterial(),
        D.length,
      );
      D.forEach((d2, i) => {
        put(bowls, i, d2.x, d2.y, d2.z, d2.sc, this._rr(0, 6.28));
        put(
          flames,
          i,
          d2.x,
          d2.y + 0.12 * d2.sc + 0.09,
          d2.z,
          d2.sc,
          this._rr(0, 6.28),
        );
      });
      this.root.add(this._finalize(bowls));
      this.root.add(this._finalize(flames));

      // soft golden halo pooled over each diya (one draw call)
      const gp = new Float32Array(D.length * 3);
      D.forEach((d2, i) => {
        gp[i * 3] = d2.x;
        gp[i * 3 + 1] = d2.y + 0.16;
        gp[i * 3 + 2] = d2.z;
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(gp, 3));
      const pts = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          size: 0.85,
          map: this._softTexture(32, [
            [0, "rgba(255,214,150,0.9)"],
            [1, "rgba(255,140,50,0)"],
          ]),
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          sizeAttenuation: true,
        }),
      );
      pts.frustumCulled = false;
      this.root.add(pts);
    }
  }

  // ---------------------------------------------------------------- bonfire --
  _bonfireFlameMaterial() {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uTime: this.timeUniform, uFlare: { value: 0 } },
      vertexShader: `
        uniform float uTime; uniform float uFlare; varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 p = position;
          float w = 1.0 - uv.y;
          float sway = 1.0 + uFlare * 0.5;
          p.x += sin(uTime * 5.0 + uv.y * 7.0) * 0.18 * w * sway;
          p.z += cos(uTime * 4.3 + uv.y * 6.0) * 0.18 * w * sway;
          p.y *= 1.0 + uFlare * 0.35;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime; uniform float uFlare; varying vec2 vUv;
        void main() {
          float n = 0.65 + 0.35 * sin(vUv.y * 12.0 - uTime * 9.0) + 0.15 * sin(vUv.x * 14.0 + uTime * 5.0);
          vec3 c = mix(vec3(1.0, 0.28, 0.03), vec3(1.0, 0.72, 0.28), vUv.y);
          c = mix(c, vec3(1.0, 0.98, 0.85), pow(vUv.y, 3.0));
          float a = smoothstep(0.0, 0.2, vUv.y) * (1.0 - vUv.y) * n;
          a *= 0.8 + uFlare * 0.6;
          gl_FragColor = vec4(c * n, a);
        }`,
    });
  }

  _buildBonfire() {
    const bx = -44,
      bz = 44;
    this.bonfire = { x: bx, z: bz };
    const g = new THREE.Group();
    g.position.set(bx, 0, bz);
    this.root.add(g);
    // stone ring (single instanced draw call)
    const ringGeo = new THREE.BoxGeometry(0.5, 0.24, 0.5);
    const ringIM = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshLambertMaterial({ color: PAL.stone, emissive: 0x0a0a12 }),
      12,
    );
    {
      const M = new THREE.Matrix4(),
        q = new THREE.Quaternion(),
        p = new THREE.Vector3(),
        s = new THREE.Vector3(1, 1, 1);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        q.setFromEuler(new THREE.Euler(0, a, 0));
        p.set(bx + Math.cos(a) * 2.0, 0.12, bz + Math.sin(a) * 2.0);
        M.compose(p, q, s);
        ringIM.setMatrixAt(i, M);
      }
      this.root.add(this._finalize(ringIM));
    }
    // log pile
    const logMat = new THREE.MeshLambertMaterial({
      color: 0x3a2415,
      emissive: 0x2a0d02,
    });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const log = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.19, 2.4, 6),
        logMat,
      );
      log.position.set(Math.cos(a) * 0.35, 0.5, Math.sin(a) * 0.35);
      log.rotation.set(Math.PI / 2 - 0.5, a, 0.4);
      g.add(log);
    }
    // flame + core glow
    this.flameMat = this._bonfireFlameMaterial();
    this.flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.85, 2.7, 18, 3, true),
      this.flameMat,
    );
    this.flame.position.y = 1.5;
    g.add(this.flame);
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 12, 10),
      new THREE.MeshBasicMaterial({
        color: 0xff7a1e,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    core.position.y = 0.8;
    g.add(core);
    this.bonfireCore = core;
    // flickering light
    this.bonfireLight = new THREE.PointLight(0xff7c2e, 1.6, 46, 2);
    this.bonfireLight.position.set(bx, 2.6, bz);
    this.root.add(this.bonfireLight);

    // embers
    const EN = 90;
    const ep = new Float32Array(EN * 3),
      ec = new Float32Array(EN * 3);
    this.emberState = [];
    for (let i = 0; i < EN; i++) {
      this.emberState.push({
        x: this._rr(-1, 1),
        y: this._rr(0.5, 4),
        z: this._rr(-1, 1),
        vy: this._rr(0.6, 1.6),
        life: this._rr(0, 1.6),
      });
      ec[i * 3] = 1.0;
      ec[i * 3 + 1] = 0.45 + this._rr(0, 0.35);
      ec[i * 3 + 2] = 0.1;
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute("position", new THREE.BufferAttribute(ep, 3));
    eg.setAttribute("color", new THREE.BufferAttribute(ec, 3));
    this.embers = new THREE.Points(
      eg,
      new THREE.PointsMaterial({
        size: 0.5,
        map: this._softTexture(32, [
          [0, "rgba(255,220,170,1)"],
          [1, "rgba(255,120,0,0)"],
        ]),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    this.embers.position.set(bx, 0, bz);
    this.embers.frustumCulled = false;
    this.root.add(this.embers);

    this._clear(bx, bz, 16);
    this.world._addCollider({ type: "circle", x: bx, z: bz, r: 2.4 });
  }

  // --------------------------------------------------------------- lanterns --
  _buildLanterns() {
    const max = this.quality === "high" ? 70 : 44;
    this.lanternMax = max;
    const bodyGeo = new THREE.SphereGeometry(0.56, 8, 6);
    bodyGeo.scale(1, 1.2, 1);
    this.lanternBody = new THREE.InstancedMesh(
      bodyGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.96,
      }),
      max,
    );
    // soft camera-facing glow: a Points cloud (one draw call) reads as a round
    // halo, unlike a hollow sphere shell whose silhouette looks like a ring
    this.lanternBody.frustumCulled = false;
    this.lanternGlowGeo = new THREE.BufferGeometry();
    this.lanternGlowGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(max * 3), 3),
    );
    this.lanternGlowGeo.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(max * 3), 3),
    );
    // Fixed screen-space size (sizeAttenuation off): a distance-attenuated
    // point ballooned into a screen-filling orange wash whenever a lantern
    // drifted close to the camera, so we keep the halo a stable, tasteful size.
    this.lanternGlow = new THREE.Points(
      this.lanternGlowGeo,
      new THREE.PointsMaterial({
        size: 17,
        map: this._softTexture(32, [
          [0, "rgba(255,200,130,1)"],
          [0.4, "rgba(255,150,60,0.5)"],
          [1, "rgba(255,120,0,0)"],
        ]),
        vertexColors: true,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: false,
      }),
    );
    this.lanternGlow.frustumCulled = false;
    this.lanternGlow.renderOrder = 4;
    this.lanterns = [];
    for (let i = 0; i < max; i++) {
      this.lanterns.push(this._newLantern(true));
      this.lanternBody.setColorAt(
        i,
        new THREE.Color(this._pick([0xffd08a, 0xffb45e, 0xffe6a8, 0xff9a52])),
      );
    }
    if (this.lanternBody.instanceColor)
      this.lanternBody.instanceColor.needsUpdate = true;
    {
      const gc = this.lanternGlowGeo.attributes.color.array;
      for (let i = 0; i < max; i++) {
        gc[i * 3] = 1.0;
        gc[i * 3 + 1] = 0.72;
        gc[i * 3 + 2] = 0.45;
      }
      this.lanternGlowGeo.attributes.color.needsUpdate = true;
    }
    this.root.add(this.lanternBody);
    this.root.add(this.lanternGlow);
    // two travelling lights for the nearest lanterns
    this.lanternLights = [];
    for (let i = 0; i < 2; i++) {
      const pl = new THREE.PointLight(0xffb464, 0.0, 24, 2);
      this.root.add(pl);
      this.lanternLights.push(pl);
    }
  }

  _newLantern(spread) {
    const a = this._rr(0, Math.PI * 2);
    const r = this._rr(14, 78);
    return {
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      y: spread ? this._rr(0, 90) : this._rr(-2, 1),
      vy: this._rr(1.1, 2.0),
      phase: this._rr(0, 6.28),
      sway: this._rr(0.4, 1.3),
      sc: this._rr(0.7, 1.15),
    };
  }

  // ------------------------------------------------------------------ crowd --
  _buildCrowd() {
    const max = this.quality === "high" ? 60 : 36;
    this.crowdMax = max;
    this.crowdRobe = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.44, 1.06, 8),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      max,
    );
    this.crowdTorso = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.15, 0.2, 0.52, 8),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      max,
    );
    this.crowdHead = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.22, 8, 6),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      max,
    );
    for (const im of [this.crowdRobe, this.crowdTorso, this.crowdHead])
      im.frustumCulled = false;

    this.crowd = [];
    for (let i = 0; i < max; i++) {
      const kind = i < max * 0.62 ? "stroll" : "gather";
      const p = { kind, phase: this._rr(0, 6.28), sc: this._rr(0.9, 1.12) };
      if (kind === "stroll") {
        const side = i % 2 ? 1 : -1;
        p.x = side * this._rr(9.5, 13.5);
        p.z = this._rr(58, 194);
        p.dir = this.rand() < 0.5 ? 1 : -1;
        p.speed = this._rr(0.5, 1.1);
      } else {
        const nearFire = this.rand() < 0.4;
        if (nearFire) {
          p.cx = -44;
          p.cz = 44;
          p.rad = this._rr(3.6, 6.6);
        } else {
          p.cx = 0;
          p.cz = 0;
          p.rad = this._rr(12, 30);
        }
        p.ang = this._rr(0, 6.28);
        p.spin = this._rr(-0.25, 0.25);
      }
      this.crowd.push(p);
      this.crowdRobe.setColorAt(i, new THREE.Color(this._pick(CLOTHES)));
      this.crowdTorso.setColorAt(i, new THREE.Color(this._pick(CLOTHES)));
      this.crowdHead.setColorAt(i, new THREE.Color(this._pick(SKINS)));
    }
    for (const im of [this.crowdRobe, this.crowdTorso, this.crowdHead]) {
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    this.root.add(this.crowdRobe, this.crowdTorso, this.crowdHead);
    this._crowdM = new THREE.Matrix4();
    this._crowdQ = new THREE.Quaternion();
    this._crowdP = new THREE.Vector3();
    this._crowdS = new THREE.Vector3();
  }

  // -------------------------------------------------------------- fireworks --
  _buildFireworks() {
    const max = this.quality === "high" ? 2600 : 1300;
    this.fwMax = max;
    this.fwNext = 0;
    this.fwVel = new Float32Array(max * 3);
    this.fwBase = new Float32Array(max * 3);
    this.fwLife = new Float32Array(max);
    this.fwMaxLife = new Float32Array(max);
    this.fwGrav = new Float32Array(max).fill(1); // per-particle gravity scale
    const pos = new Float32Array(max * 3);
    const col = new Float32Array(max * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.fwPoints = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size: 5.0,
        map: this._softTexture(32, [
          [0, "rgba(255,255,255,1)"],
          [0.4, "rgba(255,255,255,0.5)"],
          [1, "rgba(255,255,255,0)"],
        ]),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        // burning stars glow through the night haze — without this the scene
        // fog (150→1100) fades every distant sky burst into the backdrop
        fog: false,
      }),
    );
    this.fwPoints.frustumCulled = false;
    this.root.add(this.fwPoints);

    this.fwLight = new THREE.PointLight(0xffd0a0, 0, 320, 1.2);
    this.fwLight.position.set(0, 70, 0);
    this.root.add(this.fwLight);

    // small warm light that tracks the nearest active ground cracker
    this.sparkLight = new THREE.PointLight(0xffa95e, 0, 20, 2);
    this.sparkLight.position.set(0, 1.2, 0);
    this.root.add(this.sparkLight);

    this.rockets = [];
    this.nextBurst = 1.2;
    this.fwFlash = 0;
    this.sparkFlash = 0;
    this.fwColors = [
      [1.0, 0.35, 0.7],
      [0.7, 0.4, 1.0],
      [1.0, 0.8, 0.3],
      [0.4, 0.9, 1.0],
      [1.0, 0.55, 0.2],
      [0.95, 0.95, 1.0],
    ];
    // warm, saturated palette shared by the ground crackers — iron filings
    // burn gold, so the shower reads champagne/amber/copper with rare
    // white-hot flashes instead of a toy rainbow
    this.sparkCols = [
      [1.0, 0.78, 0.32], // classic gold
      [1.0, 0.62, 0.2], // amber
      [1.0, 0.45, 0.14], // copper orange
      [1.0, 0.92, 0.7], // champagne
      [1.0, 0.98, 0.9], // white-hot flash
      [1.0, 0.55, 0.3], // warm coral
    ];
    // aerial patterns: each has its own motion signature (see _fwBurst)
    this.fwTypes = [
      "chrysanthemum",
      "peony",
      "starburst",
      "willow",
      "ring",
      "palm",
    ];
  }

  _fwSet(idx, x, y, z, r, g, b) {
    const p = this.fwPoints.geometry.attributes.position.array;
    const c = this.fwPoints.geometry.attributes.color.array;
    p[idx * 3] = x;
    p[idx * 3 + 1] = y;
    p[idx * 3 + 2] = z;
    c[idx * 3] = r;
    c[idx * 3 + 1] = g;
    c[idx * 3 + 2] = b;
  }

  // spawn one spark into the shared additive pool
  _spark(x, y, z, vx, vy, vz, r, g, b, life, grav = 1) {
    const idx = this.fwNext++ % this.fwMax;
    const i3 = idx * 3;
    const p = this.fwPoints.geometry.attributes.position.array;
    p[i3] = x;
    p[i3 + 1] = y;
    p[i3 + 2] = z;
    this.fwVel[i3] = vx;
    this.fwVel[i3 + 1] = vy;
    this.fwVel[i3 + 2] = vz;
    this.fwBase[i3] = r;
    this.fwBase[i3 + 1] = g;
    this.fwBase[i3 + 2] = b;
    this.fwLife[idx] = life;
    this.fwMaxLife[idx] = life;
    this.fwGrav[idx] = grav;
    if (this.fwBounce) this.fwBounce[idx] = 0;
  }

  // Aerial shots — several distinct patterns so no two bursts look alike.
  _fwBurst(x, y, z, col, type) {
    const hi = this.quality === "high";
    type = type || this._pick(this.fwTypes);
    const k = hi ? 1 : 0.8;
    const push = (vx, vy, vz, life, tint, grav) => {
      const r = col[0] * tint,
        g = col[1] * tint,
        b = col[2] * tint;
      this._spark(x, y, z, vx, vy, vz, r, g, b, life, grav);
      return { vx, vy, vz, life, tint, grav };
    };
    const n = this._rr(0.8, 1.2);
    if (type === "chrysanthemum") {
      const count = Math.round((150 + this.rand() * 60) * k * n);
      for (let i = 0; i < count; i++) {
        const u = this.rand() * 2 - 1,
          th = this.rand() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u),
          sp = this._rr(8, 17);
        push(
          Math.cos(th) * s * sp,
          u * sp,
          Math.sin(th) * s * sp,
          this._rr(1.6, 2.6),
          this._rr(0.68, 1.0),
          0.8,
        );
      }
      // golden inner core + heavier trailing fringe = the classic chrysanthemum
      for (let i = 0; i < count * 0.5; i++) {
        const u = this.rand() * 2 - 1,
          th = this.rand() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u),
          sp = this._rr(4, 9);
        push(
          Math.cos(th) * s * sp,
          u * sp,
          Math.sin(th) * s * sp,
          this._rr(1.1, 1.9),
          0.9,
          1.15,
        );
      }
    } else if (type === "peony") {
      const count = Math.round((130 + this.rand() * 50) * k * n);
      for (let i = 0; i < count; i++) {
        const u = this.rand() * 2 - 1,
          th = this.rand() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u),
          sp = this._rr(11, 20);
        push(
          Math.cos(th) * s * sp,
          u * sp,
          Math.sin(th) * s * sp,
          this._rr(1.1, 1.8),
          this._rr(0.8, 1.05),
          1.05,
        );
      }
    } else if (type === "starburst") {
      const rays = 14 + ((this.rand() * 8) | 0);
      const per = Math.max(3, Math.round(7 * k * n));
      for (let r = 0; r < rays; r++) {
        const u = this.rand() * 2 - 1,
          th = this.rand() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const dx = Math.cos(th) * s,
          dy = u,
          dz = Math.sin(th) * s;
        const sp = this._rr(17, 30);
        for (let j = 0; j < per; j++) {
          const jj = sp * (0.45 + (j / per) * 0.75);
          push(
            dx * jj,
            dy * jj,
            dz * jj,
            this._rr(0.9, 1.6),
            this._rr(0.75, 1.05),
            1.1,
          );
        }
      }
    } else if (type === "willow") {
      const count = Math.round((120 + this.rand() * 40) * k * n);
      for (let i = 0; i < count; i++) {
        const u = Math.abs(this.rand() * 2 - 1) * 0.6 + 0.4; // upper-biased
        const th = this.rand() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u),
          sp = this._rr(5, 12);
        push(
          Math.cos(th) * s * sp,
          u * sp,
          Math.sin(th) * s * sp,
          this._rr(2.4, 3.6),
          this._rr(0.7, 1.0),
          1.7,
        );
      }
    } else if (type === "ring") {
      const count = Math.round((120 + this.rand() * 30) * k * n);
      const tilt = this._rr(-0.5, 0.5),
        yaw = this._rr(0, Math.PI * 2);
      const ct = Math.cos(tilt),
        st = Math.sin(tilt),
        cy = Math.cos(yaw),
        sy = Math.sin(yaw);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + this._rr(-0.05, 0.05);
        const sp = this._rr(13, 17) * (0.85 + this._rr(0, 0.3));
        // ring in a plane, then tilt + yaw
        let dx = Math.cos(a) * sp,
          dy = Math.sin(a) * sp * ct,
          dz = Math.sin(a) * sp * st;
        const rx = dx * cy - dz * sy,
          rz = dx * sy + dz * cy;
        push(rx, dy, rz, this._rr(1.3, 2.1), this._rr(0.8, 1.05), 1.05);
      }
    } else {
      // palm — a few thick rising fronds
      const fronds = 9 + ((this.rand() * 4) | 0);
      const per = Math.max(3, Math.round(8 * k * n));
      for (let r = 0; r < fronds; r++) {
        const th = this.rand() * Math.PI * 2,
          el = this._rr(0.35, 1.15);
        const dx = Math.cos(th) * Math.cos(el),
          dy = Math.sin(el),
          dz = Math.sin(th) * Math.cos(el);
        const sp = this._rr(14, 22);
        for (let j = 0; j < per; j++) {
          const jj = sp * (1 - j / (per * 1.6));
          push(
            dx * jj,
            dy * jj,
            dz * jj,
            this._rr(1.4, 2.4),
            this._rr(0.8, 1.05),
            1.35,
          );
        }
      }
    }
    this.fwLight.position.set(x, y, z);
    this.fwFlash = 1;
  }

  _aerialShot() {
    const a = this._rr(0, Math.PI * 2),
      // well clear of the plaza cracker ring: 5-unit additive sparks look
      // enormous and white-out the view when a burst happens near the camera
      r = this._rr(55, 160);
    const x = Math.cos(a) * r,
      z = Math.sin(a) * r;
    const y = this._rr(46, 96);
    this._fwBurst(x, y, z, this._pick(this.fwColors), this._pick(this.fwTypes));
  }

  _launchRocket() {
    const a = this._rr(0, Math.PI * 2);
    // keep launches outside the plaza so their smoke trails never pour
    // across the cracker ring at map centre
    const r = this._rr(50, 150);
    const x = Math.cos(a) * r,
      z = Math.sin(a) * r;
    const idx = this.fwNext++ % this.fwMax;
    this.rockets.push({
      idx,
      x,
      y: 1.5,
      z,
      vy: this._rr(30, 46),
      fuse: this._rr(1.0, 1.9),
      acc: 0,
      // ~40% of ambient rockets crackle once mid-climb before the main bloom
      dbl: this.rand() < 0.4,
      broke: false,
      col: this._pick(this.fwColors),
      type: this._pick(this.fwTypes),
    });
    this.fwLife[idx] = 2;
    this.fwMaxLife[idx] = 2;
    this.fwGrav[idx] = 0;
    this.fwBase[idx * 3] = 1.0;
    this.fwBase[idx * 3 + 1] = 0.86;
    this.fwBase[idx * 3 + 2] = 0.62;
    this._fwSet(idx, x, 1.5, z, 1.0, 0.86, 0.62);
  }

  _updateFireworks(dt) {
    const hi = this.quality === "high";
    // rockets rise on a spark + smoke trail, then burst at altitude
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const rk = this.rockets[i];
      const py = rk.y,
        px = rk.x,
        pz = rk.z;
      rk.x += (rk.vx || 0) * dt;
      rk.z += (rk.vz || 0) * dt;
      rk.y += rk.vy * dt;
      rk.vy -= 7 * dt;
      rk.fuse -= dt;
      if (rk.player) {
        // local player: hide the sky-sized head sprite and use a tight cluster
        // of small sparks so the rocket does not become a giant white blob
        this.fwLife[rk.idx] = 0;
        for (let s = 0; s < 2; s++) {
          this._pfxSpark(
            rk.x + this._rr(-0.05, 0.05),
            rk.y + this._rr(-0.05, 0.05),
            rk.z + this._rr(-0.05, 0.05),
            this._rr(-0.4, 0.4),
            this._rr(-0.6, 0.6),
            this._rr(-0.4, 0.4),
            1.0,
            0.88,
            0.62,
            0.1,
            0.2,
          );
        }
      } else {
        this.fwLife[rk.idx] = 0.14;
        this._fwSet(rk.idx, rk.x, rk.y, rk.z, 1.0, 0.86, 0.62);
      }
      // trail sparks
      rk.acc += dt * (hi ? 46 : 30);
      while (rk.acc >= 1) {
        rk.acc -= 1;
        const t = this._rr(0.2, 0.7);
        const tx = rk.x - (rk.x - px) * t,
          ty = rk.y - (rk.y - py) * t,
          tz = rk.z - (rk.z - pz) * t;
        if (rk.player) {
          this._pfxSpark(
            tx,
            ty,
            tz,
            this._rr(-0.8, 0.8),
            -this._rr(1, 5),
            this._rr(-0.8, 0.8),
            1.0,
            0.62 + this._rr(0, 0.3),
            0.24,
            this._rr(0.3, 0.6),
            1.1,
          );
        } else {
          this._spark(
            tx,
            ty,
            tz,
            this._rr(-0.8, 0.8),
            -this._rr(1, 5),
            this._rr(-0.8, 0.8),
            1.0,
            0.62 + this._rr(0, 0.3),
            0.24,
            this._rr(0.3, 0.6),
            1.1,
          );
        }
      }
      if (rk.fuse <= 0) {
        // double-break rocket: a small crackle pop on the way up, then the
        // shell keeps climbing a beat before the main bloom opens
        if (rk.dbl && !rk.broke) {
          rk.broke = true;
          for (let s = 0; s < 46; s++) {
            const u = this.rand() * 2 - 1,
              th = this.rand() * Math.PI * 2;
            const sq = Math.sqrt(1 - u * u),
              sp = this._rr(5, 10);
            this._spark(
              rk.x,
              rk.y,
              rk.z,
              Math.cos(th) * sq * sp,
              u * sp,
              Math.sin(th) * sq * sp,
              1.0,
              0.9,
              0.72,
              this._rr(0.5, 0.9),
              1.1,
            );
          }
          rk.fuse = this._rr(0.32, 0.5);
          rk.vy *= 0.92;
          continue;
        }
        if (rk.player)
          this.lastPlayerBurst = { x: rk.x, y: rk.y, z: rk.z, t: this.time };
        this._fwBurst(rk.x, rk.y, rk.z, rk.col, rk.type);
        if (rk.bought) this._burstFlash(rk.x, rk.y, rk.z, rk.col);
        this.fwLife[rk.idx] = 0;
        this.rockets.splice(i, 1);
      }
    }
    // schedule the show — rockets and direct aerial shots at varied heights.
    // Denser than before: a full festival sky, with a burst roughly every
    // 1.5 s and occasional triple salvos (pool budget stays ~1/3 used).
    this.nextBurst -= dt;
    if (this.nextBurst <= 0) {
      this.nextBurst = this._rr(0.9, 2.2) * (this.reduceMotion ? 1.6 : 1);
      for (let s = 0; s < 2; s++) {
        if (this.rand() < 0.55) this._launchRocket();
        else this._aerialShot();
      }
      if (hi && !this.reduceMotion && this.rand() < 0.4) {
        if (this.rand() < 0.5) this._launchRocket();
        else this._aerialShot();
      }
    }
    // integrate sparks
    const p = this.fwPoints.geometry.attributes.position.array;
    const c = this.fwPoints.geometry.attributes.color.array;
    const drag = Math.exp(-dt * 0.9);
    for (let i = 0; i < this.fwMax; i++) {
      if (this.fwLife[i] <= 0) {
        c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = 0;
        continue;
      }
      this.fwLife[i] -= dt;
      if (this.fwLife[i] <= 0) {
        c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = 0;
        continue;
      }
      const i3 = i * 3;
      this.fwVel[i3 + 1] -= 7.5 * this.fwGrav[i] * dt;
      this.fwVel[i3] *= drag;
      this.fwVel[i3 + 1] *= drag;
      this.fwVel[i3 + 2] *= drag;
      p[i3] += this.fwVel[i3] * dt;
      p[i3 + 1] += this.fwVel[i3 + 1] * dt;
      p[i3 + 2] += this.fwVel[i3 + 2] * dt;
      // ground collision: a spark that falls onto the stone goes out instead of
      // sinking through the plaza (real fireworks bounce once, then die)
      if (p[i3 + 1] < 0.06 && this.fwVel[i3 + 1] < 0) {
        if (this.fwBounce?.[i]) {
          this.fwLife[i] = 0;
          c[i3] = c[i3 + 1] = c[i3 + 2] = 0;
          continue;
        }
        p[i3 + 1] = 0.06;
        this.fwVel[i3 + 1] *= -0.32;
        this.fwVel[i3] *= 0.65;
        this.fwVel[i3 + 2] *= 0.65;
        (this.fwBounce ||= new Uint8Array(this.fwMax))[i] = 1;
      }
      const t01 = this.fwLife[i] / this.fwMaxLife[i];
      // white-hot ignition flash in the first instants, then the true colour
      const f = Math.min(1, t01 * 2.4) * (t01 > 0.88 ? 1.5 : 1);
      c[i3] = this.fwBase[i3] * f;
      c[i3 + 1] = this.fwBase[i3 + 1] * f;
      c[i3 + 2] = this.fwBase[i3 + 2] * f;
    }
    this.fwPoints.geometry.attributes.position.needsUpdate = true;
    this.fwPoints.geometry.attributes.color.needsUpdate = true;
    // flash lights decay
    this.fwFlash = Math.max(0, this.fwFlash - dt * 3.2);
    this.fwLight.intensity = this.fwFlash * 3.4;
    this.sparkFlash = Math.max(0, this.sparkFlash - dt * 4.5);
    this.sparkLight.intensity = this.sparkFlash * 2.4;
  }

  // ------------------------------------------------------------------- smoke --
  // A second Points pool (normal blending) for the soft grey puffs that trail
  // behind rockets and rise off the ground crackers. Instead of a custom
  // shader, each puff's vertex colour is lerped toward the night-sky tone as it
  // ages, so it dissolves seamlessly into the backdrop.
  _buildSmoke() {
    const max = this.quality === "high" ? 260 : 140;
    this.smokeMax = max;
    this.smokeNext = 0;
    this.smokeVel = new Float32Array(max * 3);
    this.smokeBase = new Float32Array(max * 3);
    this.smokeLife = new Float32Array(max);
    this.smokeMaxLife = new Float32Array(max);
    const pos = new Float32Array(max * 3);
    const col = new Float32Array(max * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.smokePoints = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size: 2.4,
        map: this._softTexture(64, [
          [0, "rgba(196,192,212,0.7)"],
          [0.45, "rgba(148,146,178,0.28)"],
          [1, "rgba(120,120,150,0)"],
        ]),
        vertexColors: true,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        blending: THREE.NormalBlending,
        sizeAttenuation: true,
      }),
    );
    this.smokePoints.frustumCulled = false;
    this.root.add(this.smokePoints);
    this._smokeNight = new THREE.Color(0x1a1738); // colour a puff fades into
  }

  _puff(x, y, z, spread = 0.6, life = 2, bright = 0.5) {
    if (!this.smokePoints) return;
    const idx = this.smokeNext++ % this.smokeMax;
    const i3 = idx * 3;
    const p = this.smokePoints.geometry.attributes.position.array;
    p[i3] = x + this._rr(-spread, spread);
    p[i3 + 1] = y + this._rr(-spread * 0.4, spread * 0.4);
    p[i3 + 2] = z + this._rr(-spread, spread);
    this.smokeVel[i3] = this._rr(-spread, spread) * 0.8;
    this.smokeVel[i3 + 1] = this._rr(0.5, 1.6);
    this.smokeVel[i3 + 2] = this._rr(-spread, spread) * 0.8;
    const grey = 0.38 + Math.min(0.5, bright) * 0.3;
    this.smokeBase[i3] = grey * 0.94;
    this.smokeBase[i3 + 1] = grey * 0.94;
    this.smokeBase[i3 + 2] = grey;
    this.smokeLife[idx] = life;
    this.smokeMaxLife[idx] = life;
  }

  _updateSmoke(dt) {
    if (!this.smokePoints) return;
    const p = this.smokePoints.geometry.attributes.position.array;
    const c = this.smokePoints.geometry.attributes.color.array;
    const night = this._smokeNight;
    const drag = Math.exp(-dt * 0.55);
    for (let i = 0; i < this.smokeMax; i++) {
      if (this.smokeLife[i] <= 0) {
        c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = 0;
        continue;
      }
      this.smokeLife[i] -= dt;
      if (this.smokeLife[i] <= 0) {
        c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = 0;
        continue;
      }
      const i3 = i * 3;
      this.smokeVel[i3 + 1] += 0.4 * dt; // gentle buoyancy
      this.smokeVel[i3] *= drag;
      this.smokeVel[i3 + 1] *= drag;
      this.smokeVel[i3 + 2] *= drag;
      p[i3] += this.smokeVel[i3] * dt;
      p[i3 + 1] += this.smokeVel[i3 + 1] * dt;
      p[i3 + 2] += this.smokeVel[i3 + 2] * dt;
      const fade = smoothstep(
        0.05,
        1.0,
        1 - this.smokeLife[i] / this.smokeMaxLife[i],
      );
      c[i3] = this.smokeBase[i3] * (1 - fade) + night.r * fade;
      c[i3 + 1] = this.smokeBase[i3 + 1] * (1 - fade) + night.g * fade;
      c[i3 + 2] = this.smokeBase[i3 + 2] * (1 - fade) + night.b * fade;
    }
    this.smokePoints.geometry.attributes.position.needsUpdate = true;
    this.smokePoints.geometry.attributes.color.needsUpdate = true;
  }

  // --------------------------------------------------- ground firecrackers ---
  // Anar (spark fountain), Chakri (ground spinner) and Phuljhadi (handheld
  // sparkler) get real little prop meshes placed around the plaza; all of their
  // sparks are emitted into the shared additive pool so there is only ever one
  // draw call for every spark in the scene.
  _buildCrackers() {
    this.crackers = [];
    this._crackerV = new THREE.Vector3();
    this._axisY = new THREE.Vector3(0, 1, 0);
    // [type, x, z] — displayed in a fan around the fountain at the exact centre
    // of the map (plaza origin), on the clear band between the inner diya ring
    // (r 11) and the next (r 18); the four cardinal approaches stay open.
    const spots = [
      ["anar", 11.1, 6.4],
      ["anar", -11.1, 6.4],
      ["anar", 0, -12.8],
      ["chakri", 0, 12.8],
      ["chakri", -11.1, -6.4],
      ["chakri", 11.1, -6.4],
      ["phuljhadi", -6.7, 11.6],
      ["phuljhadi", -6.7, -11.6],
    ];
    const clayMat = new THREE.MeshLambertMaterial({
      color: 0xa1542e,
      emissive: 0x200b04,
    });
    const goldMat = new THREE.MeshLambertMaterial({
      color: 0xd8a24a,
      emissive: 0x3a2405,
    });
    const discMat = new THREE.MeshLambertMaterial({
      color: 0x7a4426,
      emissive: 0x1c0c04,
    });
    const stickMat = new THREE.MeshLambertMaterial({ color: 0x9a8a68 });
    const handMat = new THREE.MeshLambertMaterial({ color: 0xe6a774 });

    for (const [type, x, z] of spots) {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      g.rotation.y = this._rr(0, Math.PI * 2);
      const glow = new THREE.MeshBasicMaterial({
        color: 0xffd28a,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const c = {
        type,
        x,
        z,
        group: g,
        glow,
        t: this._rr(0, 8),
        on: true,
        onDur: this._rr(5.4, 6.2), // ~7 s burn -> short dark cooldown
        offDur: this._rr(0.8, 1.4),
        acc: 0,
        flash: 0,
        phase: this._rr(0, 6.28),
        angle: this._rr(0, 6.28),
        spin: this._rr(9, 15),
      };
      if (type === "anar") {
        const cone = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.36, 0.56, 12),
          clayMat,
        );
        cone.position.y = 0.28;
        g.add(cone);
        const band = new THREE.Mesh(
          new THREE.CylinderGeometry(0.2, 0.26, 0.1, 12),
          goldMat,
        );
        band.position.y = 0.44;
        g.add(band);
        const vent = new THREE.Mesh(
          new THREE.SphereGeometry(0.115, 8, 6),
          glow,
        );
        vent.position.y = 0.53;
        g.add(vent);
        c.tip = vent;
        c.rate = this.quality === "high" ? 132 : 78;
      } else if (type === "chakri") {
        const spinner = new THREE.Group();
        spinner.position.y = 0.07;
        g.add(spinner);
        const disc = new THREE.Mesh(
          new THREE.CylinderGeometry(0.32, 0.32, 0.07, 18),
          discMat,
        );
        spinner.add(disc);
        const rim = new THREE.Mesh(
          new THREE.TorusGeometry(0.33, 0.055, 6, 20),
          glow,
        );
        rim.rotation.x = Math.PI / 2;
        spinner.add(rim);
        c.spinner = spinner;
        c.rate = this.quality === "high" ? 110 : 66;
      } else {
        const hand = new THREE.Mesh(
          new THREE.SphereGeometry(0.13, 8, 6),
          handMat,
        );
        hand.position.y = 0.12;
        g.add(hand);
        const holder = new THREE.Group();
        holder.position.y = 0.16;
        g.add(holder);
        const stick = new THREE.Mesh(
          new THREE.CylinderGeometry(0.028, 0.03, 1.15, 6),
          stickMat,
        );
        stick.position.y = 0.57;
        holder.add(stick);
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6), glow);
        tip.position.y = 1.16;
        holder.add(tip);
        const halo = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), glow);
        halo.position.y = 1.16;
        holder.add(halo);
        c.holder = holder;
        c.tip = tip;
        c.halo = halo;
        c.rate = this.quality === "high" ? 88 : 55;
      }
      this.root.add(g);
      this._clear(x, z, 2.4);
      this.crackers.push(c);
    }
  }

  _updateCrackers(dt) {
    const list = this.crackers;
    if (!list || !list.length) return;
    const rateF = this.reduceMotion ? 0.5 : 1;
    const v = this._crackerV;
    const axisY = this._axisY;
    let bestE = 0,
      bestC = -1;

    for (let ci = 0; ci < list.length; ci++) {
      const c = list[ci];
      c.t += dt;
      // ~7 s active burn, then a brief cooldown before re-lighting
      if (c.on) {
        if (c.t >= c.onDur) {
          c.on = false;
          c.t = 0;
          c.onDur = this._rr(5.4, 6.2);
        }
      } else if (c.t >= c.offDur) {
        c.on = true;
        c.t = 0;
        c.offDur = this._rr(0.8, 1.4);
      }
      c.flash = Math.max(0, c.flash - dt * 2.6);

      if (!c.on) {
        if (c.glow)
          c.glow.opacity += (0.12 - c.glow.opacity) * Math.min(1, dt * 5);
        if (c.type === "chakri") c.spinner.rotation.y += c.spin * 0.15 * dt;
        continue;
      }
      c.acc += c.rate * rateF * dt;
      let energy = 1;

      if (c.type === "anar") {
        c.glow.opacity = 0.45 + 0.25 * Math.sin(this.time * 24 + c.phase);
        while (c.acc >= 1) {
          c.acc -= 1;
          const col = this._pick(this.sparkCols);
          const a = this.rand() * Math.PI * 2;
          const sp = this._rr(0.3, 2.6); // thin sideways scatter
          this._pfxSpark(
            c.x + Math.cos(a) * 0.04,
            0.53 + this._rr(-0.02, 0.07),
            c.z + Math.sin(a) * 0.04,
            Math.cos(a) * sp,
            this._rr(2.6, 6.5), // spray reaches 0.5-2.8 m
            Math.sin(a) * sp,
            col[0],
            col[1],
            col[2],
            this._rr(0.55, 1.3), // falls back while still lit
            0.95,
          );
          // a few heavier sparks — they slow down, curve down, then thud to the ground
          if (this.rand() < 0.26) {
            this._pfxSpark(
              c.x + Math.cos(a) * 0.02,
              0.58 + this._rr(0, 0.05),
              c.z + Math.sin(a) * 0.02,
              Math.cos(a) * sp * 0.7,
              this._rr(3.2, 5.6),
              Math.sin(a) * sp * 0.7,
              1,
              this._rr(0.88, 1),
              0.62,
              this._rr(0.8, 1.5),
              2.1, // heavy -> strong gravity
            );
          }
        }
        if (this.rand() < dt * 2)
          this._puff(c.x, 1.1, c.z, 0.45, this._rr(1.1, 1.9), 0.4);
        // the burning clay vent breathes: scale its glowing tip, not the shared material
        if (c.tip)
          c.tip.scale.setScalar(1 + 0.14 * Math.sin(this.time * 24 + c.phase));
        // occasional bright "pop": a ring of brighter, faster sparks
        if (this.rand() < dt * 2.2) {
          c.flash = 1;
          for (let k = 0; k < (this.quality === "high" ? 26 : 16); k++) {
            const a = this.rand() * Math.PI * 2,
              sp = this._rr(2, 5);
            this._pfxSpark(
              c.x,
              0.55,
              c.z,
              Math.cos(a) * sp,
              this._rr(4.5, 8.5),
              Math.sin(a) * sp,
              1,
              this._rr(0.85, 1),
              this._rr(0.6, 0.85),
              this._rr(0.45, 0.8),
              0.9,
            );
          }
          this.sparkFlash = Math.max(this.sparkFlash, 0.9);
        }
        energy = 1 + c.flash * 2;
      } else if (c.type === "chakri") {
        // real spinning wheel: accelerates while active, sheds bright arcs
        // from its rim, and spins down naturally when it turns off.
        c.angle += c.spin * (1 + c.flash * 1.5) * dt;
        c.spinner.rotation.y = c.angle;
        c.glow.opacity =
          0.32 + 0.25 * Math.abs(Math.sin(c.angle * 0.5)) + c.flash * 0.5;
        while (c.acc >= 1) {
          c.acc -= 1;
          const a = c.angle + this._rr(-0.45, 0.45);
          const px = c.x + Math.cos(a) * 0.34,
            pz = c.z + Math.sin(a) * 0.34;
          const tang = a + Math.PI / 2;
          const sp = this._rr(2.2, 5.5);
          const col = this._pick(this.sparkCols);
          this._pfxSpark(
            px,
            this._rr(0.06, 0.36),
            pz,
            Math.cos(tang) * sp,
            this._rr(0.6, 2.2),
            Math.sin(tang) * sp,
            col[0],
            col[1],
            col[2],
            this._rr(0.45, 0.85),
            1.3,
          );
          // heavy sparks arc down and thud on the stone
          if (this.rand() < 0.3) {
            this._pfxSpark(
              px,
              this._rr(0.08, 0.34),
              pz,
              Math.cos(tang + this._rr(-0.25, 0.25)) * sp * 0.75,
              this._rr(0.3, 1.2),
              Math.sin(tang + this._rr(-0.25, 0.25)) * sp * 0.75,
              1,
              this._rr(0.85, 0.98),
              0.58,
              this._rr(0.55, 1.2),
              2.3,
            );
          }
        }
        if (this.rand() < dt * 1.3) c.flash = 1;
        energy = 1 + c.flash * 2.5;
      } else {
        // phuljhadi — rocks in the "hand" so the glowing tip traces a short trail.
        // Real sparkler look: faster hand wobble, dense bright shower of gold/white
        // sparks that fall under gravity and bounce once off the stone.
        const holder = c.holder;
        const rock = this.reduceMotion ? 0 : 1;
        holder.rotation.z =
          -0.22 + Math.sin(this.time * 3.6 + c.phase) * 0.2 * rock;
        holder.rotation.x =
          Math.sin(this.time * 2.9 + c.phase * 1.3) * 0.15 * rock;
        c.glow.opacity = 0.55 + 0.22 * Math.sin(this.time * 38 + c.phase);
        if (c.halo)
          c.halo.scale.setScalar(
            0.85 + 0.25 * Math.sin(this.time * 14 + c.phase),
          );
        // tip position in root space (holder offset + tilt, then group yaw)
        v.set(0, 1.16, 0).applyEuler(holder.rotation);
        v.x += holder.position.x;
        v.y += holder.position.y;
        v.z += holder.position.z;
        v.applyAxisAngle(axisY, c.group.rotation.y);
        const tx = c.x + v.x,
          ty = v.y,
          tz = c.z + v.z;
        while (c.acc >= 1) {
          c.acc -= 1;
          const a = this.rand() * Math.PI * 2;
          const sp = this._rr(0.8, 4.2);
          const col = this._pick(this.sparkCols);
          this._pfxSpark(
            tx,
            ty,
            tz,
            Math.cos(a) * sp,
            this._rr(-0.5, 1.6),
            Math.sin(a) * sp,
            col[0],
            col[1],
            col[2],
            this._rr(0.5, 1.15),
            0.7,
          );
        }
        if (this.rand() < dt * 1.2)
          this._puff(tx, ty, tz, 0.22, this._rr(0.8, 1.4), 0.3);
        energy = 1.1;
      }

      if (energy > bestE) {
        bestE = energy;
        bestC = ci;
      }
    }

    // one warm light follows the most energetic cracker, so the ground reads lit
    if (bestC >= 0) {
      const c = list[bestC];
      this.sparkLight.position.set(
        c.x,
        c.type === "phuljhadi" ? 1.15 : 0.6,
        c.z,
      );
      this.sparkLight.color.setHex(c.type === "chakri" ? 0xffb060 : 0xffa95e);
    }
  }

  // ----------------------------------------------- player-triggered fireworks --
  // Bought firecrackers fire into the SAME particle pools as the ambient show,
  // so a player rocket or aerial burst costs no extra draw calls. Every prop is
  // transient and disposes the one cloned glow material it owns when it ends —
  // nothing leaks between uses.
  _initPlayerFx() {
    this.pfxProps = []; // active ground props (anar / chakri)
    this.pfxSparklers = new Map(); // ownerId -> handheld sparkler
    this.pfxFlashes = []; // short bloom at bought sky-burst points
    this._pfxV = new THREE.Vector3();
    this._lastBurstType = null;
    this._flashTex = this._softTexture(64, [
      [0, "rgba(255,255,255,1)"],
      [0.35, "rgba(255,240,210,0.55)"],
      [1, "rgba(255,220,180,0)"],
    ]);
    // shared geometry (built once, never disposed)
    this._pfxAnarGeo = new THREE.CylinderGeometry(0.16, 0.36, 0.56, 12);
    this._pfxBandGeo = new THREE.CylinderGeometry(0.2, 0.26, 0.1, 12);
    this._pfxDiscGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.07, 18);
    this._pfxRimGeo = new THREE.TorusGeometry(0.33, 0.055, 6, 20);
    this._pfxBudGeo = new THREE.SphereGeometry(0.115, 8, 6);
    this._pfxStickGeo = new THREE.CylinderGeometry(0.028, 0.03, 1.15, 6);
    // shared solid materials; the additive glows are cloned per prop
    this._pfxClay = new THREE.MeshLambertMaterial({
      color: 0xa1542e,
      emissive: 0x200b04,
    });
    this._pfxGold = new THREE.MeshLambertMaterial({
      color: 0xd8a24a,
      emissive: 0x3a2405,
    });
    this._pfxDisc = new THREE.MeshLambertMaterial({
      color: 0x7a4426,
      emissive: 0x1c0c04,
    });
    this._pfxStickMat = new THREE.MeshLambertMaterial({ color: 0x9a8a68 });
    this._initPfxSparks();
  }

  // Close-up crackers need much smaller point sprites than the distant sky
  // bursts (those are 2.3 m wide so they read from 100+ m away). A second tiny
  // additive pool keeps fountains / spinners / sparklers crisp without touching
  // the ambient show or adding per-particle draw calls.
  _initPfxSparks() {
    // Large pool: it carries every ambient ground cracker (8 props x ~90-105
    // sparks/s with ~1 s lifetimes plus the handheld sparklers and bought
    // fountain props), so it needs roughly a second of full-rate output.
    const max = this.quality === "high" ? 2000 : 1000;
    this.pfxSparkMax = max;
    this.pfxSparkNext = 0;
    this.pfxSparkVel = new Float32Array(max * 3);
    this.pfxSparkBase = new Float32Array(max * 3);
    this.pfxSparkLife = new Float32Array(max);
    this.pfxSparkMaxLife = new Float32Array(max);
    this.pfxSparkGrav = new Float32Array(max);
    this.pfxSparkBounce = new Uint8Array(max); // one ground hop, then die
    const pos = new Float32Array(max * 3);
    const col = new Float32Array(max * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.pfxSparkPoints = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size: 0.36,
        map: this._softTexture(32, [
          [0, "rgba(255,255,255,1)"],
          [0.4, "rgba(255,255,255,0.5)"],
          [1, "rgba(255,255,255,0)"],
        ]),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    this.pfxSparkPoints.frustumCulled = false;
    this.root.add(this.pfxSparkPoints);
  }

  _pfxSpark(x, y, z, vx, vy, vz, r, g, b, life, grav = 1) {
    if (!this.pfxSparkPoints) return;
    const idx = this.pfxSparkNext++ % this.pfxSparkMax;
    const i3 = idx * 3;
    const p = this.pfxSparkPoints.geometry.attributes.position.array;
    p[i3] = x;
    p[i3 + 1] = y;
    p[i3 + 2] = z;
    this.pfxSparkVel[i3] = vx;
    this.pfxSparkVel[i3 + 1] = vy;
    this.pfxSparkVel[i3 + 2] = vz;
    this.pfxSparkBase[i3] = r;
    this.pfxSparkBase[i3 + 1] = g;
    this.pfxSparkBase[i3 + 2] = b;
    this.pfxSparkLife[idx] = life;
    this.pfxSparkMaxLife[idx] = life;
    this.pfxSparkGrav[idx] = grav;
    if (this.pfxSparkBounce) this.pfxSparkBounce[idx] = 0;
  }

  _updatePfxSparks(dt) {
    if (!this.pfxSparkPoints) return;
    const p = this.pfxSparkPoints.geometry.attributes.position.array;
    const c = this.pfxSparkPoints.geometry.attributes.color.array;
    const drag = 0.985;
    let live = false;
    for (let i = 0; i < this.pfxSparkMax; i++) {
      if (this.pfxSparkLife[i] <= 0) continue;
      live = true;
      const i3 = i * 3;
      const life = this.pfxSparkLife[i] - dt;
      this.pfxSparkLife[i] = life;
      if (life <= 0) {
        c[i3] = 0;
        c[i3 + 1] = 0;
        c[i3 + 2] = 0;
        continue;
      }
      this.pfxSparkVel[i3 + 1] -= 7.5 * this.pfxSparkGrav[i] * dt;
      this.pfxSparkVel[i3] *= drag;
      this.pfxSparkVel[i3 + 1] *= drag;
      this.pfxSparkVel[i3 + 2] *= drag;
      p[i3] += this.pfxSparkVel[i3] * dt;
      p[i3 + 1] += this.pfxSparkVel[i3 + 1] * dt;
      p[i3 + 2] += this.pfxSparkVel[i3 + 2] * dt;
      // ground contact: a real spark loses most of its energy, hops once,
      // and burns out on the second touch instead of sinking through the plaza
      if (p[i3 + 1] < 0.06 && this.pfxSparkVel[i3 + 1] < 0) {
        if (this.pfxSparkBounce[i]) {
          this.pfxSparkLife[i] = 0;
          c[i3] = c[i3 + 1] = c[i3 + 2] = 0;
          continue;
        }
        this.pfxSparkBounce[i] = 1;
        p[i3 + 1] = 0.06;
        this.pfxSparkVel[i3 + 1] *= -0.25;
        this.pfxSparkVel[i3] *= 0.55;
        this.pfxSparkVel[i3 + 2] *= 0.55;
      }
      const f = Math.min(1, (life / this.pfxSparkMaxLife[i]) * 2.4);
      c[i3] = this.pfxSparkBase[i3] * f;
      c[i3 + 1] = this.pfxSparkBase[i3 + 1] * f;
      c[i3 + 2] = this.pfxSparkBase[i3 + 2] * f;
    }
    if (live) {
      this.pfxSparkPoints.geometry.attributes.position.needsUpdate = true;
      this.pfxSparkPoints.geometry.attributes.color.needsUpdate = true;
    }
  }

  // A bought shell opens with a short additive bloom at the burst point. One
  // sprite / one draw call for ~0.55 s, disposed when it ends; it makes the
  // explosion read from normal third-person camera distance.
  _burstFlash(x, y, z, col) {
    if (!this._flashTex) return;
    const mat = new THREE.SpriteMaterial({
      map: this._flashTex,
      color: new THREE.Color(col[0], col[1], col[2]),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const s = new THREE.Sprite(mat);
    s.position.set(x, y, z);
    s.scale.setScalar(3);
    s.frustumCulled = false;
    this.root.add(s);
    this.pfxFlashes.push({ s, t: 0, dur: this.reduceMotion ? 0.3 : 0.55 });
  }

  _updatePfxFlashes(dt) {
    for (let i = this.pfxFlashes.length - 1; i >= 0; i--) {
      const f = this.pfxFlashes[i];
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) {
        this.root.remove(f.s);
        f.s.material.dispose();
        this.pfxFlashes.splice(i, 1);
        continue;
      }
      // snap open, then fade — reads as the shell igniting
      const grow = Math.min(1, k * 5);
      f.s.scale.setScalar(2 + grow * 6 + k * k * 4);
      f.s.material.opacity = (1 - k) ** 1.6 * 0.55;
    }
  }

  _pfxGlowMat(opacity = 0.85) {
    const m = new THREE.MeshBasicMaterial({
      color: 0xffd28a,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    m.__pfx = true;
    return m;
  }

  // pick an aerial pattern different from the previous one (keeps bursts varied)
  _nextBurstType() {
    let t = this._pick(this.fwTypes);
    if (t === this._lastBurstType && this.fwTypes.length > 1) {
      t = this.fwTypes[(this.fwTypes.indexOf(t) + 1) % this.fwTypes.length];
    }
    this._lastBurstType = t;
    return t;
  }

  // A player fires a bought firecracker at a server-validated ground position.
  playFirework(itemId, x, z, ry = 0, seed = null, self = false) {
    const item = fireworkById(itemId);
    const kind = item?.kind || "ground";
    const rng = seed != null ? mulberry32(seed) : this.rand;
    if (kind === "rocket") this._launchRocketAt(x, z, rng, ry, self);
    else if (kind === "aerial") this._aerialAt(x, z, rng, ry, self);
    else if (kind === "diya") this._groundProp("diya", x, z, ry || 0);
    else if (kind === "spinner") this._groundProp("chakri", x, z, ry || 0);
    else this._groundProp("anar", x, z, ry || 0);
  }

  _groundProp(type, x, z, ry) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    const glow = this._pfxGlowMat();
    const c = {
      type,
      x,
      z,
      group: g,
      glow,
      t: 0,
      // 7-second burn, matching the catalog durations
      dur: 7.0,
      acc: 0,
      flash: 0,
      angle: this.rand() * 6.28,
      spin: this._rr(9, 15),
      phase: this.rand() * 6.28,
    };
    if (type === "diya") {
      // placed diya: clay bowl + flickering flame (flame shader shares the
      // world-diya uTime uniforms, so it breathes exactly like the rest)
      if (!this._pfxDiyaBowlGeo) {
        this._pfxDiyaBowlGeo = new THREE.CylinderGeometry(0.15, 0.1, 0.12, 8);
        this._pfxDiyaFlameGeo = new THREE.ConeGeometry(0.055, 0.2, 6);
      }
      const bowl = new THREE.Mesh(this._pfxDiyaBowlGeo, this._pfxClay);
      bowl.position.y = 0.06;
      g.add(bowl);
      const flame = new THREE.Mesh(
        this._pfxDiyaFlameGeo,
        this._diyaFlameMaterial(),
      );
      flame.position.y = 0.27;
      flame.material.__pfx = true; // disposed with the prop
      g.add(flame);
      const halo = new THREE.Mesh(this._pfxBudGeo, glow);
      halo.position.y = 0.3;
      g.add(halo);
      c.flame = flame;
      c.rate = 0;
      c.dur = 45; // stays lit for the whole evening visit
    } else if (type === "anar") {
      const cone = new THREE.Mesh(this._pfxAnarGeo, this._pfxClay);
      cone.position.y = 0.28;
      g.add(cone);
      const band = new THREE.Mesh(this._pfxBandGeo, this._pfxGold);
      band.position.y = 0.44;
      g.add(band);
      const vent = new THREE.Mesh(this._pfxBudGeo, glow);
      vent.position.y = 0.53;
      g.add(vent);
      c.tip = vent;
      c.rate = this.quality === "high" ? 132 : 78;
    } else {
      const spinner = new THREE.Group();
      spinner.position.y = 0.07;
      g.add(spinner);
      spinner.add(new THREE.Mesh(this._pfxDiscGeo, this._pfxDisc));
      const rim = new THREE.Mesh(this._pfxRimGeo, glow);
      rim.rotation.x = Math.PI / 2;
      spinner.add(rim);
      c.spinner = spinner;
      c.rate = this.quality === "high" ? 110 : 66;
    }
    this.root.add(g);
    this.pfxProps.push(c);
  }

  _launchRocketAt(x, z, rng = this.rand, ry = 0, self = false) {
    const idx = this.fwNext++ % this.fwMax;
    // Bought rockets arc forward into the sky (rather than straight overhead)
    // so the trail + burst stay inside the third-person camera's view.
    const fuse = 1.0 + rng() * 0.6;
    const travel = 34 + rng() * 18;
    this.rockets.push({
      idx,
      x,
      y: 1.5,
      z,
      vy: 16 + rng() * 8,
      // Player yaw follows the character's local -Z forward direction.
      vx: (-Math.sin(ry) * travel) / fuse,
      vz: (-Math.cos(ry) * travel) / fuse,
      fuse,
      acc: 0,
      // half of bought rockets put on the double-break show
      dbl: rng() < 0.5,
      broke: false,
      player: !!self,
      bought: true,
      // Bought rockets always open a dense, full bloom (ambient rockets keep
      // the full pattern variety, including sparse palms/rings).
      col: this._pick(this.fwColors),
      type: this._pick(["chrysanthemum", "peony"]),
    });
    this.fwLife[idx] = 2;
    this.fwMaxLife[idx] = 2;
    this.fwGrav[idx] = 0;
    this.fwBase[idx * 3] = 1.0;
    this.fwBase[idx * 3 + 1] = 0.86;
    this.fwBase[idx * 3 + 2] = 0.62;
    this._fwSet(idx, x, 1.5, z, 1.0, 0.86, 0.62);
  }

  // A big aerial shell: rises from the placement, then a broad burst high up,
  // plus a second overlapping burst so the explosion reads as "large".
  _aerialAt(x, z, rng = this.rand, ry = 0, self = false) {
    this._launchRocketAt(x, z, rng, ry, self);
    // place the shell out ahead of the player at a sky height that stays in view
    const dist = 46 + rng() * 20;
    const y = 26 + rng() * 12;
    const bx = x - Math.sin(ry) * dist + (rng() - 0.5) * 14;
    const bz = z - Math.cos(ry) * dist + (rng() - 0.5) * 14;
    const col1 = this._pick(this.fwColors);
    this._fwBurst(bx, y, bz, col1, this._nextBurstType());
    this._burstFlash(bx, y, bz, col1);
    this.lastAerialBurst = { x: bx, y, z: bz, t: this.time };
    // second overlapping shell at a nearby point + different colour/pattern
    const bx2 = bx + (rng() - 0.5) * 10;
    const by2 = y + (rng() - 0.5) * 8;
    const bz2 = bz + (rng() - 0.5) * 10;
    const col2 = this._pick(this.fwColors);
    this._fwBurst(bx2, by2, bz2, col2, this._nextBurstType());
    this._burstFlash(bx2, by2, bz2, col2);
  }

  // Handheld sparkler attached to a character rig (own or remote).
  attachSparkler(ownerId, rig, dur = 7) {
    if (!rig) return;
    this.detachSparkler(ownerId);
    const g = new THREE.Group();
    g.position.set(0.42, 1.3, 0.2);
    g.rotation.z = -0.26;
    const stick = new THREE.Mesh(this._pfxStickGeo, this._pfxStickMat);
    stick.position.y = 0.57;
    g.add(stick);
    const tip = new THREE.Mesh(this._pfxBudGeo, this._pfxGlowMat(0.9));
    tip.position.y = 1.16;
    g.add(tip);
    const halo = new THREE.Mesh(this._pfxBudGeo, this._pfxGlowMat(0.5));
    halo.scale.setScalar(2.4);
    halo.position.y = 1.16;
    g.add(halo);
    rig.root.add(g);
    this.pfxSparklers.set(ownerId, {
      group: g,
      tip,
      halo,
      t: 0,
      dur,
      acc: 0,
      phase: this.rand() * 6.28,
    });
  }

  detachSparkler(ownerId) {
    const s = this.pfxSparklers.get(ownerId);
    if (!s) return;
    s.group.parent?.remove(s.group);
    s.group.traverse((o) => {
      if (o.material?.__pfx) o.material.dispose();
    });
    this.pfxSparklers.delete(ownerId);
  }

  _removePlayerProp(i) {
    const c = this.pfxProps[i];
    c.group.parent?.remove(c.group);
    c.group.traverse((o) => {
      if (o.material?.__pfx) o.material.dispose();
    });
    this.pfxProps.splice(i, 1);
  }

  _updatePlayerFx(dt) {
    this._updatePfxSparks(dt);
    this._updatePfxFlashes(dt);
    const rateF = this.reduceMotion ? 0.5 : 1;
    let bestE = 0,
      bx = 0,
      by = 0.6,
      bz = 0;

    // ---- ground props (anar fountain / chakri spinner) --------------------
    const list = this.pfxProps;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      c.t += dt;
      c.flash = Math.max(0, (c.flash || 0) - dt * 2.6);
      if (c.t >= c.dur + 0.7) {
        this._removePlayerProp(i);
        continue;
      }
      const active = c.t < c.dur;
      const ramp = active ? Math.min(1, (c.dur - c.t) / 0.5) : 0;
      if (c.type === "diya") {
        // no sparks — just a soft breathing halo while the flame shader flickers
        if (active) {
          c.glow.opacity = (0.4 + 0.18 * Math.sin(this.time * 9 + c.phase)) * ramp;
          if (this.rand() < dt * 0.5)
            this._puff(c.x, 0.5, c.z, 0.3, this._rr(0.7, 1.1), 0.5);
        } else {
          c.glow.opacity = Math.max(0, c.glow.opacity - dt * 1.2);
        }
      } else if (c.type === "anar") {
        if (active) {
          // the burning clay vent breathes: scale its glowing tip mesh
          if (c.tip)
            c.tip.scale.setScalar(
              1 + 0.14 * Math.sin(this.time * 24 + c.phase),
            );
          c.glow.opacity =
            (0.45 + 0.25 * Math.sin(this.time * 24 + c.phase)) * ramp;
          c.acc += c.rate * rateF * dt;
          while (c.acc >= 1) {
            c.acc -= 1;
            const col = this._pick(this.sparkCols);
            const a = this.rand() * Math.PI * 2;
            const sp = this._rr(0.3, 2.6);
            this._pfxSpark(
              c.x + Math.cos(a) * 0.04,
              0.53 + this._rr(-0.02, 0.07),
              c.z + Math.sin(a) * 0.04,
              Math.cos(a) * sp,
              this._rr(7, 15),
              Math.sin(a) * sp,
              col[0],
              col[1],
              col[2],
              this._rr(0.6, 1.6),
              0.95,
            );
            if (this.rand() < 0.26) {
              this._pfxSpark(
                c.x + Math.cos(a) * 0.02,
                0.58 + this._rr(0, 0.05),
                c.z + Math.sin(a) * 0.02,
                Math.cos(a) * sp * 0.7,
                this._rr(5.5, 9),
                Math.sin(a) * sp * 0.7,
                1,
                this._rr(0.88, 1),
                0.62,
                this._rr(0.9, 2.2),
                2.1,
              );
            }
          }
          if (this.rand() < dt * 4)
            this._puff(c.x, 1.1, c.z, 0.45, this._rr(1.1, 1.9), 0.4);
          if (bestE < 1) {
            bestE = 1;
            bx = c.x;
            bz = c.z;
          }
        } else {
          c.glow.opacity = Math.max(0, c.glow.opacity - dt * 2.4);
        }
      } else {
        // chakri — real spinner: faster spin-up, sparks trail into arcs,
        // brightens as it revs, and sheds sparks from both rim faces.
        if (active) {
          c.angle += c.spin * (1.1 + c.flash * 1.5) * dt;
          c.spinner.rotation.y = c.angle;
          c.glow.opacity =
            (0.34 + 0.25 * Math.abs(Math.sin(c.angle * 0.5)) + c.flash * 0.5) *
            ramp;
          // spark intensity grows as the wheel spins up -> brighter centre ring
          const intensity = Math.min(1, (c.t + 0.5) / 1.6);
          c.acc += c.rate * rateF * intensity * dt;
          while (c.acc >= 1) {
            c.acc -= 1;
            const a = c.angle + this._rr(-0.45, 0.45);
            const px = c.x + Math.cos(a) * 0.34,
              pz = c.z + Math.sin(a) * 0.34;
            const tang = a + Math.PI / 2;
            const sp = this._rr(2.8, 8);
            const col = this._pick(this.sparkCols);
            this._pfxSpark(
              px,
              this._rr(0.06, 0.36),
              pz,
              Math.cos(tang) * sp,
              this._rr(0.5, 2.4),
              Math.sin(tang) * sp,
              col[0],
              col[1],
              col[2],
              this._rr(0.4, 0.95),
              1.3,
            );
            // heavy rim sparks: a short arc, then a thud on the stone
            if (this.rand() < 0.3) {
              this._pfxSpark(
                px,
                this._rr(0.08, 0.34),
                pz,
                Math.cos(tang + this._rr(-0.25, 0.25)) * sp * 0.75,
                this._rr(0.3, 1.2),
                Math.sin(tang + this._rr(-0.25, 0.25)) * sp * 0.75,
                1,
                this._rr(0.85, 0.98),
                0.58,
                this._rr(0.6, 1.5),
                2.3,
              );
            }
          }
          if (this.rand() < dt * 1.3) c.flash = 1;
          if (bestE < 1.4) {
            bestE = 1.4;
            bx = c.x;
            bz = c.z;
          }
        } else {
          c.spinner.rotation.y += c.spin * 0.4 * dt;
          c.glow.opacity = Math.max(0, c.glow.opacity - dt * 2.4);
        }
      }
    }

    // ---- handheld sparklers (sparks follow the moving tip) ----------------
    if (this.pfxSparklers.size) {
      const v = this._pfxV;
      for (const [id, s] of [...this.pfxSparklers]) {
        s.t += dt;
        if (s.t >= s.dur) {
          this.detachSparkler(id);
          continue;
        }
        s.tip.getWorldPosition(v);
        const fade = Math.min(1, (s.dur - s.t) / 0.5);
        s.tip.material.opacity =
          (0.7 + 0.25 * Math.sin(this.time * 30 + s.phase)) * fade;
        s.halo.material.opacity = 0.4 * fade;
        s.halo.scale.setScalar(
          (2.2 + 0.4 * Math.sin(this.time * 14 + s.phase)) * fade,
        );
        s.acc += (this.quality === "high" ? 100 : 60) * rateF * dt;
        while (s.acc >= 1) {
          s.acc -= 1;
          const a = this.rand() * Math.PI * 2;
          const sp = this._rr(0.8, 4.2);
          const col = this._pick(this.sparkCols);
          this._pfxSpark(
            v.x,
            v.y,
            v.z,
            Math.cos(a) * sp,
            this._rr(-0.5, 1.6),
            Math.sin(a) * sp,
            col[0],
            col[1],
            col[2],
            this._rr(0.5, 1.15),
            0.7,
          );
          // heavy golden chunks that arc down and die on the ground
          if (this.rand() < 0.22) {
            this._pfxSpark(
              v.x,
              v.y,
              v.z,
              Math.cos(a) * sp * 0.55,
              this._rr(-1.4, 0.4),
              Math.sin(a) * sp * 0.55,
              1,
              this._rr(0.88, 1),
              0.62,
              this._rr(0.8, 1.8),
              2.3,
            );
          }
        }
        if (this.rand() < dt * 2.5)
          this._puff(v.x, v.y, v.z, 0.22, this._rr(0.8, 1.4), 0.3);
        if (bestE < 1.2) {
          bestE = 1.2;
          bx = v.x;
          by = v.y;
          bz = v.z;
        }
      }
    }

    // let the nearest active player cracker light the ground under it (the
    // ambient crackers write the same light; player props simply take priority)
    if (bestE > 0) {
      this.sparkLight.position.set(bx, by, bz);
      this.sparkLight.color.setHex(0xffa95e);
      this.sparkFlash = Math.max(this.sparkFlash, 0.7 * bestE);
    }
  }

  // ------------------------------------------------------- ambient particles --
  _buildMotes() {
    const N = this.quality === "high" ? 240 : 130;
    const streetN = this.quality === "high" ? 90 : 50;
    const pos = new Float32Array(N * 3);
    this.moteState = [];
    for (let i = 0; i < N; i++) {
      let st;
      if (i >= N - streetN) {
        // golden motes drifting down the festival street
        st = {
          x: this._rr(-14, 14),
          z: this._rr(46, 202),
          y: this._rr(0.6, 6.5),
          ph: this._rr(0, 6.28),
        };
      } else {
        const a = this.rand() * Math.PI * 2,
          r = this._rr(4, 64);
        st = {
          x: Math.cos(a) * r,
          z: Math.sin(a) * r,
          y: this._rr(0.5, 13),
          ph: this._rr(0, 6.28),
        };
      }
      this.moteState.push(st);
      pos[i * 3] = st.x;
      pos[i * 3 + 1] = st.y;
      pos[i * 3 + 2] = st.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.motes = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: 0xffcf8a,
        size: 0.32,
        map: this._softTexture(32),
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    this.motes.frustumCulled = false;
    this.root.add(this.motes);
  }

  // ------------------------------------------------------------------- mist --
  _buildMist() {
    const tex = this._softTexture(128, [
      [0, "rgba(200,215,255,0.85)"],
      [0.5, "rgba(170,185,235,0.3)"],
      [1, "rgba(150,165,220,0)"],
    ]);
    this.mist = [];
    const n = this.quality === "high" ? 9 : 5;
    for (let i = 0; i < n; i++) {
      const nearMountains = i < n - 2;
      const a = this._rr(0, Math.PI * 2);
      const r = nearMountains ? this._rr(430, 560) : this._rr(60, 220);
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: tex,
          color: 0x9fb0e0,
          transparent: true,
          depthWrite: false,
          opacity: nearMountains ? 0.16 : 0.09,
        }),
      );
      sp.position.set(
        Math.cos(a) * r,
        nearMountains ? this._rr(6, 26) : this._rr(3, 9),
        Math.sin(a) * r,
      );
      const s = nearMountains ? this._rr(220, 360) : this._rr(90, 170);
      sp.scale.set(s, s * 0.45, 1);
      sp.userData = {
        spin: this._rr(-0.02, 0.02),
        drift: this._rr(0.02, 0.06),
        phase: this._rr(0, 6.28),
        baseY: sp.position.y,
      };
      this.mist.push(sp);
      this.root.add(sp);
    }
  }

  // ----------------------------------------------------------- interactions --
  _registerInteractions() {
    const w = this.world;
    const reg = (id, x, z, label) =>
      w.interactables.push({ kind: "festival", id, x, z, label });
    reg(
      "bonfire",
      this.bonfire.x + 4.6,
      this.bonfire.z + 0.6,
      "Warm up at the bonfire",
    );
    reg("diya", 0, -34, "Light a diya");
    reg("diya", 34, 0, "Light a diya");
    reg("diya", -34, 0, "Light a diya");
    reg("lantern", 0, 36, "Release a paper lantern");
    reg(
      "lantern",
      this.bonfire.x + 8,
      this.bonfire.z + 6,
      "Release a paper lantern",
    );
    for (const p of this.pagodas) {
      reg("temple", p.x * 0.82, p.z * 0.82, "Spin the prayer wheel");
    }
  }

  _notify(text) {
    this.onNotify?.(text);
  }

  interact(id) {
    if (id === "bonfire") {
      this.bonfireFlare = 1;
      this.onEmote?.("dance");
      this._notify("You warm up by the bonfire.");
    } else if (id === "diya") {
      this.pulseUniform.value = 1;
      this._notify("You light a diya — may it bring good fortune.");
    } else if (id === "lantern") {
      for (let i = 0; i < 6; i++) {
        const l = this._newLantern(false);
        l.x = this._rr(-9, 9);
        l.z = this._rr(-9, 9);
        this.lanterns[(this.rand() * this.lanterns.length) | 0] = l;
      }
      this._notify("A paper lantern drifts into the night sky.");
    } else if (id === "temple") {
      this.wheelBoost = 1;
      this.onEmote?.("greet");
      this._notify("You spin the prayer wheel — blessings on the wind.");
    }
  }

  // ------------------------------------------------------------------- tick --
  tick(timeMs, dtIn) {
    const dt = Math.min(0.05, dtIn || 0.016);
    this.time += dt;
    const t = this.time;
    this.timeUniform.value = t;
    this.pulseUniform.value = Math.max(0, this.pulseUniform.value - dt * 1.6);
    this.bonfireFlare = Math.max(0, this.bonfireFlare - dt * 1.2);
    this.wheelBoost = Math.max(0, this.wheelBoost - dt * 1.5);

    // slow sky drift
    if (this.stars) this.stars.rotation.y = t * 0.004;

    // lanterns rise + sway
    const M = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      p = new THREE.Vector3(),
      s = new THREE.Vector3();
    const gp = this.lanternGlowGeo.attributes.position.array;
    for (let i = 0; i < this.lanterns.length; i++) {
      const l = this.lanterns[i];
      l.y += l.vy * dt;
      if (l.y > 135) Object.assign(l, this._newLantern(false));
      const x = l.x + Math.sin(t * 0.3 + l.phase) * l.sway;
      const z = l.z + Math.cos(t * 0.27 + l.phase) * l.sway;
      q.setFromEuler(new THREE.Euler(0, t * 0.2 + l.phase, 0));
      p.set(x, l.y, z);
      s.setScalar(l.sc);
      M.compose(p, q, s);
      this.lanternBody.setMatrixAt(i, M);
      gp[i * 3] = x;
      gp[i * 3 + 1] = l.y;
      gp[i * 3 + 2] = z;
    }
    this.lanternBody.instanceMatrix.needsUpdate = true;
    this.lanternGlowGeo.attributes.position.needsUpdate = true;
    if (this.lanternLights) {
      for (let i = 0; i < this.lanternLights.length; i++) {
        const l = this.lanterns[(i * 7) % this.lanterns.length];
        this.lanternLights[i].position.set(
          l.x + Math.sin(t * 0.3 + l.phase) * l.sway,
          l.y,
          l.z + Math.cos(t * 0.27 + l.phase) * l.sway,
        );
        this.lanternLights[i].intensity = this.quality === "high" ? 0.8 : 0.5;
      }
    }

    // bonfire
    if (this.flameMat) {
      const flick =
        0.85 +
        Math.sin(t * 11) * 0.1 +
        Math.sin(t * 23.7) * 0.05 +
        this.bonfireFlare * 0.8;
      this.flameMat.uniforms.uFlare.value = this.bonfireFlare;
      this.flame.scale.set(flick, 0.9 + flick * 0.2, flick);
      this.bonfireLight.intensity =
        1.5 + Math.sin(t * 12) * 0.25 + this.bonfireFlare * 2.0;
      this.bonfireCore.scale.setScalar(
        0.9 + Math.sin(t * 9) * 0.08 + this.bonfireFlare * 0.6,
      );
    }
    if (this.embers) {
      const ep = this.embers.geometry.attributes.position.array;
      for (let i = 0; i < this.emberState.length; i++) {
        const st = this.emberState[i];
        st.life -= dt;
        st.y += st.vy * dt;
        if (st.life <= 0) {
          st.x = this._rr(-1, 1);
          st.z = this._rr(-1, 1);
          st.y = this._rr(0.4, 1.5);
          st.life = this._rr(0.8, 2.0);
        }
        ep[i * 3] = st.x;
        ep[i * 3 + 1] = st.y;
        ep[i * 3 + 2] = st.z;
      }
      this.embers.geometry.attributes.position.needsUpdate = true;
    }

    // crowd
    this._tickCrowd(dt, t);

    // prayer wheels
    const wheelSpin = 1.2 + this.wheelBoost * 14;
    for (const w of this.wheels || []) w.rotation.y += wheelSpin * dt;

    // house / shrine lights gentle pulse
    for (const pl of this._houseLights || [])
      pl.intensity =
        pl.userData.baseIntensity *
        (0.9 + Math.sin(t * 6 + pl.position.x) * 0.1);
    for (const pl of this._shrineLights || [])
      pl.intensity =
        pl.userData.baseIntensity *
        (0.92 + Math.sin(t * 5 + pl.position.z) * 0.08);

    // fireworks, ground firecrackers, player-fired crackers and their smoke
    this._updateFireworks(dt);
    this._updateCrackers(dt);
    this._updatePlayerFx(dt);
    this._updateSmoke(dt);

    // ambient motes drift
    if (this.motes) {
      const mp = this.motes.geometry.attributes.position.array;
      for (let i = 0; i < this.moteState.length; i++) {
        const st = this.moteState[i];
        const yy = st.y + Math.sin(t * 0.6 + st.ph) * 0.6;
        mp[i * 3] = st.x + Math.sin(t * 0.4 + st.ph) * 0.7;
        mp[i * 3 + 1] = yy + ((t * 0.35 + st.ph) % 3);
        mp[i * 3 + 2] = st.z + Math.cos(t * 0.37 + st.ph) * 0.7;
      }
      this.motes.geometry.attributes.position.needsUpdate = true;
    }

    // mist drift
    for (const sp of this.mist || []) {
      sp.material.rotation += sp.userData.spin * dt;
      sp.position.x += Math.cos(sp.userData.phase) * sp.userData.drift * dt;
      sp.position.y =
        sp.userData.baseY + Math.sin(t * 0.25 + sp.userData.phase) * 0.8;
    }

    // "HAPPY DIWALI" sky greeting (revealed once the player is in the world)
    if (this.textGroup) {
      if (this.armed && this.textReveal < 0 && t > 0.6) this.beginReveal();
      this._updateSkyText(dt);
    }

    void timeMs;
  }

  _tickCrowd(dt, t) {
    const M = this._crowdM,
      q = this._crowdQ,
      p = this._crowdP,
      s = this._crowdS;
    for (let i = 0; i < this.crowd.length; i++) {
      const c = this.crowd[i];
      let x, z, ry, bob;
      if (c.kind === "stroll") {
        c.z += c.dir * c.speed * dt;
        if (c.z > 196) {
          c.z = 56;
        }
        if (c.z < 56) {
          c.z = 196;
        }
        x = c.x + Math.sin(t * 0.5 + c.phase) * 0.5;
        z = c.z;
        ry = c.dir > 0 ? 0 : Math.PI;
        bob = Math.abs(Math.sin(t * 5 + c.phase)) * 0.05;
      } else {
        c.ang += c.spin * dt;
        x = c.cx + Math.cos(c.ang) * c.rad;
        z = c.cz + Math.sin(c.ang) * c.rad;
        ry = Math.atan2(c.cx - x, c.cz - z) + Math.sin(t * 1.4 + c.phase) * 0.3;
        bob = Math.abs(Math.sin(t * 2.2 + c.phase)) * 0.06;
      }
      q.setFromEuler(new THREE.Euler(0, ry, 0));
      p.set(x, bob + 0.53 * c.sc, z);
      s.setScalar(c.sc);
      M.compose(p, q, s);
      this.crowdRobe.setMatrixAt(i, M);
      p.set(x, bob + 1.12 * c.sc, z);
      M.compose(p, q, s);
      this.crowdTorso.setMatrixAt(i, M);
      p.set(x, bob + 1.52 * c.sc, z);
      M.compose(p, q, s);
      this.crowdHead.setMatrixAt(i, M);
    }
    this.crowdRobe.instanceMatrix.needsUpdate = true;
    this.crowdTorso.instanceMatrix.needsUpdate = true;
    this.crowdHead.instanceMatrix.needsUpdate = true;
  }

  // --------------------------------------------------------------- quality ---
  setQuality(q) {
    void q;
    this.quality = "high";
    if (this.stars) {
      const N = this.quality === "high" ? 1600 : 900;
      this.stars.geometry.setDrawRange(0, N);
    }
    if (this.lanternBody)
      this.lanternBody.count = Math.min(
        this.lanternMax,
        this.quality === "high" ? 70 : 44,
      );
    if (this.lanternGlow) {
      this.lanternGlowGeo.setDrawRange(
        0,
        Math.min(this.lanternMax, this.quality === "high" ? 70 : 44),
      );
    }
    if (this.crowdRobe) {
      const n = Math.min(this.crowdMax, this.quality === "high" ? 60 : 36);
      this.crowdRobe.count = n;
      this.crowdTorso.count = n;
      this.crowdHead.count = n;
    }
    const day = this.timeOfDay === "day";
    for (const pl of this._shrineLights || [])
      pl.userData.baseIntensity = day ? 0.08 : 1.1;
    for (const pl of this._houseLights || [])
      pl.userData.baseIntensity = day ? 0.06 : 0.9;
    if (this.textParticles) {
      this.textParticles.geometry.setDrawRange(
        0,
        Math.min(this.textPMax, this.quality === "high" ? 1200 : 700),
      );
    }
    for (const c of this.crackers || []) {
      if (c.type === "anar") c.rate = this.quality === "high" ? 105 : 62;
      else if (c.type === "chakri") c.rate = this.quality === "high" ? 92 : 56;
      else c.rate = this.quality === "high" ? 72 : 44;
    }
  }

  setTimeOfDay(mode) {
    this.timeOfDay = mode === "day" ? "day" : "night";
    const day = this.timeOfDay === "day";
    if (this.skyMat) {
      const u = this.skyMat.uniforms;
      u.topColor.value.setHex(day ? 0x76b9e4 : PAL.skyTop);
      u.midColor.value.setHex(day ? 0xaedcf0 : PAL.skyMid);
      u.botColor.value.setHex(day ? 0xe6c6a7 : PAL.skyBot);
      u.glowColor.value.setHex(day ? 0xffd6a0 : PAL.glow);
    }
    if (this.stars) this.stars.visible = !day;
    if (this.moonSprite) this.moonSprite.visible = !day;
    this.setQuality("high");
  }

  // ============================================ "HAPPY DIWALI" 3D SKY TEXT ===
  // Real extruded, beveled, metallic-gold lettering. The glyph outlines are
  // recovered from the browser's own font rendering (a canvas mask is traced
  // into vector contours), so the whole thing stays procedural — no font file
  // and no external asset is ever loaded.
  _buildSkyText() {
    const group = new THREE.Group();
    group.name = "diwaliSkyText";
    group.position.set(0, TEXT_Y, TEXT_Z);
    group.rotation.y = Math.PI; // face back down the street/plaza
    this.root.add(group);
    this.textGroup = group;
    this.textReveal = -1;
    this._textDone = false;
    this.celebrateNext = 2.6;
    this.textRand = mulberry32(0x7e57a11); // separate stream: keeps scene RNG intact

    const raster = this._rasterizeText(TEXT_LINES);
    if (!raster) return;
    const { mask, maskW, maskCanvas, ink, contours } = raster;
    const [ix, iy, iw, ih] = ink;
    const k = TEXT_WIDTH / iw; // raster px -> world units
    const cx = ix + iw / 2,
      cy = iy + ih / 2;
    const toWorld = (px, py) => [(px - cx) * k, (cy - py) * k];
    this.textHeight = ih * k;

    // contours -> THREE.Shape (outer rings) with nested holes (letter counters)
    const polys = contours.map((c) => ({
      pts: c.pts,
      depth: c.depth,
      area: c.area,
      v2: c.pts.map(([px, py]) => new THREE.Vector2(...toWorld(px, py))),
    }));
    const outers = polys.filter(
      (p) => p.depth % 2 === 0 && p.area * k * k > 0.5,
    );
    const holes = polys.filter(
      (p) => p.depth % 2 === 1 && p.area * k * k > 0.1,
    );
    for (const o of outers) o.shape = new THREE.Shape(o.v2);
    for (const h of holes) {
      let parent = null;
      for (const o of outers) {
        if (
          this._pointInPoly(o.pts, h.pts[0][0], h.pts[0][1]) &&
          (!parent || o.area < parent.area)
        )
          parent = o;
      }
      if (parent) parent.shape.holes.push(new THREE.Path(h.v2));
    }
    if (!outers.length) return;

    // real extrusion with bevels and deep dimensional sides
    let geo;
    try {
      geo = new THREE.ExtrudeGeometry(
        outers.map((o) => o.shape),
        {
          depth: TEXT_DEPTH,
          steps: 1,
          curveSegments: 4,
          bevelEnabled: true,
          bevelThickness: 0.4,
          bevelSize: 0.34,
          bevelOffset: 0,
          bevelSegments: 3,
        },
      );
    } catch (err) {
      console.warn("Diwali sky text: extrusion failed", err);
      return;
    }

    // luxurious metallic gold: procedural environment map drives the reflections
    const env = this._textEnvTexture();
    const front = new THREE.MeshStandardMaterial({
      color: 0xffd27a,
      metalness: 1.0,
      roughness: 0.22,
      envMap: env,
      envMapIntensity: 1.2,
      emissive: 0x3a1d00,
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0,
    });
    const side = new THREE.MeshStandardMaterial({
      color: 0xa9701a,
      metalness: 1.0,
      roughness: 0.34,
      envMap: env,
      envMapIntensity: 0.95,
      emissive: 0x241100,
      emissiveIntensity: 0.45,
      transparent: true,
      opacity: 0,
    });
    this.textMats = [front, side];
    const mesh = new THREE.Mesh(geo, [front, side]);
    mesh.position.z = -TEXT_DEPTH / 2;
    group.add(mesh);
    this.textMesh = mesh;

    // procedural bloom halo + travelling specular sheen, masked to the letters
    const ov = this._textOverlayTextures(maskCanvas, ink, k);
    this.textTex = ov;
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(ov.glowW, ov.glowH),
      new THREE.MeshBasicMaterial({
        map: ov.glow,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    glow.position.z = -TEXT_DEPTH - 2.2;
    group.add(glow);
    this.textGlow = glow;

    const sheen = new THREE.Mesh(
      new THREE.PlaneGeometry(TEXT_WIDTH, this.textHeight),
      new THREE.MeshBasicMaterial({
        map: ov.sheen,
        alphaMap: ov.mask,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    sheen.position.z = TEXT_DEPTH / 2 + 0.6;
    group.add(sheen);
    this.textSheen = sheen;

    // dark dilated silhouette sitting behind the letters: keeps the gold legible
    // against bright bursts and the architecture without boxing it in.
    const back = this._textBackingTexture(maskCanvas, ink, k);
    const outline = new THREE.Mesh(
      new THREE.PlaneGeometry(back.w, back.h),
      new THREE.MeshBasicMaterial({
        map: back.tex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    outline.position.z = -TEXT_DEPTH / 2 - 0.4;
    group.add(outline);
    this.textOutline = outline;

    this._buildTextParticles(mask, maskW, ink, toWorld);
    this._buildTextSparkles(mask, maskW, ink, toWorld);

    const aspect =
      typeof innerWidth === "number" && innerHeight
        ? innerWidth / innerHeight
        : 1.777;
    this.layoutText(aspect, 60);
  }

  // rasterise the phrase and recover clean vector contours from the pixel mask
  _rasterizeText(lines) {
    if (typeof lines === "string") lines = [lines];
    const base = 400,
      pad = 64,
      lead = 1.06;
    const lineH = base * lead;
    const probe = this._canvas(8, 8);
    const pc = probe.getContext("2d");
    if (!pc) return null;
    pc.font = TEXT_FONT.replace("{S}", String(base));
    let tw = 0;
    for (const ln of lines) tw = Math.max(tw, pc.measureText(ln).width);
    if (!tw) tw = base * 4;
    const rawW = tw + pad * 2;
    const rawH = Math.ceil(lineH * (lines.length - 1) + base * 1.32) + pad * 2;
    const s = Math.min(1, 4096 / Math.max(rawW, rawH)); // keep the raster <= 4096px
    const W = Math.max(8, Math.floor(rawW * s));
    const H = Math.max(8, Math.floor(rawH * s));
    const c = this._canvas(W, H);
    const x = c.getContext("2d");
    if (!x) return null;
    x.fillStyle = "#000";
    x.fillRect(0, 0, W, H);
    x.fillStyle = "#fff";
    x.font = TEXT_FONT.replace(
      "{S}",
      String(Math.max(8, Math.round(base * s))),
    );
    x.textAlign = "center";
    x.textBaseline = "middle";
    const yTop = H / 2 - ((lines.length - 1) * lineH * s) / 2;
    for (let i = 0; i < lines.length; i++)
      x.fillText(lines[i], W / 2, yTop + i * lineH * s);

    const img = x.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H);
    let x0 = W,
      y0 = H,
      x1 = -1,
      y1 = -1;
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      if ((img[p] + img[p + 1] + img[p + 2]) / 3 >= 128) {
        mask[i] = 1;
        const px = i % W,
          py = (i / W) | 0;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
    }
    if (x1 <= x0 || y1 <= y0) return null;
    const ink = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
    const contours = this._traceMask(mask, W, H);
    if (!contours.length) return null;
    return { mask, maskW: W, maskH: H, maskCanvas: c, ink, contours };
  }

  // crack-follow the pixel boundary into closed rings, simplify, and nest them
  _traceMask(mask, w, h) {
    const stride = h + 1;
    const at = (x, y) =>
      x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0;
    const edges = new Map();
    const add = (ax, ay, bx, by) => {
      const key = ax * stride + ay;
      let list = edges.get(key);
      if (!list) {
        list = [];
        edges.set(key, list);
      }
      list.push(bx * stride + by);
    };
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (!mask[row + x]) continue;
        if (!at(x, y - 1)) add(x, y, x + 1, y);
        if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
        if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
        if (!at(x - 1, y)) add(x, y + 1, x, y);
      }
    }
    const out = [];
    for (const start of [...edges.keys()]) {
      let list = edges.get(start);
      while (list && list.length) {
        const ring = [];
        let v = start,
          guard = 0;
        while (guard++ < 1 << 22) {
          const l = edges.get(v);
          if (!l || !l.length) break;
          ring.push(v);
          v = l.pop();
          if (v === start) break;
        }
        list = edges.get(start);
        if (ring.length < 8) continue;
        const poly = ring.map((vv) => [Math.floor(vv / stride), vv % stride]);
        // RDP needs an open polyline: split the closed ring at its farthest point
        let k = 1,
          best = -1;
        for (let i = 1; i < poly.length; i++) {
          const dx = poly[i][0] - poly[0][0],
            dy = poly[i][1] - poly[0][1];
          const d = dx * dx + dy * dy;
          if (d > best) {
            best = d;
            k = i;
          }
        }
        const arc1 = this._rdp(poly.slice(0, k + 1), 1.0);
        const arc2 = this._rdp(poly.slice(k).concat([poly[0]]), 1.0);
        const simp = arc1.slice(0, -1).concat(arc2.slice(0, -1));
        if (simp.length < 4) continue;
        let a2 = 0,
          sx = 0,
          sy = 0;
        for (let i = 0; i < simp.length; i++) {
          const [ax, ay] = simp[i],
            [bx, by] = simp[(i + 1) % simp.length];
          a2 += ax * by - bx * ay;
          sx += ax;
          sy += ay;
        }
        const area = Math.abs(a2) / 2;
        if (area < 3) continue;
        out.push({
          pts: simp,
          area,
          depth: 0,
          cx: sx / simp.length,
          cy: sy / simp.length,
        });
      }
    }
    // nesting depth (even = filled shape, odd = hole)
    for (const c of out) {
      let d = 0;
      for (const o of out)
        if (o !== c && this._pointInPoly(o.pts, c.pts[0][0], c.pts[0][1])) d++;
      c.depth = d;
    }
    return out;
  }

  _rdp(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const [x1, y1] = pts[0],
      [x2, y2] = pts[pts.length - 1];
    const dx = x2 - x1,
      dy = y2 - y1;
    const den = Math.hypot(dx, dy) || 1e-9;
    let dmax = 0,
      idx = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i];
      const d = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / den;
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    if (dmax > eps) {
      const a = this._rdp(pts.slice(0, idx + 1), eps);
      const b = this._rdp(pts.slice(idx), eps);
      return a.slice(0, -1).concat(b);
    }
    return [pts[0], pts[pts.length - 1]];
  }

  _pointInPoly(pts, x, y) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i],
        [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }

  // small equirectangular "festival sky" used only as a reflection environment
  _textEnvTexture() {
    const c = this._canvas(256, 128);
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0.0, "#1a1440");
    g.addColorStop(0.42, "#5b2f63");
    g.addColorStop(0.5, "#ffb267");
    g.addColorStop(0.57, "#5a2f3c");
    g.addColorStop(1.0, "#0d0714");
    x.fillStyle = g;
    x.fillRect(0, 0, 256, 128);
    const rr = mulberry32(0x6d1a);
    for (let i = 0; i < 14; i++) {
      const cxp = rr() * 256,
        cyp = 26 + rr() * 64,
        rad = 8 + rr() * 22;
      const rg = x.createRadialGradient(cxp, cyp, 0, cxp, cyp, rad);
      rg.addColorStop(0, "rgba(255,224,160,0.9)");
      rg.addColorStop(1, "rgba(255,160,60,0)");
      x.fillStyle = rg;
      x.beginPath();
      x.arc(cxp, cyp, rad, 0, Math.PI * 2);
      x.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // crop the mask to its ink box as white glyphs on a TRANSPARENT ground
  // (the raster canvas itself is opaque black behind the letters, which would
  // otherwise turn every blurred halo/outline into a solid rectangle)
  _maskCrop(maskCanvas, ink) {
    const [ix, iy, iw, ih] = ink;
    const c = this._canvas(iw, ih);
    const ctx = c.getContext("2d");
    const d = maskCanvas.getContext("2d").getImageData(ix, iy, iw, ih);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) p[i + 3] = p[i]; // alpha <- luminance
    ctx.putImageData(d, 0, 0);
    return c;
  }

  _textOverlayTextures(maskCanvas, ink, k) {
    const [, , iw, ih] = ink;
    const crop = this._maskCrop(maskCanvas, ink);

    const m = Math.round(ih * 0.42);
    const gW = iw + m * 2,
      gH = ih + m * 2;
    const soft = this._canvas(gW, gH);
    const sc = soft.getContext("2d");
    sc.filter = `blur(${Math.max(5, Math.round(ih * 0.05))}px)`;
    sc.drawImage(crop, m, m);
    sc.filter = "none";

    const glow = this._canvas(gW, gH);
    const gc = glow.getContext("2d");
    gc.filter = `blur(${Math.max(12, Math.round(ih * 0.14))}px)`;
    gc.drawImage(soft, 0, 0);
    gc.filter = "none";
    gc.globalCompositeOperation = "source-in";
    const gg = gc.createLinearGradient(0, 0, 0, gH);
    gg.addColorStop(0, "#fff0bc");
    gg.addColorStop(0.5, "#ffcf74");
    gg.addColorStop(1, "#ff9a3c");
    gc.fillStyle = gg;
    gc.fillRect(0, 0, gW, gH);
    gc.globalCompositeOperation = "lighter";
    gc.drawImage(soft, 0, 0);
    gc.globalCompositeOperation = "source-over";

    // travelling sheen band (masked to the lettering by alphaMap)
    const sw = 128,
      sh = 256;
    const sheen = this._canvas(sw, sh);
    const shc = sheen.getContext("2d");
    const sg = shc.createLinearGradient(0, 0, sw, 0);
    sg.addColorStop(0, "rgba(255,255,255,0)");
    sg.addColorStop(0.42, "rgba(255,255,255,0)");
    sg.addColorStop(0.5, "rgba(255,248,220,0.95)");
    sg.addColorStop(0.58, "rgba(255,255,255,0)");
    sg.addColorStop(1, "rgba(255,255,255,0)");
    shc.fillStyle = sg;
    shc.fillRect(0, 0, sw, sh);
    shc.globalCompositeOperation = "destination-in";
    const vg = shc.createLinearGradient(0, 0, 0, sh);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(0.5, "rgba(0,0,0,1)");
    vg.addColorStop(1, "rgba(0,0,0,0)");
    shc.fillStyle = vg;
    shc.fillRect(0, 0, sw, sh);

    const maskTex = new THREE.CanvasTexture(crop);
    maskTex.anisotropy = 4;
    const glowTex = new THREE.CanvasTexture(glow);
    glowTex.colorSpace = THREE.SRGBColorSpace;
    glowTex.anisotropy = 4;
    const sheenTex = new THREE.CanvasTexture(sheen);
    sheenTex.colorSpace = THREE.SRGBColorSpace;
    sheenTex.wrapS = THREE.RepeatWrapping;
    sheenTex.repeat.set(2, 1);
    return {
      mask: maskTex,
      glow: glowTex,
      sheen: sheenTex,
      glowW: gW * k,
      glowH: gH * k,
    };
  }

  // a slightly dilated, darkened copy of the lettering used as an outline/backing
  _textBackingTexture(maskCanvas, ink, k) {
    const [ix, iy, iw, ih] = ink;
    void ix;
    void iy;
    const crop = this._maskCrop(maskCanvas, ink);
    const r = Math.max(2, Math.round(ih * 0.014)); // dilation radius
    const m = r + Math.round(ih * 0.035) + 6;
    const W = iw + m * 2,
      H = ih + m * 2;
    const c = this._canvas(W, H);
    const x = c.getContext("2d");
    x.filter = `blur(${Math.max(1, Math.round(ih * 0.005))}px)`;
    const steps = 18;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      x.drawImage(crop, m + Math.cos(a) * r, m + Math.sin(a) * r);
    }
    x.drawImage(crop, m, m);
    x.filter = "none";
    x.globalCompositeOperation = "source-in";
    const grad = x.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#000000");
    grad.addColorStop(1, "#000000");
    x.fillStyle = grad;
    x.fillRect(0, 0, W, H);
    x.globalCompositeOperation = "source-over";
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return { tex, w: W * k, h: H * k };
  }

  // golden particles that fly in and assemble the words
  _buildTextParticles(mask, w, ink, toWorld) {
    const [ix, iy, iw, ih] = ink;
    const R = this.textRand;
    const sample = () => {
      for (let i = 0; i < 40; i++) {
        const px = (ix + R() * iw) | 0,
          py = (iy + R() * ih) | 0;
        if (mask[py * w + px]) return toWorld(px, py);
      }
      return toWorld(ix + iw * 0.5, iy + ih * 0.5);
    };
    const N = this.quality === "high" ? 1200 : 700;
    this.textPMax = N;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    this.textPState = [];
    const tz = TEXT_DEPTH / 2 + 0.5;
    for (let i = 0; i < N; i++) {
      const [tx, ty] = sample();
      const a = R() * Math.PI * 2;
      const el = -0.5 + R() * 1.1;
      const dist = 60 + R() * 190;
      const sx = tx + Math.cos(el) * Math.cos(a) * dist;
      const sy = ty + Math.sin(el) * dist * 0.8 + 18;
      const sz = tz + Math.cos(el) * Math.sin(a) * dist * 0.5;
      const gg = 0.75 + R() * 0.25;
      this.textPState.push({
        tx,
        ty,
        tz,
        sx,
        sy,
        sz,
        delay: R() * 0.5,
        ph: R() * 6.28,
        cr: 1,
        cg: gg,
        cb: 0.35 + R() * 0.25,
      });
      pos[i * 3] = sx;
      pos[i * 3 + 1] = sy;
      pos[i * 3 + 2] = sz;
      col[i * 3] = 1;
      col[i * 3 + 1] = gg;
      col[i * 3 + 2] = 0.4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 1.7,
        map: this._softTexture(32, [
          [0, "rgba(255,240,200,1)"],
          [0.4, "rgba(255,200,110,0.6)"],
          [1, "rgba(255,160,60,0)"],
        ]),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        fog: false,
      }),
    );
    pts.frustumCulled = false;
    pts.visible = false;
    this.textGroup.add(pts);
    this.textParticles = pts;
  }

  // a sparse pool of gold motes that keep drifting off the finished lettering
  _buildTextSparkles(mask, w, ink, toWorld) {
    const [ix, iy, iw, ih] = ink;
    const R = this.textRand;
    this._textSample = () => {
      for (let i = 0; i < 40; i++) {
        const px = (ix + R() * iw) | 0,
          py = (iy + R() * ih) | 0;
        if (mask[py * w + px]) return toWorld(px, py);
      }
      return toWorld(ix + iw * 0.5, iy + ih * 0.5);
    };
    const N = this.quality === "high" ? 96 : 54;
    this.sparkleMax = N;
    this.sparkleNext = 0;
    this.sparkleAcc = 0;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.textSparkles = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size: 1.35,
        map: this._softTexture(32, [
          [0, "rgba(255,244,210,1)"],
          [0.45, "rgba(255,205,120,0.6)"],
          [1, "rgba(255,160,60,0)"],
        ]),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        fog: false,
      }),
    );
    this.textSparkles.frustumCulled = false;
    this.textSparkles.visible = false;
    this.textGroup.add(this.textSparkles);
    this.sparkleState = [];
    for (let i = 0; i < N; i++) {
      this.sparkleState.push({
        life: 0,
        maxLife: 1,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
      });
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0;
    }
  }

  beginReveal() {
    if (!this.textGroup || !this.textMesh || this._textDone) return;
    if (this.textReveal >= 0 && this.textReveal < TEXT_REVEAL) return;
    this.textReveal = 0;
    // the golden-particle storm is skipped for reduced-motion users
    if (this.textParticles) this.textParticles.visible = !this.reduceMotion;
    if (this.textMats)
      for (const m of this.textMats) {
        m.transparent = true;
        m.opacity = 0;
      }
    this.onRevealStart?.(); // let the camera drift up to witness it
  }

  // keep the whole greeting inside the frustum on any aspect ratio
  layoutText(aspect, fovDeg = 60) {
    if (!this.textGroup) return;
    const a = aspect > 0 ? aspect : 1.777;
    const D = Math.hypot(TEXT_Y, TEXT_Z);
    const halfH = D * Math.tan((fovDeg * Math.PI) / 180 / 2);
    const halfW = halfH * a;
    const fitW = (halfW * 0.86) / (TEXT_WIDTH / 2);
    const fitH = (halfH * 0.66) / Math.max(1, (this.textHeight || 1) / 2);
    this.textGroup.scale.setScalar(Math.max(0.2, Math.min(1, fitW, fitH)));
  }

  setViewport(aspect, fovDeg) {
    this.layoutText(aspect, fovDeg || 60);
  }

  _celebrate() {
    if (!this.fwColors) return;
    const spots = [
      [-96, 38, TEXT_Z + 46],
      [96, 44, TEXT_Z + 30],
      [0, 26, TEXT_Z + 92],
      [-52, 58, TEXT_Z + 62],
      [54, 52, TEXT_Z + 70],
      [12, 64, TEXT_Z + 120],
    ];
    for (const [ox, oy, oz] of spots)
      this._fwBurst(ox, oy, oz, this._pick(this.fwColors));
  }

  _updateSkyText(dt) {
    const t = this.time;
    const g = this.textGroup;
    const rm = this.reduceMotion;
    if (this.textReveal >= 0)
      this.textReveal = Math.min(TEXT_REVEAL + 8, this.textReveal + dt);
    const r = this.textReveal;
    const prog = r < 0 ? 0 : Math.min(1, r / TEXT_REVEAL);
    const ease = easeOutCubic(prog);
    const op = r < 0 ? 0 : smoothstep(0.04, 0.62, prog);
    const fire = Math.min(1, this.fwFlash || 0);
    const revealed = this._textDone ? 1 : op;
    const float = rm ? 0 : 1; // no hover for reduced-motion users

    // entrance: rise a touch in depth and scale up into place, then hover gently
    const depth = (1 - ease) * 12;
    g.position.y = TEXT_Y + Math.sin(t * 0.5) * 1.6 * float;
    g.position.z = TEXT_Z + depth + Math.sin(t * 0.23 + 1.1) * 2.4 * float;
    g.rotation.y = Math.PI + Math.sin(t * 0.27) * 0.022 * float;
    g.rotation.x = Math.sin(t * 0.31 + 0.6) * 0.014 * float;

    if (this.textMats) {
      for (const m of this.textMats) if (m.transparent) m.opacity = op;
      const shimmer =
        0.55 + 0.16 * Math.sin(t * 2.1) + 0.09 * Math.sin(t * 4.7 + 1.3);
      const sh = rm ? 0.62 : shimmer;
      this.textMats[0].emissiveIntensity = sh + fire * 0.7;
      this.textMats[1].emissiveIntensity = sh * 0.8 + fire * 0.5;
      this.textMats[0].envMapIntensity =
        1.2 + fire * 0.9 + (rm ? 0 : Math.sin(t * 1.3) * 0.06);
      this.textMats[1].envMapIntensity = 0.95 + fire * 0.6;
    }
    // smooth scale-up (0.86 -> 1.0) during the reveal
    if (this.textMesh) this.textMesh.scale.setScalar(0.86 + 0.14 * ease);
    if (this.textOutline) this.textOutline.material.opacity = revealed * 0.72;
    if (this.textGlow)
      this.textGlow.material.opacity =
        revealed * 0.85 * (0.82 + 0.18 * Math.sin(t * 1.6) + fire * 0.5);
    if (this.textSheen) {
      this.textSheen.material.opacity =
        revealed * (rm ? 0.3 : 0.42 * (0.55 + 0.45 * Math.sin(t * 0.9)));
      if (this.textTex && !rm) this.textTex.sheen.offset.x = (t * 0.1) % 1;
    }

    // reveal particles converge, then dissolve
    if (this.textParticles && this.textParticles.visible && r >= 0) {
      const st = this.textPState;
      const pa = this.textParticles.geometry.attributes.position.array;
      const ca = this.textParticles.geometry.attributes.color.array;
      const span = TEXT_REVEAL * 0.8;
      for (let i = 0; i < st.length; i++) {
        const p = st[i];
        const local = Math.min(1, Math.max(0, (r - p.delay) / span));
        const e = easeOutCubic(local);
        const wob = 1 - e;
        pa[i * 3] =
          p.tx + (p.sx - p.tx) * wob + Math.sin(t * 2.3 + p.ph) * 1.8 * wob;
        pa[i * 3 + 1] =
          p.ty + (p.sy - p.ty) * wob + Math.cos(t * 2.0 + p.ph) * 1.8 * wob;
        pa[i * 3 + 2] = p.tz + (p.sz - p.tz) * wob;
        const fade =
          smoothstep(0, 0.05, local) * (1 - smoothstep(0.84, 1.0, local));
        ca[i * 3] = p.cr * fade;
        ca[i * 3 + 1] = p.cg * fade;
        ca[i * 3 + 2] = p.cb * fade;
      }
      this.textParticles.geometry.attributes.position.needsUpdate = true;
      this.textParticles.geometry.attributes.color.needsUpdate = true;
      if (r > TEXT_REVEAL + 1.6) this.textParticles.visible = false;
    }

    // idle: a few gold motes drift off the finished lettering (skipped when the
    // user prefers reduced motion)
    if (this.textSparkles) {
      this.textSparkles.visible = revealed > 0.85 && !rm;
      if (this.textSparkles.visible) {
        const st = this.sparkleState;
        const pa = this.textSparkles.geometry.attributes.position.array;
        const ca = this.textSparkles.geometry.attributes.color.array;
        const tz = TEXT_DEPTH / 2 + 0.6;
        this.sparkleAcc += dt * (this.quality === "high" ? 5.5 : 3.2);
        while (this.sparkleAcc >= 1) {
          this.sparkleAcc -= 1;
          const s = st[this.sparkleNext++ % this.sparkleMax];
          const [sx, sy] = this._textSample();
          s.x = sx;
          s.y = sy;
          s.z = tz + this.textRand() * 1.2;
          s.vx = (this.textRand() - 0.5) * 1.2;
          s.vy = 0.5 + this.textRand() * 1.6;
          s.vz = (this.textRand() - 0.5) * 1.2;
          s.maxLife = 1.1 + this.textRand() * 1.3;
          s.life = s.maxLife;
          s.cr = 1;
          s.cg = 0.74 + this.textRand() * 0.22;
          s.cb = 0.34 + this.textRand() * 0.28;
        }
        for (let i = 0; i < this.sparkleMax; i++) {
          const s = st[i];
          const i3 = i * 3;
          if (s.life <= 0) {
            ca[i3] = ca[i3 + 1] = ca[i3 + 2] = 0;
            continue;
          }
          s.life -= dt;
          if (s.life <= 0) {
            ca[i3] = ca[i3 + 1] = ca[i3 + 2] = 0;
            continue;
          }
          s.vy -= 0.35 * dt;
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          s.z += s.vz * dt;
          pa[i3] = s.x;
          pa[i3 + 1] = s.y;
          pa[i3 + 2] = s.z;
          const f =
            Math.min(1, (s.life / s.maxLife) * 1.8) *
            (1 - smoothstep(0.7, 1.0, 1 - s.life / s.maxLife));
          ca[i3] = s.cr * f;
          ca[i3 + 1] = s.cg * f;
          ca[i3 + 2] = s.cb * f;
        }
        this.textSparkles.geometry.attributes.position.needsUpdate = true;
        this.textSparkles.geometry.attributes.color.needsUpdate = true;
      }
    }

    if (!this._textDone && r >= TEXT_REVEAL) {
      this._textDone = true;
      if (this.textMats)
        for (const m of this.textMats) {
          m.transparent = false;
          m.opacity = 1;
        }
      this._celebrate();
    }

    // keep a celebratory salvo framing the words
    if (this._textDone && this.fwFlash !== undefined) {
      this.celebrateNext -= dt;
      if (this.celebrateNext <= 0) {
        this.celebrateNext = 6 + this.textRand() * 5;
        this._celebrate();
      }
    }
  }
}
