// Local-only data (D10/D11): subjects, recipient addresses and anchor text never go to the backend by default.
import { base64url } from '@tracklet/shared';
import type { Platform } from './platform';

export interface LocalMeta {
  emailId: string;
  subject: string;
  createdAt: number;
  recipients: { recipientId: string; address: string; field: 'to' | 'cc' | 'bcc' }[];
  links: { index: number; url: string }[];
}

const META_PREFIX = 'meta:';
const NOTIFIED_KEY = 'notifiedEventIds';
const MAX_NOTIFIED = 500;

export async function userSecret(p: Platform): Promise<string> {
  let s = await p.local.get<string>('userSecret');
  if (!s) { s = base64url(p.randomBytes(32)); await p.local.set('userSecret', s); }
  return s;
}

/** recipient_key = HMAC-SHA256(local secret, lower(address)) → 43 base64url chars. The backend never sees the address. */
export async function recipientKey(secret: string, address: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(address.trim().toLowerCase()))));
}

export const saveMeta = (p: Platform, m: LocalMeta) => p.local.set(META_PREFIX + m.emailId, m);
export const loadMeta = (p: Platform, emailId: string) => p.local.get<LocalMeta>(META_PREFIX + emailId);
export const deleteMeta = (p: Platform, emailId: string) => p.local.remove(META_PREFIX + emailId);

export async function notifiedIds(p: Platform): Promise<string[]> { return (await p.local.get<string[]>(NOTIFIED_KEY)) ?? []; }
export async function rememberNotified(p: Platform, ids: string[]): Promise<void> {
  const all = [...(await notifiedIds(p)), ...ids];
  await p.local.set(NOTIFIED_KEY, all.slice(-MAX_NOTIFIED));
}
