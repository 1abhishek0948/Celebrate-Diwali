// ---------------------------------------------------------------------------
// island + house-interior builders (procedural low-poly, zero external assets).
// Geometry/materials are shared and reused; heavy nature elements are
// InstancedMesh batches. Every solid object registers a collider for the
// local controller, and interactive objects register an `interactable`.
//
// This is intentional placeholder-first art: clean silhouettes, flat shading,
// low draw calls — swap statics for real GLTF assets later without touching
// gameplay code (see docs/ROADMAP.md).
// ---------------------------------------------------------------------------
import * as THREE from "three";
import {
  PLAZA_RADIUS,
  FOUNTAIN,
  ROADS,
  SHOPS,
  HOUSE_PLOTS,
  HOUSE_INTERIOR,
  BEACH_BAR,
  PLAY_RADIUS,
} from "../shared/constants.js";
import { Festival } from "./festival.js";
import { makeSoilTextures } from "./soil_texture.js";

// deterministic RNG so clients render the same island for everyone
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mat = (color, extra = {}) =>
  new THREE.MeshLambertMaterial({ color, ...extra });

export class World {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.colliders = []; // {type:'aabb',x0,x1,z0,z1} | {type:'circle',x,z,r}
    this.interactables = []; // {kind,id,x,y,z,label}
    this.island = new THREE.Group();
    this.interiors = new Map(); // houseId -> Group
    this._houseTrees = []; // front-of-house palm spots, planted by _scatterNature
    this.windUniform = { value: 0 }; // drives long-grass sway (see _scatterNature)

