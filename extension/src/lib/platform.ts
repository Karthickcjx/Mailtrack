// Thin, injectable view of the Chrome/browser APIs the extension core needs (so it is unit-testable).

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Platform {
  local: KV;            // chrome.storage.local — survives restarts (subjects/addresses live ONLY here)
  session: KV;          // chrome.storage.session — in memory, cleared on browser restart (backend session token)
  getAuthToken(interactive: boolean): Promise<string>;
  removeCachedAuthToken(token: string): Promise<void>;
  clearAllCachedAuthTokens(): Promise<void>;
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;
  now(): number;
  sleep(ms: number): Promise<void>;
  randomBytes(n: number): Uint8Array;
}

/** chrome.identity failure. The message is Chrome's own (e.g. "OAuth2 not granted or revoked.", "Invalid OAuth2 Client ID."); it never contains a token. */
export class GoogleAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'GoogleAuthError'; }
}

function area(a: chrome.storage.StorageArea): KV {
  return {
    async get<T>(key: string) { return (await a.get(key))[key] as T | undefined; },
    async set(key, value) { await a.set({ [key]: value }); },
    async remove(key) { await a.remove(key); },
  };
}

/** Production platform (service worker / extension pages only — never content scripts). */
export function chromePlatform(): Platform {
  return {
    local: area(chrome.storage.local),
    session: area(chrome.storage.session ?? chrome.storage.local),
    async getAuthToken(interactive) {
      let r: chrome.identity.GetAuthTokenResult;
      try { r = await chrome.identity.getAuthToken({ interactive }); }
      catch (e) { throw new GoogleAuthError(e instanceof Error ? e.message : String(e)); }
      if (!r?.token) throw new GoogleAuthError('no token');
      return r.token;
    },
    removeCachedAuthToken: (token) => chrome.identity.removeCachedAuthToken({ token }),
    clearAllCachedAuthTokens: () => chrome.identity.clearAllCachedAuthTokens(),
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  };
}
