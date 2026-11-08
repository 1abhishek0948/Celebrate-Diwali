// ---------------------------------------------------------------------------
// Diwali Meet Up shared constants + island layout data.
// Imported by BOTH the Node server (ESM) and the browser client (import map),
// so movement limits, room geometry and door positions can never drift apart.
// All units are metres / seconds; Y is up.
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 3;

// --- Tick rates -------------------------------------------------------------
export const TICK_HZ = 20; // server broadcast rate (snapshots)
export const TICK_MS = 1000 / TICK_HZ;
export const SEND_HZ = 15; // client state send rate
export const SNAPSHOT_BUFFER = 110; // client interpolation delay (ms)

// --- Movement limits (server enforces, client plays) -------------------------
export const WALK_SPEED = 3.2;
export const RUN_SPEED = 6.0;
export const MAX_SPEED = 6.6; // absolute server clamp (a bit of tolerance + speed pads)
export const JUMP_SPEED = 5.4;
export const GRAVITY = 14.0;
export const GROUND_Y = 0.0;

// --- World -----------------------------------------------------------------
export const WORLD_HALF = 500; // 1000m x 1000m target world
// Cozy island: the plaza and every interactive place (shops, house plots,
// beach bar) keep their exact positions; only the empty outer ring of the
// island is trimmed, which cuts the amount of scenery rendered every frame.
export const ISLAND_RADIUS = 330; // visual island/beach edge
export const PLAY_RADIUS = 300; // soft radial clamp of the main island
export const INTEREST_RADIUS = 80; // send remote updates within this distance
export const MAX_PLAYERS_PER_island = 100; // hard cap per island room (see LOADTEST report)

// --- Voice ------------------------------------------------------------------
// Room-wide voice: everyone in the same island/house room is connected with no
// distance attenuation. The mesh is capped for device safety; if a room grows
// past the cap, the nearest peers are connected first.
export const MAX_VOICE_PEERS = 16;

// --- Rate limits / basic security -------------------------------------------
export const CHAT_RATE_PER_S = 3; // messages per rolling 5s window
export const CHAT_MAX_LEN = 200;
export const MSG_RATE_PER_S = 80; // any opcode frames per rolling 2s window (per socket)
export const MAX_MSG_BYTES = 16 * 1024;

// --- island layout ----------------------------------------------------------
// Main avenues + ring road (drawn by client, walk area implied on both sides).
export const ROADS = {
  avenueHalfWidth: 6, // asphalt half width
  sidewalkHalfWidth: 1.6, // sidewalk band half width around asphalt
  ringRadius: 210,
  // pull the ends of the main avenues back from the ring road by this many units
  avenueEndGap: 7,
};

// Plaza at origin
export const PLAZA_RADIUS = 40;
export const FOUNTAIN = { x: 0, z: 0, r: 6, h: 1.1, colliderR: 6.4 };

// Spawn points (ring around plaza edge)
export const SPAWN_POINTS = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2;
  return { x: Math.cos(a) * 30, y: 0, z: Math.sin(a) * 30 };
});

// --- AABB colliders (client-side collision; server spot-checks only) ---------
// Producer helpers keep this in sync with the visual builders.
export function houseHalfSize() {
  return { hx: 5, hz: 4 };
}

