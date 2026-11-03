// P2 report model: pure functions (no DOM) so result collection and coverage are unit-testable.

export type Status = 'PASS' | 'FAIL' | 'RECORDED';
export interface Result { id: string; status: Status; detail: unknown; at: string }
export interface ViewRowStats { view: string; rows: number; withId: number; totalMarks: number; at: string }

/** Every live check the runbook asks for, and how its evidence is recognised in the results. */
export const REQUIRED_CHECKS: { id: string; label: string; satisfied: (r: Result[], v: ViewRowStats[]) => boolean }[] = [
  { id: 'P2.9-load', label: 'Adapter loaded', satisfied: (r) => r.some((x) => x.id === 'P2.9 load' && x.status === 'PASS') },
  { id: 'P2.5-new', label: 'New compose detected + buttons', satisfied: (r) => hasKind(r, 'P2.5 compose-detected', 'new') && r.some((x) => x.id === 'P2.5 button-injected' && x.status === 'PASS') },
  { id: 'P2.5-reply', label: 'Reply compose detected', satisfied: (r) => hasKind(r, 'P2.5 compose-detected', 'reply') },
  { id: 'P2.5-forward', label: 'Forward compose detected', satisfied: (r) => hasKind(r, 'P2.5 compose-detected', 'forward') },
  { id: 'P2.6-to-cc-bcc', label: 'Read with To, Cc and Bcc all non-empty', satisfied: (r) => reads(r).some((d) => d.to.length > 0 && d.cc.length > 0 && d.bcc.length > 0) },
  { id: 'P2.6-unicode-subject', label: 'Read with non-ASCII subject', satisfied: (r) => reads(r).some((d) => /[^\x00-\x7f]/.test(d.subject)) },
  { id: 'P2.6-body', label: 'Read with non-empty body', satisfied: (r) => reads(r).some((d) => d.htmlLength > 0) },
  { id: 'P2.6-signature', label: 'Read with signature detected', satisfied: (r) => reads(r).some((d) => d.htmlHasSignatureDiv) },
  { id: 'P2.6-attachment', label: 'Read with attachment detected', satisfied: (r) => reads(r).some((d) => d.hasAttachments) },
  { id: 'P2.7-close', label: 'Close issued (check Drafts manually)', satisfied: (r) => r.some((x) => x.id === 'P2.7 close') },
  { id: 'P2.8-sent', label: 'Row IDs + marks in Sent', satisfied: (_r, v) => viewOk(v, 'sent') },
  { id: 'P2.8-inbox', label: 'Row IDs + marks in Inbox', satisfied: (_r, v) => viewOk(v, 'inbox') },
  { id: 'P2.8-search', label: 'Row IDs + marks in search results', satisfied: (_r, v) => viewOk(v, 'search') },
  { id: 'P2.11-view-thread', label: 'Thread-view events (>= 3 distinct)', satisfied: (r) => new Set(r.filter((x) => x.id === 'P2.11 view_thread').map((x) => (x.detail as { threadId?: string })?.threadId)).size >= 3 },
  { id: 'P2.3-hosts', label: 'No unexpected hosts after 60 s', satisfied: (r) => r.some((x) => x.id === 'P2.3 unexpected-hosts-60s' && x.status === 'PASS') },
  { id: 'P2.10-tt', label: 'No Trusted Types violations after 60 s', satisfied: (r) => r.some((x) => x.id === 'P2.10 trusted-types-60s' && x.status === 'PASS') },
  { id: 'P2.12-no-errors', label: 'No uncaught harness errors (this page load)', satisfied: (r) => !r.some((x) => x.id === 'P2.12 uncaught-error') && r.some((x) => x.id === 'P2.9 load') },
];

/** Checks that can only be confirmed by a human (outside this page load) — always reported as MANUAL. */
export const MANUAL_CHECKS = [
  'P2.7 Draft present in Drafts after "P2: Close" (yes/no)',
  'P2.12 10 reloads + Inbox<->Sent switching without red page.js errors',
  'P2.3 DevTools Network filter shows no non-Google requests',
];

type ReadDetail = { kind: string; to: string[]; cc: string[]; bcc: string[]; subject: string; htmlLength: number; htmlHasSignatureDiv: boolean; hasAttachments: boolean };
const reads = (r: Result[]) => r.filter((x) => x.id === 'P2.6 read-fields' && x.status === 'RECORDED').map((x) => x.detail as ReadDetail);
const hasKind = (r: Result[], id: string, kind: string) => r.some((x) => x.id === id && (x.detail as { kind?: string })?.kind === kind);
const viewOk = (v: ViewRowStats[], view: string) => v.some((s) => s.view === view && s.rows > 0 && s.withId === s.rows && s.totalMarks >= s.withId);

/** Maps a Gmail URL hash to a coarse view name (no message/thread IDs or search terms are kept). */
export function gmailView(hash: string): string {
  const h = hash.replace(/^#/, '');
  const first = h.split(/[/?]/)[0] ?? '';
  if (!first) return 'inbox';
  if (['inbox', 'sent', 'drafts', 'starred', 'snoozed', 'imp', 'all', 'spam', 'trash', 'scheduled'].includes(first)) {
    return h.includes('/') ? `${first}-thread` : first;
  }
  if (first === 'search' || first === 'advanced-search') return h.split('/').length > 2 ? 'search-thread' : 'search';
  if (first === 'label' || first === 'category') return h.split('/').length > 2 ? `${first}-thread` : first;
  return 'other';
}

/**
 * True if an error event originates from the harness bundle itself (live: ".../page.js"; tests: the served file name).
 * Gmail's own errors must not count against the harness (P2.12).
 */
export function isOwnError(filename: string | undefined, stack: string | undefined, selfFile: string | undefined): boolean {
  const names = ['page.js', ...(selfFile ? [selfFile] : [])];
  const hay = `${filename ?? ''}\n${stack ?? ''}`;
  return names.some((n) => hay.includes(`/${n}`) || hay.split(/[\s()]/).some((t) => t === n || t.startsWith(`${n}:`)));
}

const redact = (s: string) => s.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@/g, '$1***@');

export interface ReportInput {
  variant: 'native' | 'gmailjs';
  buildId: string;
  adapterName: string | undefined;
  userAgent: string;
  startedAt: string;
  results: Result[];
  viewStats: ViewRowStats[];
  ttViolations: unknown[];
  unexpectedHosts: Record<string, number>;
}

export function coverage(results: Result[], viewStats: ViewRowStats[]) {
  const automated = REQUIRED_CHECKS.map((c) => ({ id: c.id, label: c.label, evidence: c.satisfied(results, viewStats) ? 'PRESENT' : 'MISSING' }));
  return { automated, missing: automated.filter((c) => c.evidence === 'MISSING').map((c) => c.id), manual: MANUAL_CHECKS.map((m) => ({ check: m, evidence: 'MANUAL — report separately' })) };
}

/** JSON report with email local parts redacted (a***@domain). Thread IDs are kept (needed to verify distinct views). */
export function buildReport(i: ReportInput): string {
  return redact(JSON.stringify({
    schema: 'tracklet-p2-report/2',
    harness: 'P2',
    variant: i.variant,
    buildId: i.buildId,
    adapter: i.adapterName ?? null,
    userAgent: i.userAgent,
    startedAt: i.startedAt,
    reportedAt: new Date().toISOString(),
    coverage: coverage(i.results, i.viewStats),
    results: i.results,
    viewStats: i.viewStats,
    ttViolations: i.ttViolations,
    unexpectedHosts: i.unexpectedHosts,
  }, null, 2));
}
