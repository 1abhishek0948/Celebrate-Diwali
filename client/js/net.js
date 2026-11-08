// ---------------------------------------------------------------------------
// Diwali Meet Up client network layer.
//  - JSON-over-WebSocket protocol (same messages the server tests exercise)
//  - session resume via device token (reconnect keeps player id + room)
//  - server clock estimation for snapshot interpolation (ping/pong)
// ---------------------------------------------------------------------------
const TOKEN_KEY = "Diwali Meet Up.token";
const PROFILE_KEY = "Diwali Meet Up.profile";
let sessionToken = null;
let sessionProfile = {};

export function deviceToken() {
  if (sessionToken) return sessionToken;
  let t;
  try {
    t = localStorage.getItem(TOKEN_KEY);
  } catch { /* storage denied */ }
  if (!t || !/^[a-f0-9]{16,64}$/.test(t)) {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    t = [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch { /* session-only identity */ }
  }
  sessionToken = t;
  return sessionToken;
}

export function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
    if (p && typeof p === "object" && !Array.isArray(p)) sessionProfile = p;
  } catch {
    // Keep a session-only profile when private browsing blocks storage.
  }
  return sessionProfile;
}
export function saveProfile(p) {
  sessionProfile = p;
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  } catch { /* storage denied */ }
}

const MAX_RECONNECT_DELAY = 8000;

export class Net extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.status = "idle"; // idle | connecting | open | reconnecting | closed
    this.attempt = 0;
    this.clockOffset = 0; // serverTime - clientTime (ms)
    this.rtt = 0;
    this.welcomed = false;
    this.hello = null;
    this._queue = [];
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._connectTimer = null;
    this._stopped = false;
  }

  url() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  }

  helloMsg() {
    const core = { t: "hello", token: deviceToken() };
    if (this.hello) {
      core.name = this.hello.name;
      core.av = this.hello.av;
    }
    return core;
  }

  connect(hello) {
    if (hello) this.hello = hello;
    this._stopped = false;
    this.attempt = 0;
    this._open();
  }

  _open() {
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._connectTimer);
    this._stopPing();
    const old = this.ws;
    this.ws = null; // Late callbacks from a replaced socket must be ignored.
    if (old) {
      try {
        old.close();
      } catch {}
    }
    this.status = this.attempt ? "reconnecting" : "connecting";
    this._emit("status", this.status);
    let ws;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this._retry();
      return;
    }
    this.ws = ws;
    this._connectTimer = setTimeout(() => {
      if (this.ws === ws) ws.close();
    }, 10000);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.status = "open";
      this._emit("status", this.status);
      this.send(this.helloMsg());
      this._queue.forEach((m) => ws.send(JSON.stringify(m)));
      this._queue.length = 0;
      this._startPing();
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      this._route(m);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearTimeout(this._connectTimer);
      this._stopPing();
      this.ws = null;
      this._retry();
    };
    ws.onerror = () => ws.close();
  }

  _retry() {
    if (!this._stopped && (this.welcomed || this.attempt < 3)) {
      this.status = "reconnecting";
      this._emit("status", this.status);
      const delay = Math.min(
        MAX_RECONNECT_DELAY,
        500 * Math.pow(2, this.attempt++),
      );
      this._reconnectTimer = setTimeout(() => this._open(), delay);
    } else {
      this.status = "closed";
      this._emit("status", this.status);
    }
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    else if (this._queue.length < 64) this._queue.push(msg);
  }

  resetSession() {
    this.welcomed = false;
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._connectTimer);
    this._stopPing();
  }

  // server time estimate for interpolation
  now() {
    return Date.now() + this.clockOffset;
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      this.send({ t: "ping", ts: Date.now() });
    }, 2000);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _route(m) {
    switch (m.t) {
      case "welcome": {
        clearTimeout(this._connectTimer);
        this.welcomed = true;
        this.attempt = 0;
        this._emit("welcome", m);
        break;
      }
      case "welcome2":
        this._emit("roomRoster", m);
        break;
      case "join":
        this._emit("join", m.p);
        break;
      case "leave":
        this._emit("leave", m.id);
        if (m.sys) this._emit("sys", { text: m.sys, kind: "leave" });
        break;
      case "snap":
        this._emit("snap", m);
        break;
      case "chat":
        this._emit("chat", m);
        break;
      case "emote":
        this._emit("emote", m);
        break;
      case "sys":
        this._emit("sys", m);
        break;
      case "room":
        this._emit("room", m);
        break;
      case "err":
        this._emit("err", m);
        if (m.code === "replaced") this.resetSession();
        break;
      case "wallet":
        this._emit("wallet", m);
        break;
      case "fx":
        this._emit("fx", m);
        break;
      case "friends":
        this._emit("friends", m);
        break;
      case "fReq":
        this._emit("fReq", m);
        break;
      case "invite":
        this._emit("invite", m);
        break;
      case "houseOwned":
        this._emit("houseOwned", m);
        break;
      case "houseMode":
        this._emit("houseMode", m);
        break;
      case "blocked":
        this._emit("blocked", m);
        break;
      case "pong": {
        const rtt = Date.now() - m.ts;
        this.rtt = this.rtt ? this.rtt * 0.7 + rtt * 0.3 : rtt;
        // clock offset: server clock at receipt ≈ m.st, client local now
        const offset = m.st - (Date.now() - this.rtt / 2);
        this.clockOffset = this.clockOffset
          ? this.clockOffset * 0.7 + offset * 0.3
          : offset;
        this._emit("netstat", { rtt: this.rtt });
        break;
      }
      case "vsig":
        this._emit("vsig", m);
        break;
    }
  }

  _emit(type, detail) {
    const ev = new CustomEvent(type, { detail });
    this.dispatchEvent(ev);
  }

  // typed event hooks
  on(type, cb) {
    this.addEventListener(type, (e) => cb(e.detail));
  }
}
