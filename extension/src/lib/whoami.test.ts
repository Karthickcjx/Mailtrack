import { describe, expect, it } from 'vitest';
import { GOOGLE_TOKENINFO_URL } from '@tracklet/shared';
import { AuthRequiredError } from './backend';
import { GoogleAuthError } from './platform';
import { toReply } from './reply';
import { testPlatform } from './testPlatform';
import { googleIdentity, TokenInfoError } from './whoami';

const CID = '123-abc.apps.googleusercontent.com';
const TOKEN = 'ya29.FAKE-WHO';
const info = { aud: CID, azp: CID, sub: '109876543210987654321', email: 'me@example.test', email_verified: 'true', scope: 'openid https://www.googleapis.com/auth/userinfo.email', exp: '9', expires_in: 3599 };

describe('googleIdentity ("Show my Google account ID")', () => {
  it('returns tokeninfo `sub` (the backend allowlist key) from the same endpoint the backend uses, and never the token', async () => {
    const p = testPlatform({ tokens: [TOKEN], routes: () => ({ status: 200, body: info }) });
    const id = await googleIdentity(p, CID);
    expect(id).toEqual({ sub: '109876543210987654321', email: 'me@example.test', emailVerified: true, clientIdMatches: true });
    expect(JSON.stringify(id)).not.toContain(TOKEN);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.url).toBe(`${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(TOKEN)}`);   // only Google receives it
    expect(p.interactiveCalls).toBe(0);   // silent only
  });

  it('flags a client-ID mismatch (the backend would reject this token with 401)', async () => {
    const p = testPlatform({ routes: () => ({ status: 200, body: { ...info, aud: 'other.apps.googleusercontent.com' } }) });
    expect((await googleIdentity(p, CID)).clientIdMatches).toBe(false);
    expect((await googleIdentity(p, undefined)).clientIdMatches).toBe(false);
  });

  it('rejects a missing or malformed sub instead of showing a wrong value', async () => {
    for (const sub of [undefined, '', 'has space', 'x'.repeat(256), 123]) {
      const p = testPlatform({ routes: () => ({ status: 200, body: { ...info, sub } }) });
      await expect(googleIdentity(p, CID)).rejects.toBeInstanceOf(TokenInfoError);
    }
  });

  it('tokeninfo HTTP errors and missing consent map to specific, token-free replies', async () => {
    const bad = await googleIdentity(testPlatform({ tokens: [TOKEN], routes: () => ({ status: 400, body: { error: 'invalid_token' } }) }), CID).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(TokenInfoError);
    const r = toReply(bad) as { error: string; message: string };
    expect(r).toMatchObject({ error: 'google_auth', message: expect.stringContaining('HTTP 400') });
    expect(r.message).not.toContain(TOKEN);
    const noConsent = await googleIdentity(testPlatform({ tokenError: new GoogleAuthError('OAuth2 not granted or revoked.') }), CID).catch((e: unknown) => e);
    expect(noConsent).toBeInstanceOf(AuthRequiredError);
  });
});
