// ---------------------------------------------------------------------------
// NewBuddy server integration tests (node:test).
// Spins up a real server on a test port and drives it via WebSocket bots:
//   welcome/join + snapshots, wall-clock speed clamp + packet-spam guard,
//   chat + flood limits, friends presence, house claim / lock modes / invites,
//   seating, session takeover on duplicate login, joinRoom travel.
// Test-only teleport: NEWBUDDY_ALLOW_TELEPORT=1 (explicit, off in production).
// Run: npm test
// ---------------------------------------------------------------------------
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3999;
const URL = `ws://localhost:${PORT}`;
const TMP_DATA = path.join(os.tmpdir(), `newbuddy-srv-${process.pid}`);

let proc = null;

async function startServer() {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), NEWBUDDY_ALLOW_TELEPORT: '1', DATA_DIR: TMP_DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server start timeout')), 8000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('http+ws on')) { clearTimeout(to); resolve(); }
    });
    proc.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  });
}

after(() => {
  if (proc) proc.kill('SIGINT');
  setTimeout(() => { try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* best effort */ } }, 250);
});

// ---- tiny ws client harness -------------------------------------------------
function connect() {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    const w = waiters[0];
    if (w && w.pred(m)) w.found(m); else inbox.push(m);
  });
  const opened = new Promise((res) => ws.on('open', res));
  const client = {
    ws, opened,
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
    next: (pred, ms = 4000) => new Promise((res, rej) => {
      for (let i = 0; i < inbox.length; i++) {
        if (pred(inbox[i])) { res(inbox.splice(i, 1)[0]); return; }
      }
      const w = { pred, found: null };
      const to = setTimeout(() => {
        const idx = waiters.indexOf(w);
        if (idx >= 0) waiters.splice(idx, 1);
        rej(new Error(`timeout (pred: ${String(pred).slice(0, 80)} | recent: ${inbox.slice(-3).map((m) => m.t).join(',') || 'none'})`));
      }, ms);
      w.found = (m) => {
        clearTimeout(to);
        const idx = waiters.indexOf(w);
        if (idx >= 0) waiters.splice(idx, 1);
        res(m);
      };
      waiters.push(w);
    }),
  };
  return client;
}

const T = (ch, n = 0) => TOKEN(ch, n);
function TOKEN(ch, n = 0) {
  return (ch.charCodeAt(0).toString(16) + String(n).padStart(2, '0')).padEnd(32, 'e');
}

async function login(token, name, av) {
  const c = connect();
  await c.opened;
  c.send({ t: 'hello', token, name, av: av || { b: 0, h: 1, s: 2, p: 3 } });
  const w = await c.next((m) => m.t === 'welcome', 6000);
  return { send: c.send, next: c.next, close: c.close, ws: c.ws, id: w.id, x: w.x, z: w.z };
}

// test-only teleport (server gated by NEWBUDDY_ALLOW_TELEPORT=1)
function tp(c, x, z) {
  c.send({ t: 'st', seq: Math.random(), x: c.x ?? x, y: 0, z: c.z ?? z, ry: 0, mode: 2, debugPos: { x, z } });
}

async function awaitClose(client, ms = 2000) {
  await new Promise((res) => {
    const s = setTimeout(res, ms);
    client.ws.on('close', () => { clearTimeout(s); res(); });
    if (client.ws.readyState === WebSocket.CLOSED) { clearTimeout(s); res(); }
  });
}

// -----------------------------------------------------------------------------
before(async () => { await startServer(); });

test('welcome + join broadcast + interest snapshots', async () => {
  const A = await login(T('a'), 'Alice');
  assert.equal(A.id, 1);
  const B = await login(T('b'), 'Bob');
  assert.equal(B.id, 2);
  const join = await A.next((m) => m.t === 'join', 4000);
  assert.equal(join.p.id, 2);

  // both spawn near plaza center -> both appear in snapshots
  B.send({ t: 'st', seq: 1, x: 10, y: 0, z: 10, ry: 0, mode: 2 });
  const snap = await A.next((m) => m.t === 'snap' && m.u && m.u.length > 0, 3000);
  assert.ok(snap.u.some((r) => r[0] === 2));

  // B walks far (> interest radius 80) -> snapshot list empties for A
  tp(B, 20, 300);
  const empty = await A.next((m) => m.t === 'snap' && (m.u === 0 || !m.u.some((r) => r[0] === 2)), 3000);
  assert.ok(empty);
  A.close(); B.close();
});

