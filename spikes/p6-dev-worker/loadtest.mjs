// P6.4/P6.5 load test against the dev Worker (or local wrangler dev). Synthetic tokens only.
// Usage: node spikes/p6-dev-worker/loadtest.mjs <baseUrl> [count=200]
//   SPIKE_KEY env var is required for the /rl and /stats checks.
const base = process.argv[2];
const count = Number(process.argv[3] ?? 200);
const key = process.env.SPIKE_KEY;
if (!base || !/^https?:\/\//.test(base)) { console.error('usage: loadtest.mjs <baseUrl> [count]'); process.exit(1); }
const token = `syn-${Date.now().toString(36)}`;

const lat = [];
for (let i = 0; i < count; i++) {
  const t0 = performance.now();
  const r = await fetch(`${base}/o/${token}.gif`);
  await r.arrayBuffer();
  lat.push(performance.now() - t0);
  if (r.status !== 200) { console.error(`request ${i} -> ${r.status}`); process.exit(1); }
}
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(1);
console.log(JSON.stringify({ token, requests: count, p50_ms: pct(0.5), p95_ms: pct(0.95), max_ms: lat.at(-1).toFixed(1) }));

const bad = await fetch(`${base}/o/not-synthetic.gif`);
console.log(JSON.stringify({ nonSyntheticTokenStatus: bad.status }));

if (!key) { console.log('SPIKE_KEY not set: skipping /rl and /stats'); process.exit(0); }
await new Promise((r) => setTimeout(r, 3000));     // let waitUntil writes land
const stats = await (await fetch(`${base}/stats?token=${token}`, { headers: { 'x-spike-key': key } })).json();
console.log(JSON.stringify({ stats, allRowsWritten: stats.hits === count }));

const rl = [];
for (let i = 0; i < 8; i++) rl.push((await fetch(`${base}/rl?key=${token}`, { headers: { 'x-spike-key': key } })).status);
console.log(JSON.stringify({ rateLimitStatuses: rl, note: 'limit=5/10s per location; expect 200s then 429s if the binding is enforced' }));
const noKey = await fetch(`${base}/stats?token=${token}`);
console.log(JSON.stringify({ statsWithoutKeyStatus: noKey.status }));
