// "Show my Google account ID": the exact value the backend compares against ALLOWED_GOOGLE_SUBS.
// Reads the `sub` field from Google tokeninfo for the extension's own access token, the same endpoint and field
// the backend uses. chrome.identity.getProfileUserInfo().id is NOT used: Chrome documents it only as an
// "obfuscated gaia id" (never as the OIDC/tokeninfo `sub`), and it is empty without the identity.email permission.
// The access token goes only to Google, over TLS; it is never returned, stored or logged.
import { GOOGLE_TOKENINFO_URL } from '@tracklet/shared';
import { isConsentError, silentToken } from './auth';
import { AuthRequiredError, safeJson } from './backend';
import type { Platform } from './platform';

export interface GoogleIdentity {
  /** tokeninfo `sub`: put this exact string in ALLOWED_GOOGLE_SUBS. */
  sub: string;
  email: string | null;
  emailVerified: boolean;
  /** tokeninfo `aud` equals this build's OAuth client ID (the backend requires the same match). */
  clientIdMatches: boolean;
}

export class TokenInfoError extends Error {
  constructor(readonly status: number) { super(`Google tokeninfo returned HTTP ${status}`); this.name = 'TokenInfoError'; }
}

/** OIDC `sub`: up to 255 case-sensitive printable ASCII characters (Google OpenID Connect docs). */
const SUB_RE = /^[\x21-\x7e]{1,255}$/;

export async function googleIdentity(p: Platform, expectedClientId: string | undefined): Promise<GoogleIdentity> {
  let token: string;
  try { token = await silentToken(p); }   // silent only: sign in from the popup first
  catch (e) { throw isConsentError(e) ? new AuthRequiredError() : e; }
  const r = await p.fetch(`${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(token)}`);
  if (r.status !== 200) throw new TokenInfoError(r.status);
  const info = safeJson(await r.text()) ?? {};
  const sub = typeof info.sub === 'string' ? info.sub : '';
  if (!SUB_RE.test(sub)) throw new TokenInfoError(r.status);
  return {
    sub,
    email: typeof info.email === 'string' ? info.email : null,
    emailVerified: String(info.email_verified) === 'true',
    clientIdMatches: !!expectedClientId && info.aud === expectedClientId,
  };
}
