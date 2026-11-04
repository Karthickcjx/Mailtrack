// Per-recipient batch sender for the Gmail API, with safe failure semantics (promoted from spike P3).
// No real email is sent by tests: Gmail is reached only through the injected `fetch`.
//
// Safety rules (P3 plan, 2026-11-03):
//  - Every recipient is validated (syntax, duplicates, count) BEFORE any API request.
//  - All MIME messages are built BEFORE the first request, so builder errors can't cause a partial send.
//  - Only one batch at a time per BatchSender (double-click / concurrent sends are rejected).
//  - Stop on the first copy that is not confirmed sent; later copies are marked "skipped".
//  - Retries ONLY when Gmail has definitely not sent the message:
//      * 401 → invalidate the cached token, fetch a new one silently, retry that copy at most ONCE per batch.
//      * 429 → bounded backoff (Retry-After honoured but capped), at most MAX_429_RETRIES.
//    A network error, timeout, 5xx, or a 2xx without a parseable message id is "uncertain": never retried.
//  - Responses are read as text and parsed defensively; non-JSON bodies never lose the results log.
//  - Tokens never appear in results or error strings.
import { insertPixelAtTop } from '@tracklet/shared';
import { buildMime, toRaw, type Address } from './mime';

export const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
export const MAX_RECIPIENTS = 20;   // D18 (the spike used 3)
export const MAX_401_REFRESH = 1;
export const MAX_429_RETRIES = 3;
export const MAX_BACKOFF_MS = 10_000;
const EMAIL = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\.]+(\.[^\s@<>()",;:\\.]+)+$/;

export type CopyStatus = 'sent' | 'failed' | 'uncertain' | 'skipped';
export interface CopyResult {
  copy: number;
  to: string;
  status: CopyStatus;
  http?: number;
  id?: string;
  threadId?: string;
  attempts: number;
  error?: string;
  /** Problem reporting the result to the backend (the Gmail send itself is unaffected). */
  hookError?: string;
}
export interface BatchResult {
  ok: boolean;
  reason?: string;
  firstMessageId?: string;
  results: CopyResult[];
}

export interface SendDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;
  getToken: (interactive: boolean) => Promise<string>;
  invalidateToken: (token: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  newMessageId: () => string;
}

export interface BatchInput {
  from: Address;
  recipients: string[];
  subject: string;
  html: (copyIndex: number) => string;
  text: (copyIndex: number) => string;
  pixelUrl?: string;
  spacingMs?: number;
  /** Optional per-copy hooks (used to report status to the backend). */
  hooks?: {
    /** Runs before each copy's FIRST send attempt. If it throws, nothing more is sent (batch stops). */
    beforeSend?: (copyIndex: number) => Promise<void>;
    /** Runs after each copy settles. Errors are recorded on the result but never trigger a resend. */
    afterResult?: (copyIndex: number, result: CopyResult) => Promise<void>;
  };
}

export interface Prepared { to: string; messageId: string; inReplyTo?: string; mime: string; raw: string }

/** Validate and normalise recipients; returns errors instead of throwing. */
export function validateRecipients(raw: string[], max = MAX_RECIPIENTS): { ok: true; recipients: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const list = raw.map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) errors.push('no recipients');
  if (list.length > max) errors.push(`too many recipients (${list.length} > ${max})`);
  const seen = new Set<string>();
  for (const r of list) {
    if (/[\r\n]/.test(r) || !EMAIL.test(r)) { errors.push(`invalid address: ${JSON.stringify(r.slice(0, 80))}`); continue; }
    const k = r.toLowerCase();
    if (seen.has(k)) errors.push(`duplicate address: ${k}`);
    seen.add(k);
  }
  return errors.length ? { ok: false, errors } : { ok: true, recipients: list };
}

/** Build every copy up front (no network). Copy #1 gets its own Message-ID; copies 2..N reference it. */
export function prepareBatch(input: BatchInput, recipients: string[], newMessageId: () => string): Prepared[] {
  const firstId = newMessageId();
  return recipients.map((to, i) => {
    const messageId = i === 0 ? firstId : newMessageId();
    const html = input.pixelUrl ? insertPixelAtTop(input.html(i), input.pixelUrl) : input.html(i);
    const mime = buildMime({
      from: input.from, to: { email: to }, subject: input.subject, html, text: input.text(i), messageId,
      ...(i > 0 ? { inReplyTo: firstId } : {}),
    });
    return { to, messageId, ...(i > 0 ? { inReplyTo: firstId } : {}), mime, raw: toRaw(mime) };
  });
}

/** Dry run: validate + build + return the decoded messages and the request shapes. Never calls fetch. */
export function dryRun(input: BatchInput, newMessageId: () => string) {
  const v = validateRecipients(input.recipients);
  if (!v.ok) return { ok: false as const, errors: v.errors };
  const prepared = prepareBatch(input, v.recipients, newMessageId);
  return {
    ok: true as const,
    copies: prepared.map((p, i) => ({
      copy: i + 1, to: p.to, messageId: p.messageId, inReplyTo: p.inReplyTo ?? null,
      request: { method: 'POST', url: GMAIL_SEND_URL, body: { raw: `<${p.raw.length} base64url chars>`, ...(i > 0 ? { threadId: '<threadId of copy 1>' } : {}) } },
      decodedMime: p.mime,
    })),
  };
}

function scrub(s: string, secrets: string[]): string {
  let out = s;
  for (const sec of secrets) if (sec) out = out.split(sec).join('[REDACTED]');
  return out.replace(/ya29\.[0-9A-Za-z._-]+/g, '[REDACTED]');
}

function parseJson(text: string): Record<string, unknown> | null {
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? (v as Record<string, unknown>) : null; } catch { return null; }
}

