// SPIKE P4/P5 (throwaway): local pixel logger, exposed temporarily via a cloudflared quick tunnel.
// GET  /o/<token>.gif   -> 1x1 GIF; cache policy chosen by token prefix (P4.5):
//        ns-*  Cache-Control: no-store, no-cache, must-revalidate, max-age=0, private
//        m0-*  Cache-Control: max-age=0
//        nc-*  (no cache headers)
// POST /view           -> P5 extension reports "sender viewed thread" timestamps
// GET  /log            -> recent log lines (JSON)
// IPs are never written raw: HMAC-SHA256 with a random per-run salt.
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8799);
const here = dirname(fileURLToPath(import.meta.url));
const logDir = join(here, 'logs');
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const salt = randomBytes(32);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const recent = [];

const hashIp = (ip) => (ip ? createHmac('sha256', salt).update(ip).digest('base64url').slice(0, 16) : null);
function record(entry) {
  const line = { ts: new Date().toISOString(), ...entry };
  recent.push(line); if (recent.length > 500) recent.shift();
  appendFileSync(logFile, JSON.stringify(line) + '\n');
  console.log(JSON.stringify(line));
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const ip = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? req.socket.remoteAddress;
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 200);
  const m = url.pathname.match(/^\/o\/([A-Za-z0-9_-]{1,64})\.gif$/);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    const token = m[1];
    const headers = { 'Content-Type': 'image/gif', 'Content-Length': GIF.length, 'Referrer-Policy': 'no-referrer' };
    if (token.startsWith('ns-')) Object.assign(headers, { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0, private', Expires: '0' });
    else if (token.startsWith('m0-')) headers['Cache-Control'] = 'max-age=0';
    record({ kind: 'pixel', method: req.method, token, ua, ip_hash: hashIp(String(ip)), country: req.headers['cf-ipcountry'] ?? null, if_none_match: Boolean(req.headers['if-none-match']), if_modified_since: Boolean(req.headers['if-modified-since']) });
    res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : GIF); return;
  }
  if (url.pathname === '/view') {
    const cors = { 'Access-Control-Allow-Origin': 'https://mail.google.com', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.method === 'POST') {
      let body = ''; req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => { try { record({ kind: 'view', ...JSON.parse(body) }); } catch { /* ignore */ } res.writeHead(204, cors); res.end(); });
      return;
    }
  }
  if (url.pathname === '/log' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(recent)); return; }
  if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`P4 logger on http://127.0.0.1:${PORT}  log=${logFile}`));
