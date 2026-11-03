// SPIKE P2 (throwaway): gmail.js live-compatibility harness. Runs in Gmail's MAIN world.
// - No network requests are made by this harness.
// - No email is sent. "Close" only closes the composer (Esc), it never sends.
// - Results are kept in memory; "Copy results" copies a JSON report with addresses redacted.
import jQuery from 'jquery';
// @ts-ignore -- gmail-js ships a global-style .d.ts that is not an ES module; typed as any below.
import GmailFactory from 'gmail-js';
import type { ComposeHandle, ComposeSnapshot, GmailUiAdapter, ThreadMarkState } from '../../extension/src/gmail/adapter';
import { normalizeRecipients, threadIdFromAttrs, toComposeKind } from './map';

type Result = { id: string; status: 'PASS' | 'FAIL' | 'RECORDED'; detail: unknown; at: string };
const results: Result[] = [];
const redact = (s: string) => s.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@/g, '$1***@');
function record(id: string, status: Result['status'], detail: unknown) {
  results.push({ id, status, detail, at: new Date().toISOString() });
  console.info(`[P2] ${id} ${status}`, detail);
  renderPanel();
}

// ---------- P2.10 Trusted Types probe (before gmail.js touches the DOM) ----------
function probeTrustedTypes() {
  const tt = (window as unknown as { trustedTypes?: { createPolicy(n: string, p: object): unknown } }).trustedTypes;
  let innerHtmlBlocked = false;
  try { document.createElement('div').innerHTML = '<b>x</b>'; } catch { innerHtmlBlocked = true; }
  let defaultPolicy: string = 'not attempted';
  if (innerHtmlBlocked && tt) {
    try { tt.createPolicy('default', { createHTML: (s: string) => s }); defaultPolicy = 'created'; innerHtmlBlocked = false; }
    catch (e) { defaultPolicy = `refused: ${String(e).slice(0, 160)}`; }
  }
  record('P2.10 trusted-types', innerHtmlBlocked ? 'FAIL' : 'RECORDED', { trustedTypesApi: Boolean(tt), innerHtmlBlockedAfterProbe: innerHtmlBlocked, defaultPolicy });
}

// ---------- P2.3 unexpected network observation ----------
const ALLOWED = /(^|\.)(google\.com|gstatic\.com|googleusercontent\.com|googleapis\.com|ggpht\.com|youtube\.com|doubleclick\.net|google-analytics\.com|googletagmanager\.com)$/;
const unexpectedHosts = new Map<string, number>();
function watchNetwork() {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        let host = '';
        try { host = new URL(e.name).hostname; } catch { continue; }
        if (!host || ALLOWED.test(host)) continue;
        unexpectedHosts.set(host, (unexpectedHosts.get(host) ?? 0) + 1);
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (e) { record('P2.3 network-observer', 'FAIL', String(e)); }
}

// ---------- gmail.js adapter (implements the product interface) ----------
class GmailJsAdapter implements GmailUiAdapter {
  readonly name = 'gmail.js@1.1.16';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private gmail: any;
  private marks = new Map<string, ThreadMarkState>();
  private timer: number | undefined;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Factory = (GmailFactory as any).Gmail ?? (GmailFactory as any);
    this.gmail = new Factory(jQuery);
  }

  ready(): Promise<void> {
    return new Promise((resolve) => this.gmail.observe.on_load(() => resolve()));
  }

  onCompose(handler: (c: ComposeHandle) => void) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cb = (compose: any, type: unknown) => {
      const kind = toComposeKind(type);
      const handle: ComposeHandle = {
        composeId: String(compose.id?.() ?? ''),
        kind,
        snapshot: (): ComposeSnapshot => {
          const rec = normalizeRecipients(compose.recipients());
          let atts = 0;
          try { atts = compose.attachments().length; } catch { atts = -1; }
          return {
            composeId: String(compose.id?.() ?? ''), kind,
            to: rec.to, cc: rec.cc, bcc: rec.bcc,
            subject: String(compose.subject() ?? ''), html: String(compose.body() ?? ''),
            hasAttachments: atts !== 0,
          };
        },
        addButton: (label, onClick) => {
          const btn = this.gmail.tools.add_compose_button(compose, label, onClick, 'p2-btn');
          return () => btn?.remove?.();
        },
        close: () => compose.close(),
      };
      handler(handle);
    };
    this.gmail.observe.on('compose', cb);
    return () => this.gmail.observe.off('compose');
  }

  setThreadMarks(marks: ReadonlyMap<string, ThreadMarkState>) {
    this.marks = new Map(marks);
    this.timer ??= window.setInterval(() => this.paintRows(), 1500);
  }

  /** Paints a mark on EVERY visible row with a parsable thread id (spike: we have no real tracking data). */
  private paintRows() {
    let rows = 0, withId = 0, painted = 0;
    document.querySelectorAll<HTMLTableRowElement>('tr.zA').forEach((row) => {
      rows++;
      const legacy = row.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id');
      const tid = row.querySelector('[data-thread-id]')?.getAttribute('data-thread-id');
      const id = threadIdFromAttrs({ legacy: legacy ?? null, threadId: tid ?? null });
      if (!id) return;
      withId++;
      if (row.querySelector('.p2-mark')) return;
      const target = row.querySelector('td.yX, td.xY') ?? row.lastElementChild;
      if (!target) return;
      const mark = document.createElement('span');
      mark.className = 'p2-mark';
      mark.textContent = this.marks.get(id) === 'likely_opened' ? '✓✓' : '✓';
      mark.title = `P2 spike mark for thread ${id}`;
      mark.style.cssText = 'color:#188038;font-weight:600;margin:0 4px;font-size:12px';
      target.prepend(mark);
      painted++;
    });
    rowStats = { rows, withId, paintedThisPass: painted, totalMarks: document.querySelectorAll('.p2-mark').length };
    renderPanel();
  }

  onThreadViewed(handler: (id: string) => void) {
    this.gmail.observe.on('view_thread', () => {
      const id = this.gmail.new?.get?.thread_id?.() ?? this.gmail.get?.thread_id?.();
      if (id) handler(String(id));
    });
    return () => this.gmail.observe.off('view_thread');
  }

  dispose() { if (this.timer) clearInterval(this.timer); this.gmail.observe.off(); }
}

