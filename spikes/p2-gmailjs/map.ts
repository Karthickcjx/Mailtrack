// Pure mapping helpers for the gmail.js adapter (unit-testable, no DOM).
import type { ComposeKind, MailAddress } from '../../extension/src/gmail/adapter';

export function toComposeKind(gmailJsType: unknown): ComposeKind {
  switch (gmailJsType) {
    case 'compose': return 'new';
    case 'reply': return 'reply';
    case 'forward': return 'forward';
    default: return 'unknown';
  }
}

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

/** gmail.js recipients() returns { to: string[], cc: string[], bcc: string[] } (emails only, no names). */
export function normalizeRecipients(raw: unknown): { to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[]; invalid: string[] } {
  const out = { to: [] as MailAddress[], cc: [] as MailAddress[], bcc: [] as MailAddress[], invalid: [] as string[] };
  const seen = new Set<string>();
  const r = (raw ?? {}) as Record<string, unknown>;
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const list = Array.isArray(r[field]) ? (r[field] as unknown[]) : [];
    for (const v of list) {
      const email = String(v ?? '').trim().toLowerCase();
      if (!EMAIL.test(email)) { if (email) out.invalid.push(email); continue; }
      if (seen.has(email)) continue;          // same address in To and Cc => one copy (first field wins)
      seen.add(email);
      out[field].push({ email });
    }
  }
  return out;
}

/** Extracts Gmail thread IDs from a thread-row element's attributes (selectors are an unstable Gmail detail). */
export function threadIdFromAttrs(attrs: { legacy?: string | null; threadId?: string | null }): string | null {
  if (attrs.legacy && /^[0-9a-f]{10,20}$/i.test(attrs.legacy)) return attrs.legacy.toLowerCase();
  const m = attrs.threadId?.match(/thread-[a-z]:(\d+)/i);
  return m ? m[1]! : null;
}
