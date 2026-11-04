// Native DOM implementation of GmailUiAdapter — PRIMARY Gmail integration (D12, rev 7). Trusted-Types-safe.
// Rules: no innerHTML/outerHTML/insertAdjacentHTML/document.write setters, no Trusted Types policies,
// no jQuery. Reading `innerHTML` (getter) is allowed: it is not a DOM XSS sink.
// All Gmail selectors live in SELECTORS (taken from gmail.js 1.1.16's compose dom map) so they can be
// updated in one place when Gmail changes.
import type { ComposeHandle, ComposeKind, ComposeSnapshot, GmailUiAdapter, MailAddress, ThreadMarkState } from './adapter';
import { normalizeRecipients, threadIdFromAttrs } from './map';

export const SELECTORS = {
  composeRoot: 'div.M9',                       // compose / reply / forward container
  inlineAncestor: '.AO',                       // inline (reply/forward) composes live inside the main pane
  peopleKitChip: (f: string) => `div[name=${f}] [data-hovercard-id]`,
  legacyRecipient: (f: string) => `.GS input[type=hidden][name=${f}]`,
  // Text typed into a recipient field but not yet committed as a chip (Gmail still sends to it).
  recipientInput: (f: string) => `div[name=${f}] input:not([type=hidden])`,
  subjectBox: 'input[name=subjectbox]',
  subjectHidden: 'input[name=subject]',
  composeId: 'input[name=composeid]',
  body: 'div[contenteditable=true]:not([id=subject])',
  attachment: 'div.dL',
  sendRow: '.gU.Up',
  threadRow: 'tr.zA',
  // Exclude Tracklet's own elements so our marks can never be mistaken for Gmail's ID carriers.
  rowLegacyId: '[data-legacy-thread-id]:not(.tracklet-mark)',
  rowThreadId: '[data-thread-id]:not(.tracklet-mark)',
  rowMarkTarget: 'td.yX, td.xY',
  openThreadHeading: 'h2[data-legacy-thread-id]',
  discardButton: '[aria-label^="Discard draft"], [data-tooltip^="Discard draft"]',
} as const;

const FIELDS = ['to', 'cc', 'bcc'] as const;

/** Email-shaped tokens in free text such as "a@x.com, B <b@y.org>; c@z.net" (validated later by normalizeRecipients). */
export function emailsInText(text: string): string[] {
  return text.match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+/g) ?? [];
}

function readRecipients(root: Element) {
  const raw: Record<string, string[]> = { to: [], cc: [], bcc: [] };
  for (const f of FIELDS) {
    const chips = [...root.querySelectorAll(SELECTORS.peopleKitChip(f))].map((e) => e.getAttribute('data-hovercard-id') ?? '');
    const legacy = [...root.querySelectorAll<HTMLInputElement>(SELECTORS.legacyRecipient(f))].map((e) => e.value);
    // P2 round 7 (live Gmail): addresses typed with commas but never committed stay as raw text in the
    // field's input, yet Gmail still treats them as recipients. Include them so none is missed.
    const typed = [...root.querySelectorAll<HTMLInputElement>(SELECTORS.recipientInput(f))].flatMap((e) => emailsInText(e.value));
    raw[f] = [...(chips.length ? chips : legacy), ...typed];
  }
  return normalizeRecipients(raw);
}

function kindOf(root: Element): ComposeKind {
  if (!root.closest(SELECTORS.inlineAncestor)) return 'new';
  const subj = root.querySelector<HTMLInputElement>(SELECTORS.subjectHidden)?.value ?? root.querySelector<HTMLInputElement>(SELECTORS.subjectBox)?.value ?? '';
  return /^fw/i.test(subj) ? 'forward' : 'reply';
}

class NativeCompose implements ComposeHandle {
  readonly composeId: string;
  readonly kind: ComposeKind;
  constructor(private readonly root: Element) {
    this.composeId = root.querySelector<HTMLInputElement>(SELECTORS.composeId)?.value ?? '';
    this.kind = kindOf(root);
  }
  snapshot(): ComposeSnapshot {
    const rec = readRecipients(this.root);
    const strip = (a: MailAddress[]) => a;
    return {
      composeId: this.composeId, kind: kindOf(this.root),
      to: strip(rec.to), cc: strip(rec.cc), bcc: strip(rec.bcc),
      subject: this.root.querySelector<HTMLInputElement>(SELECTORS.subjectBox)?.value ?? this.root.querySelector<HTMLInputElement>(SELECTORS.subjectHidden)?.value ?? '',
      html: this.root.querySelector(SELECTORS.body)?.innerHTML ?? '',   // getter only
      hasAttachments: this.root.querySelectorAll(SELECTORS.attachment).length > 0,
    };
  }
  addButton(label: string, onClick: () => void): () => void {
    const row = [...this.root.querySelectorAll(SELECTORS.sendRow)].pop();
    if (!row?.parentElement) throw new Error('send row not found');
    const btn = document.createElement('div');
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;
    btn.className = 'tracklet-compose-btn';
    btn.textContent = label;                     // text only — never markup
    btn.style.cssText = 'display:inline-block;margin-left:8px;padding:0 12px;line-height:36px;border-radius:18px;background:#e8f0fe;color:#174ea6;cursor:pointer;font:500 14px system-ui';
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } });
    row.after(btn);
    return () => btn.remove();
  }
  close(): void {
    const body = this.root.querySelector<HTMLElement>(SELECTORS.body);
    body?.focus();
    (body ?? this.root).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true } as KeyboardEventInit));
  }
  /** Clicks Gmail's own "Discard draft" control in THIS compose (label observed live in P2: "Discard draft (Ctrl-Shift-D)"). */
  discard(): boolean {
    const btn = this.root.querySelector<HTMLElement>(SELECTORS.discardButton);
    if (!btn) return false;
    btn.click();
    return true;
  }
}

