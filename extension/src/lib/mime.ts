// RFC 5322 / MIME builder for one per-recipient copy (browser-native: TextEncoder + btoa, no Buffer).
// Produces the base64url "raw" value for users.messages.send.

export interface Address { email: string; name?: string }
export interface CopyInput {
  from: Address;
  to: Address;
  subject: string;
  html: string;
  text: string;
  messageId: string;          // <...@...>
  inReplyTo?: string;         // copy #1 Message-ID for copies 2..N
  date?: Date;
  boundary?: string;          // injectable for deterministic tests
}

const CRLF = '\r\n';
const enc = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(bin);
}
export const utf8Base64 = (s: string) => bytesToBase64(enc.encode(s));
export const toRaw = (mime: string) => utf8Base64(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RFC 2047 encoded-word (B) only when non-ASCII is present; split into words of at most 75 chars. */
export function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    const candidate = chunk + ch;
    if (Math.ceil(enc.encode(candidate).length / 3) * 4 + 12 > 75) { words.push(chunk); chunk = ch; } else chunk = candidate;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${utf8Base64(w)}?=`).join(`${CRLF} `);
}

const EMAIL = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\.]+(\.[^\s@<>()",;:\\.]+)+$/;
export function formatAddress(a: Address): string {
  if (/[\r\n<>]/.test(a.email) || !EMAIL.test(a.email)) throw new Error('invalid address');
  if (!a.name) return `<${a.email}>`;
  const safe = /^[\x20-\x7e]*$/.test(a.name) ? `"${a.name.replace(/["\\]/g, '\\$&').replace(/[\r\n]/g, ' ')}"` : encodeHeaderWord(a.name.replace(/[\r\n]/g, ' '));
  return `${safe} <${a.email}>`;
}

function headerSafe(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error('header injection attempt');
  return v;
}

/** RFC 5322 date, e.g. "Wed, 04 Nov 2026 12:00:00 +0000". */
export function rfc5322Date(d: Date): string {
  return d.toUTCString().replace('GMT', '+0000');
}

const base64Body = (s: string) => utf8Base64(s).replace(/.{76}/g, `$&${CRLF}`);

export function buildMime(c: CopyInput): string {
  const boundary = c.boundary ?? `b_${crypto.randomUUID().replace(/-/g, '')}`;
  const headers = [
    `From: ${formatAddress(c.from)}`,
    `To: ${formatAddress(c.to)}`,
    `Subject: ${encodeHeaderWord(headerSafe(c.subject))}`,
    `Date: ${rfc5322Date(c.date ?? new Date())}`,                 // required by RFC 5322 (P3 review finding)
    `Message-ID: ${headerSafe(c.messageId)}`,
    ...(c.inReplyTo ? [`In-Reply-To: ${headerSafe(c.inReplyTo)}`, `References: ${headerSafe(c.inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Body(c.text),
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Body(c.html),
    `--${boundary}--`, '',
  ];
  return headers.join(CRLF) + CRLF + CRLF + parts.join(CRLF);
}
