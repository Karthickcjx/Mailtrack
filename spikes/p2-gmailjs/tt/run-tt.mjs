// Trusted Types compatibility runner (P2.10).
// Serves a fixture page with a STRICT Trusted Types CSP (no policies allowed at all),
// loads one script under test in headless Chrome, and returns what happened.
// Usage (CLI): node spikes/p2-gmailjs/tt/run-tt.mjs <script.js> [fixture=blank|compose]
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Strict: every DOM XSS sink must receive a TrustedHTML; `trusted-types 'none'` forbids creating ANY policy.
export const STRICT_CSP = "require-trusted-types-for 'script'; trusted-types 'none'; script-src 'self' 'unsafe-inline'; object-src 'none'";

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Reporter runs FIRST (inline, before the script under test); it never uses HTML sinks itself. */
const REPORTER = `
window.__tt = { violations: [], errors: [] };
document.addEventListener('securitypolicyviolation', (e) => {
  window.__tt.violations.push({ directive: e.violatedDirective, sample: (e.sample || '').slice(0, 80), line: e.lineNumber, source: (e.sourceFile || '').split('/').pop() });
});
window.addEventListener('error', (e) => { window.__tt.errors.push({ message: String(e.message).slice(0, 200), line: e.lineno, source: (e.filename || '').split('/').pop() }); });
window.addEventListener('load', () => setTimeout(() => {
  const out = document.createElement('pre');
  out.id = '__tt_result';
  const probe = window.__ttProbe ? window.__ttProbe() : {};
  out.textContent = JSON.stringify({ ...window.__tt, probe });
  document.body.appendChild(out);
}, 1500));
`;

export async function runTT(scriptPath, fixture = 'blank') {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found (set CHROME_PATH)');
  const script = readFileSync(resolve(scriptPath));
  const fixtureHtml = readFileSync(join(here, `fixture-${fixture}.html`), 'utf8');
  const page = fixtureHtml.replace('<!--REPORTER-->', `<script>${REPORTER}</script>`).replace('<!--SUT-->', '<script src="/sut.js"></script>');

  const server = createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': STRICT_CSP }); res.end(page); return; }
    if (req.url === '/sut.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(script); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const dom = await new Promise((resolveP, reject) => {
      const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${join(here, '.chrome-profile')}`, '--virtual-time-budget=5000', '--dump-dom', `http://127.0.0.1:${port}/`]);
      let out = ''; p.stdout.on('data', (d) => { out += d; });
      const t = setTimeout(() => { p.kill(); reject(new Error('chrome timeout')); }, 60000);
      p.on('close', () => { clearTimeout(t); resolveP(out); });
    });
    const m = dom.match(/<pre id="__tt_result">([\s\S]*?)<\/pre>/);
    if (!m) throw new Error('no result block in dumped DOM');
    const text = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return { ...JSON.parse(text), dom };
  } finally { server.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runTT(process.argv[2], process.argv[3]);
  delete r.dom;
  console.log(JSON.stringify(r, null, 2));
}
