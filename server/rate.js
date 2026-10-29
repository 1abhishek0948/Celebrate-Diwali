// ---------------------------------------------------------------------------
// Rate limiting + input sanitization (basic security for the prototype).
// ---------------------------------------------------------------------------
import { CHAT_RATE_PER_S, MSG_RATE_PER_S, CHAT_MAX_LEN } from '../shared/constants.js';

export class RateLimiter {
  constructor() {
    this.events = [];
  }

  // push now (ms), prune window, return true if still under limit
  allow(max, windowMs, now = Date.now()) {
    this.events.push(now);
    while (this.events.length && this.events[0] < now - windowMs) this.events.shift();
    return this.events.length <= max;
  }
}

// Allow N messages per PER_S seconds (per kind).
const buckets = new WeakMap(); // socket -> {msg, chat, shop, use}
export function limiterFor(socket) {
  let b = buckets.get(socket);
  if (!b) {
    b = {
      msg: new RateLimiter(), chat: new RateLimiter(),
      shop: new RateLimiter(), use: new RateLimiter(),
    };
    buckets.set(socket, b);
  }
  return b;
}
export const MSG_LIMIT = () => ({ max: MSG_RATE_PER_S, windowMs: 2000 });
export const CHAT_LIMIT = () => ({ max: CHAT_RATE_PER_S, windowMs: 5000 });
// Economy limits: generous enough for a human clicking, tight enough to stop a
// scripted buy/use flood from farming the wallet or the particle pool.
export const SHOP_LIMIT = () => ({ max: 8, windowMs: 2000 });  // purchases
export const USE_LIMIT = () => ({ max: 10, windowMs: 2000 }); // firecracker uses

// Strip control chars + clamp length. escapeHtml happens client-side (UI renders
// via textContent); server strips unprintables.
export function sanitizeChat(text) {
  if (typeof text !== 'string') return '';
  let t = text.replace(/[\u0000-\u001f\u007f]/g, '');
  t = t.trim().slice(0, CHAT_MAX_LEN);
  return t;
}
