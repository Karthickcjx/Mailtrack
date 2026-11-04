/**
 * GmailUiAdapter — the ONLY boundary between Tracklet and the Gmail web UI (decision D12).
 *
 * Implementations:
 *  - gmail.js adapter (primary candidate, pending live spike P2): runs in Gmail's page world.
 *  - Extension-hosted compose page (fallback): no Gmail DOM dependency; uses only the Gmail API.
 *
 * Product code must depend on this interface, never on gmail.js or Gmail DOM selectors directly,
 * so the integration can be swapped when Gmail changes or gmail.js breaks.
 */

export interface MailAddress {
  email: string;
  name?: string;
}

export type ComposeKind = 'new' | 'reply' | 'forward' | 'unknown';

/** A snapshot of a compose window's user-entered content (read-only). */
export interface ComposeSnapshot {
  composeId: string;
  kind: ComposeKind;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  /** HTML body as rendered in the composer, including the Gmail signature. */
  html: string;
  hasAttachments: boolean;
}

export interface ComposeHandle {
  readonly composeId: string;
  readonly kind: ComposeKind;
  snapshot(): ComposeSnapshot;
  /** Adds a button next to Gmail's Send button. Returns a disposer. */
  addButton(label: string, onClick: () => void): () => void;
  /** Closes the compose window. Whether a draft remains is implementation-specific (see spike P2.7). */
  close(): void;
  /** Optional: discard the draft via Gmail's own Discard control. Returns false if the control wasn't found. */
  discard?(): boolean;
}

export type ThreadMarkState = 'sent' | 'likely_opened' | 'clicked' | 'suspected_only' | 'not_sent';

export interface GmailUiAdapter {
  readonly name: string;
  /** Resolves when the adapter is ready, or rejects with a reason (e.g. unsupported Gmail build). */
  ready(): Promise<void>;
  onCompose(handler: (compose: ComposeHandle) => void): () => void;
  /** Draws/updates a status mark on visible thread rows for the given Gmail thread IDs. */
  setThreadMarks(marks: ReadonlyMap<string, ThreadMarkState>): void;
  /** Called when the user opens a thread (used for self-open filtering, ARCHITECTURE §5.5). */
  onThreadViewed(handler: (gmailThreadId: string) => void): () => void;
  dispose(): void;
}
