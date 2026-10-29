// ---------------------------------------------------------------------------
// Proximity voice chat (WebRTC mesh, browser-native audio).
//
//   capture    getUserMedia -> one mic track shared by every peer
//   transport  RTCPeerConnection per nearby peer; the server only relays
//              SDP/ICE through the existing WebSocket (`vsig`), media is P2P
//   proximity  each peer gets an <audio> element; volume follows distance
//              (VOICE_RADIUS falloff). Peers drop out of range / blocked.
//
// Negotiation model:
//   * Every connection is created with a bidirectional ("sendrecv") audio
//     transceiver, even before the mic exists. Turning the mic on/off later
//     only swaps the sender track via replaceTrack() — no renegotiation, so
//     a peer that enables their mic late is still heard (the classic bug).
//   * The lower player id always offers; the higher id answers.
//   * ICE candidates that arrive before the remote description is applied are
//     queued and flushed afterwards instead of being silently dropped.
//   * Listening without a microphone is a first-class mode.
//
// Requires HTTPS or localhost for mic access. No TURN server in the
// prototype: STUN + host candidates work on LAN/localhost, some NATs fail.
// ---------------------------------------------------------------------------
import { VOICE_RADIUS, MAX_VOICE_PEERS } from '../shared/constants.js';

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const DISCONNECT_GRACE_MS = 4000;

export class VoiceChat extends EventTarget {
  constructor(net) {
    super();
    this.net = net;
    this.enabled = false;      // microphone capturing + sending
    this.listening = false;    // mesh active (receiving) — mic optional
    this.micMuted = false;
    this.speakerVolume = 0.8;
    this.stream = null;
    this.peers = new Map();    // id -> { pc, audio, gain, pendingIce, remoteSet, disconnectTimer }
    this._retries = new Map(); // id -> offer retry count (peer had voice off)
    this.blocked = new Set();  // ids whose voice I muted
    this.selfId = null;
    this.status = 'off';       // off | on | listening | denied | insecure
    this.lastError = '';

    net.on('vsig', (m) => this._sig(m.from, m.data));
  }

  setSelf(id) { this.selfId = id; }

