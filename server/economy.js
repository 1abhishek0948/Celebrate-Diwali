// ---------------------------------------------------------------------------
// Diwali economy — server-authoritative wallet + firecracker inventory.
//
// The catalog and prices live in shared/constants.js so the client and server
// agree, but ONLY the server ever reads or mutates a balance. Clients submit an
// item id + quantity and (for world placement) a target position; the server
// prices the order itself and rejects anything it cannot honour.
//
// Everything here is pure (profile in -> new numbers out) so it is unit-testable
// without a socket, and the socket layer just persists the returned patch.
// ---------------------------------------------------------------------------
import { CURRENCY, FIREWORKS, MAX_BUY_QTY, fireworkById } from '../shared/constants.js';

export const CATALOG = FIREWORKS;
export const CATALOG_MAP = new Map(FIREWORKS.map((f) => [f.id, f]));
export const MAX_QTY = MAX_BUY_QTY;

const clampInt = (v, d = 0) => (Number.isInteger(v) ? v : d);

// Coerce whatever is on disk into a valid { wallet, inventory } pair. Missing,
// corrupt or hand-edited saves degrade gracefully to a fresh but playable state.
export function normalize(prof) {
  let wallet = clampInt(prof?.wallet, CURRENCY.start);
  if (wallet < 0) wallet = 0;
  if (wallet > CURRENCY.maxBalance) wallet = CURRENCY.maxBalance;

  const inventory = {};
  const src = prof?.inventory;
  if (src && typeof src === 'object') {
    for (const f of FIREWORKS) {
      if (f.kind === 'pack') continue;               // packs are never held
      const n = clampInt(src[f.id], 0);
      if (n > 0) inventory[f.id] = Math.min(n, f.maxStack ?? 99);
    }
  }
  return { wallet, inventory };
}

// deterministic wallet packet builder (single shape the client understands)
export function walletPacket(prof, extra = {}) {
  const { wallet, inventory } = normalize(prof);
  return { t: 'wallet', balance: wallet, inventory, currency: { ...CURRENCY }, ...extra };
}

// Attempt a purchase. Returns { ok:false, code } or
// { ok:true, wallet, inventory, cost, item, qty, gained }.
export function buy(prof, itemId, qty) {
  const item = CATALOG_MAP.get(String(itemId || ''));
  if (!item) return { ok: false, code: 'item' };

  // strict quantity validation: no coercing "two" / 2.5 / null into a purchase
  const q = qty === undefined ? 1 : qty;
  if (!Number.isInteger(q) || q < 1 || q > MAX_QTY) return { ok: false, code: 'qty' };

  const eco = normalize(prof);
  const cost = item.price * q;
  if (cost > eco.wallet) return { ok: false, code: 'funds', wallet: eco.wallet };

  const inventory = { ...eco.inventory };
  const gained = {};

  if (item.kind === 'pack') {
    // pre-flight the whole bundle so we never take coins for items we can't hold
    for (const [gid, gqty] of Object.entries(item.gives || {})) {
      const target = CATALOG_MAP.get(gid);
      if (!target) continue;
      const have = inventory[gid] || 0;
      if (have + gqty * q > (target.maxStack ?? 99)) return { ok: false, code: 'limit', itemId: gid };
      gained[gid] = gqty * q;
    }
    for (const [gid, add] of Object.entries(gained)) inventory[gid] = (inventory[gid] || 0) + add;
  } else {
    const have = inventory[item.id] || 0;
    if (have + q > (item.maxStack ?? 99)) return { ok: false, code: 'limit', itemId: item.id };
    inventory[item.id] = have + q;
    gained[item.id] = q;
  }

  return {
    ok: true,
    wallet: eco.wallet - cost,
    inventory,
    cost,
    item,
    qty: q,
    gained,
  };
}

// Consume exactly one usable item. Returns { ok:false, code } or
// { ok:true, wallet, inventory }.
export function use(prof, itemId) {
  const item = CATALOG_MAP.get(String(itemId || ''));
  if (!item || item.kind === 'pack') return { ok: false, code: 'item' }; // packs are not usable

  const eco = normalize(prof);
  if ((eco.inventory[item.id] || 0) < 1) return { ok: false, code: 'empty' };

  const inventory = { ...eco.inventory };
  inventory[item.id] -= 1;
  if (inventory[item.id] <= 0) delete inventory[item.id];

  return { ok: true, wallet: eco.wallet, inventory };
}

export const isUsable = (id) => {
  const f = fireworkById(id);
  return !!f && f.kind !== 'pack';
};
