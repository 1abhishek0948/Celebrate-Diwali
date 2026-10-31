# Setup

## Requirements

- Node.js ≥ 18 (tested on 22). No build step, no bundler.
- A WebGL-capable browser for the client (Chrome, Edge, Safari 16+).

## Install & run

```bash
npm install          # installs ws + three
npm start            # serves client at / and the game WebSocket on :3000
```

Open `http://localhost:3000` in two different browsers (or a normal + an
incognito window) to play with two players. Two tabs of the _same_ browser
share one device token, and a new login with the same token takes over the
session by design.

## Environment variables (server)

| var                           | default | meaning                                                                                                                                                                 |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                        | `3000`  | HTTP + WebSocket port                                                                                                                                                   |
| `ALLOWED_ORIGINS`             | —       | comma list of extra origins allowed in the WS `Origin` header (LAN testing). `http://localhost:*` and the serving host are always allowed                               |
| `DiwalyMeetUp_ALLOW_TELEPORT` | off     | dev-only: allows the `st` field `debugPos` to teleport a player (bypasses the movement budget). Normal movement validation is unchanged. Tests run with this set to `1` |
| `DiwalyMeetUp_DEBUG_MSG`      | off     | log every received message type to stderr                                                                                                                               |

There is no database: persistent state (names, avatars, friend lists, house
ownership) lives in `data/profiles.json`, created on first write. Delete it to
start clean.

## Voice chat (WebRTC proximity)

Players within 45 m automatically get a direct peer-to-peer audio link with
distance-based volume falloff. Mic on/off, mute and listen-only live in the
voice panel (sidebar → mic icon).

Requirements & caveats:

- Browsers only expose `getUserMedia` in **secure contexts**: `localhost` or
  any `https://` page. Opening the game via plain `http://<LAN-IP>` works for
  the game itself, but the mic is blocked — the voice panel will say so.
- On LAN/remote setups WebRTC peers usually need a STUN/TURN server
  (see `docs/ROADMAP.md`); on `localhost` and most home NATs STUN via public
  Google servers is enough.
- Chrome e2e for voice uses `--use-fake-device-for-media-stream` (see
  `tools/voice-e2e.js`): run `node tools/voice-e2e.js`, it starts its own
  server on `:3111` and should print all checks as `PASS`.

## Checks

```bash
npm test                          # 9 protocol integration tests (node --test)
node tools/e2e.js                 # headless-Chrome E2E of the real client (server must run)
node tools/voice-e2e.js           # two-browser WebRTC voice E2E (starts its own server)
node tools/loadtest.js [N] [sec]  # N bot clients; writes loads/load-report.md
```

The e2e tool needs a system Chrome at the default macOS path — override the
`CHROME` constant in `tools/e2e.js` if needed, and set `LOADTEST_URL` /
server `PORT` consistently for the load tool.

## Multi-browser / LAN testing

Serve on your LAN address, set `ALLOWED_ORIGINS` to the LAN URLs the other
browsers use, and open those URLs. No other configuration is required; the
server is stateless between restarts except `data/profiles.json`.
