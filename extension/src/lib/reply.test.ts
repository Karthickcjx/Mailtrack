// Regression: popup showed "Something went wrong" when sign-in hit an unreachable backend.
// Root cause: fetch() to TRACKLET_API_BASE (http://127.0.0.1:8787, no server listening) rejects with
// TypeError("Failed to fetch") — reproduced in headless Chrome 156 — and toReply() mapped it to a generic message.
import { describe, expect, it } from 'vitest';
import { isConsentError } from './auth';
import { AuthRequiredError, Backend, BackendError, BackendUnreachableError } from './backend';
import { GoogleAuthError } from './platform';
import { redact, toReply } from './reply';
import { testPlatform } from './testPlatform';

const failingFetch = () => {
  const p = testPlatform({ tokens: ['ya29.FAKE-LEAK'] });
  p.fetch = async () => { throw new TypeError('Failed to fetch'); };   // exactly what Chrome throws
  return p;
};

describe('sign-in with the backend unreachable (regression)', () => {
  it('ensureSession converts the fetch TypeError into BackendUnreachableError with the API origin', async () => {
    const b = new Backend(failingFetch(), 'http://127.0.0.1:8787');
    const e = await b.ensureSession(true).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BackendUnreachableError);
    expect(e).toMatchObject({ origin: 'http://127.0.0.1:8787', causeName: 'TypeError' });
  });

  it('authenticated requests are converted the same way', async () => {
    const p = failingFetch();
    await p.session.set('backendSession', { token: 's', expiresAt: p.now() + 3_600_000, userId: 'u', email: 'e' });
    await expect(new Backend(p, 'http://127.0.0.1:8787').request('GET', '/v1/dashboard')).rejects.toBeInstanceOf(BackendUnreachableError);
  });

  it('the popup reply is specific, actionable and token-free (not "Something went wrong")', async () => {
    const e = await new Backend(failingFetch(), 'http://127.0.0.1:8787').ensureSession(true).catch((x: unknown) => x);
    const r = toReply(e, { type: 'signIn' });
    expect(r).toMatchObject({ ok: false, error: 'backend_unreachable' });
    const msg = (r as { message: string }).message;
    expect(msg).toContain("Can't reach the Tracklet server at http://127.0.0.1:8787 (TypeError)");
    expect(msg).toContain('TRACKLET_API_BASE');
    expect(msg).not.toMatch(/Something went wrong|ya29|FAKE-LEAK/);
  });
});

describe('Google identity errors keep Chrome\'s specific message', () => {
  it('misconfigured client ID is reported as configuration, not as "please sign in"', () => {
    for (const m of ['Invalid OAuth2 Client ID.', "OAuth2 request failed: Service responded with error: 'bad client id: 123-abc.apps.googleusercontent.com'"]) {
      expect(isConsentError(new GoogleAuthError(m))).toBe(false);
      const r = toReply(new GoogleAuthError(m), { type: 'signIn' }) as { error: string; message: string };
      expect(r.error).toBe('google_auth');
      expect(r.message).toMatch(/misconfigured/);
      expect(r.message).toMatch(/client id|Client ID/);
    }
  });

  it('cancelled consent during Sign in says so; elsewhere it asks to sign in', () => {
    const e = new GoogleAuthError('The user did not approve access.');
    expect(toReply(e, { type: 'signIn' })).toMatchObject({ error: 'auth_required', message: expect.stringContaining('The user did not approve access.') });
    expect(toReply(e, { type: 'dashboard' })).toMatchObject({ error: 'auth_required', message: 'Sign in to Tracklet (open the popup).' });
    expect(toReply(new GoogleAuthError('OAuth2 not granted or revoked.'))).toMatchObject({ error: 'auth_required' });
  });

  it('other identity errors pass Chrome\'s text through (redacted)', () => {
    expect(toReply(new GoogleAuthError('Authorization page could not be loaded.'))).toMatchObject({ error: 'google_auth', message: 'Google sign-in failed: "Authorization page could not be loaded.".' });
  });
});

describe('other mappings stay specific', () => {
  it('backend statuses', () => {
    expect(toReply(new BackendError(403, 'forbidden'))).toMatchObject({ error: 'forbidden', message: expect.stringContaining('ALLOWED_GOOGLE_SUBS') });
    expect(toReply(new BackendError(429, 'rate_limited'))).toMatchObject({ error: 'backend', message: expect.stringContaining('Too many requests') });
    expect(toReply(new BackendError(500, 'internal'))).toMatchObject({ error: 'backend', message: 'Tracklet server error (HTTP 500, internal).' });
    expect(toReply(new AuthRequiredError())).toMatchObject({ error: 'auth_required' });
  });

  it('unexpected errors name the error class and a redacted message', () => {
    const r = toReply(new TypeError('Cannot read properties of undefined (reading \'x\')')) as { message: string };
    expect(r.message).toBe("Unexpected error in Tracklet (TypeError: Cannot read properties of undefined (reading 'x')).");
  });
});

describe('redact', () => {
  it('removes tokens, JWTs, addresses, query strings and long opaque values', () => {
    const s = redact('failed ya29.a0AfB_byC-xyz Bearer abc.def eyJhbGciOi.eyJzdWIi.c2ln to a.b@example.com https://x.test/p?access_token=zzz ' + 'A'.repeat(50));
    expect(s).not.toMatch(/ya29\.|abc\.def|eyJ|example\.com|zzz|AAAA/);
    expect(s).toContain('[token]');
    expect(redact('word '.repeat(100))).toHaveLength(200);   // length cap
    expect(redact('x'.repeat(500))).toBe('[redacted]');        // opaque run
  });
});