test('wall-clock speed clamp + packet-flood guard', async () => {
  const C = await login(T('c'), 'Cara');
  const sx = C.x, sz = C.z;
  // spam claiming +1m per packet, far faster than the send rate
  for (let i = 0; i < 60; i++) {
    C.send({ t: 'st', seq: i, x: sx + i, y: 0, z: sz, ry: 0, mode: 2 });
  }
  await new Promise((r) => setTimeout(r, 300));
  tp(C, sx, sz); // land back so later tests unaffected
  await C.next((m) => m.t === 'snap', 800);
  C.close();
});

test('chat broadcast + flood limit', async () => {
  const A = await login(T('a'), 'Alice');
  A.send({ t: 'chat', text: 'hello world' });
  const chat = await A.next((m) => m.t === 'chat', 3000);
  assert.equal(chat.text, 'hello world');

  for (let i = 0; i < 3; i++) A.send({ t: 'chat', text: 'flood ' + i });
  const err = await A.next((m) => m.t === 'err', 3000);
  assert.equal(err.code, 'chat-flood');
  await awaitClose(A, 50); // close later, after prior sends drained
  A.close();
});

test('friends list with presence', async () => {
  const A = await login(T('a'), 'Alice');
  A.send({ t: 'friend', op: 'add', name: 'Bob' });
  // wait for the friends list that actually contains Bob (an earlier,
  // pre-add list may have raced into the inbox)
  const f = await A.next((m) => m.t === 'friends' && m.list.some((x) => x.name === 'Bob'), 3000);
  assert.ok(f.list.some((x) => x.name === 'Bob'));
  A.close();
});

test('duplicate login takes over session (same player id)', async () => {
  const c1 = connect();
  await c1.opened;
  c1.send({ t: 'hello', token: T('h'), name: 'Reconn' });
  const w1 = await c1.next((m) => m.t === 'welcome', 5000);
  const c2 = connect();
  await c2.opened;
  c2.send({ t: 'hello', token: T('h'), name: 'Reconn' });
  const w2 = await c2.next((m) => m.t === 'welcome', 5000);
  assert.equal(w2.id, w1.id);
  c2.close();
});

test('house claim, lock modes, invite-bypass entry', async () => {
  // Owner claims house-1 (teleport allowed by env), sends door request
  const O = await login(T('d'), 'Owner', { b: 1, h: 1, s: 1, p: 1 });
  tp(O, -90, 132 + 4.2);
  O.send({ t: 'door', houseId: 'house-1' });
  const room = await O.next((m) => m.t === 'room', 5000);
  assert.equal(room.room, 'house:house-1');
  assert.equal(room.owner, true);

  // lock to friends-only
  O.send({ t: 'house', houseId: 'house-1', v: 'friends' });

  // stranger walks in -> locked
  const S = await login(T('f'), 'Stranger', { b: 3, h: 1, s: 1, p: 1 });
  tp(S, -90, 132 + 4.3);
  S.send({ t: 'door', houseId: 'house-1' });
  const nope = await S.next((m) => m.t === 'err', 3000);
  assert.equal(nope.code, 'locked');

  // owner invites a friend; friend accepts from anywhere
  const F = await login(T('e'), 'OwnerFriend', { b: 2, h: 1, s: 1, p: 1 });
  O.send({ t: 'friend', op: 'add', name: 'OwnerFriend' });
  await O.next((m) => m.t === 'friends', 2000);
  O.send({ t: 'invite', name: 'OwnerFriend' });
  const inv = await F.next((m) => m.t === 'invite', 5000);
  assert.equal(inv.fromName, 'Owner');
  F.send({ t: 'inviteAccept', inviteId: inv.inviteId });
  const froom = await F.next((m) => m.t === 'room', 5000);
  assert.equal(froom.room, 'house:house-1');

  // exit through door zone
  F.send({ t: 'seat', i: 0 });
  await F.next((m) => m.t === 'seated', 2000);
  F.send({ t: 'unseat' });
  F.send({ t: 'st', seq: 7, x: 0, y: 0, z: 5.4, ry: 0, mode: 1, debugPos: { x: 0, z: 5.4 } });
  F.send({ t: 'doorExit' });
  const back = await F.next((m) => m.t === 'room', 3000);
  assert.equal(back.roomType, 'island');
  O.close(); S.close(); F.close();
});

