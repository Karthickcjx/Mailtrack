// Google sign-in via chrome.identity (stable APIs only — P1). Tokens never leave the service worker.
import type { Platform } from './platform';

export type AuthState = 'signed_in' | 'consent_required' | 'error';

/** Chrome error text when the user hasn't granted (or has revoked) access, or Testing-mode consent expired. */
export function isConsentError(e: unknown): boolean {
  const m = String(e instanceof Error ? e.message : e);
  // A misconfigured client ID ("Invalid OAuth2 Client ID", "...bad client id...") is NOT a consent problem:
  // treating it as one would loop the user through sign-in forever while hiding the real cause.
  if (isAuthConfigError(m)) return false;
  return /not granted|revoked|user did not approve|interaction required|OAuth2 request failed|no token/i.test(m);
}

/** Chrome identity errors that mean the extension's OAuth configuration is wrong (client ID / extension ID mismatch). */
export function isAuthConfigError(e: unknown): boolean {
  return /client[ _]?id|invalid_client|unauthorized_client|redirect_uri_mismatch/i.test(String(e instanceof Error ? e.message : e));
}

/** Silent token (never shows UI). Throws when consent is needed. */
export const silentToken = (p: Platform) => p.getAuthToken(false);

/** Interactive consent — only ever call from an explicit user action (button click). */
export const interactiveToken = (p: Platform) => p.getAuthToken(true);

/** Sign out: revoke the grant at Google, then drop Chrome's cached tokens and our backend session. */
export async function signOut(p: Platform): Promise<{ revoked: boolean }> {
  let revoked = false;
  try {
    const token = await p.getAuthToken(false);
    const r = await p.fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(token)}`,
    });
    revoked = r.status === 200;
    await p.removeCachedAuthToken(token);
  } catch { /* already signed out / no grant */ }
  await p.clearAllCachedAuthTokens();
  await p.session.remove('backendSession');
  return { revoked };
}
