// ---------------------------------------------------------------------------
// Diwali economy integration tests (node:test).
// Spins up a real server on its own port and drives purchases / uses through
// the same WebSocket protocol the browser uses. Also unit-tests the pure
// wallet normaliser so corrupt saves can never produce a negative balance.
//
// Every test uses a random device token, so it starts from a genuinely fresh
// profile and cannot inherit state from a previous run.
// ---------------------------------------------------------------------------
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { CURRENCY, FIREWORKS, MAX_BUY_QTY } from "../shared/constants.js";
import { normalize, buy, use } from "../server/economy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3998;
const URL = `ws://localhost:${PORT}`;
const TMP_DATA = path.join(os.tmpdir(), `Diwali Meet Up-eco-${process.pid}`);

let proc = null;

async function startServer() {
  proc = spawn(
    process.execPath,
    [path.join(__dirname, "..", "server", "index.js")],
    {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: TMP_DATA },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((resolve, reject) => {
    const to = setTimeout(
      () => reject(new Error("server start timeout")),
      8000,
    );
    proc.stdout.on("data", (d) => {
      if (String(d).includes("http+ws on")) {
        clearTimeout(to);
        resolve();
      }
    });
    proc.stderr.on("data", (d) => process.stderr.write("[eco-srv] " + d));
  });
}

after(() => {
  if (proc) proc.kill("SIGINT");
  setTimeout(() => {
    try {
      fs.rmSync(TMP_DATA, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }, 250);
});

// ---- tiny ws client harness (mirrors tests/server.test.js) ------------------
function connect() {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on("message", (d) => {
    let m;
    try {
      m = JSON.parse(d.toString());
    } catch {
      return;
    }
    const w = waiters[0];
    if (w && w.pred(m)) w.found(m);
    else inbox.push(m);
  });
  const opened = new Promise((res) => ws.on("open", res));
  return {
    ws,
    opened,
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
    next: (pred, ms = 4000) =>
      new Promise((res, rej) => {
        for (let i = 0; i < inbox.length; i++) {
          if (pred(inbox[i])) {
            res(inbox.splice(i, 1)[0]);
            return;
          }
        }
        const w = { pred, found: null };
        const to = setTimeout(() => {
          const idx = waiters.indexOf(w);
          if (idx >= 0) waiters.splice(idx, 1);
          rej(
            new Error(
              `timeout (recent: ${
                inbox
                  .slice(-4)
                  .map((m) => m.t + (m.code ? ":" + m.code : ""))
                  .join(",") || "none"
              })`,
            ),
          );
        }, ms);
        w.found = (m) => {
          clearTimeout(to);
          const idx = waiters.indexOf(w);
          if (idx >= 0) waiters.splice(idx, 1);
          res(m);
        };
        waiters.push(w);
      }),
  };
}

const newToken = () => randomBytes(16).toString("hex");

async function login(token = newToken(), name = "EcoTester") {
  const c = connect();
  await c.opened;
  c.send({ t: "hello", token, name, av: { b: 0, h: 1 } });
  const w = await c.next((m) => m.t === "welcome", 6000);
  const wallet = await c.next((m) => m.t === "wallet", 6000);
  return { ...c, id: w.id, x: w.x, z: w.z, wallet };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  await startServer();
});

// -----------------------------------------------------------------------------
// pure wallet / inventory normalisation
// -----------------------------------------------------------------------------
test("normalize repairs corrupt or hostile saves", () => {
  assert.equal(normalize(null).wallet, CURRENCY.start);
  assert.equal(normalize({}).wallet, CURRENCY.start);
  assert.equal(normalize({ wallet: -500 }).wallet, 0);
  assert.equal(normalize({ wallet: 1e12 }).wallet, CURRENCY.maxBalance);
  assert.equal(normalize({ wallet: "oops" }).wallet, CURRENCY.start);

  const inv = normalize({
    inventory: {
      anar: -3,
      chakri: 2.5,
      rocket: "x",
      aerial: 5,
      phuljhadi: 1e9,
      sparklers: 99,
    },
  }).inventory;
  assert.deepEqual(inv, { aerial: 5, phuljhadi: 99 }); // negative/float/string dropped, stack clamped
  assert.equal(inv.sparklers, undefined); // packs are never held
});

test("stack limits are enforced server-side", () => {
  const r = buy(
    { wallet: CURRENCY.maxBalance, inventory: { anar: 98 } },
    "anar",
    2,
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "limit");
  assert.equal(r.itemId, "anar");
});

test("use() consumes exactly one and rejects empty / packs", () => {
  const ok = use({ wallet: 0, inventory: { anar: 2 } }, "anar");
  assert.equal(ok.ok, true);
  assert.equal(ok.inventory.anar, 1);

  const last = use({ wallet: 0, inventory: { anar: 1 } }, "anar");
  assert.equal(last.ok, true);
  assert.equal(last.inventory.anar, undefined);

  assert.equal(use({ wallet: 0, inventory: {} }, "anar").code, "empty");
  assert.equal(use({ wallet: 0, inventory: {} }, "combo").code, "item");
});

// -----------------------------------------------------------------------------
// live protocol
// -----------------------------------------------------------------------------
test("a fresh profile starts with the configured balance + empty bag", async () => {
  const c = await login();
  assert.equal(c.wallet.balance, CURRENCY.start);
  assert.deepEqual(c.wallet.inventory, {});
  assert.equal(c.wallet.currency.id, CURRENCY.id);
  assert.equal(c.wallet.currency.maxBalance, CURRENCY.maxBalance);
  c.close();
});

test("buy prices server-side and updates wallet/inventory once", async () => {
  const c = await login();
  c.send({ t: "shopBuy", itemId: "anar", qty: 2 });
  const w1 = await c.next((m) => m.t === "wallet" && m.bought);
  assert.equal(w1.balance, CURRENCY.start - 80);
  assert.equal(w1.inventory.anar, 2);
  assert.equal(w1.bought.qty, 2);
  assert.equal(w1.bought.cost, 80);

  // a second order stacks; it must not replay/duplicate the first
  c.send({ t: "shopBuy", itemId: "anar", qty: 1 });
  const w2 = await c.next((m) => m.t === "wallet" && m.bought);
  assert.equal(w2.inventory.anar, 3);
  assert.equal(w2.balance, CURRENCY.start - 120);
  c.close();
});

test("invalid item / invalid quantity are rejected without charging", async () => {
  const c = await login();
  c.send({ t: "shopBuy", itemId: "not-a-thing", qty: 1 });
  await c.next((m) => m.t === "err" && m.code === "shop-item");

  c.send({ t: "shopBuy", itemId: "anar", qty: 0 });
  await c.next((m) => m.t === "err" && m.code === "shop-qty");

  c.send({ t: "shopBuy", itemId: "anar", qty: 99 });
  await c.next((m) => m.t === "err" && m.code === "shop-qty");

  c.send({ t: "shopBuy", itemId: "anar", qty: "two" });
  await c.next((m) => m.t === "err" && m.code === "shop-qty");

  // a legitimate purchase still starts from the untouched balance
  c.send({ t: "shopBuy", itemId: "anar", qty: 1 });
  const w = await c.next((m) => m.t === "wallet" && m.bought);
  assert.equal(w.balance, CURRENCY.start - 40);
  assert.deepEqual(w.inventory, { anar: 1 });
  c.close();
});

test("cannot overspend; the balance never goes negative", async () => {
  const c = await login();
  // Drain the wallet with the largest single orders the server allows, using
  // the most expensive catalog item, until one more order cannot be afforded.
  // Deriving everything from the catalog keeps this valid if prices or the
  // starting balance change.
  const combo = FIREWORKS.find((f) => f.id === "combo");
  const order = combo.price * MAX_BUY_QTY;
  let spent = 0;
  while (CURRENCY.start - spent >= order) {
    c.send({ t: "shopBuy", itemId: "combo", qty: MAX_BUY_QTY });
    const w = await c.next((m) => m.t === "wallet" && m.bought);
    spent += w.bought.cost;
    assert.equal(w.balance, CURRENCY.start - spent);
    assert.ok(w.balance >= 0, "balance must never go negative");
  }

  // The next order costs more than what is left -> rejected outright and the
  // balance is untouched (a second identical attempt still fails).
  assert.ok(
    CURRENCY.start - spent < order,
    "wallet should be drained below one order",
  );
  c.send({ t: "shopBuy", itemId: "combo", qty: MAX_BUY_QTY });
  await c.next((m) => m.t === "err" && m.code === "shop-funds");
  c.send({ t: "shopBuy", itemId: "combo", qty: MAX_BUY_QTY });
  await c.next((m) => m.t === "err" && m.code === "shop-funds");

  // A smaller, affordable order still goes through and lands on a non-negative
  // balance: 0 <= balance < the smallest item price.
  const anar = FIREWORKS.find((f) => f.id === "anar");
  const left = CURRENCY.start - spent;
  if (left >= anar.price) {
    c.send({ t: "shopBuy", itemId: "anar", qty: 1 });
    const w = await c.next((m) => m.t === "wallet" && m.bought);
    assert.equal(w.balance, left - anar.price);
    assert.ok(w.balance >= 0);
  }
  c.close();
});

test("packs grant their bundle and every included item is individually usable", async () => {
  const c = await login();
  c.send({ t: "shopBuy", itemId: "combo", qty: 1 });
  const w = await c.next((m) => m.t === "wallet" && m.bought);
  assert.equal(w.balance, CURRENCY.start - 240);
  assert.equal(w.inventory.anar, 2);
  assert.equal(w.inventory.chakri, 2);
  assert.equal(w.inventory.phuljhadi, 3);
  assert.equal(w.inventory.rocket, 1);
  assert.equal(w.inventory.aerial, 1);
  assert.equal(w.inventory.combo, undefined);

  c.send({ t: "useItem", itemId: "rocket", x: c.x, z: c.z, ry: 0 });
  const fx = await c.next((m) => m.t === "fx" && m.item === "rocket");
  assert.equal(fx.kind, "rocket");
  const w2 = await c.next((m) => m.t === "wallet" && m.used);
  assert.equal(w2.inventory.rocket, undefined);
  assert.equal(w2.inventory.anar, 2); // the rest of the bundle is untouched
  c.close();
});

test("using decrements exactly once; an empty bag is rejected", async () => {
  const c = await login();
  c.send({ t: "shopBuy", itemId: "chakri", qty: 2 });
  await c.next((m) => m.t === "wallet" && m.bought);

  c.send({ t: "useItem", itemId: "chakri", x: c.x + 3, z: c.z, ry: 0 });
  const fx = await c.next((m) => m.t === "fx" && m.item === "chakri");
  assert.equal(fx.kind, "spinner");
  assert.equal(fx.id, c.id);
  const w1 = await c.next((m) => m.t === "wallet" && m.used);
  assert.equal(w1.inventory.chakri, 1);

  c.send({ t: "useItem", itemId: "chakri", x: c.x + 3, z: c.z, ry: 0 });
  const w2 = await c.next((m) => m.t === "wallet" && m.used);
  assert.equal(w2.inventory.chakri, undefined);

  c.send({ t: "useItem", itemId: "chakri", x: c.x + 3, z: c.z, ry: 0 });
  await c.next((m) => m.t === "err" && m.code === "use-empty");
  c.close();
});

test("packs cannot be used directly", async () => {
  const c = await login();
  c.send({ t: "shopBuy", itemId: "sparklers", qty: 1 });
  const w = await c.next((m) => m.t === "wallet" && m.bought);
  assert.equal(w.inventory.phuljhadi, 4);
  c.send({ t: "useItem", itemId: "sparklers", x: c.x, z: c.z });
  await c.next((m) => m.t === "err" && m.code === "use-item");
  c.close();
});

test("out-of-reach placement is clamped near the player", async () => {
  const c = await login();
  c.send({ t: "shopBuy", itemId: "anar", qty: 1 });
  await c.next((m) => m.t === "wallet" && m.bought);

  c.send({ t: "useItem", itemId: "anar", x: c.x + 500, z: c.z - 500, ry: 0 });
  const fx = await c.next((m) => m.t === "fx" && m.item === "anar");
  const dist = Math.hypot(fx.x - c.x, fx.z - c.z);
  assert.ok(dist <= 12.01, `expected <=12m, got ${dist}`);
  assert.ok(Math.hypot(fx.x, fx.z) <= 452.01, "inside PLAY_RADIUS");
  const w = await c.next((m) => m.t === "wallet" && m.used);
  assert.equal(w.inventory.anar, undefined);
  c.close();
});

test("handheld use broadcasts an fx that carries the sparkler duration", async () => {
  const c = await login();
  c.send({ t: "shopBuy", itemId: "phuljhadi", qty: 1 });
  await c.next((m) => m.t === "wallet" && m.bought);
  c.send({ t: "useItem", itemId: "phuljhadi", x: c.x, z: c.z });
  const fx = await c.next((m) => m.t === "fx" && m.item === "phuljhadi");
  assert.equal(fx.kind, "handheld");
  assert.equal(fx.id, c.id);
  assert.ok(fx.dur > 0);
  c.close();
});

test("wallet + inventory persist across a reconnect", async () => {
  const token = newToken();
  const a = await login(token, "EcoSave");
  a.send({ t: "shopBuy", itemId: "rocket", qty: 2 });
  const w = await a.next((m) => m.t === "wallet" && m.bought);
  assert.equal(w.inventory.rocket, 2);
  a.close();
  await sleep(900); // let the debounced profile store flush

  const b = await login(token, "EcoSave");
  assert.equal(b.wallet.balance, CURRENCY.start - 160);
  assert.equal(b.wallet.inventory.rocket, 2);
  b.close();
});