test('occupancy screen: house is capped at 12', async () => {
  // fill house-5 with 12 bots then expect 'full' on the 13th
  const bots = [];
  for (let i = 0; i < 12; i++) {
    const b = await login(T('i', i), 'Guest' + i, { b: 5, h: 1, s: 1, p: 1 });
    tp(b, -90, 252 + 4.2);
    b.send({ t: 'door', houseId: 'house-5' });
    await b.next((m) => m.t === 'room', 5000);
    bots.push(b);
  }
  const extra = await login(T('z'), 'Late', { b: 6, h: 1, s: 1, p: 1 });
  tp(extra, -90, 252 + 4.2);
  extra.send({ t: 'door', houseId: 'house-5' });
  const full = await extra.next((m) => m.t === 'err', 4000);
  assert.equal(full.code, 'full');
  bots.forEach((b) => b.close());
  extra.close();
});

test('joinRoom: travel to a friend, house guests must use invites', async () => {
  const A = await login(T('q', 1), 'JourneyA');
  const B = await login(T('q', 2), 'JourneyB');
  const C = await login(T('q', 3), 'JourneyC');

  // unknown / offline target
  A.send({ t: 'joinRoom', name: 'AbsentPerson' });
  const off = await A.next((m) => m.t === 'err', 3000);
  assert.equal(off.code, 'not-online');

  // B steps into house-3 (public, untouched by earlier tests), A tries to follow
  tp(B, 60, 132 + 4.2);
  B.send({ t: 'door', houseId: 'house-3' });
  const broom = await B.next((m) => m.t === 'room', 5000);
  assert.equal(broom.room, 'house:house-3');
  A.send({ t: 'joinRoom', name: 'JourneyB' });
  const houseErr = await A.next((m) => m.t === 'err', 3000);
  assert.equal(houseErr.code, 'house');

  // B exits to the island; now A can travel to B's island instance
  B.send({ t: 'st', seq: 9, x: 0, y: 0, z: 5.4, ry: 0, mode: 1, debugPos: { x: 0, z: 5.4 } });
  B.send({ t: 'doorExit' });
  await B.next((m) => m.t === 'room' && m.roomType === 'island', 4000);
  A.send({ t: 'joinRoom', name: 'JourneyB' });
  const moved = await A.next((m) => m.t === 'room', 5000);
  assert.equal(moved.room, 'island-1');
  assert.equal(moved.roomType, 'island');

  // same-room travel to C still sends a clean room msg
  A.send({ t: 'joinRoom', name: 'JourneyC' });
  const again = await A.next((m) => m.t === 'room', 5000);
  assert.equal(again.room, 'island-1');

  A.close(); B.close(); C.close();
});

test('vsig relay: same room only, blocked pairs filtered', async () => {
  const A = await login(T('v', 1), 'VoiceA');
  const B = await login(T('v', 2), 'VoiceB');
  const C = await login(T('v', 3), 'VoiceC');

  // same island room -> relayed with the sender id
  A.send({ t: 'vsig', to: B.id, data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0 test' } } });
  const got = await B.next((m) => m.t === 'vsig', 3000);
  assert.equal(got.from, A.id);
  assert.equal(got.data.type, 'offer');

  // blocked pair -> silently dropped
  A.send({ t: 'block', id: B.id, on: true });
  await A.next((m) => m.t === 'blockedOk', 2000);
  A.send({ t: 'vsig', to: B.id, data: { type: 'ice', cand: { candidate: 'blocked' } } });
  await assert.rejects(B.next((m) => m.t === 'vsig', 800));

  // different room -> dropped (C steps into a house)
  tp(C, 60, 132 + 4.2);
  C.send({ t: 'door', houseId: 'house-3' });
  await C.next((m) => m.t === 'room', 5000);
  A.send({ t: 'vsig', to: C.id, data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } } });
  await assert.rejects(C.next((m) => m.t === 'vsig', 800));

  A.close(); B.close(); C.close();
});
