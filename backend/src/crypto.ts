// HS256 session tokens and keyed hashing (WebCrypto only; works in Workers and Node).
const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string, usage: ("sign" | "verify")[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SessionClaims { sub: string; iat: number; exp: number }

export async function signSession(secret: string, claims: SessionClaims): Promise<string> {
  if (!secret || secret.length < 32) throw new Error('SESSION_SIGNING_KEY missing or too short');
  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

/** Returns the claims if the signature (constant-time, via subtle.verify) and expiry are valid. */
export async function verifySession(secret: string, token: string, now: number): Promise<SessionClaims | null> {
  if (!secret || secret.length < 32) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const head = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]!)));
    if (head.alg !== 'HS256') return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), fromB64url(parts[2]!) as unknown as ArrayBuffer, enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]!))) as SessionClaims;
    if (typeof c.sub !== 'string' || typeof c.exp !== 'number' || c.exp * 1000 <= now) return null;
    return c;
  } catch { return null; }
}
