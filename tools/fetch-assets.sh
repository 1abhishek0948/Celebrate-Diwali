#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Re-downloads the vendored character assets if they are ever lost.
#
# Everything below is served from Ready Player Me's own public GitHub repos
# and the three.js repo. Licenses (see docs/LICENSES.md):
#   - Avatars: Ready Player Me sample avatars published for use with the RPM
#     SDKs/demos. Use with RPM avatars per Ready Player Me terms.
#   - Animations: Ready Player Me Animation Library — free for personal and
#     commercial use WITH Ready Player Me avatars; do not redistribute the
#     clip files outside your project.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p client/assets/avatars client/assets/anims

DEMO="https://raw.githubusercontent.com/readyplayerme/animation-library-demo/HEAD/Assets/Ready%20Player%20Me/Avatars"
THREE="https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf"

# gender variants: feminine f0..f2, masculine m0..m2 (hairstyle index selects)
fetch_avatar() { # <file> <avatarId>
  [ -s "client/assets/avatars/$1" ] || curl -sL "$DEMO/$2/2fac66e374c947c41bc74325c6e3d934/$2.glb" -o "client/assets/avatars/$1"
}
fetch_avatar f0.glb 64e49fd93bf46b6b7fb28764
fetch_avatar f1.glb 64e35a43c603b299c00dfeba
fetch_avatar f2.glb 64d6034717883fd73ebe3dea
fetch_avatar m0.glb 64e359ea58f50a12df573a70
fetch_avatar m1.glb 64e49ef0cb0dbe5f8449d1da
fetch_avatar m2.glb 64e49f0ce0d08c465057866c

LIB="https://raw.githubusercontent.com/readyplayerme/animation-library/master"
fetch_clip() { # <file> <armature> <category> <clipName>
  [ -s "client/assets/anims/$1" ] || curl -sL "$LIB/$2/glb/$3/$4.glb" -o "client/assets/anims/$1"
}
fetch_clip f_idle.glb  feminine idle      F_Standing_Idle_001
fetch_clip f_walk.glb  feminine locomotion F_Walk_002
fetch_clip f_run.glb   feminine locomotion F_Run_001
fetch_clip f_jump.glb  feminine locomotion F_Jog_Jump_Small_001
fetch_clip f_dance.glb feminine dance      F_Dances_004
fetch_clip m_idle.glb  masculine idle      M_Standing_Idle_001
fetch_clip m_walk.glb  masculine locomotion M_Walk_001
fetch_clip m_run.glb   masculine locomotion M_Run_001
fetch_clip m_jump.glb  masculine locomotion M_Jog_Jump_001
fetch_clip m_dance.glb masculine dance      M_Dances_001

echo "avatar assets present:"
ls -la client/assets/avatars client/assets/anims
