// Builds the P2 harness extension. Usage: node spikes/p2-gmailjs/build.mjs [native|gmailjs]  (default: native)
// Output: spikes/p2-gmailjs/dist-<adapter>/{page.js, manifest.json, build-info.json}
//   - no permissions, MAIN-world content script
//   - BUILD ID = sha256 over the variant, input sources (line endings normalised) and pinned tool/library
//     versions; embedded in the bundle and shown in the panel/report so a report maps to an exact build.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const adapter = process.argv[2] ?? 'native';
if (!['native', 'gmailjs'].includes(adapter)) { console.error('adapter must be native|gmailjs'); process.exit(1); }
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
// Read package.json directly (jquery 4 does not export ./package.json).
const version = (p) => JSON.parse(readFileSync(join(root, 'node_modules', p, 'package.json'), 'utf8')).version;

const sources = [
  'spikes/p2-gmailjs/harness.ts', 'spikes/p2-gmailjs/panel.ts', 'spikes/p2-gmailjs/report.ts',
  'extension/src/gmail/adapter.ts', 'extension/src/gmail/native-adapter.ts', 'extension/src/gmail/map.ts',
  ...(adapter === 'gmailjs' ? ['spikes/p2-gmailjs/gmailjs-adapter.ts'] : []),
];
const versions = { esbuild: version('esbuild'), ...(adapter === 'gmailjs' ? { 'gmail-js': version('gmail-js'), jquery: version('jquery') } : {}) };
const h = createHash('sha256').update(`variant=${adapter}\n${JSON.stringify(versions)}\n`);
for (const f of sources) h.update(`--${f}--\n`).update(readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n'));
const buildId = `${adapter}-${h.digest('hex').slice(0, 12)}`;

const out = join(here, `dist-${adapter}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, 'harness.ts')], bundle: true, format: 'iife', outfile: join(out, 'page.js'),
  platform: 'browser', target: 'chrome120', legalComments: 'none',
  define: { __ADAPTER__: JSON.stringify(adapter), __BUILD_ID__: JSON.stringify(buildId) },
});
writeFileSync(join(out, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: `Tracklet P2 spike (${adapter})`,
  version: '0.0.3',
  description: `Throwaway compatibility harness ${buildId}. No permissions, no network, never sends mail.`,
  permissions: [],
  content_scripts: [{ matches: ['https://mail.google.com/*'], js: ['page.js'], run_at: adapter === 'gmailjs' ? 'document_start' : 'document_idle', world: 'MAIN' }],
}, null, 2));
const bundle = readFileSync(join(out, 'page.js'), 'utf8');
const sinks = (bundle.match(/\.(innerHTML|outerHTML)\s*=(?!=)|insertAdjacentHTML\(|document\.write\(|createPolicy\(/g) ?? []).length;
const pageSha256 = createHash('sha256').update(bundle).digest('hex');
writeFileSync(join(out, 'build-info.json'), JSON.stringify({ buildId, variant: adapter, versions, sources: sources.map((s) => relative(root, join(root, s)).replace(/\\/g, '/')), pageSha256, sinks }, null, 2));
console.log(`Built ${out} ${buildId} (${(bundle.length / 1024).toFixed(0)} KB) page.js sha256=${pageSha256.slice(0, 16)}…; HTML-sink/createPolicy occurrences: ${sinks}`);