    this._mkShared();
    // The Festival of Lights builds its geometry (and registers the tree-free
    // clearings it needs) BEFORE nature is scattered, so groves never grow
    // through the temples, townhouses or bonfire ground.
    this.festival = new Festival(this, opts);
    this._buildisland();
    for (const plot of HOUSE_PLOTS) this._buildInterior(plot);
    scene.add(this.island);
  }

  _addCollider(c) {
    this.colliders.push(c);
    return c;
  }

  _mkShared() {
    this.geo = {
      box: new THREE.BoxGeometry(1, 1, 1),
      sphere: new THREE.SphereGeometry(1, 12, 10),
      cyl: new THREE.CylinderGeometry(1, 1, 1, 10),
      cone: new THREE.ConeGeometry(1, 1, 12),
      disc: new THREE.CircleGeometry(1, 40),
      ring: new THREE.RingGeometry(1, 1, 48),
      plane: new THREE.PlaneGeometry(1, 1),
    };
    this.mats = {
      // tilled-soil ground: seamless procedural PBR set (see soil_texture.js)
      soil: (() => {
        const t = makeSoilTextures();
        return new THREE.MeshStandardMaterial({
          map: t.map,
          bumpMap: t.bumpMap,
          bumpScale: 1.15,
          roughnessMap: t.roughnessMap,
          roughness: 1,
          metalness: 0,
        });
      })(),
      soilWall: mat(0x453121), // dark earth cross-section under the beach
      sand: mat(0xdfc98d),
      water: new THREE.MeshLambertMaterial({
        color: 0x3f9ad1,
        transparent: true,
        opacity: 0.85,
      }),
      plaza: mat(0xb5b0a4),
      plazaDark: mat(0x96917f),
      road: mat(0x4a4f57),
      sidewalk: mat(0x9fa4ab),
      dash: new THREE.MeshBasicMaterial({ color: 0x8f8b7e }),
      wood: mat(0x8a623d),
      woodDark: mat(0x5f4426),
      leaf: mat(0x3f7d3c),
      leaf2: mat(0x4f9444),
      trunk: mat(0x6d4a2f),
      barkDetail: mat(0x8a6a48),
      grassBlade: new THREE.MeshLambertMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
      }),
      wall: mat(0xd9cbb2),
      wall2: mat(0xc7b49a),
      roof: mat(0xb0553f),
      roof2: mat(0x4f7d8c),
      door: mat(0x5b4326),
      // warm golden windows glowing into the festival night
      window: new THREE.MeshLambertMaterial({
        color: 0x3a2a16,
        emissive: 0xffa94d,
        emissiveIntensity: 0.9,
      }),
      // smooth (non-flat) so instance-colored canopies read as fluffy clumps
      canopy: mat(0xffffff),
      lampPole: mat(0x3c4048),
      lampBulb: new THREE.MeshBasicMaterial({ color: 0xffe9a8 }),
      awning: mat(0xd85f4a),
      cloth: mat(0xe4e0d6),
      metal: mat(0x8b93a3),
      rug: mat(0x9c5c74),
      stone: mat(0x808a91),
      cushion: mat(0xc4503f),
    };
  }

  _box(x, y, z, sx, sy, sz, material, parent = this.island) {
    const m = new THREE.Mesh(this.geo.box, material);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    parent.add(m);
    return m;
  }

  // ------------------------------------------------------------- animation --
  tick(timeMs, dt = 0.016) {
    this.windUniform.value = (timeMs % 1e7) / 1000;
    this.festival.tick(timeMs, dt);
  }

  setQuality(q) {
    this.festival.setQuality(q);
  }

  setTimeOfDay(mode) {
    this.festival.setTimeOfDay(mode);
  }

  // keeps responsive overlays (the sky greeting) fitted to the viewport
  setViewport(aspect, fovDeg) {
    this.festival.setViewport(aspect, fovDeg);
  }

  // ------------------------------------------------------------- island --
  _buildisland() {
    const G = this.island;
    const { geo, mats } = this;

    // ocean floor + island base; the top cap carries the tiled tilled-soil
    // PBR texture (cap UVs span the disc, repeat handles world-scale tiling)
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(486, 500, 2, 48),
      [mats.soilWall, mats.soil, mats.soilWall], // side, top, bottom
    );
    base.position.y = -1;
    G.add(base);

    // beach ring
    const sand = new THREE.Mesh(
      new THREE.RingGeometry(PLAY_RADIUS - 22, 486, 64),
      mats.sand,
    );
    sand.rotation.x = -Math.PI / 2;
    sand.position.y = 0.012;
    G.add(sand);

    // water ring around the island
    const water = new THREE.Mesh(
      new THREE.RingGeometry(486, 900, 64),
      mats.water,
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.25;
    G.add(water);

    // plaza
    const plaza = new THREE.Mesh(
      new THREE.CircleGeometry(PLAZA_RADIUS, 48),
      mats.plaza,
    );
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.y = 0.02;
    G.add(plaza);

    // fountain
    const fx = FOUNTAIN.x,
      fz = FOUNTAIN.z;
    const basin = new THREE.Mesh(this.geo.cyl, mats.plazaDark);
    basin.scale.set(FOUNTAIN.r, FOUNTAIN.h, FOUNTAIN.r);
    basin.position.set(fx, FOUNTAIN.h / 2, fz);
    G.add(basin);
    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(FOUNTAIN.r - 0.8, 32),
      mats.water,
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(fx, FOUNTAIN.h + 0.02, fz);
    G.add(pool);
    const spout = new THREE.Mesh(this.geo.cyl, mats.plazaDark);
    spout.scale.set(0.5, 1.6, 0.5);
    spout.position.set(fx, FOUNTAIN.h + 0.8, fz);
    G.add(spout);
    const spoutBall = new THREE.Mesh(this.geo.sphere, mats.water);
    spoutBall.scale.setScalar(0.55);
    spoutBall.position.set(fx, FOUNTAIN.h + 1.95, fz);
    G.add(spoutBall);
    this._addCollider({
      type: "circle",
      x: fx,
      z: fz,
      r: FOUNTAIN.colliderR,
      h: 2.4,
    });
    this.interactables.push({
      kind: "greet",
      id: "fountain",
      x: fx + 9,
      z: fz,
      label: "Meet at the fountain",
    });
    // benches around plaza (N/S/E/W at r 26)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this._bench(26 * Math.cos(a), 26 * Math.sin(a), -a - Math.PI / 2);
    }

    // ---------------- roads ------------------------------------------------
    // avenues stop at the ring road's inner sidewalk edge so the black
    // asphalt never overlaps the ring carriageway
    const avLenToRing =
      ROADS.ringRadius -
      ROADS.avenueHalfWidth -
      ROADS.sidewalkHalfWidth -
      PLAZA_RADIUS -
      ROADS.avenueEndGap;
    for (const axis of ["x", "z"]) {
      for (const sign of [1, -1]) {
        const center = sign * (PLAZA_RADIUS + avLenToRing / 2);
        const mS = this._box(
          axis === "x" ? center : 0,
          0.035,
          axis === "x" ? 0 : center,
          axis === "x"
            ? avLenToRing
            : 2 * (ROADS.avenueHalfWidth + ROADS.sidewalkHalfWidth),
          0.02,
          axis === "x"
            ? 2 * (ROADS.avenueHalfWidth + ROADS.sidewalkHalfWidth)
            : avLenToRing,
          mats.sidewalk,
        );
        mS.userData.noCollide = true;
        const mR = this._box(
          axis === "x" ? center : 0,
          0.05,
          axis === "x" ? 0 : center,
          axis === "x" ? avLenToRing : 2 * ROADS.avenueHalfWidth,
          0.02,
          axis === "x" ? 2 * ROADS.avenueHalfWidth : avLenToRing,
          mats.road,
        );
        mR.userData.noCollide = true;
      }
    }

    // ring road + sidewalks (created once, not once per avenue axis)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(
        ROADS.ringRadius - ROADS.avenueHalfWidth,
        ROADS.ringRadius + ROADS.avenueHalfWidth,
        72,
      ),
      mats.road,
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.045;
    G.add(ring);
    const ringWalk1 = new THREE.Mesh(
      new THREE.RingGeometry(
        ROADS.ringRadius - ROADS.avenueHalfWidth - ROADS.sidewalkHalfWidth,
        ROADS.ringRadius - ROADS.avenueHalfWidth,
        72,
      ),
      mats.sidewalk,
    );
    ringWalk1.rotation.x = -Math.PI / 2;
    ringWalk1.position.y = 0.04;
    G.add(ringWalk1);
    const ringWalk2 = new THREE.Mesh(
      new THREE.RingGeometry(
        ROADS.ringRadius + ROADS.avenueHalfWidth,
        ROADS.ringRadius + ROADS.avenueHalfWidth + ROADS.sidewalkHalfWidth,
        72,
      ),
      mats.sidewalk,
    );
    ringWalk2.rotation.x = -Math.PI / 2;
    ringWalk2.position.y = 0.04;
    G.add(ringWalk2);

    // dashes on the two avenues (instanced)
    {
      const n = 48;
      const dashes = new THREE.InstancedMesh(
        new THREE.BoxGeometry(2.4, 0.02, 0.3),
        mats.dash,
        n * 4,
      );
      const M = new THREE.Matrix4();
      let i = 0;
      for (let k = 0; k < n; k++) {
        const d = PLAZA_RADIUS + 6 + k * ((avLenToRing - 12) / (n - 1));
        for (const sign of [1, -1]) {
          M.identity();
          M.setPosition(sign * d, 0.07, 0);
          dashes.setMatrixAt(i++, M);
          M.makeRotationY(Math.PI / 2);
          M.setPosition(0, 0.07, sign * d);
          dashes.setMatrixAt(i++, M);
        }
      }
      G.add(dashes);
    }

    // street lamps (instanced parts; avoid roads & plaza & interior districts)
    {
      const rng = mulberry32(7734);
      const spots = [];
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2;
        spots.push([
          Math.cos(a) * (ROADS.ringRadius + ROADS.avenueHalfWidth + 1),
          Math.sin(a) * (ROADS.ringRadius + ROADS.avenueHalfWidth + 1),
        ]);
      }
      for (let k = 0; k < 5; k++) {
        const d = PLAZA_RADIUS + 14 + k * ((avLenToRing - 24) / 4);
        spots.push([d, 8.8]);
        spots.push([d, -8.8]);
        spots.push([8.8, d]);
        spots.push([-8.8, d]);
      }
      void rng;
      const poles = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.09, 0.12, 4.6, 8),
        mats.lampPole,
        spots.length,
      );
      const bulbs = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.28, 10, 8),
        mats.lampBulb,
        spots.length,
      );
      const M = new THREE.Matrix4();
      spots.forEach(([x, z], i) => {
        M.makeTranslation(x, 2.3, z);
        poles.setMatrixAt(i, M);
        M.makeTranslation(x, 4.75, z);
        bulbs.setMatrixAt(i, M);
      });
      G.add(poles);
      G.add(bulbs);
    }

    this._buildResidential();
    this._buildCommercial();
    this._buildPark();
    this._buildBeach();
    this._buildCommunityHalls();
    this._scatterNature();
  }

  // ------------------------------------------------------------- district --
  _buildResidential() {
    const { geo } = this;
    for (const plot of HOUSE_PLOTS) {
      const g = new THREE.Group();
      g.position.set(plot.x, 0, plot.z);
      g.rotation.y = plot.ry;
      const { hx, hz } = { hx: 5, hz: 4 };
      const body = this._box(0, 1.75, 0, 10, 3.5, 8, this.mats.wall, g);
      body.material = plot.x < 0 ? this.mats.wall : this.mats.wall2;
      const roof = new THREE.Mesh(
        new THREE.CylinderGeometry(0.01, 6.4, 3.2, 4),
        plot.x < 0 ? this.mats.roof : this.mats.roof2,
      );
      roof.rotation.y = Math.PI / 4;
      roof.position.set(0, 4.95, 0);
      roof.scale.set(1.35, 1, 1.1);
      g.add(roof);
      const doorM = new THREE.Mesh(this.geo.plane, this.mats.door);
      doorM.scale.set(1.5, 2.6, 1);
      doorM.position.set(0, 1.3, hz + 0.02);
      g.add(doorM);
      const doorknob = new THREE.Mesh(geo.sphere, this.mats.metal);
      doorknob.scale.setScalar(0.08);
      doorknob.position.set(0.5, 1.2, hz + 0.06);
      g.add(doorknob);
      for (const wx of [-3.1, 3.1]) {
        const win = new THREE.Mesh(this.geo.plane, this.mats.window);
        win.scale.set(1.7, 1.4, 1);
        win.position.set(wx, 2.1, hz + 0.02);
        g.add(win);
      }
      // lawn + path
      const lawn = new THREE.Mesh(this.geo.plane, mat(0x5b8c4c));
      lawn.rotation.x = -Math.PI / 2;
      lawn.scale.set(13, 9, 1);
      lawn.position.set(0, 0.015, 1.5);
      g.add(lawn);
      const path = new THREE.Mesh(
        new THREE.CircleGeometry(1.6, 16),
        this.mats.sidewalk,
      );
      path.rotation.x = -Math.PI / 2;
      path.position.set(0, 0.03, hz + 2.4);
      path.scale.set(1, 1.8, 1);
      g.add(path);
      // palms flanking the front path (door side faces world -z; ry = PI)
      this._houseTrees.push(
        { x: plot.x + 4.2, z: plot.z - 8.5, s: 0.85 },
        { x: plot.x - 4.2, z: plot.z - 8.5, s: 0.75 },
      );

      // garden trees at the corners (mini oak: layered blobs + branch)
      for (const tx of [-8, 8]) {
        const gRng = mulberry32(plot.x * 7919 + tx);
        const trunk = new THREE.Mesh(this.geo.cyl, this.mats.trunk);
        trunk.scale.set(0.18, 2, 0.26);
        trunk.position.set(tx, 1, -2.4);
        trunk.rotation.z = (gRng() - 0.5) * 0.12;
        g.add(trunk);
        const limb = new THREE.Mesh(this.geo.cyl, this.mats.barkDetail);
        limb.scale.set(0.07, 1.1, 0.07);
        limb.position.set(tx + 0.3, 2, -2.35);
        limb.rotation.z = 0.7;
        g.add(limb);
        const tones = [0x46a52c, 0x62c23a, 0x3a9a28, 0x74d048];
        const blobs2 = [
          [tx + 0.2, 2.35, -2.3, 1.25],
          [tx - 0.45, 2.2, -2.15, 0.95],
          [tx + 0.05, 2.75, -2.55, 0.85],
          [tx + 0.4, 1.95, -2.6, 0.7],
        ];
        blobs2.forEach(([bx, by, bz, br], i) => {
          const leaf = new THREE.Mesh(
            geo.sphere,
            mat(tones[((i + gRng() * 3) | 0) % tones.length]),
          );
          leaf.scale.set(br, br * (0.8 + gRng() * 0.25), br);
          leaf.position.set(bx, by, bz);
          g.add(leaf);
        });
      }

      this.island.add(g);
      // static AABB (roots are axis-aligned: ry is PI, so footprint stays axis-aligned)
      this._addCollider({
        type: "aabb",
        x0: plot.x - 5,
        x1: plot.x + 5,
        z0: plot.z - 4.4,
        z1: plot.z + 4.4,
        h: 5.5,
      });
      this.interactables.push({
        kind: "door",
        houseId: plot.id,
        x: plot.x,
        z: plot.z + 4.2,
        label: `Knock on ${plot.id.replace("house-", "House ")}'s door`,
      });
    }
  }

  _buildCommercial() {
    for (const s of SHOPS) {
      const g = new THREE.Group();
      g.position.set(s.x, 0, s.z);
      const body = this._box(0, s.h / 2, 0, s.w, s.h, s.d, this.mats.wall2, g);
      body.material = mat(s.color);
      // awning + sign
      const awn = this._box(
        0,
        s.h - 1.6,
        s.d / 2 + 0.7,
        s.w * 0.6,
        0.25,
        1.5,
        this.mats.awning,
        g,
      );
      awn.rotation.x = 0.18;
      const sign = new THREE.Mesh(this.geo.plane, signMaterial(s.sign));
      sign.scale.set(s.w * 0.55, 1.1, 1);
      sign.position.set(0, s.h - 0.9, s.d / 2 + 0.05);
      g.add(sign);
      const door = new THREE.Mesh(this.geo.plane, this.mats.door);
      door.scale.set(2.2, 2.8, 1);
      door.position.set(0, 1.4, s.d / 2 + 0.02);
      g.add(door);
      // windows
      for (const wx of [-s.w * 0.27, s.w * 0.27]) {
        const win = new THREE.Mesh(this.geo.plane, this.mats.window);
        win.scale.set(s.w * 0.2, 1.6, 1);
        win.position.set(wx, 2, s.d / 2 + 0.02);
        g.add(win);
      }
      this.island.add(g);
      this._addCollider({
        type: "aabb",
        x0: s.x - s.w / 2,
        x1: s.x + s.w / 2,
        z0: s.z - s.d / 2,
        z1: s.z + s.d / 2,
        h: s.h,
      });

      // ---- festive firecracker store --------------------------------------
      if (s.shop) {
        // market stands flanking the doorway, loaded with crackers
        for (const sx of [-1, 1]) {
          const cx = s.x + sx * (s.w / 2 - 1.5),
            cz = s.z + s.d / 2 + 1.4;
          this._crackerStand(cx, cz, s.x * 31 + sx * 7 + 1);
          this._addCollider({
            type: "aabb",
            x0: cx - 1.0,
            x1: cx + 1.0,
            z0: cz - 0.55,
            z1: cz + 0.55,
            h: 1.6,
          });
        }
        // glowing "crackers" marquee band above the entrance
        const band = new THREE.Mesh(
          this.geo.box,
          new THREE.MeshBasicMaterial({ color: 0xffb454 }),
        );
        band.scale.set(s.w * 0.72, 0.16, 0.12);
        band.position.set(0, s.h - 1.15, s.d / 2 + 0.14);
        g.add(band);
        // interactive: browse the shop (fires controller.onShop)
        this.interactables.push({
          kind: "shop",
          id: s.id,
          x: s.x,
          z: s.z + s.d / 2 + 4.4,
          label: `Browse ${s.sign}`,
        });
      }
    }
  }

  // A little cracker stall: clay anar, a rocket, colour-wrapped cartridges and
  // a warm marquee — all shared geometry so it stays one-draw-call friendly.
  _crackerStand(cx, cz, seed) {
    const rng = mulberry32((seed * 73856093) >>> 0);
    const g = new THREE.Group();
    g.position.set(cx, 0, cz);
    g.rotation.y = (rng() - 0.5) * 0.16;
    const wood = mat(0x7a4a28);
    const woodTop = mat(0x91603a);
    const gold = mat(0xd8a24a);
    const clay = mat(0xa1542e);
    const wrapCols = [0xd23b3b, 0x2f9e6a, 0xd8a24a, 0x7d3fb0, 0x2f7fd2];
    // trestle table
    this._box(0, 0.45, 0, 1.85, 0.14, 0.9, woodTop, g);
    for (const lx of [-0.8, 0.8])
      for (const lz of [-0.36, 0.36]) {
        this._box(lx, 0.22, lz, 0.1, 0.46, 0.1, wood, g);
      }
    // big clay anar with a gold collar
    const anar = new THREE.Mesh(this.geo.cone, clay);
    anar.scale.set(0.34, 0.62, 0.34);
    anar.position.set(-0.5, 0.83, 0.06);
    g.add(anar);
    const collar = new THREE.Mesh(this.geo.cyl, gold);
    collar.scale.set(0.19, 0.1, 0.19);
    collar.position.set(-0.5, 0.97, 0.06);
    g.add(collar);
    // a rocket standing on its stick
    const rocket = new THREE.Mesh(this.geo.cyl, mat(0xe23b3b));
    rocket.scale.set(0.09, 0.48, 0.09);
    rocket.position.set(0.2, 0.97, -0.12);
    g.add(rocket);
    const nose = new THREE.Mesh(this.geo.cone, gold);
    nose.scale.set(0.1, 0.2, 0.1);
    nose.position.set(0.2, 1.28, -0.12);
    g.add(nose);
    // rolled colour-wrapped cartridges stacked along the table
    for (let i = 0; i < 4; i++) {
      const w = new THREE.Mesh(
        this.geo.cyl,
        mat(wrapCols[i % wrapCols.length]),
      );
      w.scale.set(0.11, 0.28, 0.11);
      w.position.set(0.55 + (i % 2) * 0.24 - 0.12, 0.66, -0.3 + i * 0.2);
      g.add(w);
    }
    // warm marquee bulb over the stall
    const bulb = new THREE.Mesh(
      this.geo.sphere,
      new THREE.MeshBasicMaterial({ color: 0xffd27a }),
    );
    bulb.scale.setScalar(0.11);
    bulb.position.set(0, 1.5, 0.2);
    g.add(bulb);
    this.island.add(g);
  }

  _buildPark() {
    const px = 258,
      pz = 0;
    const pond = new THREE.Mesh(
      new THREE.CircleGeometry(14, 32),
      this.mats.water,
    );
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(px + 10, 0.03, pz);
    this.island.add(pond);
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(14, 15.6, 40),
      this.mats.stone,
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(px + 10, 0.04, pz);
    this.island.add(rim);
    this._addCollider({ type: "circle", x: px + 10, z: pz, r: 15.4, h: 0.6 });

    // benches
    this._bench(px, pz + 18, Math.PI);
    this._bench(px - 4, pz - 18, 0);
    this._bench(ROADS.ringRadius - 16, pz + 44, -Math.PI / 2);

    // flower beds
    const rng = mulberry32(2007);
    const cols = [0xf26d6d, 0xf2b23f, 0xc866d8, 0xf7f7f7];
    for (let b = 0; b < 6; b++) {
      const bx = px + 26 * Math.cos(b * 1.05),
        bz = pz + 26 * Math.sin(b * 1.05);
      const bed = new THREE.Mesh(
        new THREE.CircleGeometry(2.6, 18),
        mat(0x77502e),
      );
      bed.rotation.x = -Math.PI / 2;
      bed.position.set(bx, 0.03, bz);
      this.island.add(bed);
      for (let i = 0; i < 7; i++) {
        const fy = new THREE.Mesh(
          this.geo.sphere,
          mat(cols[(b + i) % cols.length]),
        );
        fy.scale.setScalar(0.22 + rng() * 0.12);
        fy.position.set(bx + (rng() - 0.5) * 4, 0.18, bz + (rng() - 0.5) * 4);
        this.island.add(fy);
      }
    }
  }

  _buildBeach() {
    const { geo } = this;
    const bar = BEACH_BAR;
    const g = new THREE.Group();
    g.position.set(bar.x, 0, bar.z);
    const base = this._box(0, 1.3, 0, 10, 2.6, 6, this.mats.wood, g);
    base.material = this.mats.wood;
    const roof = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 6.6, 2.6, 6),
      mat(0x8a6d3b),
    );
    roof.position.set(0, 3.9, 0);
    g.add(roof);
    const counter = this._box(0, 1.2, 3.2, 8, 0.3, 0.4, this.mats.woodDark, g);
    void counter;
    this.island.add(g);
    this._addCollider({
      type: "aabb",
      x0: bar.x - 5,
      x1: bar.x + 5,
      z0: bar.z - 3.2,
      z1: bar.z + 3.6,
      h: 4.5,
    });
    this.interactables.push({
      kind: "greet",
      id: "beachbar",
      x: bar.x,
      z: bar.z + 5,
      label: "Order a drink (hang out)",
    });

    // umbrellas + towels
    const rng = mulberry32(555);
    const towels = [0xe2574c, 0x35d0c5, 0xf2b23f, 0x9a7fd8];
    for (let i = 0; i < 8; i++) {
      const ux = -310 + rng() * 60,
        uz = -80 + rng() * 180;
      if (Math.hypot(ux, uz) < 260) continue;
      const pole = new THREE.Mesh(this.geo.cyl, this.mats.metal);
      pole.scale.set(0.05, 2.4, 0.05);
      pole.position.set(ux, 1.2, uz);
      this.island.add(pole);
      const um = new THREE.Mesh(geo.cone, mat(towels[i % towels.length]));
      um.scale.set(2.2, 0.9, 2.2);
      um.position.set(ux, 2.5, uz);
      this.island.add(um);
      const towel = new THREE.Mesh(
        this.geo.plane,
        mat(towels[(i + 1) % towels.length]),
      );
      towel.rotation.x = -Math.PI / 2;
      towel.scale.set(1.3, 2.4, 1);
      towel.position.set(ux + (rng() - 0.5) * 4, 0.02, uz + 3.4);
      this.island.add(towel);
    }
    // palm trees along the shore
    const palms = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.16, 0.28, 0, 7),
      this.mats.trunk,
      40,
    );
    let idx = 0;
    const palmHead = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1.8, 2.6, 6),
      this.mats.leaf,
      40,
    );
    for (let i = 0; i < 60; i++) {
      const a = rng() * Math.PI * 2;
      const r = PLAY_RADIUS - 26 - rng() * 8;
      const px2 = Math.cos(a) * r,
        pz2 = Math.sin(a) * r;
      if (Math.hypot(px2 - bar.x, pz2 - bar.z) < 14) continue;
      if (idx >= 40) break;
      const M = new THREE.Matrix4();
      M.makeRotationZ((rng() - 0.5) * 0.3);
      M.setPosition(px2, 1.6, pz2);
      palms.setMatrixAt(idx, M);
      M.makeTranslation(px2, 3.4, pz2);
      palmHead.setMatrixAt(idx, M);
      idx++;
    }
    palms.count = idx;
    palmHead.count = idx;
    if (palms.computeBoundingSphere) {
      palms.computeBoundingSphere();
      palmHead.computeBoundingSphere();
    }
    this.island.add(palms);
    this.island.add(palmHead);
  }

  _bench(x, z, ry) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    const seat = this._box(0, 0.45, 0, 1.8, 0.09, 0.52, this.mats.wood, g);
    void seat;
    const back = this._box(0, 0.75, -0.24, 1.8, 0.5, 0.07, this.mats.wood, g);
    void back;
    for (const lx of [-0.7, 0.7]) {
      const leg = this._box(
        lx,
        0.21,
        0,
        0.09,
        0.42,
        0.4,
        this.mats.woodDark,
        g,
      );
      void leg;
    }
    this.island.add(g);
  }

  // ------------------------------------------------------- community halls --
  // One hang-out hall toward each compass point, just outside the ring road,
  // each facing the plaza. Their yards are registered as tree clearings.
  _buildCommunityHalls() {
    const halls = [
      { id: "hall-n", x: 0, z: 230, ry: Math.PI }, // faces back toward plaza
      { id: "hall-e", x: 230, z: 0, ry: -Math.PI / 2 },
      { id: "hall-s", x: 0, z: -230, ry: 0 },
      { id: "hall-w", x: -230, z: 0, ry: Math.PI / 2 },
    ];
    for (const h of halls) {
      const g = new THREE.Group();
      g.position.set(h.x, 0, h.z);
      g.rotation.y = h.ry;
      const body = this._box(0, 2.6, 0, 22, 5.2, 14, this.mats.wall, g);
      body.material = this.mats.wall2;
      const roof = new THREE.Mesh(
        new THREE.CylinderGeometry(0.01, 13.5, 3, 4),
        this.mats.roof2,
      );
      roof.rotation.y = Math.PI / 4;
      roof.position.set(0, 6.7, 0);
      roof.scale.set(1.25, 1, 0.95);
      g.add(roof);
      const door = new THREE.Mesh(this.geo.plane, this.mats.door);
      door.scale.set(3, 3.4, 1);
      door.position.set(0, 1.7, 7.05);
      g.add(door);
      for (const wx of [-7, 7]) {
        const win = new THREE.Mesh(this.geo.plane, this.mats.window);
        win.scale.set(2.6, 1.8, 1);
        win.position.set(wx, 3, 7.03);
        g.add(win);
      }
      const sign = new THREE.Mesh(this.geo.plane, signMaterial("COMMUNITY HALL"));
      sign.scale.set(9, 1.4, 1);
      sign.position.set(0, 5.6, 7.08);
      g.add(sign);
      // festive bulb row over the entrance
      for (let i = -3; i <= 3; i++) {
        const bulb = new THREE.Mesh(this.geo.sphere, this.mats.lampBulb);
        bulb.scale.setScalar(0.16);
        bulb.position.set(i * 1.6, 4.6 + (i % 2 ? 0 : 0.3), 7.15);
        g.add(bulb);
      }
      this.island.add(g);
      // ry is a multiple of 90°, so the rotated footprint stays axis-aligned
      const along = Math.abs(Math.sin(h.ry)) > 0.5;
      const ex = along ? 7 : 11;
      const ez = along ? 11 : 7;
      this._addCollider({
        type: "aabb",
        x0: h.x - ex,
        x1: h.x + ex,
        z0: h.z - ez,
        z1: h.z + ez,
        h: 7,
      });
      const dx = Math.sin(h.ry),
        dz = Math.cos(h.ry);
      this.interactables.push({
        kind: "greet",
        id: h.id,
        x: h.x + dx * 9,
        z: h.z + dz * 9,
        label: "Hang out at the community hall",
      });
      // keep the scattered forest out of the hall yard
      this.festival.clearings.push({ x: h.x, z: h.z, r: 24 });
    }
  }

  // is (x,z) free of roads/plaza/pond/buildings/bar? shared by trees & grass
  _natureSpotOk(x, z) {
    const r = Math.hypot(x, z);
    if (r > PLAY_RADIUS - 6 || r < PLAZA_RADIUS + 8) return false;
    // keep festival structures (pagodas, townhouses, bonfire) clear of trees
    for (const c of this.festival.clearings) {
      if (Math.hypot(x - c.x, z - c.z) < c.r) return false;
    }
    const sw = ROADS.avenueHalfWidth + ROADS.sidewalkHalfWidth + 1.2;
    if (Math.abs(z) < sw && Math.abs(x) < ROADS.ringRadius + 8 && Math.abs(x) > 34)
      return false;
    if (Math.abs(x) < sw && Math.abs(z) < ROADS.ringRadius + 8 && Math.abs(z) > 34)
      return false;
    if (
      Math.abs(r - ROADS.ringRadius) <
      ROADS.avenueHalfWidth + ROADS.sidewalkHalfWidth + 2
    )
      return false;
    if (Math.hypot(x - 258, z) < 20) return false; // pond
    if (z < -110 && z > -140 && x > -70 && x < 70) return false; // shops
    // house rows: north 1/2 + corner extensions, east/west columns, south rows
    if (z > 124 && z < 140 && Math.abs(x) > 52 && Math.abs(x) < 142)
      return false; // north row 1
    if (z > 244 && z < 260 && Math.abs(x) > 52 && Math.abs(x) < 142)
      return false; // north row 2
    if (Math.abs(x - 132) < 9 && Math.abs(z) > 52 && Math.abs(z) < 99)
      return false; // east column
    if (Math.abs(x + 132) < 9 && Math.abs(z) > 52 && Math.abs(z) < 99)
      return false; // west column
    if (z > -141 && z < -123 && Math.abs(x) > 80 && Math.abs(x) < 100)
      return false; // south row 1
    if (z > -261 && z < -243 && Math.abs(x) > 80 && Math.abs(x) < 100)
      return false; // south row 2
    if (Math.hypot(x - BEACH_BAR.x, z - BEACH_BAR.z) < 16) return false;
    if (Math.hypot(x, z) < FOUNTAIN.colliderR + 3) return false;
    return true;
  }

  // a single tapering grass blade (unit height, bends toward +z at the tip)
  _bladeGeometry() {
    const g = new THREE.BufferGeometry();
    const pos = [
      -0.07,
      0,
      0,
      0.07,
      0,
      0, // base
      -0.04,
      0.5,
      0.07,
      0.04,
      0.5,
      0.07,
      0,
      1.0,
      0.22, // tip
    ];
    const idx = [0, 1, 3, 0, 3, 2, 2, 3, 4];
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // a drooping palm frond: unit strip along +z, the tip sagging toward -y
  _frondGeometry() {
    const g = new THREE.BufferGeometry();
    const pos = [
      -0.16, 0, 0, 0.16, 0, 0, // base pair
      -0.11, -0.16, 1.05, 0.11, -0.16, 1.05,
      -0.06, -0.46, 1.95, 0.06, -0.46, 1.95,
      0, -0.72, 2.6, // tip
    ];
    const idx = [0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4, 4, 5, 6];
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  _scatterNature() {
    const rng = mulberry32(1234);
    const M = new THREE.Matrix4();
    const S = new THREE.Matrix4();
    const Q = new THREE.Quaternion();
    const V = new THREE.Vector3();
    const pick = (a) => a[(rng() * a.length) | 0];
    const tint = (h, sat, li, hs, ss, ls) =>
      new THREE.Color().setHSL(
        h + (rng() - 0.5) * hs,
        sat + (rng() - 0.5) * ss,
        li + (rng() - 0.5) * ls,
      );

    // gather instances; a few InstancedMesh batches total so draw calls stay low
    const trunks = [],
      branches = [],
      blobs = [],
      pineTiers = [],
      fronds = [],
      blades = [];
    const SC = new THREE.Vector3();
    const push = (list, x, y, z, sx, sy, sz, tiltZ, ry, color) => {
      Q.setFromEuler(new THREE.Euler((rng() - 0.5) * 0.06, ry, tiltZ));
      M.compose(V.set(x, y, z), Q, SC.set(sx, sy, sz));
      list.push({ M: M.clone(), c: color });
    };

    // ---- tree spots: clustered groves + scattered singles -------------------
    const spots = [];
    const minDist = (list, x, z, d) =>
      list.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < d);

    // grove centers (woodland clusters)
    const groves = [];
    let gTries = 0;
    while (groves.length < 150 && gTries++ < 6000) {
      const x = (rng() - 0.5) * 2 * 400,
        z = (rng() - 0.5) * 2 * 400;
      if (!this._natureSpotOk(x, z) || minDist(groves, x, z, 26)) continue;
      groves.push([x, z]);
    }
    for (const [gx, gz] of groves) {
      const n = 3 + ((rng() * 3) | 0);
      for (let i = 0; i < n; i++) {
        const x = gx + (rng() - 0.5) * 17,
          z = gz + (rng() - 0.5) * 17;
        if (!this._natureSpotOk(x, z) || minDist(spots, x, z, 3.4)) continue;
        spots.push([x, z, rng()]);
      }
      // soft grass floor under the grove
      for (let i = 0, n2 = 30 + ((rng() * 24) | 0); i < n2; i++) {
        const a = rng() * Math.PI * 2,
          rad = 2 + rng() * 10;
        push(
          blades,
          gx + Math.cos(a) * rad,
          0,
          gz + Math.sin(a) * rad,
          0.7 + rng() * 0.7,
          0.85 + rng() * 0.6,
          0.7 + rng() * 0.7,
          (rng() - 0.5) * 0.3,
          rng() * 6.3,
          tint(0.29, 0.5, 0.24, 0.05, 0.16, 0.07),
        );
      }
    }

    // scattered standalone trees between the groves
    let tTries = 0;
    while (spots.length < 560 && tTries++ < 5600) {
      const x = (rng() - 0.5) * 2 * 430;
      const z = (rng() - 0.5) * 2 * 430;
      if (!this._natureSpotOk(x, z) || minDist(spots, x, z, 13)) continue;
      spots.push([x, z, rng()]); // third slot: pre-rolled species roll
    }

    // plant one tree of `kind` ('oak' | 'pine' | 'palm' | 'small') at (x, z);
    // sc scales the whole plant. Shared by the scattered forest, the plaza
    // palm ring and the house-front palms.
    const plantTree = (x, z, kind, sc = 1) => {
      const isPine = kind === "pine";
      const isSmall = kind === "small";
      const h =
        (isPine
          ? 7 + rng() * 2.5
          : isSmall
            ? 3.1 + rng() * 1
            : 4.6 + rng() * 2.6) * sc;
      const trunkTint = tint(0.065, 0.42, 0.32, 0.02, 0.08, 0.06);

      if (kind === "palm") {
        // segmented, slightly leaning trunk + a fan of drooping fronds
        const H = (7 + rng() * 2.5) * sc;
        const lean = 0.04 + rng() * 0.05;
        const segs = 5;
        for (let i = 0; i < segs; i++) {
          const f = (i + 0.5) / segs;
          const r = (0.3 - f * 0.12) * (i % 2 ? 1.14 : 1); // ring bulges
          push(
            trunks,
            x,
            H * f,
            z,
            r,
            (H / segs) * 1.18,
            r,
            lean,
            rng() * 6.3,
            tint(0.07, 0.5, 0.34, 0.02, 0.06, 0.05),
          );
        }
        const crownY = H * 1.04;
        for (let i = 0; i < 8; i++) {
          const ry2 = (i / 8) * Math.PI * 2 + rng() * 0.35;
          Q.setFromEuler(new THREE.Euler(0.45 + rng() * 0.3, ry2, 0));
          M.compose(V.set(x, crownY, z), Q, SC.set(sc, sc, sc));
          fronds.push({
            M: M.clone(),
            c: tint(0.3, 0.66, 0.33, 0.02, 0.08, 0.05),
          });
        }
        // grass skirt around the roots
        for (let i = 0, n = 5 + ((rng() * 4) | 0); i < n; i++) {
          const a = rng() * Math.PI * 2,
            rad = 0.5 + rng() * 1.2;
          push(
            blades,
            x + Math.cos(a) * rad,
            0,
            z + Math.sin(a) * rad,
            0.9,
            1.1,
            0.9,
            (rng() - 0.5) * 0.3,
            rng() * 6.3,
            tint(0.3, 0.6, 0.28, 0.03, 0.1, 0.05),
          );
        }
        this._addCollider({ type: "circle", x, z, r: 0.3 });
        return;
      }

      if (isPine) {
        // conifer: short visible trunk + 4 stacked frond cones, lighter at top
        push(
          trunks,
          x,
          h * 0.18,
          z,
          0.18 + rng() * 0.06,
          h * 0.42,
          0.18 + rng() * 0.06,
          0,
          rng() * 6.3,
          trunkTint,
        );
        const tiers = 4;
        for (let t = 0; t < tiers; t++) {
          const f = t / (tiers - 1); // 0 bottom .. 1 top
          const tr = (1.9 - f * 1.35) * (0.85 + rng() * 0.3);
          const th = h * (0.34 - f * 0.1);
          const ty = h * 0.2 + f * (h - th) * 0.78;
          push(
            pineTiers,
            x,
            ty,
            z,
            tr,
            th,
            tr,
            0,
            rng() * 6.3,
            tint(0.36, 0.62, 0.2 + f * 0.1, 0.02, 0.08, 0.05),
          );
        }
      } else {
        const isTall = kind === "oak";
        const spread = isTall ? 2.6 : isSmall ? 0.95 : 1.5;

        push(
          trunks,
          x,
          h / 2,
          z,
          (isTall ? 0.32 : 0.22) + rng() * 0.1,
          h,
          (isTall ? 0.32 : 0.22) + rng() * 0.1,
          (rng() - 0.5) * 0.05,
          rng() * 6.3,
          trunkTint,
        );

        const crown = h + spread * 0.3;

        // branches peeking out under the canopy (tall trees only)
        if (isTall) {
          const nb = 2;
          for (let b = 0; b < nb; b++) {
            const ba = b * Math.PI + rng() * 0.6;
            push(
              branches,
              x + Math.cos(ba) * 0.25,
              crown - 0.5,
              z + Math.sin(ba) * 0.25,
              0.55,
              1.1 + rng() * 0.8,
              0.55,
              0.95 + rng() * 0.4,
              ba,
              trunkTint,
            );
          }
        }

        // fluffy cartoon canopy: clumps of smooth spheres ringing the crown,
        // lit from above (lighter greens up top, deeper greens below)
        const nClumps = isSmall ? 4 : 6 + ((rng() * 4) | 0);
        for (let i = 0; i < nClumps; i++) {
          const a = (i / nClumps) * Math.PI * 2 + rng() * 0.9;
          const rr = spread * (0.35 + rng() * 0.55);
          const up = crown + (rng() - 0.45) * spread * 0.9;
          const br = spread * (0.45 + rng() * 0.5);
          const lit = Math.max(-1, Math.min(1, (up - crown) / spread));
          push(
            blobs,
            x + Math.cos(a) * rr,
            up,
            z + Math.sin(a) * rr,
            br,
            br * (0.8 + rng() * 0.25),
            br,
            0,
            rng() * 6.3,
            tint(
              0.28 + lit * 0.02,
              0.68 + lit * 0.08,
              0.26 + lit * 0.09,
              0.03,
              0.08,
              0.05,
            ),
          );
        }
        // bright crown cap tying the clumps together
        push(
          blobs,
          x,
          crown + spread * 0.55,
          z,
          spread * 0.9,
          spread * 0.55,
          spread * 0.9,
          0,
          rng() * 6.3,
          tint(0.29, 0.72, 0.36, 0.02, 0.06, 0.04),
        );
      }

      // tree colliders (thin circle per trunk; sparse for free walking)
      if (rng() < 0.6)
        this._addCollider({
          type: "circle",
          x,
          z,
          r: isPine ? 0.3 : 0.42,
        });

      // long grass tufts at the base of the tree
      for (let i = 0, n2 = 8 + ((rng() * 8) | 0); i < n2; i++) {
        const a = rng() * Math.PI * 2,
          rad = 0.6 + rng() * 3.2;
        const gx = x + Math.cos(a) * rad,
          gz = z + Math.sin(a) * rad;
        if (!this._natureSpotOk(gx, gz)) continue;
        push(
          blades,
          gx,
          0,
          gz,
          0.8 + rng() * 0.7,
          0.95 + rng() * 0.6,
          0.8 + rng() * 0.7,
          (rng() - 0.5) * 0.25,
          rng() * 6.3,
          tint(0.29, 0.5, 0.24, 0.05, 0.16, 0.07),
        );
      }
    };

    for (const [x, z, roll] of spots) {
      plantTree(x, z, roll < 0.3 ? "pine" : roll > 0.94 ? "small" : "oak");
    }

    // showcase palms: a ring around the central plaza…
    for (let k = 0; k < 8; k++) {
      const a = (k + 0.5) * (Math.PI / 4);
      plantTree(Math.cos(a) * 54, Math.sin(a) * 54, "palm", k % 2 ? 1.15 : 1);
    }
    // …and two flanking every house's front path
    for (const t of this._houseTrees || []) plantTree(t.x, t.z, "palm", t.s);

    // tall-grass meadows: dense grassy fields you can wade through
    const fields = [];
    let fTries = 0;
    while (fields.length < 90 && fTries++ < 5000) {
      const x = (rng() - 0.5) * 2 * 430,
        z = (rng() - 0.5) * 2 * 430;
      if (!this._natureSpotOk(x, z) || minDist(fields, x, z, 18)) continue;
      fields.push([x, z]);
    }
    for (const [fx, fz] of fields) {
      const n2 = 150 + ((rng() * 100) | 0);
      for (let i = 0; i < n2; i++) {
        const a = rng() * Math.PI * 2,
          rad = Math.sqrt(rng()) * 10;
        push(
          blades,
          fx + Math.cos(a) * rad,
          0,
          fz + Math.sin(a) * rad,
          0.8 + rng() * 0.7,
          0.9 + rng() * 0.7,
          0.8 + rng() * 0.7,
          (rng() - 0.5) * 0.3,
          rng() * 6.3,
          tint(0.29, 0.5, 0.25, 0.05, 0.16, 0.07),
        );
      }
    }

    // ---- build the batches ---------------------------------------------------
    const buildBatch = (geo, material, list) => {
      const im = new THREE.InstancedMesh(geo, material, list.length);
      list.forEach((it, i) => {
        im.setMatrixAt(i, it.M);
        if (it.c) im.setColorAt(i, it.c);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      // instanced bounds: geometry sphere alone would wrongly cull the batch
      if (im.computeBoundingSphere) im.computeBoundingSphere();
      else im.frustumCulled = false;
      return im;
    };

    const barkGeo = new THREE.CylinderGeometry(0.35, 0.5, 1, 7); // tapered by scale.y
    const branchGeo = new THREE.CylinderGeometry(0.05, 0.11, 1, 5);
    const blobGeo = new THREE.SphereGeometry(1, 10, 8); // smooth fluffy clumps
    const conePine = new THREE.ConeGeometry(1, 1, 9); // pine frond tier
    const frondGeo = this._frondGeometry(); // palm fronds
    const bladeGeo = this._bladeGeometry();

    // wind sway: bend the blades with an injected vertex-shader wave
    this.mats.grassBlade.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.windUniform;
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uTime;")
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec4 gw = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            float gsway = sin(uTime * 1.6 + gw.x * 0.32 + gw.z * 0.18) * 0.055
                        + sin(uTime * 3.1 + gw.z * 0.5 + gw.x * 0.13) * 0.02;
            float gy = max(transformed.y, 0.0);
            transformed.x += gsway * gy * gy * 3.0;
            transformed.z += gsway * gy * gy * 1.4;
          #endif`,
        );
    };

    this.island.add(buildBatch(barkGeo, this.mats.trunk, trunks));
    this.island.add(buildBatch(branchGeo, this.mats.barkDetail, branches));
    this.island.add(buildBatch(blobGeo, this.mats.canopy, blobs));
    this.island.add(buildBatch(conePine, this.mats.canopy, pineTiers));
    this.island.add(buildBatch(frondGeo, this.mats.grassBlade, fronds));
    this.island.add(buildBatch(bladeGeo, this.mats.grassBlade, blades));
  }

  // ------------------------------------------------------- house interiors --
  _buildInterior(plot) {
    const g = new THREE.Group();
    g.visible = false;
    const I = HOUSE_INTERIOR;
    const { halfX, halfZ, wallH } = I;

    const floor = new THREE.Mesh(this.geo.plane, mat(0xb98f5e));
    floor.rotation.x = -Math.PI / 2;
    floor.scale.set(halfX * 2, halfZ * 2, 1);
    floor.position.y = 0.01;
    g.add(floor);

    const rug = new THREE.Mesh(
      new THREE.CircleGeometry(2.4, 24),
      this.mats.rug,
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, 0.02, -0.6);
    g.add(rug);

    // back wall + side walls (front wall split around the door)
    const wall = mat(0xf0e3cd);
    this._iw(g, wall, 0, wallH / 2, -halfZ, halfX * 2, wallH); // back
    this._iw(g, wall, -halfX, wallH / 2, 0, wallH, halfZ * 2); // left
    this._iw(g, wall, halfX, wallH / 2, 0, wallH, halfZ * 2); // right
    const frontHalf = (halfX - 1.4) / 2;
    this._iw(
      g,
      wall,
      -(1.4 + frontHalf),
      wallH / 2,
      halfZ,
      frontHalf * 2,
      wallH,
    );
    this._iw(g, wall, 1.4 + frontHalf, wallH / 2, halfZ, frontHalf * 2, wallH);
    this._iw(g, wall, 0, wallH + 0.5, halfZ, 2.8, 1); // door header

    // windows (emissive planes) on back wall
    for (const wx of [-3.4, 3.4]) {
      const win = new THREE.Mesh(this.geo.plane, this.mats.window);
      win.scale.set(1.9, 1.5, 1);
      win.position.set(wx, 1.6, -halfZ + 0.04);
      g.add(win);
    }

    // Interior furniture remains decorative.
    I.seats.forEach((seat) => {
      const fx = seat.type === "couch" ? 2.6 : seat.x * 1;
      void fx;
      if (seat.type === "couch") {
        this._box(
          seat.x - 0.1,
          0.42,
          seat.z,
          1,
          0.36,
          2.2,
          this.mats.woodDark,
          g,
        );
        for (const oz of [-0.62, 0.62]) {
          const sz = seat.z + oz;
          const backrest = this._box(
            seat.x - 0.42,
            0.75,
            sz,
            0.3,
            0.65,
            0.92,
            this.mats.cushion,
            g,
          );
          void backrest;
        }
      } else {
        this._box(seat.x, 0.24, seat.z, 0.9, 0.09, 0.9, this.mats.wood, g);
        this._box(
          seat.x,
          0.62,
          seat.z - 0.4,
          0.9,
          0.8,
          0.12,
          this.mats.woodDark,
          g,
        );
        for (const ox of [-0.4, 0.4]) {
          this._box(
            seat.x + ox,
            0.36,
            seat.z + 0.4,
            0.08,
            0.35,
            0.08,
            this.mats.woodDark,
            g,
          );
          this._box(
            seat.x + ox,
            0.36,
            seat.z - 0.4,
            0.08,
            0.35,
            0.08,
            this.mats.woodDark,
            g,
          );
        }
      }
      const seatPad = new THREE.Mesh(this.geo.box, this.mats.cushion);
      seatPad.scale.set(0.8, 0.12, 0.8);
      seatPad.position.set(seat.x, 0.32, seat.z);
      g.add(seatPad);
    });

    // table + lamp for life
    this._box(0.4, 0.5, -2.2, 1.6, 0.08, 1, this.mats.woodDark, g);
    const lampP = new THREE.Mesh(this.geo.cyl, this.mats.lampPole);
    lampP.scale.set(0.06, 1.2, 0.06);
    lampP.position.set(-5.8, 0.6 + 0, -halfZ + 0.8);
    g.add(lampP);
    const lampShade = new THREE.Mesh(this.geo.cone, this.mats.lampBulb);
    lampShade.scale.set(0.5, 0.55, 0.5);
    lampShade.position.set(-5.8, 1.5, -halfZ + 0.8);
    g.add(lampShade);
    // warm interior light (only the visible interior contributes, so this is
    // effectively one active point light while indoors, even at night)
    const roomLight = new THREE.PointLight(0xffd9a0, 1.1, 16, 2);
    roomLight.position.set(0, wallH - 0.3, 0);
    g.add(roomLight);

    // door exit marker (green glow strip at the doorway)
    const ex = new THREE.Mesh(
      this.geo.plane,
      new THREE.MeshBasicMaterial({
        color: 0x35d0c5,
        transparent: true,
        opacity: 0.6,
      }),
    );
    ex.scale.set(2.6, 0.12, 1);
    ex.position.set(I.door.x, 0.06, I.door.z - 0.3);
    g.add(ex);

    this.interiors.set(plot.id, g);
    this.scene.add(g);
  }

  // interior wall (no collider — one-way prototype walls; documented)
  _iw(parent, material, x, y, z, sx, sz) {
    const w = new THREE.Mesh(this.geo.box, material);
    w.scale.set(sx, y * 2, sz);
    w.position.set(x, y, z);
    parent.add(w);
  }

  // rooms ---------------------------------------------------------------------
  showisland() {
    this.island.visible = true;
    for (const g of this.interiors.values()) g.visible = false;
  }
  showInterior(houseId) {
    this.island.visible = false;
    for (const [id, g] of this.interiors) g.visible = id === houseId;
  }
}

// ---------------------------------------------------------------- utility ---
function signMaterial(text) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 96;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#22304e";
  ctx.fillRect(0, 0, 512, 96);
  ctx.fillStyle = "#ffe6b8";
  ctx.font = 'bold 54px "Avenir Next", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 52);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 2;
  return new THREE.MeshBasicMaterial({ map: tex });
}
