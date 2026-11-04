// In-memory Platform for unit tests.
import type { KV, Platform } from './platform';

export function memKV(): KV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(k: string) { return structuredClone(data.get(k)) as T | undefined; },
    async set(k, v) { data.set(k, structuredClone(v)); },
    async remove(k) { data.delete(k); },
  };
}

export type FakeReply = { status: number; body?: unknown; headers?: Record<string, string> };

export function testPlatform(opts: { tokens?: string[]; tokenError?: Error; routes?: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => FakeReply } = {}) {
  const calls: { url: string; method: string; body?: string; headers?: Record<string, string> }[] = [];
  const tokens = [...(opts.tokens ?? ['ya29.UNIT'])];
  let now = Date.UTC(2026, 10, 4, 12);
  const p: Platform & { calls: typeof calls; local: ReturnType<typeof memKV>; session: ReturnType<typeof memKV>; advance(ms: number): void; removed: string[]; interactiveCalls: number } = {
    calls, removed: [], interactiveCalls: 0,
    local: memKV(), session: memKV(),
    async getAuthToken(interactive) {
      if (interactive) p.interactiveCalls++;
      if (opts.tokenError) throw opts.tokenError;
      return tokens[0]!;
    },
    async removeCachedAuthToken(t) { p.removed.push(t); if (tokens.length > 1) tokens.shift(); },
    async clearAllCachedAuthTokens() { p.removed.push('*'); },
    async fetch(url, init = {}) {
      calls.push({ url, method: init.method ?? 'GET', ...(init.body !== undefined ? { body: init.body } : {}), ...(init.headers ? { headers: init.headers } : {}) });
      const r = opts.routes ? opts.routes(url, init) : { status: 404, body: { error: 'not_found' } };
      return { status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})) };
    },
    now: () => now,
    advance(ms) { now += ms; },
    sleep: async () => {},
    randomBytes: (n) => new Uint8Array(n).map((_, i) => (i * 37 + 11) & 255),
  };
  return p;
}
