// ---------------------------------------------------------------------------
// NewBuddy server entry point.
//  - HTTP: static client files (client/, shared/, vendored three.js)
//  - WS  : lobby, rooms (island instances + private houses), movement
//          validation, 20Hz snapshots, chat, friends, invites, voice signaling.
//
// Start:  PORT=3000 node server/index.js
// Env:    PORT, ALLOWED_ORIGINS (comma list for LAN testing), DATA_DIR reserved.
// Metrics: GET /metrics (JSON) used by tools/loadtest.js and docs.
// ---------------------------------------------------------------------------
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  PROTOCOL_VERSION,
  TICK_MS,
  INTEREST_RADIUS,
  PLAY_RADIUS,
  HOUSE_PLOTS,
  plotDoorPos,
  HOUSE_INTERIOR,
  ISLAND_ROOM_PREFIX,
  SPAWN_POINTS,
} from "../shared/constants.js";
import { RoomIndex, Player, validateMove } from "./rooms.js";
import * as store from "./persistence.js";
import {
  limiterFor,
  MSG_LIMIT,
  CHAT_LIMIT,
  SHOP_LIMIT,
  USE_LIMIT,
  sanitizeChat,
} from "./rate.js";
import * as economy from "./economy.js";

const PORT = Number(process.env.PORT || 3000);
const EXTRA_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEBUG_TELEPORT = process.env.NewBuddy_ALLOW_TELEPORT === "1";

// ---------------------------------------------------------------------------
// Static file serving (client + shared + vendored three.js from node_modules)
// ---------------------------------------------------------------------------
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLIENT = path.join(ROOT, "client");
const SHARED = path.join(ROOT, "shared");
const VENDOR = path.join(CLIENT, "vendor");

