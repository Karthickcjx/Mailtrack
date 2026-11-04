// Link-target validation for click tracking. Only http(s) URLs without embedded credentials are
// ever stored as redirect targets; everything else is left untracked in the email.

export const MAX_URL_LENGTH = 2048;

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

export function validateTargetUrl(raw: unknown): UrlCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'not a string' };
  const s = raw.trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (s.length > MAX_URL_LENGTH) return { ok: false, reason: 'too long' };
  // Reject control characters and whitespace inside the URL (common smuggling vector).
  if (/[\u0000-\u001f\u007f\s]/.test(s)) return { ok: false, reason: 'control or whitespace characters' };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, reason: 'unparseable' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: `scheme ${u.protocol} not allowed` };
  if (u.username || u.password) return { ok: false, reason: 'credentials in URL' };
  if (!u.hostname) return { ok: false, reason: 'no host' };
  const out = u.toString();
  if (out.length > MAX_URL_LENGTH) return { ok: false, reason: 'too long after normalisation' };
  return { ok: true, url: out };
}

/**
 * Why a tracking URL (pixel / click) can NOT be reached by recipients' mail clients or Gmail's image proxy,
 * or null if it looks publicly reachable. Mail images are fetched from the public internet (Gmail fetches them
 * from Google's servers), so loopback / private / local-only hosts and plain http never record an open.
 */
export function trackingUrlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'not a valid URL'; }
  if (u.protocol !== 'https:') return `uses ${u.protocol.replace(':', '')}, not https`;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return 'is localhost';
  if (/\.(local|internal|lan|home\.arpa)$/.test(h)) return 'is a local-network name';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) {
      return 'is a loopback/private IP address';
    }
    return null;
  }
  if (h.includes(':')) return /^(::1?|f[cd][0-9a-f]{0,2}:.*|fe80:.*)$/.test(h) ? 'is a loopback/private IP address' : null;
  if (!h.includes('.')) return 'is not a public hostname';
  return null;
}
