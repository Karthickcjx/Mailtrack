// Identifiers. Tracking tokens are 128-bit CSPRNG values (base64url, 22 chars), never derived from
// email addresses or database IDs, so they reveal nothing and can't be guessed or enumerated.

const B64URL = /^[A-Za-z0-9_-]+$/;

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 128-bit random token (22 base64url chars). */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Strict shape check for a tracking token taken from a URL (prevents odd input from reaching SQL). */
export function isTrackingToken(s: unknown): s is string {
  return typeof s === 'string' && s.length === 22 && B64URL.test(s);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = 0;
let lastRand: Uint8Array = new Uint8Array(10);

/** ULID: 48-bit ms timestamp + 80 random bits, lexicographically sortable; monotonic within one ms. */
export function ulid(now: number = Date.now()): string {
  let rand: Uint8Array;
  if (now === lastTime) {
    rand = lastRand.slice();
    for (let i = rand.length - 1; i >= 0; i--) { if (rand[i]! < 255) { rand[i]!++; break; } rand[i] = 0; }
  } else {
    rand = crypto.getRandomValues(new Uint8Array(10));
  }
  lastTime = now; lastRand = rand;
  let t = now, time = '';
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  let bits = 0, value = 0, out = '';
  for (const b of rand) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += CROCKFORD[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return time + out.slice(0, 16);
}

export function isUlid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}