function vendorize() {
  fs.mkdirSync(VENDOR, { recursive: true });
  const jobs = [
    ["node_modules/three/build/three.module.js", "three.module.js"],
    ["node_modules/three/LICENSE", "LICENSE.three"],
    ["node_modules/three/package.json", "THREE.package.json"],
    [
      "node_modules/three/examples/jsm/renderers/CSS2DRenderer.js",
      "CSS2DRenderer.js",
    ],
  ];
  for (const [src, dst] of jobs) {
    try {
      const from = path.join(ROOT, src);
      const to = path.join(VENDOR, dst);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (
        !fs.existsSync(to) ||
        fs.statSync(from).mtimeMs > fs.statSync(to).mtimeMs
      ) {
        fs.copyFileSync(from, to);
      }
    } catch (e) {
      console.error("[vendor] failed to copy", src, e.message);
    }
  }
  // license notices for third-party code (kept under docs/LICENSES/)
  fs.mkdirSync(path.join(ROOT, "docs", "LICENSES"), { recursive: true });
  try {
    fs.copyFileSync(
      path.join(ROOT, "node_modules", "ws", "LICENSE"),
      path.join(ROOT, "docs", "LICENSES", "ws-license.txt"),
    );
  } catch (e) {
    console.error("[vendor] ws license copy failed:", e.message);
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".gltf": "model/gltf+json",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  // metrics endpoint for load tests / dashboards
  if (urlPath === "/metrics") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(metrics()));
    return;
  }
  if (urlPath === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  let dir = CLIENT,
    rel = urlPath;
  if (urlPath.startsWith("/shared/")) {
    dir = SHARED;
    rel = urlPath.slice(8);
  }
  const file = path.normalize(path.join(dir, rel));
  if (!(file.startsWith(dir + path.sep) || file === dir)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    // Client modules are edited during development and imported by URL. Do
    // not let an old tab reuse a stale actors.js/main.js module graph after a
    // rigging fix; the server is already intended for local game sessions.
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------
let nextPlayerId = 1;
const rooms = new RoomIndex(); // roomId -> Room
const playersById = new Map(); // id -> Player (even disconnected ones during grace)
const tokensOnline = new Map(); // token -> playerId
const pendingInvites = new Map(); // inviteId -> {from,id,fromName,houseId,expires}
let uptimeStart = Date.now();
const tickStats = { ms: [] };

function metrics() {
  const ms = tickStats.ms.length ? [...tickStats.ms].sort((a, b) => a - b) : [];
  const p = (q) => (ms.length ? ms[Math.floor(q * (ms.length - 1))] : 0);
  return {
    time: Date.now(),
    uptimeS: Math.round((Date.now() - uptimeStart) / 1000),
    players: playersById.size,
    online: [...playersById.values()].filter((pl) => pl.socket).length,
    rooms: [...rooms.rooms.values()].map((r) => ({
      id: r.id,
      type: r.type,
      n: r.players.size,
      mode: r.mode,
    })),
    tickMs: { p50: p(0.5), p95: p(0.95), p99: p(0.99) },
  };
}

// island-1 stays reserved; island-2.. spawn when island-1 is full.
function islandRoomFor() {
  const first = rooms.ensureIsland(ISLAND_ROOM_PREFIX + "1");
  if (!first.full()) return first;
  for (let i = 2; i < 50; i++) {
    const r = rooms.ensureIsland(ISLAND_ROOM_PREFIX + i);
    if (!r.full()) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// WebSocket layer
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

function acceptOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (tests/bots) — see docs
  const host = `http://${req.headers.host}`;
  const allowed = new Set([
    `https://${req.headers.host}`,
    host,
    ...EXTRA_ORIGINS,
  ]);
  if (origin.startsWith("http://localhost:")) return true;
  return allowed.has(origin);
}

const server = http.createServer(serveStatic);

server.on("upgrade", (req, socket, head) => {
  if (!acceptOrigin(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // per-connection metadata
    ws.player = null;
    ws.limits = limiterFor(ws);
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  // guard: pending player record for reconnect grace
  let helloTimer = setTimeout(() => {
    try {
      ws.close(1008, "no hello");
    } catch {}
  }, 5000);

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string" || !rateOk(ws)) return;
    if (process.env.NewBuddy_DEBUG_MSG)
      process.stderr.write(`[msg] ${msg.t}\n`);
    const h = handlers[msg.t];
    if (!h) return;
    try {
      h(ws, msg);
    } catch (e) {
      // One malformed interaction must never take down the tick loop.
      console.error("[handler-error]", msg.t, e);
    }
  });

  ws.on("close", () => {
    clearTimeout(helloTimer);
    const pl = ws.player;
    if (pl && pl.socket === ws) {
      pl.socket = null;
      pl.disconnectedAt = Date.now();
      // Reconnect grace: keep the slot for 10s, server reattaches on same token+hello.
      setTimeout(() => {
        if (pl.socket === null) {
          dropPlayer(pl, "left");
        }
      }, 10000);
    }
  });

  ws.on("error", () => {});
  ws.helloTimer = helloTimer;
});

function rateOk(ws) {
  const lim = ws.limits.msg.allow(MSG_LIMIT().max, MSG_LIMIT().windowMs);
  return lim;
}

function dropPlayer(pl, why) {
  if (!pl.room) {
    playersById.delete(pl.id);
    return;
  }
  const room = rooms.remove(pl);
  if (room) {
    room.broadcast({
      t: "leave",
      id: pl.id,
      sys: why === "left" ? `${pl.name} left.` : `${pl.name} disconnected.`,
    });
  }
  if (tokensOnline.get(pl.token) === pl.id) tokensOnline.delete(pl.token);
  playersById.delete(pl.id);
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------
const handlers = {
  ping(ws, m) {
    ws.send(JSON.stringify({ t: "pong", ts: m.ts, st: Date.now() }));
  },

  hello(ws, m) {
    // {t:'hello', name, av:{g,b,h,y,o,e,s,p}, token}
    if (ws.player) return; // already hello'd
    clearTimeout(ws.helloTimer);

    const token = String(m.token ?? "");
    let prof = store.getProfile(token) ?? {};
    const requested = String(m.name ?? prof.name ?? "")
      .slice(0, 20)
      .trim();
    let name = requested || "Player" + Math.floor(Math.random() * 9000 + 1000);

    // de-duplicate names across online players
    const taken = new Set(
      [...playersById.values()].filter((p) => p.socket).map((p) => p.name),
    );
    if (taken.has(name)) {
      let i = 2;
      while (taken.has(`${name} ${i}`)) i++;
      name = `${name} ${i}`;
    }

    // reconnect-grace / session takeover: same token had a socket? reattach that
    // player (close the old socket if it is somehow still open).
    const prevId = tokensOnline.get(token);
    let player = null;
    if (prevId && playersById.has(prevId)) {
      const prev = playersById.get(prevId);
      if (prev.socket && prev.socket !== ws) {
        try {
          prev.socket.send(
            JSON.stringify({
              t: "err",
              code: "replaced",
              msg: "Signed in from another window.",
            }),
          );
          prev.socket.close(4001, "replaced");
        } catch {
          /* already void */
        }
      }
      player = prev; // survives room state across reconnects
    } else if (prevId) {
      tokensOnline.delete(token); // stale mapping from a gc'd player
    }
    if (player) {
      if (requested) player.name = name;
    } else {
      player = new Player(nextPlayerId++, token, name, normAv(m.av));
      playersById.set(player.id, player);
    }
    player.socket = ws;
    tokensOnline.set(token, player.id);
    ws.player = player;

    store.upsertProfile(token, { name, av: player.av });
    if (!prof.created) store.upsertProfile(token, { friends: [] });

    // Economy: coerce any missing/corrupt/hand-edited save into a valid wallet +
    // inventory and write the cleaned values back so it can never go negative.
    const eco = economy.normalize(prof);
    store.upsertProfile(token, {
      wallet: eco.wallet,
      inventory: eco.inventory,
    });

    // default room: island (auto-instance)
    if (!player.room) {
      const room = islandRoomFor();
      if (!room) {
        ws.send(
          JSON.stringify({
            t: "err",
            code: "full",
            msg: "All islands are full.",
          }),
        );
        return;
      }
      const sp = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
      player.x = sp.x;
      player.y = 0;
      player.z = sp.z;
      rooms.add(room, player);
    }

    const room = player.room;
    // welcome: own id + full roster of this room + friends presence
    const roster = [];
    for (const p of room.players.values()) {
      if (p.id !== player.id) roster.push(stateOf(p, true));
    }
    ws.send(
      JSON.stringify({
        t: "welcome",
        v: PROTOCOL_VERSION,
        id: player.id,
        name: player.name,
        room: room.id,
        roomType: room.type,
        house: prof.house ?? null,
        ownedPlots: ownedPlots(token),
        x: player.x,
        y: player.y,
        z: player.z,
        time: Date.now(),
        players: roster,
      }),
    );
    room.broadcast({ t: "join", p: stateOf(player, true) }, player.id);
    // toast to others
    if (room.type === "island")
      room.broadcast(
        { t: "sys", kind: "join", text: `${player.name} joined the island.` },
        player.id,
      );
    // wallet + firecracker inventory (server-authoritative; re-sent on bookkeeping)
    ws.send(
      JSON.stringify(economy.walletPacket(store.getProfile(token) ?? eco)),
    );
    sendFriendsList(player);
  },

  shopBuy(ws, m) {
    // {t:'shopBuy', itemId, qty} — server prices the order itself
    const pl = ws.player;
    if (!pl || !pl.room) return;
    const lim = ws.limits.shop;
    if (!lim.allow(SHOP_LIMIT().max, SHOP_LIMIT().windowMs)) {
      soft(ws, "shop-flood");
      return;
    }

    const prof = store.getProfile(pl.token) ?? {};
    const r = economy.buy(prof, m.itemId, m.qty);
    if (!r.ok) {
      ws.send(
        JSON.stringify({
          t: "err",
          code: "shop-" + r.code,
          msg: SHOP_MSGS[r.code] || "Purchase failed.",
        }),
      );
      return;
    }
    store.upsertProfile(pl.token, { wallet: r.wallet, inventory: r.inventory });
    ws.send(
      JSON.stringify({
        t: "wallet",
        balance: r.wallet,
        inventory: r.inventory,
        currency: { ...economy.CURRENCY },
        bought: {
          id: r.item.id,
          name: r.item.name,
          qty: r.qty,
          cost: r.cost,
          gained: r.gained,
        },
      }),
    );
  },

  useItem(ws, m) {
    // {t:'useItem', itemId, x, z, ry} — consume once, spawn once
    const pl = ws.player;
    if (!pl || !pl.room) return;
    if (pl.room.type !== "island") {
      ws.send(
        JSON.stringify({ t: "err", code: "use-place", msg: USE_MSGS.place }),
      );
      return;
    }
    const lim = ws.limits.use;
    if (!lim.allow(USE_LIMIT().max, USE_LIMIT().windowMs)) {
      soft(ws, "use-flood");
      return;
    }

    const prof = store.getProfile(pl.token) ?? {};
    const r = economy.use(prof, m.itemId);
    if (!r.ok) {
      ws.send(
        JSON.stringify({
          t: "err",
          code: "use-" + r.code,
          msg: USE_MSGS[r.code] || "Cannot use that.",
        }),
      );
      return;
    }
    const item = economy.CATALOG_MAP.get(String(m.itemId));
    store.upsertProfile(pl.token, { inventory: r.inventory });

    // placement: handheld attaches to the player; every other kind spawns at a
    // position the server validates itself (finite, within reach, in-bounds).
    let x = Number(m.x),
      z = Number(m.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      x = pl.x;
      z = pl.z;
    }
    const dd = Math.hypot(x - pl.x, z - pl.z);
    if (dd > 12) {
      const k = 12 / dd;
      x = pl.x + (x - pl.x) * k;
      z = pl.z + (z - pl.z) * k;
    }
    const rr = Math.hypot(x, z);
    if (rr > PLAY_RADIUS) {
      const k = PLAY_RADIUS / rr;
      x *= k;
      z *= k;
    }
    const ry = Number.isFinite(Number(m.ry)) ? Number(m.ry) : pl.ry;

    pl.room.broadcast({
      t: "fx",
      id: pl.id,
      item: item.id,
      kind: item.kind,
      name: item.name,
      x: +x.toFixed(2),
      y: 0,
      z: +z.toFixed(2),
      ry: +ry.toFixed(2),
      dur: item.duration ?? 0,
      seed: (Math.random() * 0x7fffffff) | 0,
    });
    // confirm + authoritative inventory back to the sender (decremented once)
    ws.send(
      JSON.stringify({
        t: "wallet",
        balance: r.wallet,
        inventory: r.inventory,
        used: { id: item.id, name: item.name, kind: item.kind },
      }),
    );
  },

  st(ws, m) {
    // movement frame
    const pl = ws.player;
    if (!pl || !pl.room) return;
    if (pl.lastStateAt && Date.now() - pl.lastStateAt < 10) return; // >100 msg/s spam guard
    // Test/development convenience: explicit env opt-in, OFF by default.
    if (DEBUG_TELEPORT && m.debugPos) {
      const dx = Number(m.debugPos.x ?? pl.x),
        dz = Number(m.debugPos.z ?? pl.z);
      if (Number.isFinite(dx) && Number.isFinite(dz)) {
        if (pl.room.type === "island") {
          const r = Math.hypot(dx, dz);
          const k = r > PLAY_RADIUS + 20 ? (PLAY_RADIUS + 20) / r : 1;
          pl.x = dx * k;
          pl.z = dz * k;
        } else {
          pl.x = dx;
          pl.z = dz;
        }
        pl.y = 0;
        return;
      }
    }
    const r = validateMove(pl, m, Date.now());
    if (!r.ok) return;
    // NOTE: no per-frame broadcast; the 20Hz tick loop does fan-out.
  },

  chat(ws, m) {
    const pl = ws.player;
    if (!pl || !pl.room) return;
    const lim = ws.limits.chat;
    if (!lim.allow(CHAT_LIMIT().max, CHAT_LIMIT().windowMs)) {
      soft(ws, "chat-flood");
      return;
    }
    const text = sanitizeChat(m.text);
    if (!text) return;

    if (m.to && Number.isInteger(m.to)) {
      // private message
      const to = playersById.get(m.to);
      if (!to || to.room.id !== pl.room.id) {
        soft(ws, "pm-offline");
        return;
      }
      const a = pl.blocks,
        b = to.blocks;
      if ((a && a.has(to.id)) || (b && b.has(pl.id))) return;
      to.socket?.send(
        JSON.stringify({
          t: "chat",
          id: pl.id,
          name: pl.name,
          text,
          scope: "pm",
        }),
      );
      ws.send(
        JSON.stringify({
          t: "chat",
          id: pl.id,
          name: pl.name,
          text,
          scope: "pm",
          self: true,
        }),
      );
    } else {
      pl.room.broadcast({
        t: "chat",
        id: pl.id,
        name: pl.name,
        text,
        scope: "local",
      });
    }
  },

  emote(ws, m) {
    const pl = ws.player;
    if (!pl || !pl.room) return;
    const e = String(m.e || "");
    if (!["wave", "dance", "greet"].includes(e)) return;
    pl.emote = { e, until: Date.now() + 6000 };
    pl.room.broadcast({ t: "emote", id: pl.id, e }, -1);
  },

  door(ws, m) {
    // enter a house via exterior door (island)
    const pl = ws.player;
    if (!pl || !pl.room || pl.room.type !== "island") return;
    const plot = HOUSE_PLOTS.find((h) => h.id === String(m.houseId));
    if (!plot) return;
    const d = plotDoorPos(plot);
    const dist = Math.hypot(pl.x - d.x, pl.z - d.z);
    if (dist > 4.0) {
      ws.send(
        JSON.stringify({
          t: "err",
          code: "far",
          msg: "Too far from that door.",
        }),
      );
      return;
    }
    enterHouse(pl, plot, /*bypass=*/ false, ws);
  },

  doorExit(ws) {
    const pl = ws.player;
    if (!pl || !pl.room || !pl.room.isHouse()) return;
    if (
      Math.hypot(pl.x - HOUSE_INTERIOR.door.x, pl.z - HOUSE_INTERIOR.door.z) > 3
    ) {
      ws.send(
        JSON.stringify({
          t: "err",
          code: "far",
          msg: "Walk to the door to exit.",
        }),
      );
      return;
    }
    // find island room + spawn in front of the plot
    const plot = HOUSE_PLOTS.find((h) => h.id === pl.room.id.split(":")[1]);
    const room = rooms.ensureIsland(ISLAND_ROOM_PREFIX + "1");
    const from = rooms.remove(pl);
    const d = plotDoorPos(plot);
    pl.x = d.x;
    pl.y = 0;
    pl.z = d.z + 1.2;
    rooms.add(room, pl);
    ws.send(
      JSON.stringify({
        t: "room",
        room: room.id,
        roomType: "island",
        x: pl.x,
        y: 0,
        z: pl.z,
        plot: plot.id,
      }),
    );
    room.broadcast({ t: "join", p: stateOf(pl, true) }, pl.id);
    rosterTo(pl, room); // island room may have changed while we were indoors
    if (from)
      from.broadcast({
        t: "leave",
        id: pl.id,
        sys: `${pl.name} stepped outside.`,
      });
  },

  house(ws, m) {
    // owner: change access mode
    const pl = ws.player;
    if (!pl || !pl.room) return;
    const room = rooms.get("house:" + String(m.houseId));
    if (!room || room.owner !== pl.token) return;
    if (!["public", "friends", "invite"].includes(m.v)) return;
    room.mode = m.v;
    room.broadcast({ t: "houseMode", houseId: m.houseId, v: m.v });
  },

  invite(ws, m) {
    // invite someone to my owned house
    const pl = ws.player;
    if (!pl || !pl.room) return;
    const prof = store.getProfile(pl.token);
    const houseId =
      (prof && prof.house) ||
      (pl.room.isHouse() ? pl.room.id.split(":")[1] : null);
    if (!houseId) {
      ws.send(
        JSON.stringify({
          t: "err",
          code: "no-house",
          msg: "You do not own a house yet.",
        }),
      );
      return;
    }
    const target = store.findOnlineByName(rooms.rooms, String(m.name || ""));
    if (!target) {
      soft(ws, "not-online");
      return;
    }
    if (target.id === pl.id) return;
    const invId = "inv" + nextInviteId++;
    pendingInvites.set(invId, {
      from: pl.id,
      fromName: pl.name,
      houseId,
      to: target.id,
      expires: Date.now() + 90_000,
    });
    target.socket?.send(
      JSON.stringify({
        t: "invite",
        inviteId: invId,
        fromName: pl.name,
        houseId,
      }),
    );
  },

  inviteAccept(ws, m) {
    const inv = pendingInvites.get(String(m.inviteId || ""));
    if (!inv || inv.expires < Date.now() || inv.to !== ws.player?.id) {
      ws.send(
        JSON.stringify({
          t: "err",
          code: "invite",
          msg: "That invite expired.",
        }),
      );
      return;
    }
    pendingInvites.delete(m.inviteId);
    const plot = HOUSE_PLOTS.find((h) => h.id === inv.houseId);
    if (!plot || !ws.player) return;
    enterHouse(ws.player, plot, /*bypass=*/ true, ws);
  },

  joinRoom(ws, m) {
    // travel to a friend's current island instance
    const pl = ws.player;
    if (!pl || !pl.room) return;
    const target = store.findOnlineByName(rooms.rooms, String(m.name || ""));
    if (!target || target.id === pl.id) {
      soft(ws, "not-online");
      return;
    }
    const tRoom = target.room;
    if (tRoom.type === "house") {
      ws.send(
        JSON.stringify({
          t: "err",
          code: "house",
          msg: "They're inside a house — use invites to join.",
        }),
      );
      return;
    }
    if (tRoom.full()) {
      ws.send(
        JSON.stringify({ t: "err", code: "full", msg: "That island is full." }),
      );
      return;
    }
    moveToRoom(pl, tRoom, null, null, ws);
  },

  friend(ws, m) {
    const pl = ws.player;
    if (!pl) return;
    const name = String(m.name || "")
      .trim()
      .slice(0, 20);
    if (m.op === "add") {
      if (!name || name === pl.name) return;
      store.addFriend(pl.token, name);
      const target = store.findOnlineByName(rooms.rooms, name);
      if (target && !blockBetween(pl, target)) {
        target.socket?.send(
          JSON.stringify({ t: "fReq", from: pl.id, name: pl.name }),
        );
      }
      ws.send(
        JSON.stringify({
          t: "sys",
          kind: "info",
          text: `Friend request sent to ${name}.`,
        }),
      );
      sendFriendsList(pl);
      if (target) sendFriendsList(target);
    } else if (m.op === "accept") {
      store.addFriend(pl.token, name);
      sendFriendsList(pl);
    } else if (m.op === "remove") {
      store.removeFriend(pl.token, name);
      sendFriendsList(pl);
    }
  },

  block(ws, m) {
    const pl = ws.player;
    const id = Number(m.id);
    if (!pl || !Number.isInteger(id)) return;
    pl.blocks ??= new Set();
    if (m.on) pl.blocks.add(id);
    else pl.blocks.delete(id);
    const other = playersById.get(id);
    if (other && other.socket && m.on) {
      other.socket.send(JSON.stringify({ t: "blocked", by: pl.id }));
    }
    ws.send(JSON.stringify({ t: "blockedOk", id }));
  },

  report(ws, m) {
    // Prototype: logged server-side only. Production requires a moderation pipeline.
    const pl = ws.player;
    const id = Number(m.id);
    if (!pl || !Number.isInteger(id)) return;
    console.log(
      `[report] player ${pl.name}(${pl.id}) reported ${id} :: reason=${String(m.reason || "").slice(0, 80)}`,
    );
    ws.send(
      JSON.stringify({
        t: "sys",
        kind: "info",
        text: "Report received. Moderation tooling is not yet implemented.",
      }),
    );
  },

  vsig(ws, m) {
    // WebRTC signaling relay (same room, not blocked)
    const pl = ws.player;
    if (!pl || !pl.room) return;
    const target = playersById.get(Number(m.to));
    if (!target || !target.socket || target.room?.id !== pl.room.id) return;
    if (blockBetween(pl, target)) return;
    if (m.data && typeof m.data.type === "string" && m.data.type.length > 0) {
      target.socket.send(
        JSON.stringify({ t: "vsig", from: pl.id, data: m.data }),
      );
    }
  },
};

// helpers -------------------------------------------------------------------
function normAv(av) {
  const a = Number.isInteger(av?.b) ? { ...av } : {};
  return {
    g: a.g ? 1 : 0,
    b: bclamp(a.b ?? 0),
    h: bclamp(a.h ?? 1),
    s: bclamp(a.s ?? 2),
    p: bclamp(a.p ?? 3),
    y: Math.max(0, Math.min(2, Number.isInteger(a.y) ? a.y : (a.h ?? 1) % 3)),
    o: Math.max(0, Math.min(2, Number.isInteger(a.o) ? a.o : 0)),
    e: Math.max(0, Math.min(2, Number.isInteger(a.e) ? a.e : 0)),
  };
}
function bclamp(v) {
  return Math.max(0, Math.min(7, Number.isInteger(v) ? v : 0));
}

function stateOf(p, full = false) {
  const s = {
    id: p.id,
    name: p.name,
    x: +p.x.toFixed(2),
    y: +p.y.toFixed(2),
    z: +p.z.toFixed(2),
    ry: +p.ry.toFixed(2),
    mode: p.mode,
  };
  if (full) {
    s.av = p.av;
  }
  return s;
}

function sendFriendsList(pl) {
  const prof = store.getProfile(pl.token);
  const friends = (prof?.friends ?? []).map((name) => {
    const online = store.findOnlineByName(rooms.rooms, name);
    return {
      name,
      online: !!online,
      room: online?.room?.id ?? null,
      id: online?.id ?? null,
    };
  });
  pl.socket?.send(
    JSON.stringify({
      t: "friends",
      list: friends,
      requests: prof?.requests ?? [],
    }),
  );
  // include requests to me: scan profiles for tokens whose friends include my name? For the prototype,
  // incoming request handling is event-driven via 'fReq'.
}

function blockBetween(a, b) {
  return (a.blocks?.has(b.id) || b.blocks?.has(a.id)) ?? false;
}

// Generic room move used by joinRoom (island <-> island instances).
function moveToRoom(pl, room, spawn, housePlotId, ws) {
  const from = rooms.remove(pl);
  rooms.add(room, pl);
  if (spawn) {
    pl.x = spawn.x;
    pl.y = spawn.y ?? 0;
    pl.z = spawn.z;
    pl.ry = 0;
  }
  ws.send(
    JSON.stringify({
      t: "room",
      room: room.id,
      roomType: room.type,
      houseId: housePlotId ?? undefined,
      x: pl.x,
      y: pl.y,
      z: pl.z,
      mode: room.mode,
      owner: room.owner === pl.token,
    }),
  );
  if (from)
    from.broadcast({ t: "leave", id: pl.id, sys: `${pl.name} traveled on.` });
  room.broadcast({ t: "join", p: stateOf(pl, true) }, pl.id);
  rosterTo(pl, room);
}

function rosterTo(pl, room) {
  const roster = [];
  for (const p of room.players.values())
    if (p.id !== pl.id) roster.push(stateOf(p, true));
  pl.socket?.send(
    JSON.stringify({
      t: "welcome2",
      time: Date.now(),
      players: roster,
      mode: room.mode,
      ownerTokenMatch: room.owner === pl.token,
    }),
  );
}

function ownedPlots(token) {
  return HOUSE_PLOTS.filter((h) => houseOwner(h.id) === token).map((h) => h.id);
}
function houseOwner(houseId) {
  const room = rooms.get("house:" + houseId);
  return room?.owner ?? null;
}

function enterHouse(pl, plot, bypass, ws) {
  const room =
    rooms.rooms.get("house:" + plot.id) ?? rooms.ensureHouse(plot.id, null);
  if (!bypass) {
    if (
      room.mode === "invite" ||
      (room.mode === "friends" && !store.isFriend(room.owner, pl.name))
    ) {
      const inviteOk = false; // invited guests enter via inviteAccept (bypass)
      if (!inviteOk) {
        ws.send(
          JSON.stringify({
            t: "err",
            code: "locked",
            msg:
              room.mode === "friends"
                ? "Friends only."
                : "Private - invite needed.",
          }),
        );
        return;
      }
    }
  }
  if (room.players.size >= 12) {
    ws.send(
      JSON.stringify({
        t: "err",
        code: "full",
        msg: "That house is full (12).",
      }),
    );
    return;
  }
  // claim
  if (!room.owner) {
    room.owner = pl.token;
    store.upsertProfile(pl.token, { house: plot.id });
    pl.socket?.send(JSON.stringify({ t: "houseOwned", houseId: plot.id }));
  }
  const from = rooms.remove(pl);
  rooms.add(room, pl);
  {
    const sp = HOUSE_INTERIOR.spawn;
    pl.x = sp.x;
    pl.y = sp.y;
    pl.z = sp.z;
    pl.ry = 0;
  }
  ws.send(
    JSON.stringify({
      t: "room",
      room: room.id,
      roomType: "house",
      houseId: plot.id,
      x: pl.x,
      y: pl.y,
      z: pl.z,
      owner: room.owner === pl.token,
      mode: room.mode,
    }),
  );
  if (from)
    from.broadcast({
      t: "leave",
      id: pl.id,
      sys: `${pl.name} entered a house.`,
    });
  room.broadcast({ t: "join", p: stateOf(pl, true) }, pl.id);
  // Send the existing occupants to the joining player.
  const roster = [];
  for (const p of room.players.values())
    if (p.id !== pl.id) roster.push(stateOf(p, true));
  ws.send(
    JSON.stringify({
      t: "welcome2",
      time: Date.now(),
      players: roster,
      mode: room.mode,
      ownerTokenMatch: room.owner === pl.token,
    }),
  );
}

setInterval(() => {
  rooms.gc();
}, 30000);

// snapshots -------------------------------------------------------------
let nextInviteId = 1;

// Player-facing text for the economy error codes (server is the only judge).
const SHOP_MSGS = {
  item: "That item isn't in the shop.",
  qty: "Choose a quantity between 1 and 9.",
  funds: "Not enough Diwali Coins for that.",
  limit: "You're already carrying the maximum of that.",
};
const USE_MSGS = {
  item: "That item can't be used.",
  empty: "You don't have any of those left.",
  place: "Firecrackers only work out on the island.",
  far: "Too far away.",
};

function soft(ws, code) {
  const msgs = {
    "chat-flood": "Slow down (chat rate limit).",
    "pm-offline": "That player is not in your area.",
    "not-online": "That player is not online.",
    "shop-flood": "Slow down — too many purchases at once.",
    "use-flood": "Slow down — take a breath between crackers.",
  };
  ws.send(
    JSON.stringify({ t: "err", code, msg: msgs[code] || "Request failed." }),
  );
}

const tickLoop = setInterval(() => {
  const t0 = process.hrtime.bigint();
  for (const room of rooms.rooms.values()) {
    if (room.players.size === 0) continue;
    // snapshot per room, message per-recipient filtered by interest radius
    const a = [...room.players.values()];
    for (const pl of a) {
      if (!pl.socket || pl.socket.readyState !== pl.socket.OPEN) continue;
      const u = [];
      for (const other of a) {
        if (other === pl) continue;
        const dx = other.x - pl.x,
          dz = other.z - pl.z,
          dy = other.y - pl.y;
        if (dx * dx + dz * dz + dy * dy <= INTEREST_RADIUS * INTEREST_RADIUS) {
          u.push([other.id, other.x, other.y, other.z, other.ry, other.mode]);
        }
      }
      pl.socket.send(
        JSON.stringify({ t: "snap", time: Date.now(), u: u.length ? u : 0 }),
      );
    }
  }
  const took = Number(process.hrtime.bigint() - t0) / 1e6;
  tickStats.ms.push(took);
  if (tickStats.ms.length > 3000) tickStats.ms.splice(0, 1500);
}, TICK_MS);

// main ----------------------------------------------------------------------
vendorize();
const n = store.initStore();
console.log(`[NewBuddy] store: ${n} profiles (data/profiles.json)`);
server.listen(PORT, () => {
  console.log(`[NewBuddy] http+ws on http://localhost:${PORT}  (client at /)`);
});

process.on("SIGINT", () => {
  console.log("\n[NewBuddy] shutting down");
  process.exit(0);
});
