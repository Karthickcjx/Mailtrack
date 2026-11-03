// Builds the P1/P3 spike extension into spikes/p1-oauth/dist.
// Usage: TRACKLET_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com node spikes/p1-oauth/build.mjs
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const clientId = process.env.TRACKLET_OAUTH_CLIENT_ID;
if (!clientId || !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) {
  console.error('Set TRACKLET_OAUTH_CLIENT_ID to the Chrome Extension OAuth client ID (public identifier).');
  process.exit(1);
}
const { key } = JSON.parse(readFileSync(join(root, 'extension', 'manifest.key.json'), 'utf8'));
const out = join(here, 'dist');
mkdirSync(out, { recursive: true });
await build({ entryPoints: [join(here, 'popup.ts')], bundle: true, format: 'esm', outfile: join(out, 'popup.js'), platform: 'browser', target: 'chrome120', inject: [join(here, 'buffer-shim.js')] });
copyFileSync(join(here, 'popup.html'), join(out, 'popup.html'));
writeFileSync(join(out, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'Tracklet P1/P3 spike',
  version: '0.0.1',
  key,
  action: { default_popup: 'popup.html' },
  permissions: ['identity', 'identity.email'],
  host_permissions: ['https://oauth2.googleapis.com/*', 'https://gmail.googleapis.com/*'],
  oauth2: { client_id: clientId, scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/gmail.send'] },
}, null, 2));
console.log(`Built ${out}. Load it unpacked in the DEDICATED Chrome profile.`);
