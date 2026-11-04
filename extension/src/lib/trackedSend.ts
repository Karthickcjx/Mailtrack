// Tracked send orchestration: validate → register with backend → per-recipient rewrite → Gmail send → report.
import {
  extractLinks, htmlToText, insertPixelAtTop, rewriteLinks, trackingUrlProblem,
  type PatchRecipientRequest, type RegisterEmailRequest, type RegisterEmailResponse,
} from '@tracklet/shared';
import type { Backend } from './backend';
import { recipientKey, saveMeta, userSecret } from './localStore';
import type { Platform } from './platform';
import { BatchSender, validateRecipients, type BatchResult } from './send';

export interface ComposeInput {
  kind: 'new' | 'reply' | 'forward' | 'unknown';
  to: string[]; cc: string[]; bcc: string[];
  subject: string;
  html: string;
  hasAttachments: boolean;
  /** Required for 2+ recipients (D5): the user confirmed separate copies / no Reply-All. */
  groupConfirmed: boolean;
}

export interface Prefs { disclosure_enabled: boolean; disclosure_text: string | null }

export interface Planned { recipients: { address: string; field: 'to' | 'cc' | 'bcc' }[]; links: { index: number; url: string }[] }

export type PlanResult = { ok: true; plan: Planned } | { ok: false; errors: string[] };

/** Pure pre-flight checks. Nothing is registered or sent if this fails. */
export function plan(c: ComposeInput): PlanResult {
  const errors: string[] = [];
  if (c.kind !== 'new') errors.push('Tracked sending is only available for new messages (not replies or forwards) in this version.');
  if (c.hasAttachments) errors.push('Messages with attachments cannot be sent tracked yet. Use Gmail\'s normal Send.');
  if (!c.subject.trim()) errors.push('Add a subject first.');
  if (!c.html.trim()) errors.push('The message body is empty.');
  const recipients = [
    ...c.to.map((a) => ({ address: a.trim(), field: 'to' as const })),
    ...c.cc.map((a) => ({ address: a.trim(), field: 'cc' as const })),
    ...c.bcc.map((a) => ({ address: a.trim(), field: 'bcc' as const })),
  ].filter((r) => r.address);
  const v = validateRecipients(recipients.map((r) => r.address));
  if (!v.ok) errors.push(...v.errors.map((e) => e.replace('duplicate address', 'The same address appears twice (To/Cc/Bcc)')));
  if (recipients.length > 1 && !c.groupConfirmed) errors.push('Confirm sending separate copies to each recipient.');
  return errors.length ? { ok: false, errors } : { ok: true, plan: { recipients, links: extractLinks(c.html) } };
}

function withDisclosure(html: string, prefs: Prefs): string {
  if (!prefs.disclosure_enabled || !prefs.disclosure_text) return html;
  const t = prefs.disclosure_text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  return `${html}<p style="color:#5f6368;font-size:12px">${t}</p>`;
}

/** Per-recipient HTML: links rewritten to that recipient's click URLs, pixel at the top, optional disclosure. */
export function personalise(html: string, r: RegisterEmailResponse['recipients'][number], prefs: Prefs): { html: string; text: string } {
  const byIndex = new Map(r.links.map((l) => [l.index, l.click_url]));
  const rewritten = withDisclosure(rewriteLinks(html, (i) => byIndex.get(i) ?? null), prefs);
  return { html: r.pixel_url ? insertPixelAtTop(rewritten, r.pixel_url) : rewritten, text: htmlToText(rewritten) };
}

export interface SendOutcome {
  ok: boolean;
  emailId?: string;
  errors?: string[];
  batch?: BatchResult;
  summary: string;
}

