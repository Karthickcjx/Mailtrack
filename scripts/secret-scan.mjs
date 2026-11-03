#!/usr/bin/env node
// Scans tracked source files and build output for secrets. Exits 1 on any finding.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PATTERNS = [
  ['private key block', /-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['Google OAuth client secret', /GOCSPX-[A-Za-z0-9_-]{20,}/],
  ['client_secret field', /["']?client_secret["']?\s*[:=]\s*["'][^"']+["']/i],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Google access token', /ya29\.[0-9A-Za-z_-]{20,}/],
  ['Google refresh token', /\b1\/\/0[0-9A-Za-z_-]{30,}/],
  ['Cloudflare API token (heuristic)', /\bCF_API_TOKEN\s*=\s*\S+/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Slack token', /xox[baprs]-[0-9A-Za-z-]{10,}/],
];

const files = new Set(
  execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
    .split('\n').filter(Boolean),
);
// Also scan build output (gitignored) because that is what gets loaded/shipped.
for (const dir of ['extension/dist']) {
  if (!existsSync(dir)) continue;
  const walk = (d) => readdirSync(d).forEach((f) => {
    const p = join(d, f);
    statSync(p).isDirectory() ? walk(p) : files.add(p.replace(/\\/g, '/'));
  });
  walk(dir);
}

const SELF = 'scripts/secret-scan.mjs';
let findings = 0;
for (const f of files) {
  if (f === SELF || /\.(png|jpe?g|gif|ico|woff2?)$/i.test(f) || !existsSync(f)) continue;
  if (/\.(pem|der|p12|key|crx)$/i.test(f)) { console.error(`FAIL key-like file present: ${f}`); findings++; continue; }
  const text = readFileSync(f, 'utf8');
  for (const [name, re] of PATTERNS) {
    if (re.test(text)) { console.error(`FAIL ${name}: ${f}`); findings++; }
  }
}
console.log(`secret-scan: ${files.size} files scanned, ${findings} finding(s).`);
process.exit(findings ? 1 : 0);
