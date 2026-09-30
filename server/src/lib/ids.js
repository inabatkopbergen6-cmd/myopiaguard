import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short, sortable-ish, human-scannable ids: `seat_9f3k2m4p`. */
export function makeId(prefix = 'id') {
  const bytes = randomBytes(8);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function makeToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

export function uuid() {
  return randomUUID();
}

/** Constant-time string compare that tolerates unequal lengths. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Deterministic PRNG so seeded demo weeks are reproducible from a seed value. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