export class NativeDomAdapter implements GmailUiAdapter {
  readonly name = 'native-dom';
  private observers: MutationObserver[] = [];
  private seen = new WeakSet<Element>();
  private marks = new Map<string, ThreadMarkState>();
  private timer: number | undefined;
  private cleanups: (() => void)[] = [];
  rowStats = { rows: 0, withId: 0, totalMarks: 0 };

  /**
   * @param markUntracked  true (P2 harness default) paints a mark on every identified row;
   *                       false (product) marks only threads present in setThreadMarks() and removes stale marks.
   */
  constructor(private readonly doc: Document = document, private readonly markUntracked = true) {}

  ready(): Promise<void> {
    if (this.doc.readyState !== 'loading') return Promise.resolve();
    return new Promise((r) => this.doc.addEventListener('DOMContentLoaded', () => r(), { once: true }));
  }

  onCompose(handler: (c: ComposeHandle) => void): () => void {
    const scan = (node: ParentNode) => {
      const roots = node instanceof Element && node.matches(SELECTORS.composeRoot) ? [node] : [];
      roots.push(...node.querySelectorAll(SELECTORS.composeRoot));
      for (const r of roots) {
        if (this.seen.has(r)) continue;
        this.seen.add(r);
        handler(new NativeCompose(r));
      }
    };
    scan(this.doc);
    const mo = new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n instanceof Element) scan(n); });
    mo.observe(this.doc.documentElement, { childList: true, subtree: true });
    this.observers.push(mo);
    return () => mo.disconnect();
  }

  setThreadMarks(marks: ReadonlyMap<string, ThreadMarkState>): void {
    this.marks = new Map(marks);
    this.paintRows();
    this.timer ??= window.setInterval(() => this.paintRows(), 1500);
  }

  /** Thread IDs of visible list rows (hidden cached views excluded), max 50. */
  visibleThreadIds(): string[] {
    const out = new Set<string>();
    this.doc.querySelectorAll<HTMLTableRowElement>(SELECTORS.threadRow).forEach((row) => {
      if (out.size >= 50 || !row.isConnected || row.offsetParent === null) return;
      const id = threadIdFromAttrs({
        legacy: row.querySelector(SELECTORS.rowLegacyId)?.getAttribute('data-legacy-thread-id') ?? null,
        threadId: row.querySelector(SELECTORS.rowThreadId)?.getAttribute('data-thread-id') ?? null,
      });
      if (id) out.add(id);
    });
    return [...out];
  }

  paintRows(): void {
    let rows = 0, withId = 0;
    this.doc.querySelectorAll<HTMLTableRowElement>(SELECTORS.threadRow).forEach((row) => {
      rows++;
      const id = threadIdFromAttrs({
        legacy: row.querySelector(SELECTORS.rowLegacyId)?.getAttribute('data-legacy-thread-id') ?? null,
        threadId: row.querySelector(SELECTORS.rowThreadId)?.getAttribute('data-thread-id') ?? null,
      });
      if (!id) return;
      withId++;
      const state = this.marks.get(id);
      let mark = row.querySelector<HTMLSpanElement>('.tracklet-mark');
      if (!state && !this.markUntracked) { mark?.remove(); return; }   // product: only tracked threads are marked
      if (!mark) {
        const target = row.querySelector(SELECTORS.rowMarkTarget) ?? row.lastElementChild;
        if (!target) return;
        mark = this.doc.createElement('span');
        mark.className = 'tracklet-mark';
        mark.style.cssText = 'color:#188038;font-weight:600;margin:0 4px;font-size:12px';
        target.prepend(mark);
      }
      // data-tracklet-* only: a plain data-thread-id here would be re-read as Gmail's ID on the next repaint.
      // Write ONLY when a value changes: unconditional writes on every 1.5 s repaint generated
      // ~4 mutation records per row per cycle and woke our own document-wide observer (P2 round 7, live Gmail).
      const text = state === 'likely_opened' || state === 'clicked' ? '✓✓' : '✓';
      const stateAttr = state ?? 'unknown';
      const title = `Tracklet: ${state ?? 'no data'}`;
      if (mark.dataset.trackletThreadId !== id) mark.dataset.trackletThreadId = id;
      if (mark.dataset.trackletState !== stateAttr) mark.dataset.trackletState = stateAttr;
      if (mark.textContent !== text) mark.textContent = text;
      if (mark.title !== title) mark.title = title;
    });
    this.rowStats = { rows, withId, totalMarks: this.doc.querySelectorAll('.tracklet-mark').length };
  }

  onThreadViewed(handler: (id: string) => void): () => void {
    let last = '';
    const check = () => {
      const id = this.doc.querySelector(SELECTORS.openThreadHeading)?.getAttribute('data-legacy-thread-id');
      if (id && id !== last) { last = id; handler(id); }
    };
    const onHash = () => setTimeout(check, 500);
    window.addEventListener('hashchange', onHash);
    const mo = new MutationObserver(check);
    mo.observe(this.doc.documentElement, { childList: true, subtree: true });
    this.observers.push(mo);
    const off = () => { window.removeEventListener('hashchange', onHash); mo.disconnect(); };
    this.cleanups.push(off);
    return off;
  }

  dispose(): void {
    this.observers.forEach((o) => o.disconnect());
    this.cleanups.forEach((c) => c());
    if (this.timer) clearInterval(this.timer);
    this.doc.querySelectorAll('.tracklet-mark, .tracklet-compose-btn').forEach((e) => e.remove());
  }
}
