# Diwali Meet Up

A 3D multiplayer social island — no combat. Walk around a procedurally generated
island, visit twenty-four houses, sit on furniture, chat, emote, and talk to
nearby players over WebRTC voice. Built as a complete prototype: authoritative
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

## Controls

**Desktop**

| Input                    | Action                                   |
| ------------------------ | ---------------------------------------- |
| W A S D / arrows         | Walk (camera-relative)                   |
| Shift (hold) + W/A/S/D   | Run                                      |
| Space                    | Jump                                     |
| Hold mouse button + drag | Rotate camera (cursor stays visible)     |
| Mouse wheel              | Zoom camera in/out                       |
| E                        | Interact (doors, shops, festival, greet) |
| F                        | Light equipped firecracker               |
| I                        | Open firecracker bag                     |
| 1 / 2 / 3                | Wave / Dance / Greet emotes              |
| P / B / V                | Players / Friends / Voice panels         |
| T                        | Toggle day/night                         |
| G                        | Toggle fullscreen                        |
| Esc                      | Close modals & panels                    |

**Mobile / tablet** — virtual joystick (bottom-left) with multi-touch (move +
jump together), Jump and Use buttons (bottom-right), drag the right half of the
screen to rotate the camera. Fullscreen button is in the top-right HUD.

## Deploy

### Vercel Hobby (free)

This repository is configured to deploy the static Diwali MeetUp site in
`public/` to Vercel. In the Vercel import flow, leave the project root at the
repository root; `vercel.json` selects the output directory and runs the
verification step automatically.

```bash
npm run build
npx vercel --prod
```

To preview only that static site locally, run `npm run start:site`.

You can alternatively connect the repository in the Vercel dashboard. Every
push to the production branch will then deploy automatically. The site uses no
environment variables, database, or paid Vercel feature.

### Render Web Service (GitHub + WebSockets)

The 3D multiplayer game uses a long-lived WebSocket server and therefore cannot
run inside Vercel Functions. This repository includes a root-level
`render.yaml` Blueprint for a free Render Web Service. It serves the game and
its WebSocket endpoint from the same `onrender.com` origin, so no client URL or
environment-variable changes are required.

To deploy from GitHub:

1. Commit and push this repository to GitHub.
2. In Render, choose **New → Blueprint**, then connect that GitHub repository.
3. Render detects `render.yaml`. Confirm the `diwali-meetup-game` Web Service
   and create it.
4. Open the generated `https://…onrender.com` URL after the deploy completes.

Render runs `npm ci`, starts the app with `npm run start:game`, checks
`/health`, and redeploys automatically after commits to the selected branch.
The client will use `wss://…/ws` automatically in production.

The Free plan is suitable for demos and personal projects, but it sleeps after
15 minutes without traffic and its filesystem is ephemeral. This prototype's
profile store is file-based, so names, friends, and ownership can reset after a
sleep, restart, or redeploy. Use a managed database before treating it as
durable production data.

If the service was deployed before the latest commit, use **Manual Deploy →
Deploy latest commit** in Render after pushing. The server generates the
browser-side Three.js modules when it starts; this is required for the avatar
loader to work on a fresh Render instance.

For local game-server development:

```bash
npm install
npm run start:game
```

- **Render / Railway / Fly.io / Heroku**: create a Node service, build command
  `npm install`, start command `npm run start:game`. The port is taken from `PORT`
  automatically.
- **Self-host / VPS**: `npm install && npm run start:game` behind any reverse proxy.
- Note: WebRTC voice needs HTTPS (or `localhost`); plain-HTTP LAN serves the
  game fine but browsers will block microphone access.

## What works (all tested)

- Authoritative 20 Hz snapshots, 15 Hz client sends, wall-clock movement
  budget validation (anti-teleport, anti-packet-spam) — see ARCHITECTURE
- islands cap at 100 players; houses cap at 12 (including owner)
- House claiming, lock modes (`public / friends / private`), invite bypass
- Friend add/remove with presence, friend requests, PMs, chat + PM flood limits
- 10 s reconnect grace; duplicate login takes over the session (old socket closed,
  same player id preserved)
- Interest radius: you only receive snapshots for players within 80 m
- Realistic Ready Player Me full-body avatars (three hairstyles for **both**
  genders) with mocap idle/walk/run/jump/dance plus code-driven wave + namaste
  gestures; a procedural primitive rig is the offline fallback
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
