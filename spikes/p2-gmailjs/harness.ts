// SPIKE P2 (throwaway): live-compatibility harness. Runs in Gmail's MAIN world.
// - Adapter chosen at build time: native DOM (default) or gmail.js (+jQuery 4).
// - No network requests. Never sends mail. "Close" only closes the composer.
// - Trusted Types: observed PASSIVELY (securitypolicyviolation events). This harness never creates a
//   TT policy and never assigns to an HTML sink.
import type { GmailUiAdapter } from '../../extension/src/gmail/adapter';
import { NativeDomAdapter } from '../../extension/src/gmail/native-adapter';
import { DiagnosticPanel } from './panel';
import { buildReport, coverage, gmailView, isOwnError, type Result, type ViewRowStats } from './report';

declare const __ADAPTER__: 'native' | 'gmailjs';
declare const __BUILD_ID__: string;

const results: Result[] = [];
const viewStats: ViewRowStats[] = [];
const ttViolations: { sample: string; source: string; line: number }[] = [];
const unexpectedHosts = new Map<string, number>();
const startedAt = new Date().toISOString();
let adapter: (GmailUiAdapter & { rowStats?: { rows: number; withId: number; totalMarks: number } }) | undefined;

const report = () => buildReport({
  variant: __ADAPTER__, buildId: __BUILD_ID__, adapterName: adapter?.name, userAgent: navigator.userAgent, startedAt,
  results, viewStats, ttViolations, unexpectedHosts: Object.fromEntries(unexpectedHosts),
});
const panel = new DiagnosticPanel(`P2 harness (${__ADAPTER__}) ${__BUILD_ID__}`, report);
function render() {
  const missing = coverage(results, viewStats).missing.length;
  panel.render(results.map((r) => ({ status: r.status, id: r.id })),
    `view ${gmailView(location.hash)} | missing checks ${missing} | TT ${ttViolations.length} | hosts ${unexpectedHosts.size} | rows ${JSON.stringify(adapter?.rowStats ?? {})}`);
}
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

// Uncaught errors originating from THIS harness bundle (P2.12). Gmail's own errors are ignored.
const SELF_FILE = (document.currentScript as HTMLScriptElement | null)?.src?.split('/').pop();
window.addEventListener('error', (e) => {
  if (!isOwnError(e.filename, (e.error as Error | undefined)?.stack, SELF_FILE)) return;
  record('P2.12 uncaught-error', 'FAIL', { message: String(e.message).slice(0, 200), line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  if (!isOwnError(undefined, (e.reason as Error | undefined)?.stack, SELF_FILE)) return;
  record('P2.12 uncaught-error', 'FAIL', { message: String(e.reason).slice(0, 200) });
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

// Per-view row statistics (P2.8): sampled 2.5 s after every view change, and every 10 s.
function sampleRows() {
  const s = adapter?.rowStats;
  if (!s) return;
  const view = gmailView(location.hash);
  const last = viewStats.filter((v) => v.view === view).pop();
  if (last && last.rows === s.rows && last.withId === s.withId && last.totalMarks === s.totalMarks) return;
  viewStats.push({ view, rows: s.rows, withId: s.withId, totalMarks: s.totalMarks, at: new Date().toISOString() });
  render();
}

async function createAdapter(): Promise<NonNullable<typeof adapter>> {
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
    record('P2.9 load', 'PASS', { variant: __ADAPTER__, adapter: a.name, buildId: __BUILD_ID__, msToLoad: Math.round(performance.now() - t0) });
    a.setThreadMarks(new Map());
    window.addEventListener('hashchange', () => { setTimeout(sampleRows, 2500); render(); });
    setTimeout(sampleRows, 2500);
    setInterval(sampleRows, 10_000);
    a.onThreadViewed((id) => record('P2.11 view_thread', 'RECORDED', { threadId: id, view: gmailView(location.hash) }));
    a.onCompose((c) => {
      record('P2.5 compose-detected', 'PASS', { kind: c.kind, composeIdPresent: Boolean(c.composeId), view: gmailView(location.hash) });
      try {
        c.addButton('P2: Read', () => {
          try {
            const s = c.snapshot();
            record('P2.6 read-fields', 'RECORDED', { kind: s.kind, to: s.to.map((x) => x.email), cc: s.cc.map((x) => x.email), bcc: s.bcc.map((x) => x.email),
              subject: s.subject, htmlLength: s.html.length, htmlHasSignatureDiv: /gmail_signature/.test(s.html), hasAttachments: s.hasAttachments });
          } catch (e) { record('P2.6 read-fields', 'FAIL', String(e)); }
        });
        c.addButton('P2: Close', () => { c.close(); record('P2.7 close', 'RECORDED', { kind: c.kind, note: 'Esc-close issued; check Drafts' }); });
        record('P2.5 button-injected', 'PASS', { kind: c.kind });
      } catch (e) { record('P2.5 button-injected', 'FAIL', String(e)); }
    });
    window.setTimeout(() => {
      record('P2.3 unexpected-hosts-60s', unexpectedHosts.size ? 'FAIL' : 'PASS', Object.fromEntries(unexpectedHosts));
      record('P2.10 trusted-types-60s', ttViolations.length ? 'FAIL' : 'PASS', { violations: ttViolations.length, first: ttViolations.slice(0, 3) });
    }, 60_000);
  })
  .catch((e) => record('P2.9 load', 'FAIL', String(e)));
// The gmail.js variant runs at document_start, before <body> exists; render() is a no-op until then.
// Re-render once the body is available so early results (including failures) are always visible.
render();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
