// ---------------------------------------------------------------------------
// Load test: spins up N bot WebSocket clients against a running server,
// each bot walks a circle at 15 Hz (like the real client) and chats
// occasionally. Reports per-client uplink/downlink bytes/s, RTT, and pulls
// server tick p50/p95/p99 from GET /metrics. Output: markdown table in
// stdout + loads/load-report.md.
//
// Usage: node tools/loadtest.js [clients] [durationS]
//   node tools/loadtest.js 60 60     # 60 bots, 60s (server must be running)
// ---------------------------------------------------------------------------
import WebSocket from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';

const N = Number(process.argv[2] ?? 60);
const DURATION_S = Number(process.argv[3] ?? 45);
const URL = process.env.LOADTEST_URL ?? 'ws://localhost:3000';
const HTTP = URL.replace('ws://', 'http://');
const SEED_CHAT_EVERY_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
  constructor(i) {
    this.i = i;
    this.name = `Bot${i}`;
    this.token = `load-${i}-${Date.now().toString(36)}`;
    this.upBytes = 0;      // client -> server
    this.downBytes = 0;    // server -> client
    this.rtt = [];
    this.lastPing = 0;
    this.seq = 0;
    this.angle = (i / N) * Math.PI * 2;
    this.radius = 30 + (i % 5) * 35; // different circles keep everyone in range
    this.ws = new WebSocket(URL);
    this.ws.on('open', () => {
      this.send({ t: 'hello', token: this.token, name: this.name, av: { b: i % 4, h: i % 6, s: i % 4, p: i % 4 } });
    });
    this.ws.on('message', (d) => {
      this.downBytes += d.length;
      const m = JSON.parse(d.toString());
      if (m.t === 'pong') this.rtt.push(Date.now() - m.ts);
    });
    // movement loop: 15 Hz like the client, walking a circle at walk speed
    const omega = 3.2 / this.radius; // rad/s so tangential speed = 3.2 m/s
    setInterval(() => {
      this.angle += omega * 0.066;
      const x = Math.cos(this.angle) * this.radius;
      const z = Math.sin(this.angle) * this.radius;
      const ry = this.angle + Math.PI / 2;
      this.send({ t: 'st', seq: ++this.seq, x, y: 0, z, ry, mode: 1 });
      // RTT sample every 5s
      if (Date.now() - this.lastPing > 5000) { this.lastPing = Date.now(); this.send({ t: 'ping', ts: Date.now() }); }
      // occasional chat (rate limiter allows 3/5s; keep well under)
      if (Date.now() % SEED_CHAT_EVERY_MS < 16) this.send({ t: 'chat', text: `loadcheck ${this.name}` });
    }, 66);
  }
  send(m) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.upBytes += Buffer.byteLength(JSON.stringify(m));
    this.ws.send(JSON.stringify(m));
  }
  close() { this.ws.close(); }
}

console.log(`NewBuddy load test: ${N} bots @ ${URL} for ${DURATION_S}s`);
const t0 = Date.now();
const bots = [];
for (let i = 0; i < N; i++) bots.push(new Bot(i));
await sleep(1000);

const openCount = await Promise.all(bots.map(async (b) => {
  if (b.ws.readyState === WebSocket.OPEN) return true;
  await new Promise((r) => b.ws.once('open', r));
  return b.ws.readyState === WebSocket.OPEN;
}));
console.log(`connected ${openCount.filter(Boolean).length}/${N}`);

// run for the duration, sampling once mid-way
await sleep((DURATION_S - 4) * 1000);
const elapsedS = (Date.now() - t0) / 1000;
const metrics = await (await fetch(HTTP + '/metrics')).json();

const upBps = bots.map((b) => Math.round(b.upBytes / elapsedS));
const downBps = bots.map((b) => Math.round(b.downBytes / elapsedS));
const p = (arr, q) => arr.length ? arr.sort((a, b) => a - b)[Math.floor(q * (arr.length - 1))] : 0;
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

const report = [
  `# NewBuddy load test — ${new Date().toISOString()}`,
  '',
  `Bots: ${N} | Duration: ${DURATION_S}s | Server: ${URL}`,
  '',
  '## Per-client throughput (bytes/s, all bots)',
  '',
  '| metric | p50 | p95 | p99 | max | avg | total |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  `| uplink | ${p(upBps, .5)} | ${p(upBps, .95)} | ${p(upBps, .99)} | ${Math.max(...upBps)} | ${Math.round(sum(upBps) / N)} | ${Math.round(sum(upBps))} |`,
  `| downlink | ${p(downBps, .5)} | ${p(downBps, .95)} | ${p(downBps, .99)} | ${Math.max(...downBps)} | ${Math.round(sum(downBps) / N)} | ${Math.round(sum(downBps))} |`,
  '',
  '## RTT (server loopback, pong)',
  '',
  `| p50 | p95 | p99 | ms |`,
  `| ${p(bots.flatMap((b) => b.rtt), .5)} | ${p(bots.flatMap((b) => b.rtt), .95)} | ${p(bots.flatMap((b) => b.rtt), .99)} | ms |`,
  '',
  '## Server tick',
  '',
  `| p50 | p95 | p99 | ms |`,
  `| ${metrics.tickMs.p50} | ${metrics.tickMs.p95} | ${metrics.tickMs.p99} | ms |`,
  '',
  `## Rooms`,
  '',
  ...metrics.rooms.map((r) => `- ${r.id} (${r.type}, cap ${r.type === 'island' ? '100' : '12'}): **${r.n}** players`),
  '',
  `Online players: ${metrics.online} | Uptime: ${metrics.uptimeS}s`,
].join('\n');

console.log(report);
mkdirSync('loads', { recursive: true });
writeFileSync('loads/load-report.md', report + '\n');
console.log('\nreport saved to loads/load-report.md');

bots.forEach((b) => b.close());
process.exit(0);
