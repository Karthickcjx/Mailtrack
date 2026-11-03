// gmail.js-backed GmailUiAdapter (P2 candidate). Requires jQuery >= 4 under Trusted Types:
// jQuery 3.7.1 throws during its own load-time feature tests (see spikes/RESULTS.md P2.10).
// gmail.js is used ONLY for observers and data reads. All UI injection uses native DOM APIs
// (gmail.js's add_compose_button / modal / infobox pass markup to jQuery .html() and are blocked by TT).
import jQuery from 'jquery';
// @ts-ignore -- gmail-js ships a global-style .d.ts that is not an ES module
import GmailFactory from 'gmail-js';
import type { ComposeHandle, ComposeSnapshot, GmailUiAdapter, ThreadMarkState } from '../../extension/src/gmail/adapter';
import { normalizeRecipients, toComposeKind } from '../../extension/src/gmail/map';
import { NativeDomAdapter, SELECTORS } from '../../extension/src/gmail/native-adapter';

export class GmailJsAdapter implements GmailUiAdapter {
  readonly name = 'gmail.js@1.1.16+jquery4';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private gmail: any;
  private readonly marks = new NativeDomAdapter();   // row marks: DOM only
  get rowStats() { return this.marks.rowStats; }

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Factory = (GmailFactory as any).Gmail ?? GmailFactory;
    this.gmail = new Factory(jQuery);
  }

  ready(): Promise<void> {
    return new Promise((resolve) => this.gmail.observe.on_load(() => resolve()));
  }

  onCompose(handler: (c: ComposeHandle) => void): () => void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.gmail.observe.on('compose', (compose: any, type: unknown) => {
      const kind = toComposeKind(type);
      const root: Element = compose.$el?.[0];
      handler({
        composeId: String(compose.id?.() ?? ''),
        kind,
        snapshot: (): ComposeSnapshot => {
          const rec = normalizeRecipients(compose.recipients());
          let atts = 0;
          try { atts = compose.attachments().length; } catch { atts = -1; }
          return { composeId: String(compose.id?.() ?? ''), kind, to: rec.to, cc: rec.cc, bcc: rec.bcc,
            subject: String(compose.subject() ?? ''), html: String(compose.body() ?? ''), hasAttachments: atts !== 0 };
        },
        addButton: (label, onClick) => {
          const row = root ? [...root.querySelectorAll(SELECTORS.sendRow)].pop() : undefined;
          if (!row) throw new Error('send row not found');
          const btn = document.createElement('div');
          btn.setAttribute('role', 'button');
          btn.className = 'tracklet-compose-btn';
          btn.textContent = label;
          btn.style.cssText = 'display:inline-block;margin-left:8px;padding:0 12px;line-height:36px;border-radius:18px;background:#e8f0fe;color:#174ea6;cursor:pointer;font:500 14px system-ui';
          btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
          row.after(btn);
          return () => btn.remove();
        },
        close: () => compose.close(),
      });
    });
    return () => this.gmail.observe.off('compose');
  }

  setThreadMarks(marks: ReadonlyMap<string, ThreadMarkState>): void { this.marks.setThreadMarks(marks); }

  onThreadViewed(handler: (id: string) => void): () => void {
    this.gmail.observe.on('view_thread', () => {
      const id = this.gmail.new?.get?.thread_id?.() ?? this.gmail.get?.thread_id?.();
      if (id) handler(String(id));
    });
    return () => this.gmail.observe.off('view_thread');
  }

  dispose(): void { this.gmail.observe.off(); this.marks.dispose(); }
}
