# Third-party licenses

NewBuddy's own code is original; the only external components are listed
below. Full license texts are copied into `docs/LICENSES/` and
`client/vendor/` so the tree stays self-contained (the server re-copies
them from `node_modules` on startup if they go missing).

| component | version | license | where |
| --- | --- | --- | --- |
| `three` (3D engine) | 0.166.x | MIT — `client/vendor/LICENSE.three` | `client/vendor/three.module.js` |
| `CSS2DRenderer` (three examples) | same as three | MIT (three license) | `client/vendor/CSS2DRenderer.js` |
| `BufferGeometryUtils` (three examples) | same as three | MIT (three license) | `client/vendor/BufferGeometryUtils.js` |
| `ws` (WebSocket server) | 8.x | MIT — `docs/LICENSES/ws-license.txt` | `node_modules` (server only) |

No other third-party code is used: the world, characters, and UI are
generated procedurally with engine primitives and hand-written HTML/CSS/JS.
