// SPIKE P2 (throwaway): live-compatibility harness. Runs in Gmail's MAIN world.
// - Adapter chosen at build time: native DOM (default) or gmail.js (+jQuery 4).
// - No network requests. Never sends mail. "Close" only closes the composer.
// - Trusted Types: observed PASSIVELY (securitypolicyviolation events). This harness never creates a
//   TT policy and never assigns to an HTML sink.
import type { GmailUiAdapter } from '../../extension/src/gmail/adapter';
import { NativeDomAdapter } from '../../extension/src/gmail/native-adapter';
import { DiagnosticPanel } from './panel';

declare const __ADAPTER__: 'native' | 'gmailjs';

type Result = { id: string; status: 'PASS' | 'FAIL' | 'RECORDED'; detail: unknown; at: string };
const results: Result[] = [];
const ttViolations: { sample: string; source: string; line: number }[] = [];
const unexpectedHosts = new Map<string, number>();
let adapter: GmailUiAdapter & { rowStats?: Record<string, number> };

const redact = (s: string) => s.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@/g, '$1***@');
const report = () => redact(JSON.stringify({ harness: 'P2', adapter: adapter?.name, userAgent: navigator.userAgent, results, ttViolations, rowStats: adapter?.rowStats, unexpectedHosts: Object.fromEntries(unexpectedHosts) }, null, 2));
const panel = new DiagnosticPanel(`P2 harness (${__ADAPTER__})`, report);
const render = () => panel.render(results.map((r) => ({ status: r.status, id: r.id })),
  `TT violations ${ttViolations.length} | rows ${JSON.stringify(adapter?.rowStats ?? {})} | unexpected hosts ${unexpectedHosts.size}`);
function record(id: string, status: Result['status'], detail: unknown) {
  results.push({ id, status, detail, at: new Date().toISOString() });
  console.info(`[P2] ${id} ${status}`, detail);
  render();
}
(window as unknown as { __P2_REPORT: () => string }).__P2_REPORT = report;

// Passive Trusted Types observation (P2.10)
document.addEventListener('securitypolicyviolation', (e) => {
  if (e.violatedDirective !== 'require-trusted-types-for') return;
  ttViolations.push({ sample: (e.sample || '').slice(0, 60), source: (e.sourceFile || '').split('/').pop() ?? '', line: e.lineNumber });
  render();
});

// Unexpected network hosts (P2.3)
const ALLOWED = /(^|\.)(google\.com|gstatic\.com|googleusercontent\.com|googleapis\.com|ggpht\.com|youtube\.com|doubleclick\.net|google-analytics\.com|googletagmanager\.com)$/;
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      let host = ''; try { host = new URL(e.name).hostname; } catch { continue; }
      if (host && !ALLOWED.test(host)) unexpectedHosts.set(host, (unexpectedHosts.get(host) ?? 0) + 1);
    }
  }).observe({ type: 'resource', buffered: true });
} catch (e) { record('P2.3 network-observer', 'FAIL', String(e)); }

async function createAdapter(): Promise<typeof adapter> {
  if (__ADAPTER__ === 'gmailjs') {
    const { GmailJsAdapter } = await import('./gmailjs-adapter');
    return new GmailJsAdapter();
  }
  return new NativeDomAdapter();
}

const t0 = performance.now();
createAdapter()
  .then(async (a) => {
    adapter = a;
    await a.ready();
    record('P2.9 load', 'PASS', { adapter: a.name, msToLoad: Math.round(performance.now() - t0) });
    a.setThreadMarks(new Map());
    a.onThreadViewed((id) => record('P2.11 view_thread', 'RECORDED', { threadId: id }));
    a.onCompose((c) => {
      record('P2.5 compose-detected', 'PASS', { kind: c.kind, composeIdPresent: Boolean(c.composeId) });
      try {
        c.addButton('P2: Read', () => {
          try {
            const s = c.snapshot();
            record('P2.6 read-fields', 'RECORDED', { kind: s.kind, to: s.to.map((x) => x.email), cc: s.cc.map((x) => x.email), bcc: s.bcc.map((x) => x.email),
              subject: s.subject, htmlLength: s.html.length, htmlHasSignatureDiv: /gmail_signature/.test(s.html), hasAttachments: s.hasAttachments });
          } catch (e) { record('P2.6 read-fields', 'FAIL', String(e)); }
        });
        c.addButton('P2: Close', () => { c.close(); record('P2.7 close', 'RECORDED', { note: 'Esc-close issued; check Drafts' }); });
        record('P2.5 button-injected', 'PASS', { kind: c.kind });
      } catch (e) { record('P2.5 button-injected', 'FAIL', String(e)); }
    });
    window.setTimeout(() => {
      record('P2.3 unexpected-hosts-60s', unexpectedHosts.size ? 'FAIL' : 'PASS', Object.fromEntries(unexpectedHosts));
      record('P2.10 trusted-types-60s', ttViolations.length ? 'FAIL' : 'PASS', { violations: ttViolations.length, first: ttViolations.slice(0, 3) });
    }, 60_000);
  })
  .catch((e) => record('P2.9 load', 'FAIL', String(e)));
render();
