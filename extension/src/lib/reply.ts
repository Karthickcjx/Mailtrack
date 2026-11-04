// Maps service-worker errors to replies for the popup / dashboard / Gmail toasts.
// Messages are specific enough to act on, but never contain tokens, request bodies or addresses.
import type { Reply } from '../messages';
import { isAuthConfigError, isConsentError } from './auth';
import { AuthRequiredError, BackendError, BackendUnreachableError, GOOGLE_TOKEN_REJECTED } from './backend';
import { GoogleAuthError } from './platform';
import { TokenInfoError } from './whoami';

/** Strips anything token-, credential- or address-shaped from an error message and bounds its length. */
export function redact(s: string): string {
  return s
    .replace(/ya29\.[\w.-]+/g, '[token]')
    .replace(/\b(Bearer|token=|access_token=)\s*[^\s&"']+/gi, '$1[token]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\?[^\s"']*/g, '?[query]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
    .slice(0, 200);
}

export function toReply(e: unknown, ctx: { type?: string } = {}): Reply {
  if (e instanceof BackendUnreachableError) {
    return { ok: false, error: 'backend_unreachable', message: `Can't reach the Tracklet server at ${e.origin} (${e.causeName}). Check that the backend is running and that this build's TRACKLET_API_BASE points to it.` };
  }
  if (e instanceof GoogleAuthError || (e instanceof Error && isAuthConfigError(e))) {
    const m = redact((e as Error).message);
    if (isAuthConfigError(m)) return { ok: false, error: 'google_auth', message: `Google sign-in is misconfigured: "${m}". The extension ID and the OAuth client ID in this build must match the Chrome Extension OAuth client in Google Cloud.` };
    if (isConsentError(m)) {
      return { ok: false, error: 'auth_required', message: ctx.type === 'signIn' ? `Google sign-in was not completed ("${m}"). Click Sign in to try again.` : 'Sign in to Tracklet (open the popup).' };
    }
    return { ok: false, error: 'google_auth', message: `Google sign-in failed: "${m}".` };
  }
  if (e instanceof AuthRequiredError) {
    if (e.message === GOOGLE_TOKEN_REJECTED) return { ok: false, error: 'auth_required', message: `${GOOGLE_TOKEN_REJECTED} (HTTP 401). Try signing in again; if it keeps failing, the backend's GOOGLE_CLIENT_ID may not match this extension's OAuth client.` };
    return { ok: false, error: 'auth_required', message: 'Sign in to Tracklet (open the popup).' };
  }
  if (e instanceof BackendError) {
    if (e.status === 400) return { ok: false, error: 'validation', message: 'The request was rejected as invalid.', details: e.details };
    if (e.status === 403) return { ok: false, error: 'forbidden', message: 'This Google account is not allowed on this Tracklet backend (add its Google account ID to ALLOWED_GOOGLE_SUBS).' };
    if (e.status === 429) return { ok: false, error: 'backend', message: 'Too many requests to the Tracklet server. Wait a minute and try again.' };
    return { ok: false, error: 'backend', message: `Tracklet server error (HTTP ${e.status}, ${redact(e.code)}).` };
  }
  if (e instanceof TokenInfoError) return { ok: false, error: 'google_auth', message: `Couldn't read your Google account ID (${e.message}). Sign in again and retry.` };
  if (isConsentError(e)) return { ok: false, error: 'auth_required', message: 'Sign in to Tracklet (open the popup).' };
  const name = e instanceof Error ? e.name : typeof e;
  const msg = e instanceof Error ? redact(e.message) : '';
  return { ok: false, error: 'internal', message: `Unexpected error in Tracklet (${name}${msg ? `: ${msg}` : ''}).` };
}

/** One-line, redacted description for the service-worker console. */
export function logLine(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${redact(e.message)}` : typeof e;
}
