import type { PageMessage, Reply } from '../messages';

export class RpcError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function rpc<T>(msg: PageMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (r: Reply<T> | undefined) => {
      if (!r) return reject(new RpcError('internal', chrome.runtime.lastError?.message ?? 'No response from Tracklet'));
      if (r.ok) resolve(r.data); else reject(new RpcError(r.error, r.message));
    });
  });
}

export const fmtTime = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function fmtRelative(ms: number | null | undefined): string {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const CLASS_LABEL: Record<string, { text: string; tone: 'good' | 'info' | 'muted' | 'warn' }> = {
  human_likely: { text: 'Likely human', tone: 'good' },
  proxy_open: { text: 'Via image proxy', tone: 'info' },
  prefetch_suspected: { text: 'Possibly automatic (prefetch)', tone: 'muted' },
  scanner_suspected: { text: 'Possibly a security scanner', tone: 'warn' },
  self_suspected: { text: 'Probably you', tone: 'muted' },
  duplicate: { text: 'Duplicate', tone: 'muted' },
};