// Residential plots. The original rows sit along the north streets; the
// expanded island adds rows on the east (right), west (left) and south
// (front) sides so the playable area is ringed by houses on all sides.
// ry: Math.PI keeps every footprint axis-aligned (see world._buildResidential)
// and keeps plotDoorPos()/door triggers consistent for the server.
export const HOUSE_PLOTS = [
  // north (back) rows — original island
  { id: "house-1", x: -90, z: 132, ry: Math.PI }, // faces street to the south
  { id: "house-2", x: -60, z: 132, ry: Math.PI },
  { id: "house-3", x: 60, z: 132, ry: Math.PI },
  { id: "house-4", x: 90, z: 132, ry: Math.PI },
  { id: "house-5", x: -90, z: 252, ry: Math.PI },
  { id: "house-6", x: 90, z: 252, ry: Math.PI },
  { id: "house-7", x: -60, z: 252, ry: Math.PI },
  { id: "house-8", x: 60, z: 252, ry: Math.PI },
  // north row extension (outside the ±90 corners)
  { id: "house-9", x: -132, z: 132, ry: Math.PI },
  { id: "house-10", x: 132, z: 132, ry: Math.PI },
  { id: "house-11", x: -132, z: 252, ry: Math.PI },
  { id: "house-12", x: 132, z: 252, ry: Math.PI },
  // east (right) column — clear of the +x avenue (|z| > 8) and the ring road
  { id: "house-13", x: 132, z: 90, ry: Math.PI },
  { id: "house-14", x: 132, z: 60, ry: Math.PI },
  { id: "house-15", x: 132, z: -60, ry: Math.PI },
  { id: "house-16", x: 132, z: -90, ry: Math.PI },
  // west (left) column — clear of the beach bar and bonfire
  { id: "house-17", x: -132, z: 90, ry: Math.PI },
  { id: "house-18", x: -132, z: 60, ry: Math.PI },
  { id: "house-19", x: -132, z: -60, ry: Math.PI },
  { id: "house-20", x: -132, z: -90, ry: Math.PI },
  // south (front) rows — flanking the commercial street, clear of the shops
  { id: "house-21", x: -90, z: -132, ry: Math.PI },
  { id: "house-22", x: 90, z: -132, ry: Math.PI },
  { id: "house-23", x: -90, z: -252, ry: Math.PI },
  { id: "house-24", x: 90, z: -252, ry: Math.PI },
];

// Door world position of each plot (registered server-side as trigger zones).
export function plotDoorPos(plot) {
  return { x: plot.x, z: plot.z + 4.2 };
}

// --- House interior (private room) ------------------------------------------
// All interiors are procedurally built on the CLIENT in a hidden group;
// server only needs geometry-independent data (spawn/seats/policies).
export const HOUSE_INTERIOR = {
  halfX: 7,
  halfZ: 5.5,
  wallH: 3.2,
  spawn: { x: 0, y: 0, z: -3.6 },
  door: { x: 0, y: 0, z: 5.4 }, // exit trigger
  seats: [
    { x: -3.4, y: 0.45, z: -1.2, ry: Math.PI / 2, type: "chair" },
    { x: -3.4, y: 0.45, z: 1.4, ry: Math.PI / 2, type: "chair" },
    { x: 3.2, y: 0.4, z: -0.2, ry: -Math.PI / 2, type: "couch" },
    { x: 3.2, y: 0.4, z: 1.6, ry: -Math.PI / 2, type: "couch" },
    { x: 0.0, y: 0.45, z: 2.6, ry: Math.PI, type: "chair", lock: true },
  ],
};

// --- Public buildings (South commercial street) ------------------------------
export const SHOPS = [
  {
    id: "cafe",
    x: -54,
    z: -126,
    w: 18,
    d: 14,
    h: 7,
    color: 0xd8a47f,
    sign: "CAFE",
  },
  {
    id: "restaurant",
    x: -18,
    z: -126,
    w: 20,
    d: 14,
    h: 7.5,
    color: 0xc96f4a,
    sign: "RESTAURANT",
  },
  // two festive firecracker stores (interactive; buy + use, see FIREWORKS below)
  {
    id: "fireworks",
    x: 22,
    z: -126,
    w: 16,
    d: 12,
    h: 6.5,
    color: 0xb23c2c,
    sign: "DIWALI FIREWORKS",
    shop: true,
  },
  {
    id: "crackers",
    x: 54,
    z: -126,
    w: 16,
    d: 12,
    h: 6.5,
    color: 0x7d3fb0,
    sign: "FESTIVAL CRACKERS",
    shop: true,
  },
];
// NOTE: shop facades are non-enterable in this prototype (documented limitation).

// Interactive firecracker stores (a subset of SHOPS flagged `shop`).
export const FIREWORK_SHOPS = SHOPS.filter((s) => s.shop);

// --- Diwali economy: virtual currency + firecracker catalog ------------------
// The catalog lives in shared/ so the server can price + validate purchases and
// the client can render the very same list. Never trust a client price.
export const CURRENCY = {
  id: "diwali-coins",
  name: "Diwali Coins",
  symbol: "🪙",
  start: 7500, // generous starting balance so the shop is playable at once
  maxBalance: 999999,
  note: "A free in-game currency. Earned by exploring, spent at the festival shops — never real money.",
};

