// SPIKE P3 (throwaway): RFC 5322 / MIME builder for one per-recipient copy.
// Produces the base64url "raw" value for users.messages.send.

export interface Address { email: string; name?: string }
export interface CopyInput {
  from: Address;
  to: Address;
  subject: string;
  html: string;
  text: string;
  messageId: string;                 // e.g. <01J...@tracklet.invalid>
  inReplyTo?: string;                // copy #1 Message-ID for copies 2..N
  date?: Date;
  boundary?: string;                 // injectable for deterministic tests
}

const CRLF = '\r\n';

/** RFC 2047 encoded-word (B encoding) only when non-ASCII is present. Long values are split into <=75-char words. */
export function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    const candidate = chunk + ch;
    // 12 = "=?UTF-8?B?" + "?=" overhead; base64 grows 4/3.
    if (Math.ceil(Buffer.byteLength(candidate, 'utf8') / 3) * 4 + 12 > 75) { words.push(chunk); chunk = ch; } else chunk = candidate;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

export function formatAddress(a: Address): string {
  if (/[\r\n<>]/.test(a.email) || !/^[^@\s]+@[^@\s]+$/.test(a.email)) throw new Error(`invalid address: ${a.email}`);
  if (!a.name) return `<${a.email}>`;
  const safe = /^[\x20-\x7e]*$/.test(a.name) ? `"${a.name.replace(/["\\]/g, '\\$&')}"` : encodeHeaderWord(a.name);
  return `${safe} <${a.email}>`;
}

function headerSafe(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error('header injection attempt');
  return v;
}

function base64Body(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, `$&${CRLF}`);
}

export function buildMime(c: CopyInput): string {
  const boundary = c.boundary ?? `b_${crypto.randomUUID().replace(/-/g, '')}`;
  const headers = [
    `From: ${formatAddress(c.from)}`,
    `To: ${formatAddress(c.to)}`,
    `Subject: ${encodeHeaderWord(headerSafe(c.subject))}`,
    `Message-ID: ${headerSafe(c.messageId)}`,
    ...(c.inReplyTo ? [`In-Reply-To: ${headerSafe(c.inReplyTo)}`, `References: ${headerSafe(c.inReplyTo)}`] : []),
    ...(c.date ? [`Date: ${c.date.toUTCString().replace('GMT', '+0000')}`] : []),
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

export function toRaw(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url');
}

/** Pixel goes at the START of the body (D17: Gmail clips >~102 KB). */
export function insertPixelAtTop(html: string, pixelUrl: string): string {
  const img = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`;
  return /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => m + img) : img + html;
}
