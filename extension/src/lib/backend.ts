// Backend client. Holds the backend session (not the Google token) in chrome.storage.session.
import { isConsentError, silentToken } from './auth';
import type { Platform } from './platform';

export interface BackendSession { token: string; expiresAt: number; userId: string; email: string }

export const GOOGLE_TOKEN_REJECTED = 'The Tracklet server rejected the Google sign-in';
export class AuthRequiredError extends Error { constructor(m = 'Sign-in required') { super(m); this.name = 'AuthRequiredError'; } }
/** The backend could not be reached at all (fetch rejected: server down, DNS, TLS, offline). Carries no request data. */
export class BackendUnreachableError extends Error {
  constructor(readonly origin: string, readonly causeName: string) { super(`Tracklet server unreachable at ${origin}`); this.name = 'BackendUnreachableError'; }
}
export class BackendError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details?: unknown) { super(`backend ${status} ${code}`); this.name = 'BackendError'; }
}

export class Backend {
  constructor(private readonly p: Platform, readonly baseUrl: string) {}

  /** fetch() rejects with a bare TypeError ("Failed to fetch") on network failure; convert it into a specific error. */
  private async call(url: string, init: Parameters<Platform['fetch']>[1]) {
    try { return await this.p.fetch(url, init); }
    catch (e) {
      let origin = this.baseUrl;
      try { origin = new URL(this.baseUrl).origin; } catch { /* keep as configured */ }
      throw new BackendUnreachableError(origin, e instanceof Error ? e.name : typeof e);
    }
  }

  private async loadSession(): Promise<BackendSession | null> {
    const s = await this.p.session.get<BackendSession>('backendSession');
    return s && s.expiresAt - 60_000 > this.p.now() ? s : null;
  }

  /** Exchanges a SILENT Google token for a backend session. Never prompts. */
  async ensureSession(force = false): Promise<BackendSession> {
    if (!force) { const s = await this.loadSession(); if (s) return s; }
    let google: string;
    try { google = await silentToken(this.p); }
    catch (e) { throw isConsentError(e) ? new AuthRequiredError() : e; }
    const r = await this.call(`${this.baseUrl}/v1/auth/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ google_access_token: google }),
    });
    const body = safeJson(await r.text());
    if (r.status === 401) { await this.p.removeCachedAuthToken(google); throw new AuthRequiredError(GOOGLE_TOKEN_REJECTED); }
    if (r.status !== 200 || typeof body?.session_token !== 'string') throw new BackendError(r.status, String(body?.error ?? 'session_failed'));
    const s: BackendSession = { token: body.session_token as string, expiresAt: Number(body.expires_at), userId: String((body.user as { id?: string })?.id), email: String((body.user as { email?: string })?.email) };
    await this.p.session.set('backendSession', s);
    return s;
  }

  /** Authenticated request; on 401 refreshes the backend session once (silently) and retries. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await this.ensureSession(attempt > 0);
      const r = await this.call(`${this.baseUrl}${path}`, {
        method, headers: { authorization: `Bearer ${s.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (r.status === 401 && attempt === 0) { await this.p.session.remove('backendSession'); continue; }
      if (r.status === 204) return undefined as T;
      const text = await r.text();
      const j = safeJson(text);
      if (r.status >= 200 && r.status < 300) return j as T;
      throw new BackendError(r.status, String(j?.error ?? 'error'), j?.details);
    }
    throw new AuthRequiredError();
  }
}

export function safeJson(text: string): Record<string, unknown> | null {
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