// ---------- overlay panel (DOM APIs only; no innerHTML) ----------
let rowStats: Record<string, number> = {};
let panel: HTMLDivElement | null = null;
function renderPanel() {
  if (!document.body) return;
  if (!panel) {
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:2147483647;background:#fff;border:1px solid #888;border-radius:6px;padding:6px 8px;font:11px system-ui;max-width:360px;max-height:220px;overflow:auto;box-shadow:0 2px 8px rgba(0,0,0,.2)';
    document.body.appendChild(panel);
  }
  panel.replaceChildren();
  const title = document.createElement('b'); title.textContent = 'P2 gmail.js harness'; panel.append(title);
  const copy = document.createElement('button'); copy.textContent = 'Copy results'; copy.style.marginLeft = '8px';
  copy.onclick = () => { void navigator.clipboard.writeText(report()); copy.textContent = 'Copied'; };
  panel.append(copy);
  for (const r of results.slice(-8)) {
    const d = document.createElement('div'); d.textContent = `${r.status} ${r.id}`; panel.append(d);
  }
  const s = document.createElement('div'); s.textContent = `rows ${JSON.stringify(rowStats)} | unexpected hosts ${unexpectedHosts.size}`; panel.append(s);
}
function report() {
  return redact(JSON.stringify({ harness: 'P2 gmail.js', userAgent: navigator.userAgent, results, rowStats, unexpectedHosts: Object.fromEntries(unexpectedHosts) }, null, 2));
}
(window as unknown as { __P2_REPORT: () => string }).__P2_REPORT = report;

// ---------- test wiring ----------
probeTrustedTypes();
watchNetwork();
const adapter = new GmailJsAdapter();
const t0 = performance.now();
adapter.ready().then(() => {
  record('P2.9 load', 'PASS', { msToLoad: Math.round(performance.now() - t0) });
  adapter.setThreadMarks(new Map());
  adapter.onThreadViewed((id) => record('P2.11 view_thread', 'RECORDED', { threadId: id }));
  adapter.onCompose((c) => {
    record('P2.5 compose-detected', 'PASS', { kind: c.kind, composeIdPresent: Boolean(c.composeId) });
    try {
      c.addButton('P2: Read', () => {
        try {
          const s = c.snapshot();
          record('P2.6 read-fields', 'RECORDED', {
            kind: s.kind, to: s.to.map((a) => a.email), cc: s.cc.map((a) => a.email), bcc: s.bcc.map((a) => a.email),
            subject: s.subject, htmlLength: s.html.length, htmlHasSignatureDiv: /gmail_signature/.test(s.html), hasAttachments: s.hasAttachments,
          });
        } catch (e) { record('P2.6 read-fields', 'FAIL', String(e)); }
      });
      c.addButton('P2: Close', () => { c.close(); record('P2.7 close', 'RECORDED', { note: 'Esc-close issued; check Drafts for a saved draft' }); });
      record('P2.5 button-injected', 'PASS', { kind: c.kind });
    } catch (e) { record('P2.5 button-injected', 'FAIL', String(e)); }
  });
  window.setTimeout(() => record('P2.3 unexpected-hosts-60s', unexpectedHosts.size ? 'FAIL' : 'PASS', Object.fromEntries(unexpectedHosts)), 60_000);
}).catch((e) => record('P2.9 load', 'FAIL', String(e)));
