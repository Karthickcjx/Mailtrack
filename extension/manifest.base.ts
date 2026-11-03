import { OAUTH_SCOPES } from '@tracklet/shared';

/**
 * Builds the MV3 manifest. The public "key" pins the extension ID (docs/EXTENSION_ID.md).
 * The OAuth client ID is a public identifier (not a secret); it comes from the
 * environment variable TRACKLET_OAUTH_CLIENT_ID (e.g. extension/.env.local, gitignored).
 */
export function buildManifest(opts: { key: string; oauthClientId: string | undefined; version: string }) {
  return {
    manifest_version: 3,
    name: 'Tracklet (personal, dev)',
    version: opts.version,
    description: 'Personal Gmail open/click tracker — Phase 0 skeleton.',
    key: opts.key,
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_popup: 'popup.html', default_title: 'Tracklet' },
    // Phase 0 requests no permissions. "identity" etc. are added in Phase 1 (approved scope list only).
    permissions: [] as string[],
    ...(opts.oauthClientId
      ? { oauth2: { client_id: opts.oauthClientId, scopes: [...OAUTH_SCOPES] } }
      : {}),
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  };
}
