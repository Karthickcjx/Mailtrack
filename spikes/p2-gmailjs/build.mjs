// Builds the P2 gmail.js harness extension into spikes/p2-gmailjs/dist (no permissions, MAIN-world content script).
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, 'harness.ts')], bundle: true, format: 'iife', outfile: join(out, 'page.js'),
  platform: 'browser', target: 'chrome120', legalComments: 'none',
});
writeFileSync(join(out, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'Tracklet P2 gmail.js spike',
  version: '0.0.1',
  description: 'Throwaway compatibility harness. No permissions, no network, never sends mail.',
  permissions: [],
  content_scripts: [{ matches: ['https://mail.google.com/*'], js: ['page.js'], run_at: 'document_start', world: 'MAIN' }],
}, null, 2));
const bundle = readFileSync(join(out, 'page.js'), 'utf8');
const hosts = [...new Set((bundle.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((u) => new URL(u).hostname))].sort();
console.log(`Built ${out} (${(bundle.length / 1024).toFixed(0)} KB). Hosts referenced in bundle: ${hosts.join(', ') || '(none)'}`);
