// Tracklet Gmail content script (ISOLATED world). DOM APIs only — no HTML sinks, no Trusted Types policies.
// It never sees tokens: it sends compose snapshots to the service worker and shows the results.
import type { ThreadMarkState } from './gmail/adapter';
import { NativeDomAdapter } from './gmail/native-adapter';
import type { ComposeInput, SendOutcome } from './lib/trackedSend';
import type { Reply } from './messages';

const adapter = new NativeDomAdapter(document, false);

function send<T>(msg: unknown): Promise<Reply<T>> {
  return new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (r: Reply<T> | undefined) => resolve(r ?? { ok: false, error: 'internal', message: chrome.runtime.lastError?.message ?? 'No response' })); }
    catch { resolve({ ok: false, error: 'internal', message: 'Tracklet was updated — reload Gmail.' }); }
  });
}

// ---------- toast / panel (DOM APIs only) ----------
let toastEl: HTMLDivElement | null = null;
function toast(text: string, kind: 'info' | 'ok' | 'error' = 'info', lines: string[] = []) {
  toastEl?.remove();
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.className = 'tracklet-toast';
  el.style.cssText = `position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:420px;max-height:60vh;overflow:auto;padding:12px 14px;border-radius:10px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.18);background:${kind === 'error' ? '#fce8e6' : kind === 'ok' ? '#e6f4ea' : '#e8f0fe'};color:#202124;border:1px solid ${kind === 'error' ? '#f28b82' : kind === 'ok' ? '#81c995' : '#aecbfa'}`;
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;gap:8px;align-items:flex-start';
  const msg = document.createElement('div');
  msg.style.flex = '1';
  msg.textContent = text;
  const x = document.createElement('button');
  x.type = 'button';
  x.textContent = '×';
  x.setAttribute('aria-label', 'Dismiss');
  x.style.cssText = 'border:0;background:none;font-size:16px;cursor:pointer;color:#5f6368';
  x.addEventListener('click', () => el.remove());
  head.append(msg, x);
  el.append(head);
  for (const l of lines) { const d = document.createElement('div'); d.style.cssText = 'margin-top:6px;white-space:pre-wrap;word-break:break-word;color:#3c4043'; d.textContent = l; el.append(d); }
  document.body.append(el);
  toastEl = el;
  if (kind === 'ok') setTimeout(() => { if (toastEl === el) el.remove(); }, 8000);
}

// ---------- compose integration ----------
function composeInput(s: ReturnType<Parameters<Parameters<typeof adapter.onCompose>[0]>[0]['snapshot']>, groupConfirmed: boolean): ComposeInput {
  return { kind: s.kind, to: s.to.map((a) => a.email), cc: s.cc.map((a) => a.email), bcc: s.bcc.map((a) => a.email),
    subject: s.subject, html: s.html, hasAttachments: s.hasAttachments, groupConfirmed };
}

adapter.ready().then(() => {
  adapter.onCompose((c) => {
    if (c.kind !== 'new') return;   // D7: no tracked replies/forwards in the MVP
    let busy = false;
    const sendBtnDispose = c.addButton('Send tracked', async () => {
      if (busy) return;   // double-click guard (the service worker's sender has its own lock too)
      const snap = c.snapshot();
      const n = snap.to.length + snap.cc.length + snap.bcc.length;
      let groupConfirmed = false;
      if (n > 1) {
        groupConfirmed = window.confirm(
          `Tracklet will send ${n} SEPARATE copies (one per recipient) so each recipient can be tracked individually.\n\n` +
          '• Each recipient sees only their own address\n• Cc becomes a separate copy\n• Reply-All will reach only you\n\nContinue?');
        if (!groupConfirmed) return;
      }
      busy = true;
      toast(`Sending ${n === 1 ? '1 tracked copy' : `${n} tracked copies`}…`);
      try {
        const r = await send<SendOutcome>({ type: 'send', compose: composeInput(snap, groupConfirmed) });
        if (!r.ok) { toast(r.message, 'error'); return; }
        const o = r.data;
        if (!o.ok && o.errors) { toast('Not sent:', 'error', o.errors); return; }
        if (o.ok) {
          const discarded = c.discard?.() ?? false;
          if (!discarded) c.close();
          toast(o.summary, 'ok', discarded ? [] : ['Gmail kept a draft of this message — you can delete it from Drafts.']);
        } else {
          toast(o.summary, 'error', (o.batch?.results ?? []).map((x) => `${x.to}: ${x.status}${x.error ? ` — ${x.error}` : ''}`));
        }
      } finally { busy = false; }
    });
    const previewDispose = c.addButton('Preview tracking', async () => {
      const r = await send<{ ok: boolean; errors?: string[]; copies?: { to: string; text: string }[]; links?: unknown[] }>({ type: 'dryRun', compose: composeInput(c.snapshot(), true) });
      if (!r.ok) { toast(r.message, 'error'); return; }
      if (!r.data.ok) { toast('Not ready to send tracked:', 'error', r.data.errors ?? []); return; }
      toast(`Preview only — nothing sent. ${r.data.copies!.length} copy(ies), ${r.data.links!.length} link(s) tracked.`, 'info',
        r.data.copies!.map((x) => `To ${x.to}:\n${x.text.slice(0, 400)}`));
    });
    void sendBtnDispose; void previewDispose;
  });

  adapter.onThreadViewed((threadId) => { void send({ type: 'threadViewed', threadId }); });

  const LABEL: Record<string, ThreadMarkState> = { clicked: 'clicked', likely_opened: 'likely_opened', sent: 'sent' };
  let lastKey = '';
  async function refreshMarks() {
    const ids = adapter.visibleThreadIds();
    const key = ids.join(',');
    if (!ids.length) { adapter.setThreadMarks(new Map()); return; }
    const r = await send<Record<string, { label: string }>>({ type: 'threadStatus', ids });
    if (!r.ok) return;
    const m = new Map<string, ThreadMarkState>();
    for (const [id, v] of Object.entries(r.data)) if (LABEL[v.label]) m.set(id, LABEL[v.label]!);
    adapter.setThreadMarks(m);
    lastKey = key;
  }
  window.addEventListener('hashchange', () => { setTimeout(() => void refreshMarks(), 1500); });
  setInterval(() => { if (document.visibilityState === 'visible') void refreshMarks(); }, 30_000);
  setTimeout(() => void refreshMarks(), 2000);
  void lastKey;
}).catch(() => { /* Gmail not ready — nothing to do */ });
