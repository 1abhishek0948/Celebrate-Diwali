# NewBuddy

A 3D multiplayer social island — no combat. Walk around a procedurally generated
island, visit eight houses, sit on furniture, chat, emote, and talk to nearby
players over WebRTC voice. Built as a complete prototype: authoritative
Node.js lobby/snapshot server + vanilla Three.js browser client, no external
assets (everything is primitive-geometry), zero build step.

```
/ ─ client/            browser game (Three.js, ES modules via import map)
  └ js/                net, world, actors, controller, voice, screens, main
  └ vendor/            vendored three.module.js + CSS2DRenderer.js (MIT)
/ ─ server/            Node.js 18+ authoritative server (ws, JSON protocol)
/ ─ shared/constants.js  single source of truth for protocol + world geometry
/ ─ tests/             node:test integration suite (7 tests, all passing)
/ ─ tools/             e2e.js (headless-Chrome client E2E), loadtest.js (bot load)
/ ─ loads/             measured load report (loads/load-report.md)
/ ─ data/              profiles.json persistence (gitkeep; runtime-created)
```

## Quick start

```bash
npm install          # ws + three; the server auto-vendors three into client/vendor/ on start
npm start          # http server + WebSocket game server on :3000
# open http://localhost:3000 in TWO different browsers (or browser + incognito
# window). Note: tabs in one browser share a device token, and a new login
# with the same token takes over that session — so use separate browsers.
```

Open a second browser (or a second tab with a different localStorage token via
the "Join as..." screen) and you will see each other walk around, sit in
houses, chat, and — with the mic on — talk.

## What works (all tested)

- Authoritative 20 Hz snapshots, 15 Hz client sends, wall-clock movement
  budget validation (anti-teleport, anti-packet-spam) — see ARCHITECTURE
- Islands cap at 100 players; houses cap at 12 (including owner)
- House claiming, lock modes (`public / friends / private`), invite bypass
- Friend add/remove with presence, friend requests, PMs, chat + PM flood limits
- 10 s reconnect grace; duplicate login takes over the session (old socket closed,
  same player id preserved)
- Interest radius: you only receive snapshots for players within 80 m
- Three festival outfits and three hairstyles for **both** genders, all built
  procedurally from primitives (daura/kurta/waistcoat/shalwar, saree/lehenga);
  the Fabric / Accent swatches recolor either gender
- WebRTC voice mesh (≤8 nearest peers, distance-attenuated, room-scoped)
- 7 server integration tests, 10-client E2E smoke in headless Chrome,
  100-player load test (`npm run loadtest`)

## Run the checks

```bash
npm test              # server protocol integration tests (node --test)
npm start             # leave running, then:
node tools/e2e.js     # drives the real client in headless Chrome + a bot peer
node tools/loadtest.js 100 45   # 100 bots, 45s -> loads/load-report.md
```

## Docs

- [docs/SETUP.md](docs/SETUP.md) — environments, flags, multi-origin, persistence
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — protocol, rooms, validation, voice
- [docs/LICENSES.md](docs/LICENSES.md) — third-party component licenses
- [docs/ROADMAP.md](docs/ROADMAP.md) — known limitations and next steps
- [loads/load-report.md](loads/load-report.md) — measured throughput @ 100 players

# Celebrate-Diwali
