import { OAUTH_SCOPES } from '@tracklet/shared';

/** Chrome permissions Tracklet requests — keep minimal; every entry is justified in docs/release/SECURITY_REVIEW.md. */
export const PERMISSIONS = ['identity', 'storage', 'alarms', 'notifications'] as const;
export const GOOGLE_HOSTS = ['https://gmail.googleapis.com/*', 'https://oauth2.googleapis.com/*'] as const;
export const GMAIL_MATCH = 'https://mail.google.com/*';

/** Origin pattern for the Tracklet API base URL (http only for loopback dev; https otherwise). */
export function apiHostPattern(apiBase: string): string {
  const u = new URL(apiBase);
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error(`TRACKLET_API_BASE must be https (or http on loopback): ${apiBase}`);
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error('TRACKLET_API_BASE must be a bare origin');
  return `${u.protocol}//${u.hostname}/*`;   // match patterns ignore ports
}

/**
 * Builds the MV3 manifest. The public "key" pins the extension ID (docs/EXTENSION_ID.md).
 * The OAuth client ID is a public identifier (not a secret); it comes from TRACKLET_OAUTH_CLIENT_ID
 * (extension/.env.local, gitignored). Without it the manifest has no oauth2 block and sign-in is unavailable.
 */
export function buildManifest(opts: { key: string; oauthClientId: string | undefined; version: string; apiBase: string }) {
  return {
    manifest_version: 3,
    name: 'Tracklet',
    version: opts.version,
    description: 'Personal open and click tracking for emails you send from Gmail.',
    key: opts.key,
    icons: { '128': 'icon128.png' },
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_popup: 'popup.html', default_title: 'Tracklet', default_icon: { '128': 'icon128.png' } },
    permissions: [...PERMISSIONS] as string[],
    host_permissions: [...GOOGLE_HOSTS, apiHostPattern(opts.apiBase)],
    content_scripts: [{ matches: [GMAIL_MATCH], js: ['content.js'], run_at: 'document_idle', all_frames: false }],
    ...(opts.oauthClientId ? { oauth2: { client_id: opts.oauthClientId, scopes: [...OAUTH_SCOPES] } } : {}),
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
    minimum_chrome_version: '120',
  };
}
