// Builds the P2 harness extension. Usage: node spikes/p2-gmailjs/build.mjs [native|gmailjs]  (default: native)
// Output: spikes/p2-gmailjs/dist-<adapter>/  (no permissions, MAIN-world content script)
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const adapter = process.argv[2] ?? 'native';
if (!['native', 'gmailjs'].includes(adapter)) { console.error('adapter must be native|gmailjs'); process.exit(1); }
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, `dist-${adapter}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, 'harness.ts')], bundle: true, format: 'iife', outfile: join(out, 'page.js'),
  platform: 'browser', target: 'chrome120', legalComments: 'none',
  define: { __ADAPTER__: JSON.stringify(adapter) },
});
writeFileSync(join(out, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: `Tracklet P2 spike (${adapter})`,
  version: '0.0.2',
  description: 'Throwaway compatibility harness. No permissions, no network, never sends mail.',
  permissions: [],
  content_scripts: [{ matches: ['https://mail.google.com/*'], js: ['page.js'], run_at: adapter === 'gmailjs' ? 'document_start' : 'document_idle', world: 'MAIN' }],
}, null, 2));
const bundle = readFileSync(join(out, 'page.js'), 'utf8');
const sinks = (bundle.match(/\.(innerHTML|outerHTML)\s*=(?!=)|insertAdjacentHTML\(|document\.write\(|createPolicy\(/g) ?? []).length;
console.log(`Built ${out} (${(bundle.length / 1024).toFixed(0)} KB); HTML-sink/createPolicy occurrences in bundle: ${sinks}`);
