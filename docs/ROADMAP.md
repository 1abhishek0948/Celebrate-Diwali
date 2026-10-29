# Known limitations & roadmap

## Limitations (prototype, by design)

- **No auth, no TLS.** Single device-token identity from `localStorage`;
  any LAN user can join. Fine for local testing, not for public hosting.
- **STUN-only WebRTC voice.** No TURN servers: NAT'd peers behind
  symmetric NATs may fail to establish voice (text still works).
- **Shop facades are not enterable** — commercial street is scenery;
  interiors exist only for the 8 residential houses
  (see `SHOPS` comment in `shared/constants.js`).
- **No persistence beyond `profiles.json`.** No server-side inventory,
  cosmetics, or world edits; house ownership lives in that one file.
- **Single process.** One Node process ≈ one island-metropolis; no
  horizontal sharding yet.
- **Primitives-only art.** Everything is boxes/cylinders/spheres;
  `docs/screenshots/` shows the current visual state.
- **macOS Chrome path hardcoded** in `tools/e2e.js` for the E2E harness.

## Verified limits (from `loads/load-report.md`)

- 100 concurrent players on one island: tick p95 ≈ 5.7 ms (budget 50 ms),
  ~96 KB/s downlink per client on loopback.
- House rooms cap at 12; island rooms cap at 100.

## Roadmap

1. **Transport polish** — TLS termination (or `wss` behind a proxy),
   TURN server config for voice, optional auth tokens.
2. **World growth** — enterable shops, a second district, day/night cycle,
   weather; keep everything procedural.
3. **Social depth** — party/invite UI on the island, public voice channels,
   emote dueling mini-game (no combat), house décor (server-stored).
4. **Client perf** — instanced trees/bushes, LOD on colliders,
   renderer quality tiers for low-end phones.
5. **Ops** — sharding across processes by island, `/metrics` → Prometheus
   format, structured logging.
6. **Assets** — swap primitive rigs for low-poly skinned models;
   keep the no-build pipeline.