  secureContext() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('change', {
      detail: {
        status: this.status,
        enabled: this.enabled,
        listening: this.listening,
        micMuted: this.micMuted,
        peers: this.peers.size,
        error: this.lastError,
      },
    }));
  }

  on(type, cb) { this.addEventListener(type, (e) => cb(e.detail)); }

  // -- capture ---------------------------------------------------------------
  async enable() { return this.enableMic(); }

  async enableMic() {
    if (this.enabled) return true;
    if (!this.secureContext()) {
      this.status = 'insecure';
      this.lastError = 'Microphone needs https:// or http://localhost';
      this._emit();
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      this.status = 'denied';
      this.lastError = e?.message || String(e);
      console.info('[voice] mic unavailable:', this.lastError);
      this._emit();
      return false;
    }
    this.enabled = true;
    this.micMuted = false;
    this.stream.getAudioTracks().forEach((t) => (t.enabled = true));
    this.startListening();
    this._syncTracks();
    this.status = 'on';
    this._emit();
    return true;
  }

  disableMic() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.enabled = false;
    this.micMuted = false;
    this._syncTracks(); // replaceTrack(null) — peers stay connected, receive only
    if (this.listening) this.status = 'listening';
    this._emit();
  }

  // -- listening / full off --------------------------------------------------
  startListening() {
    this.listening = true;
    if (this.status === 'off' || this.status === 'denied' || this.status === 'insecure') {
      this.status = this.enabled ? 'on' : 'listening';
    }
    this._emit();
  }

  stopListening() {
    this.listening = false;
    for (const id of [...this.peers.keys()]) this.hangup(id);
    this.status = this.enabled ? 'on' : 'off';
    this._emit();
  }

  disable() {
    this.disableMic();
    this.stopListening();
    this.status = 'off';
    this._emit();
  }

  toggleMic() {
    if (!this.stream) return this.micMuted;
    this.micMuted = !this.micMuted;
    this.stream.getAudioTracks().forEach((t) => (t.enabled = !this.micMuted));
    this._emit();
    return this.micMuted;
  }

  setSpeakerVolume(v) {
    this.speakerVolume = Math.max(0, Math.min(1, Number(v) || 0));
    for (const p of this.peers.values()) p.audio.volume = this.speakerVolume * p.gain;
    this._emit();
  }

  block(id) { this.blocked.add(id); this.hangup(id); this._emit(); }
  unblock(id) { this.blocked.delete(id); this._emit(); }

  // -- proximity -------------------------------------------------------------
  // Called ~every frame by main with [{id, dist}] of nearby remote players.
  updatePeers(candidates) {
    if (!this.listening || this.selfId === null) return;
    const keep = new Set(
      candidates
        .filter((c) => c.dist <= VOICE_RADIUS && !this.blocked.has(c.id))
        .map((c) => c.id)
    );
    for (const id of [...this.peers.keys()]) {
      if (!keep.has(id)) {
        this.hangup(id);
        this._retries.delete(id);
      }
    }

    let created = 0;
    for (const id of keep) {
      const existing = this.peers.get(id);
      if (existing) {
        // offer ignored (peer had voice off) -> retry; they may enable later
        const tries = this._retries.get(id) ?? 0;
        if (existing.pc.connectionState === 'new'
            && performance.now() - existing.createdAt > 5000
            && tries < 12) {
          this._retries.set(id, tries + 1);
          this.hangup(id);
          if (id > this.selfId) this._call(id);
        }
        continue;
      }
      // deterministic offer direction: only the lower id initiates
      if (id > this.selfId) {
        if (created >= MAX_VOICE_PEERS) break;
        created++;
        this._call(id);
      }
    }

    for (const c of candidates) {
      const p = this.peers.get(c.id);
      if (!p) continue;
      const falloff = Math.max(0, 1 - c.dist / VOICE_RADIUS);
      p.gain = falloff * falloff; // quadratic falloff
      const vol = this.speakerVolume * p.gain;
      p.audio.volume = vol;
    }
  }

  // -- peer plumbing ---------------------------------------------------------
  _createPeer(id, withAudioTransceiver) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.volume = 0;
    document.body.appendChild(audio);

    const peer = {
      pc, audio, gain: 0, pendingIce: [], remoteSet: false,
      disconnectTimer: null, createdAt: performance.now(), retries: 0,
    };
    this.peers.set(id, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.net.send({ t: 'vsig', to: id, data: { type: 'ice', cand: e.candidate } });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      audio.srcObject = stream;
      audio.play?.().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') this._retries.delete(id);
      if (st === 'failed' || st === 'closed') { this.hangup(id); return; }
      if (st === 'disconnected') {
        // transient during ICE checks — only tear down if it doesn't recover
        if (!peer.disconnectTimer) {
          peer.disconnectTimer = setTimeout(() => {
            peer.disconnectTimer = null;
            if (pc.connectionState === 'disconnected') this.hangup(id);
          }, DISCONNECT_GRACE_MS);
        }
      } else if (peer.disconnectTimer) {
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = null;
      }
      this._emit();
    };

    if (withAudioTransceiver) pc.addTransceiver('audio', { direction: 'sendrecv' });
    return peer;
  }

  _syncTracks() {
    const track = this.stream?.getAudioTracks()[0] ?? null;
    for (const peer of this.peers.values()) {
      for (const tr of peer.pc.getTransceivers()) {
        if (!tr.sender) continue;
        tr.direction = 'sendrecv';
        tr.sender.replaceTrack(track).catch(() => {});
      }
    }
  }

  async _flushIce(peer) {
    const list = peer.pendingIce.splice(0);
    for (const cand of list) {
      try { await peer.pc.addIceCandidate(cand); } catch { /* stale candidate */ }
    }
  }

  async _call(id) {
    const peer = this._createPeer(id, true);
    this._syncTracks();
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this.net.send({ t: 'vsig', to: id, data: { type: 'offer', sdp: peer.pc.localDescription } });
      this._emit();
    } catch (e) {
      console.info('[voice] offer failed for', id, e?.message || e);
      this.hangup(id);
    }
  }

  async _sig(from, data) {
    if (!data || typeof data.type !== 'string') return;
    try {
      if (data.type === 'offer') {
        if (!this.listening) return; // voice switched off locally
        if (this.peers.has(from)) this.hangup(from);
        const peer = this._createPeer(from, false);
        await peer.pc.setRemoteDescription(data.sdp);
        peer.remoteSet = true;
        // attach our mic to the transceiver created by the remote offer, and
        // negotiate bidirectional audio so late mic changes need no reneg.
        for (const tr of peer.pc.getTransceivers()) {
          tr.direction = 'sendrecv';
          const track = this.stream?.getAudioTracks()[0];
          if (tr.sender) tr.sender.replaceTrack(track ?? null).catch(() => {});
        }
        await this._flushIce(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.net.send({ t: 'vsig', to: from, data: { type: 'answer', sdp: peer.pc.localDescription } });
        this._emit();
      } else if (data.type === 'answer') {
        const peer = this.peers.get(from);
        if (!peer) return;
        if (peer.pc.signalingState === 'have-local-offer') {
          await peer.pc.setRemoteDescription(data.sdp);
          peer.remoteSet = true;
          await this._flushIce(peer);
          this._emit();
        }
      } else if (data.type === 'ice') {
        const peer = this.peers.get(from);
        if (!peer || !data.cand) return;
        if (!peer.remoteSet) { peer.pendingIce.push(data.cand); return; }
        try { await peer.pc.addIceCandidate(data.cand); } catch { /* duplicate/late */ }
      }
    } catch (e) {
      console.info('[voice] signaling issue with', from, e?.message || e);
    }
  }

  hangup(id) {
    const p = this.peers.get(id);
    if (!p) return;
    if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
    try { p.pc.close(); } catch { /* already closed */ }
    p.audio.srcObject = null;
    p.audio.remove();
    this.peers.delete(id);
    this._emit();
  }

  dropAll() { for (const id of [...this.peers.keys()]) this.hangup(id); }
}
