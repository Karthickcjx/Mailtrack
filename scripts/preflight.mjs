#!/usr/bin/env node
// Release preflight: verifies production configuration BEFORE `wrangler deploy` or a release build.
// Reads only public configuration (wrangler.toml [env.production], extension/.env.release.local or env vars).
// It never reads secrets or the extension's private key. Exits 1 on any problem.
//
//   npm run preflight             backend + extension
//   npm run preflight -- backend  backend only (used by `npm run deploy --workspace backend`)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2];
const problems = [];
const ok = [];

/** Same rules as shared/src/url.ts trackingUrlProblem: mail clients must be able to reach this host. */
function publicHttpsProblem(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'is not a valid URL'; }
  if (u.protocol !== 'https:') return 'must use https';
  if (u.pathname !== '/' || u.search || u.hash) return 'must be a bare origin (no path, query or trailing slash)';
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || /\.(local|internal|lan|home\.arpa)$/.test(h) || !h.includes('.')) return 'is not a public hostname';
  if (/^(127|10|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)) return 'is a private IP address';
  if (/REPLACE/i.test(raw)) return 'is still a placeholder';
  return null;
}

/** Values inside one TOML table (simple `key = "value"` lines). Enough for our own wrangler.toml. */
function tomlTable(text, header) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return null;
  const out = {};
  for (const l of lines.slice(start + 1)) {
    if (/^\s*\[/.test(l)) break;
    const m = /^\s*([A-Za-z_]+)\s*=\s*"([^"]*)"/.exec(l);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function readEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
}

const extensionId = JSON.parse(readFileSync(join(root, 'extension/manifest.key.json'), 'utf8')).extensionId;
const toml = readFileSync(join(root, 'backend/wrangler.toml'), 'utf8');
const vars = tomlTable(toml, '[env.production.vars]');
const d1 = tomlTable(toml, '[[env.production.d1_databases]]');

if (only !== 'extension') {
  if (!vars || !d1) problems.push('backend/wrangler.toml: [env.production] section is missing');
  else {
    const p = publicHttpsProblem(vars.PUBLIC_BASE_URL ?? '');
    p ? problems.push(`backend PUBLIC_BASE_URL ${p} (${vars.PUBLIC_BASE_URL})`) : ok.push(`backend PUBLIC_BASE_URL ${vars.PUBLIC_BASE_URL}`);
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d1.database_id ?? '') && !/^0{8}-/.test(d1.database_id)
      ? ok.push('backend D1 database_id set') : problems.push('backend D1 database_id is a placeholder (run: npx wrangler d1 create tracklet)');
    vars.EXTENSION_ORIGIN === `chrome-extension://${extensionId}` ? ok.push('backend EXTENSION_ORIGIN matches the pinned extension ID')
      : problems.push(`backend EXTENSION_ORIGIN must be chrome-extension://${extensionId}`);
    /\.apps\.googleusercontent\.com$/.test(vars.GOOGLE_CLIENT_ID ?? '') ? ok.push('backend GOOGLE_CLIENT_ID set') : problems.push('backend GOOGLE_CLIENT_ID missing');
  }
}

if (only !== 'backend') {
  const env = { ...readEnvFile(join(root, 'extension/.env.release.local')), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('TRACKLET_'))) };
  const api = (env.TRACKLET_API_BASE ?? '').replace(/\/+$/, '');
  const p = publicHttpsProblem(api || 'missing');
  p ? problems.push(`extension TRACKLET_API_BASE ${p} (set it in extension/.env.release.local)`) : ok.push(`extension TRACKLET_API_BASE ${api}`);
  const cid = env.TRACKLET_OAUTH_CLIENT_ID ?? '';
  if (!/\.apps\.googleusercontent\.com$/.test(cid)) problems.push('extension TRACKLET_OAUTH_CLIENT_ID missing (extension/.env.release.local)');
  else if (vars && cid !== vars.GOOGLE_CLIENT_ID) problems.push('extension TRACKLET_OAUTH_CLIENT_ID differs from backend GOOGLE_CLIENT_ID (the backend would reject every sign-in)');
  else ok.push('extension OAuth client ID matches the backend');
  if (vars && !p && vars.PUBLIC_BASE_URL && api !== vars.PUBLIC_BASE_URL) problems.push(`extension TRACKLET_API_BASE (${api}) differs from backend PUBLIC_BASE_URL (${vars.PUBLIC_BASE_URL})`);
}

for (const o of ok) console.log(`  ok    ${o}`);
for (const p of problems) console.log(`  FAIL  ${p}`);
console.log(problems.length ? `\npreflight: ${problems.length} problem(s). Fix them before deploying or building a release.` : '\npreflight: ready');
process.exit(problems.length ? 1 : 0);
