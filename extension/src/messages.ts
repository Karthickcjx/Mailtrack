// Message protocol between extension contexts. The service worker is the only holder of tokens;
// replies never contain Google tokens or backend session tokens.
import type { Preferences } from '@tracklet/shared';
import type { ComposeInput } from './lib/trackedSend';

/** Messages allowed from the Gmail content script. */
export type ContentMessage =
  | { type: 'send'; compose: ComposeInput }
  | { type: 'dryRun'; compose: ComposeInput }
  | { type: 'threadViewed'; threadId: string }
  | { type: 'threadStatus'; ids: string[] };

/** Messages allowed only from extension pages (popup / dashboard). */
export type PageMessage =
  | { type: 'authStatus' }
  | { type: 'signIn' }
  | { type: 'signOut' }
  | { type: 'dashboard'; range: '7d' | '30d' | '90d' }
  | { type: 'emails'; cursor?: string; filter?: 'all' | 'opened' | 'unopened' | 'clicked' }
  | { type: 'email'; emailId: string; includeSuspected: boolean }
  | { type: 'deleteEmail'; emailId: string }
  | { type: 'deleteAll' }
  | { type: 'getPrefs' }
  | { type: 'putPrefs'; prefs: Preferences }
  | { type: 'pollNow' }
  | { type: 'whoami' };

export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: 'auth_required' | 'validation' | 'backend' | 'backend_unreachable' | 'google_auth' | 'forbidden' | 'internal'; message: string; details?: unknown };

export const CONTENT_TYPES = new Set(['send', 'dryRun', 'threadViewed', 'threadStatus']);
export const PAGE_TYPES = new Set(['authStatus', 'signIn', 'signOut', 'dashboard', 'emails', 'email', 'deleteEmail', 'deleteAll', 'getPrefs', 'putPrefs', 'pollNow', 'whoami']);

export type SenderKind = 'content' | 'page' | 'unknown';

/** Classify a runtime message sender. Only our own extension's pages and Gmail tabs are trusted. */
export function senderKind(sender: { id?: string; url?: string; tab?: unknown }, extensionId: string, extensionOrigin: string): SenderKind {
  if (sender.id !== extensionId || !sender.url) return 'unknown';
  if (sender.url.startsWith(extensionOrigin)) return 'page';
  if (sender.tab && /^https:\/\/mail\.google\.com\//.test(sender.url)) return 'content';
  return 'unknown';
}

export function isAllowed(kind: SenderKind, type: unknown): boolean {
  if (typeof type !== 'string') return false;
  if (kind === 'content') return CONTENT_TYPES.has(type);
  if (kind === 'page') return PAGE_TYPES.has(type) || CONTENT_TYPES.has(type);
  return false;
}