export async function trackedSend(p: Platform, backend: Backend, sender: BatchSender, c: ComposeInput, from: string, prefs: Prefs): Promise<SendOutcome> {
  const pl = plan(c);
  if (!pl.ok) return { ok: false, errors: pl.errors, summary: pl.errors.join(' ') };
  const { recipients, links } = pl.plan;
  const secret = await userSecret(p);
  const keys = await Promise.all(recipients.map((r) => recipientKey(secret, r.address)));
  const req: RegisterEmailRequest = {
    client_request_id: crypto.randomUUID().replace(/-/g, ''),
    mode: recipients.length === 1 ? 'single' : 'individual_group',
    subject: null, track_opens: true, track_clicks: true, disclosure_added: !!(prefs.disclosure_enabled && prefs.disclosure_text),
    recipients: recipients.map((r, i) => ({ recipient_key: keys[i]!, original_field: r.field, address: null })),
    links,
  };
  const reg = await backend.request<RegisterEmailResponse>('POST', '/v1/emails', req);
  // Refuse to send mail that can never be tracked: the backend's PUBLIC_BASE_URL decides the pixel/click URLs,
  // and mail clients (and Gmail's image proxy, which fetches from Google's servers) can't reach loopback/private/http hosts.
  const unreachable = reg.recipients.flatMap((r) => [r.pixel_url, ...r.links.map((l) => l.click_url)])
    .filter((u): u is string => !!u).map((u) => ({ u, why: trackingUrlProblem(u) })).find((x) => x.why);
  if (unreachable) {
    await backend.request('DELETE', `/v1/emails/${reg.email_id}`).catch(() => undefined);   // no orphan "sent 0" record
    let origin = 'the tracking server';
    try { origin = new URL(unreachable.u).origin; } catch { /* keep generic */ }
    const msg = `Not sent. Tracking URLs point to ${origin}, which ${unreachable.why}. Recipients' mail apps and Gmail's image proxy can't reach it, so opens and clicks would never be recorded. The backend's PUBLIC_BASE_URL must be a public https address.`;
    return { ok: false, errors: [msg], summary: msg };
  }
  const byKey = new Map(reg.recipients.map((r) => [r.recipient_key, r]));
  const regs = keys.map((k) => byKey.get(k)!);
  await saveMeta(p, { emailId: reg.email_id, subject: c.subject, createdAt: p.now(), links,
    recipients: recipients.map((r, i) => ({ recipientId: regs[i]!.recipient_id, address: r.address, field: r.field })) });
  const copies = regs.map((r) => personalise(c.html, r, prefs));
  const patch = (i: number, b: PatchRecipientRequest) => backend.request('PATCH', `/v1/emails/${reg.email_id}/recipients/${regs[i]!.recipient_id}`, b);

  const batch = await sender.send({
    from: { email: from }, recipients: recipients.map((r) => r.address), subject: c.subject,
    html: (i) => copies[i]!.html, text: (i) => copies[i]!.text, spacingMs: 1000,
    hooks: {
      beforeSend: (i) => patch(i, { send_status: 'sending' }).then(() => undefined),
      afterResult: async (i, res) => {
        if (res.status === 'sent') await patch(i, { send_status: 'sent', gmail_message_id: res.id!, ...(res.threadId ? { gmail_thread_id: res.threadId } : {}), sent_at: p.now() });
        else if (res.status === 'failed') await patch(i, { send_status: 'failed', send_error: (res.error ?? 'failed').slice(0, 200) });
        else if (res.status === 'uncertain') await patch(i, { send_status: 'failed', send_error: `uncertain delivery — check Gmail Sent: ${(res.error ?? '').slice(0, 150)}` });
      },
    },
  });
  const sent = batch.results.filter((r) => r.status === 'sent').length;
  const uncertain = batch.results.filter((r) => r.status === 'uncertain').length;
  const summary = batch.ok
    ? `Sent ${sent} tracked ${sent === 1 ? 'copy' : 'copies'}.`
    : `Sent ${sent} of ${recipients.length}. ${uncertain ? 'One copy has an UNCERTAIN delivery status — check Gmail Sent before retrying. ' : ''}${batch.reason ?? ''}`;
  return { ok: batch.ok, emailId: reg.email_id, batch, summary };
}

/** Dry run: same planning and per-recipient rewriting with placeholder URLs. No backend call, no Gmail call. */
export function dryRunPreview(c: ComposeInput, prefs: Prefs) {
  const pl = plan(c);
  if (!pl.ok) return { ok: false as const, errors: pl.errors };
  return {
    ok: true as const,
    copies: pl.plan.recipients.map((r, i) => {
      const fake = { recipient_id: `preview-${i}`, recipient_key: '', pixel_url: `https://tracking.invalid/o/PREVIEW${i}.gif`,
        links: pl.plan.links.map((l) => ({ index: l.index, click_url: `https://tracking.invalid/c/PREVIEW${i}-${l.index}` })) };
      return { to: r.address, field: r.field, ...personalise(c.html, fake, prefs) };
    }),
    links: pl.plan.links,
  };
}
