// ---------------------------------------------------------------------------
// Room registry: island instances + private house rooms.
// Each room owns its players and a light spatial grid for interest management.
// ---------------------------------------------------------------------------
import { MAX_PLAYERS_PER_ISLAND, PLAY_RADIUS } from '../shared/constants.js';

export class Player {
  constructor(id, token, name, av) {
    this.id = id;
    this.token = token;
    this.name = name;
    this.av = av; // {g,b,h,y,o,e,s,p} appearance ints
    this.socket = null;
    this.room = null; // Room ref
    this.x = 0; this.y = 0; this.z = 0; this.ry = 0;
    this.mode = 0; // 0 idle, 1 walk, 2 run, 3 air
    this.lastSeq = 0;
    this.budget = 0; // movement budget (m) accumulates
    this.lastStateAt = 0; // wall-clock ms of last validated frame (0 = none yet)
    this.disconnectedAt = 0;
  }
}

export class Room {
  constructor(id, type) {
    this.id = id;
    this.type = type; // 'island' | 'house'
    this.players = new Map(); // id -> Player
    // house-room state
    this.owner = null;  // token of owner
    this.mode = 'public';
    this.hashedPlayers = new Set();
  }

  isHouse() { return this.type === 'house'; }

  broadcast(msg, skipId = null) {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.id !== skipId && p.socket && p.socket.readyState === p.socket.OPEN) {
        p.socket.send(s);
      }
    }
    return s.length;
  }

  sendTo(id, msg) {
    const p = this.players.get(id);
    if (p && p.socket && p.socket.readyState === p.socket.OPEN) p.socket.send(JSON.stringify(msg));
  }

  full() {
    return this.type === 'island' && this.players.size >= MAX_PLAYERS_PER_ISLAND;
  }
}

export class RoomIndex {
  constructor() {
    this.rooms = new Map(); // id -> Room
  }

  get(id) { return this.rooms.get(id) ?? null; }

  ensureIsland(name) {
    let room = this.rooms.get(name);
    if (!room) {
      room = new Room(name, 'island');
      this.rooms.set(name, room);
    }
    return room;
  }

  ensureHouse(houseId, ownerToken) {
    const id = 'house:' + houseId;
    let room = this.rooms.get(id);
    if (!room) {
      room = new Room(id, 'house');
      room.owner = ownerToken;
      this.rooms.set(id, room);
    }
    return room;
  }

  add(room, player) {
    room.players.set(player.id, player);
    player.room = room;
  }

  remove(player) {
    const room = player.room;
    if (!room) return null;
    room.players.delete(player.id);
    player.room = null;
    return room;
  }

  // Drop empty house rooms to keep memory bounded (islands stay reserved).
  gc() {
    for (const [id, room] of this.rooms) {
      if (room.type === 'house' && room.players.size === 0) this.rooms.delete(id);
    }
  }
}

// Validate an incoming movement frame against wall-clock movement budget.
// Anti-exploit: budget accrues on REAL elapsed time (max 250ms credit per gap),
// so flooding packets faster than the send rate cannot buy extra speed.
export function validateMove(player, st, nowMs) {
  const { x, y, z, ry, mode } = st;
  if (![x, y, z, ry].every(Number.isFinite) || !Number.isInteger(mode) || mode < 0 || mode > 3) {
    return { ok: false };
  }
  // Baseline: the first frame (lastStateAt 0/undefined) pins the clock but
  // grants no budget; from then on, real elapsed time accrues movement.
  const since = nowMs - (player.lastStateAt || nowMs);
  player.lastStateAt = nowMs;
  if (since >= 15) {
    player.budget = Math.min(player.budget + 8.5 * (Math.min(since, 250) / 1000), 4.0); // ~8.5 m/s ceiling + tolerance
  }
  const dist = Math.hypot(x - player.x, y - player.y, z - player.z);
  if (dist > player.budget) {
    // Corrected: move toward the claimed point as far as budget allows (anti-teleport)
    const k = player.budget / dist;
    player.x += (x - player.x) * k;
    player.z += (z - player.z) * k;
    player.y += (y - player.y) * k;
    player.budget = 0;
  } else {
    player.x = x; player.y = y; player.z = z;
    player.budget -= dist;
  }
  player.ry = ry >= -Math.PI && ry <= Math.PI ? ry : player.ry;
  player.mode = mode;

  // World bounds clamp
  if (player.room && player.room.type === 'island') {
    const r = Math.hypot(player.x, player.z);
    if (r > PLAY_RADIUS) {
      const k = PLAY_RADIUS / r;
      player.x *= k; player.z *= k;
    }
    if (player.y < -0.5) player.y = 0;
    if (player.y > 12) player.y = 12;
  } else if (player.room && player.room.isHouse()) {
    player.x = Math.max(-8.4, Math.min(8.4, player.x));
    player.z = Math.max(-6.8, Math.min(6.8, player.z));
    if (player.y < -0.5 || player.y > 3) player.y = 0;
  }
  return { ok: true, corrected: player.budget === 0 };
}
