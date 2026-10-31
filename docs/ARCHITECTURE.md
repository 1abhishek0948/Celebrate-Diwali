# Architecture

DiwalyMeetUp is an authoritative real-time world. The server owns truth
(positions, rooms, houses, seats, friends); clients render and interpolate.
All game data is exchanged as small JSON frames over one WebSocket per player.

## Topology

```
 browser A ── ws://…/   ─┐
 browser B ── ws://…/   ─┼──► Node server (ws)  ──► tick loop @ 20 Hz
 browser C ── ws://…/   ─┘        │  (per-room snapshots, interest-filtered)
        │                          │
        └────── WebRTC voice mesh (browser↔browser, SFU-less, STUN only)
```

- HTTP and WebSocket share one port (`server/index.js` serves the static
  client from `client/` and upgrades the same socket to ws).
- The only third-party runtime deps are `ws` (server) and `three`
  (client, vendored into `client/vendor/` by the server at startup).

## Server (`server/`)

### `index.js` — socket layer, message handlers, tick loop

- `hello` authenticates the session (device token). A token maps to one
  player record; a second socket with the same token **takes over**: the old
  socket is closed and the player reattaches (10 s disconnect grace, then the
  player is dropped).
- `st` frames are validated by `rooms.validateMove` (below). They are _not_
  broadcast; the 20 Hz tick loop does all fan-out.
- One JSON message type per handler key (see catalog).
- `/metrics` returns room occupancy + tick p50/p95/p99; consumed by
  `tools/loadtest.js`.

### `rooms.js` — Player/Room/RoomIndex + movement validation

- **Wall-clock movement budget.** Each `st` frame may only advance the
  player up to what the elapsed wall-clock permits:
  `budget += min(elapsed, 250ms) * 8.5 m/s`, capped at 4.0 m. Faster claims
  are corrected in place (moved _toward_ the claimed point within budget),
  so a client can never teleport; spamming `st` faster than the 100
  msg/s guard earns nothing because the budget is time-based.
- island rooms cap at `MAX_PLAYERS_PER_island` (100); house rooms at 12.
- House rooms have a persistent owner + mode (`public`/`friends`/`private`);
  entry checks mode + invites + friendship.

### `persistence.js` — `data/profiles.json`

Names, avatars, friend lists, house ownership. Written on mutation; loaded
at boot. Delete the file to reset the world.

### `rate.js` — sliding-window limiters

- 80 arbitrary frames / 2 s per socket (`MSG_RATE_PER_S`)
- 3 chat / PMs / 5 s per player (`CHAT_RATE_PER_S`)

## Protocol (JSON over WS)

Client → server:
| `t` | purpose |
| --- | --- |
| `hello` `{token, name, av}` | start/resume session, pick name + avatar |
| `st` `{x,y,z,ry,mode,seq}` | movement frame (validated, not broadcast) |
| `ping` | RTT probe (answered with `pong`) |
| `chat` `{text, pmTo?}` | public chat or private message |
| `emote` `{e}` | wave/dance/etc. broadcast to room |
| `door` `{plotId}` / `doorExit` | enter/leave house interiors |
| `seat` `{i}` / `unseat` | sit on / stand up from furniture |
| `house` `{mode}` | owner changes access mode |
| `invite` `{name}` / `inviteAccept` `{inviteId}` | owner grants entry for 5 min |
| `friend` `{op: add/remove/accept}` | friend list + requests |
| `block` / `report` | per-target chat mute / abuse flag |
| `vsig` `{to, data}` | WebRTC SDP/ICE relay, same-room peers only |

Server → client:
`welcome` (id, name, room, spawn, roster) · `welcome2` (roster on
room changes) · `snap` (20 Hz position updates, interest-filtered:
`u: [id,x,y,z,ry,mode,seat?]` for peers within 80 m) · `join`/`leave` ·
`room` (room switch + seat/plot info) · `seated` · `chat` · `emote` ·
`sys` (world feed) · `err` · `friends` / `fReq` · `invite` ·
`houseOwned` / `houseMode` · `blocked` · `pong` · `vsig`.

## Client (`client/js/`)

| module          | job                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `main.js`       | scene/camera/renderer bootstrap, 20 Hz snapshot application + interpolation (110 ms buffer), loop, input dispatch |
| `net.js`        | WebSocket, device token (localStorage), reconnect, ping/RTT, message dispatch                                     |
| `world.js`      | procedurally builds island, 8 house interiors, collider registry, room↔scene switching                            |
| `actors.js`     | `CharacterRig`: primitive-based humanoid + seated/emote/locomotion poses, avatar palettes, CSS2D name labels      |
| `controller.js` | local avatar: AABB/circle collision vs. registry, gravity/jump, facing, interact-scan, `playEmote`, `unseat`      |
| `voice.js`      | WebRTC voice mesh: ≤8 nearest peers, room-scoped, distance attenuation, STUN-only (no TURN)                       |
| `screens.js`    | UI: HUD, chat, friends, settings, profile, panels, toasts                                                         |

Client sends 15 Hz `st` frames; remote positions are interpolated from the
20 Hz snapshots in a 110 ms buffer (`SNAPSHOT_BUFFER`).

## Security posture (prototype scope)

- Movement is server-clamped (wall-clock budget + island radius + house
  bounds); a cheating client can at most lag, not escape.
- Rate limits prevent chat/message floods; 16 KB frame cap.
- House privacy is server-enforced (owner + mode + invites + friends).
- No auth, no TLS, no TURN: it is a local/LAN prototype — see ROADMAP.