function retryAfterMs(header: string | null, attempt: number): number {
  const secs = header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : NaN;
  const ms = Number.isFinite(secs) ? secs * 1000 : 1000 * 2 ** attempt;   // 1 s, 2 s, 4 s …
  return Math.min(Math.max(ms, 0), MAX_BACKOFF_MS);
}

export class BatchSender {
  private inFlight = false;
  constructor(private readonly deps: SendDeps) {}

  get busy(): boolean { return this.inFlight; }

  async send(input: BatchInput): Promise<BatchResult> {
    if (this.inFlight) return { ok: false, reason: 'busy: a batch is already being sent', results: [] };
    this.inFlight = true;
    try { return await this.run(input); } finally { this.inFlight = false; }
  }

  private async run(input: BatchInput): Promise<BatchResult> {
    const v = validateRecipients(input.recipients);
    if (!v.ok) return { ok: false, reason: `validation: ${v.errors.join('; ')}`, results: [] };

    let prepared: Prepared[];
    try { prepared = prepareBatch(input, v.recipients, this.deps.newMessageId); }
    catch (e) { return { ok: false, reason: `build: ${String(e)}`, results: [] }; }

    let token: string;
    try { token = await this.deps.getToken(false); }
    catch (e) { return { ok: false, reason: `token: ${scrub(String(e), [])}`, results: [] }; }

    const secrets = [token];
    const results: CopyResult[] = prepared.map((p, i) => ({ copy: i + 1, to: p.to, status: 'skipped', attempts: 0 }));
    let threadId: string | undefined;
    let refreshesUsed = 0;

    const settle = async (i: number) => {
      if (!input.hooks?.afterResult) return;
      try { await input.hooks.afterResult(i, results[i]!); }
      catch (e) { results[i]!.hookError = scrub(String(e), secrets).slice(0, 200); }
    };
    const stop = async (i: number, reason: string): Promise<BatchResult> => {
      await settle(i);
      return { ok: false, reason, firstMessageId: prepared[0]!.messageId, results };
    };

    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i]!;
      const res = results[i]!;
      if (i > 0 && input.spacingMs) await this.deps.sleep(input.spacingMs);
      let retries429 = 0;
      if (input.hooks?.beforeSend) {
        try { await input.hooks.beforeSend(i); }
        catch (e) {
          // The backend could not record this copy as "sending": do not send something it doesn't know about.
          res.error = `pre-send hook failed: ${scrub(String(e), secrets).slice(0, 200)}`;
          return { ok: false, reason: `copy ${i + 1} not sent (could not record send intent)`, firstMessageId: prepared[0]!.messageId, results };
        }
      }

      for (;;) {
        res.attempts++;
        const body: Record<string, string> = { raw: p.raw };
        if (i > 0 && threadId) body.threadId = threadId;
        let status: number;
        let text = '';
        let retryAfter: string | null = null;
        try {
          const r = await this.deps.fetch(GMAIL_SEND_URL, {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
          });
          status = r.status;
          retryAfter = r.headers.get('retry-after');
          try { text = await r.text(); } catch { text = ''; }
        } catch (e) {
          // The request may or may not have reached Gmail: never retry blindly.
          res.status = 'uncertain';
          res.error = `network: ${scrub(String(e), secrets).slice(0, 200)}`;
          return stop(i, `copy ${i + 1} uncertain (network error)`);
        }
        res.http = status;
        const json = parseJson(text);

        if (status >= 200 && status < 300) {
          const id = typeof json?.id === 'string' ? json.id : undefined;
          if (!id) {
            res.status = 'uncertain';
            res.error = `2xx without message id; body: ${scrub(text, secrets).slice(0, 200)}`;
            return stop(i, `copy ${i + 1} uncertain (unparseable success response)`);
          }
          res.status = 'sent';
          res.id = id;
          if (typeof json?.threadId === 'string') res.threadId = json.threadId;
          if (i === 0) threadId = res.threadId;
          await settle(i);
          break;
        }

        if (status === 401 && refreshesUsed < MAX_401_REFRESH) {
          // Gmail rejected the request (not sent): refresh once, silently, and retry this copy.
          refreshesUsed++;
          try {
            await this.deps.invalidateToken(token);
            token = await this.deps.getToken(false);
            secrets.push(token);
          } catch (e) {
            res.status = 'failed';
            res.error = `401 and token refresh failed: ${scrub(String(e), secrets).slice(0, 200)}`;
            return stop(i, `copy ${i + 1} failed (auth)`);
          }
          continue;
        }

        if (status === 429 && retries429 < MAX_429_RETRIES) {
          // Rate limited: Gmail did not accept the message. Bounded backoff, then retry this copy.
          await this.deps.sleep(retryAfterMs(retryAfter, retries429));
          retries429++;
          continue;
        }

        const apiMsg = json && typeof (json.error as { message?: unknown } | undefined)?.message === 'string'
          ? (json.error as { message: string }).message : text;
        if (status >= 500) {
          res.status = 'uncertain';   // server error: the send may have been processed; do not retry blindly
          res.error = `HTTP ${status}: ${scrub(apiMsg, secrets).slice(0, 200)}`;
          return stop(i, `copy ${i + 1} uncertain (HTTP ${status})`);
        }
        res.status = 'failed';
        res.error = `HTTP ${status}${status === 401 ? ' after token refresh' : status === 429 ? ' after max backoff retries' : ''}: ${scrub(apiMsg, secrets).slice(0, 200)}`;
        return stop(i, `copy ${i + 1} failed (HTTP ${status})`);
      }
    }
    return { ok: true, firstMessageId: prepared[0]!.messageId, results };
  }
}
