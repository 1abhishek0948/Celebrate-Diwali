# Third-party licenses

NewBuddy's own code is original; the only external components are listed
below. Full license texts are copied into `docs/LICENSES/` and
`client/vendor/` so the tree stays self-contained (the server re-copies
them from `node_modules` on startup if they go missing).

| component                        | version       | license                              | where                            |
| -------------------------------- | ------------- | ------------------------------------ | -------------------------------- |
| `three` (3D engine)              | 0.166.x       | MIT — `client/vendor/LICENSE.three`  | `client/vendor/three.module.js`  |
| `CSS2DRenderer` (three examples) | same as three | MIT (three license)                  | `client/vendor/CSS2DRenderer.js` |
| `GLTFLoader`, `BufferGeometryUtils`, `SkeletonUtils` (three examples) | same as three | MIT (three license) | `client/vendor/*.js` |
| `ws` (WebSocket server)          | 8.x           | MIT — `docs/LICENSES/ws-license.txt` | `node_modules` (server only)     |
| Ready Player Me sample avatars   | 2023 export   | Ready Player Me terms (see below)    | `client/assets/avatars/*.glb`    |
| RPM Animation Library clips      | 1.0 (2023)    | RPM Animation Library license (below) | `client/assets/anims/*.glb`    |

## Character assets

The realistic player characters are Ready Player Me full-body avatars, and the
locomotion/idle/jump/dance animations are from Ready Player Me's free
[animation library](https://github.com/readyplayerme/animation-library)
(retargeted to the RPM armature). Both were taken from Ready Player Me's own
public GitHub repositories:

- Avatars: `readyplayerme/animation-library-demo` sample avatars
  (`tools/fetch-assets.sh` re-downloads them).
- Animations: `readyplayerme/animation-library` (CC-style proprietary license:
  free for personal and commercial use **with Ready Player Me avatars**; the
  clip files may be modified for the project but must not be redistributed or
  sold outside it).

Per the animation library license, keep these asset files inside this project
and keep avatars Ready Player Me ones if the clips are used. If you replace
the characters with non-RPM models, you must also replace the animation clips
(the procedural fallback rig and the gesture layer are original code and
unrestricted).

No other third-party code is used: the world, UI, animation controller and the
procedural fallback character are generated with engine primitives and
hand-written HTML/CSS/JS.