// kind: ground | spinner | handheld | rocket | aerial | diya | pack
//   packs are purchase-only bundles that grant the `gives` contents on purchase
export const FIREWORKS = [
  {
    id: "diya",
    name: "Diya",
    alt: "दिया",
    kind: "diya",
    price: 20,
    maxStack: 99,
    icon: "diya",
    duration: 45,
    tagline: "Lit clay lamp",
    desc: "Place a glowing clay diya that lights the path all evening.",
  },
  {
    id: "anar",
    name: "Anar",
    alt: "अनार",
    kind: "ground",
    price: 40,
    maxStack: 99,
    icon: "anar",
    tagline: "Ground spark fountain",
    desc: "A clay fountain that showers the path in golden, orange and red sparks.",
  },
  {
    id: "chakri",
    name: "Chakri",
    alt: "चकरी",
    kind: "spinner",
    price: 55,
    maxStack: 99,
    icon: "chakri",
    tagline: "Spinning ground wheel",
    desc: "A wheel that spins up fast, throwing circular trails of colourful sparks.",
  },
  {
    id: "phuljhadi",
    name: "Phuljhadi",
    alt: "फुलझड़ी",
    kind: "handheld",
    price: 30,
    maxStack: 99,
    icon: "phuljhadi",
    duration: 7,
    tagline: "Handheld sparkler",
    desc: "Carry a glowing sparkler that trails light as you walk.",
  },
  {
    id: "rocket",
    name: "Rocket",
    alt: "रकेट",
    kind: "rocket",
    price: 80,
    maxStack: 99,
    icon: "rocket",
    tagline: "Soars then bursts",
    desc: "Lifts off on a sparkling tail and bursts high above the island.",
  },
  {
    id: "aerial",
    name: "Aerial Shots",
    alt: "Sky Shots",
    kind: "aerial",
    price: 120,
    maxStack: 99,
    icon: "aerial",
    tagline: "Big sky fireworks",
    desc: "A large, colourful aerial shell with a bold, varied burst pattern.",
  },
  {
    id: "sparklers",
    name: "Sparklers Pack",
    alt: "झिलमिल",
    kind: "pack",
    price: 100,
    maxStack: 99,
    icon: "pack",
    tagline: "Four handheld sparklers",
    desc: "A family pack of four phuljhadi sparklers.",
    gives: { phuljhadi: 4 },
  },
  {
    id: "diya-set",
    name: "Diya Set",
    alt: "दीपों की माला",
    kind: "pack",
    price: 80,
    maxStack: 99,
    icon: "pack",
    tagline: "Five clay diyas",
    desc: "A set of five lit diyas — line your doorstep with light.",
    gives: { diya: 5 },
  },
  {
    id: "crackers-pack",
    name: "Firecrackers Pack",
    alt: "आतिशबाज़ी पैक",
    kind: "pack",
    price: 180,
    maxStack: 99,
    icon: "pack",
    tagline: "Classic crackers bundle",
    desc: "Two anars, two chakris and a rocket — the classic firecracker line-up.",
    gives: { anar: 2, chakri: 2, rocket: 1 },
  },
  {
    id: "combo",
    name: "Festival Combo",
    alt: "Diwali Combo",
    kind: "pack",
    price: 240,
    maxStack: 99,
    icon: "combo",
    tagline: "The full Diwali bundle",
    desc: "Anar, chakri, sparklers, a rocket and an aerial shot — the whole show.",
    gives: { anar: 2, chakri: 2, phuljhadi: 3, rocket: 1, aerial: 1 },
  },
];

// max quantity purchasable in a single transaction (anti-fat-finger / anti-spam)
export const MAX_BUY_QTY = 9;

const FIREWORK_BY_ID = new Map(FIREWORKS.map((f) => [f.id, f]));
export function fireworkById(id) {
  return FIREWORK_BY_ID.get(id) ?? null;
}

// --- Beach props (West) ------------------------------------------------------
export const BEACH_BAR = { x: -262, z: 40, ry: 0 };

// --- Room naming -------------------------------------------------------------
export const island_ROOM_PREFIX = "island-";
